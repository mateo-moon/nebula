//! Guest-local key retrieval and fixed, authenticated mount leases.
//! Identical replacement guests start with an empty Trustee. There is no
//! hardware-derived fallback and no persistent copy of the instance credential.
use crate::{
    generic_config::{Initialization, Volume},
    lifecycle::{Exit, Format},
    mount_handoff as handoff, volume,
};
use anyhow::{bail, ensure, Context, Result};
use std::{
    fs::{self, File, Permissions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::Path,
    sync::atomic::Ordering,
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

fn tmpfs(path: &str) -> Result<()> {
    let path = std::ffi::CString::new(path)?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    ensure!(
        unsafe { libc::statfs(path.as_ptr(), &mut stat) } == 0 && stat.f_type == 0x01021994,
        "guest memory volume required"
    );
    Ok(())
}

pub(crate) fn install() -> Result<()> {
    tmpfs("/run/nebula-runtime")?;
    let bytes = fs::read(std::env::current_exe()?)?;
    write_new(
        Path::new("/run/nebula-runtime/nebula-confidential-storage"),
        &bytes,
        0o555,
    )
}

// HTTP/1.0 requires a length or connection-close response, never chunked
// transfer coding. Both the peer and endpoint are fixed guest components.
// Buffer even error bodies in zeroizing memory; never return them in errors.
fn local_key(resource: &str) -> Result<Option<Zeroizing<[u8; 32]>>> {
    let address: SocketAddr = "127.0.0.1:8006".parse()?;
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    // Native api-server-rest can wait up to 50 seconds for CDH.
    socket.set_read_timeout(Some(Duration::from_secs(60)))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        socket,
        "GET /cdh/resource/{resource} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = Zeroizing::new(Vec::new());
    socket.take(8193).read_to_end(&mut response)?;
    ensure!(response.len() <= 8192, "invalid local key response");
    let split = response
        .windows(4)
        .position(|v| v == b"\r\n\r\n")
        .context("invalid local response")?;
    let header = std::str::from_utf8(&response[..split])?;
    let mut lines = header.split("\r\n");
    let status = lines.next().context("missing local response status")?;
    if !matches!(status.split_whitespace().nth(1), Some("200")) {
        return Ok(None);
    }
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':').context("invalid response header")?;
        ensure!(
            !name.eq_ignore_ascii_case("transfer-encoding"),
            "unsupported transfer coding"
        );
        if name.eq_ignore_ascii_case("content-length") {
            ensure!(length.is_none(), "duplicate response length");
            length = Some(value.trim().parse::<usize>()?);
        }
    }
    let body = &response[split + 4..];
    ensure!(
        body.len() == 32 && length.is_none_or(|n| n == 32),
        "volume key must be exactly 32 bytes"
    );
    let mut key = Zeroizing::new([0; 32]);
    key.copy_from_slice(body);
    ensure!(key.iter().any(|b| *b != 0), "invalid volume key");
    Ok(Some(key))
}

fn retrieve(resource: &str) -> Result<Zeroizing<[u8; 32]>> {
    loop {
        ensure!(
            handoff::SIGNAL.load(Ordering::SeqCst) == 0,
            "guest shutdown interrupted owner provisioning"
        );
        if let Ok(Some(key)) = local_key(resource) {
            return Ok(key);
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn publish(phase: &str) -> Result<()> {
    publish_status(phase, None)
}

fn publish_status(phase: &str, error: Option<&anyhow::Error>) -> Result<()> {
    let target = Path::new("/run/volume/status.json");
    let temporary = target.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    write_new(
        &temporary,
        &serde_json::to_vec(&serde_json::json!({
            "version":1,"phase":phase,
            // Local operations never include keys or resource responses in
            // errors. Only the authenticated owner diagnostic exposes this.
            "error":error.map(|e| format!("{e:#}").chars().take(1024).collect::<String>())
        }))?,
        0o444,
    )?;
    fs::rename(temporary, target)?;
    Ok(())
}

fn hold_refusal(phase: &str, error: anyhow::Error) -> Result<()> {
    publish_status(phase, Some(&error))?;
    // Keep the measured helper and its diagnosis alive. A Kubernetes restart
    // is not an owner-authorized retry, and must not reset the refusal state.
    while handoff::SIGNAL.load(Ordering::SeqCst) == 0 {
        thread::sleep(Duration::from_millis(100));
    }
    Err(error)
}

fn directories(config: &Volume, created: bool, root: &Path) -> Result<()> {
    for client in &config.clients {
        let path = root.join(&client.name);
        if created {
            fs::create_dir(&path)?;
            fs::set_permissions(&path, Permissions::from_mode(0o700))?;
            let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
            ensure!(
                unsafe { libc::chown(name.as_ptr(), client.uid, client.gid) } == 0,
                "client directory ownership failed"
            );
        }
        let stat = fs::symlink_metadata(&path)?;
        ensure!(
            stat.is_dir()
                && stat.uid() == client.uid
                && stat.gid() == client.gid
                && stat.mode() & 0o7777 == 0o700,
            "invalid persistent client directory"
        );
    }
    File::open(root)?.sync_all()?;
    Ok(())
}

pub(crate) fn serve(json: &str) -> Result<()> {
    let config = Volume::parse(json)?;
    tmpfs("/run/volume")?;
    volume::discover()?;
    handoff::signals()?;
    publish("awaiting-owner")?;
    let key = retrieve(&config.key_resource)?;
    let profile = volume::Profile::generic(&config.name, config.size_bytes);
    let format = match config.initialization {
        Initialization::Never => Format::Deny,
        Initialization::IfEmpty => Format::Allow,
    };
    let (active, report) = match volume::open_lifecycle(key, profile, format) {
        Ok(opened) => opened,
        Err(error) => return hold_refusal("failed", error),
    };
    let Some(mut active) = active else {
        return hold_refusal("unlock-denied", Exit::UnlockDenied.into());
    };
    directories(
        &config,
        report["formatted"] == true,
        Path::new(profile.mount),
    )?;
    fs::set_permissions("/run/volume", Permissions::from_mode(0o755))?;
    let socket = "/run/volume/mount.sock";
    let listener = UnixListener::bind(socket)?;
    fs::set_permissions(socket, Permissions::from_mode(0o666))?;
    listener.set_nonblocking(true)?;
    publish("ready")?;
    let count = config.clients.len();
    let mut leases: Vec<Option<UnixStream>> = (0..count).map(|_| None).collect();
    let mut pending: Vec<Option<handoff::PendingMount>> = (0..count).map(|_| None).collect();
    let mut used = vec![false; count];
    let mut stopping = None;
    loop {
        if handoff::SIGNAL.load(Ordering::SeqCst) != 0 && stopping.is_none() {
            stopping = Some(Instant::now());
            pending.iter_mut().for_each(|request| *request = None);
            for lease in leases.iter_mut().flatten() {
                let _ = lease.write_all(b"S");
            }
        }
        if stopping.is_none() {
            if let Ok((stream, _)) = listener.accept() {
                if let Ok((uid, gid)) = handoff::peer_credentials(&stream) {
                    if let Some(index) = config
                        .clients
                        .iter()
                        .position(|c| c.uid == uid && c.gid == gid)
                    {
                        if !used[index] && pending[index].is_none() {
                            pending[index] =
                                handoff::PendingMount::new(stream, Instant::now()).ok();
                        }
                    }
                }
            }
            for index in 0..count {
                let Some(request) = pending[index].as_mut() else {
                    continue;
                };
                match request.ready(Instant::now()) {
                    Ok(false) => {}
                    Err(_) => {
                        pending[index] = None;
                    }
                    Ok(true) => {
                        // Set before export: a partial SCM_RIGHTS failure cannot
                        // authorize a second lease for this UID in this VM.
                        used[index] = true;
                        leases[index] =
                            Some(pending[index].take().unwrap().grant(&format!(
                                "{}/{}",
                                profile.mount, config.clients[index].name
                            ))?);
                    }
                }
            }
        }
        for lease in &mut leases {
            if let Some(stream) = lease {
                let mut byte = [0];
                match stream.read(&mut byte) {
                    Ok(1) if byte == *b"D" => {
                        *lease = None;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    _ => bail!("mount lease ended without clean unmount"),
                }
            }
        }
        if stopping.is_some() && leases.iter().all(Option::is_none) {
            break;
        }
        ensure!(
            stopping.is_none_or(|start| start.elapsed() <= Duration::from_secs(50)),
            "mount leases did not close within guest shutdown grace"
        );
        thread::sleep(Duration::from_millis(100));
    }
    drop(listener);
    fs::remove_file(socket)?;
    active.close()?;
    publish("closed")
}

fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
