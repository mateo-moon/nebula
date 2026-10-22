//! Guest-local key retrieval and fixed, authenticated mount leases.
//! Identical replacement guests start with an empty Trustee. There is no
//! hardware-derived fallback and no persistent copy of the instance credential.
use crate::{
    generic_config::{Initialization, ResourceBroker, ResourceClient, Volume},
    lifecycle::{Exit, Format},
    mount_handoff as handoff, volume,
};
use anyhow::{bail, ensure, Context, Result};
use std::{
    fs::{self, File, Permissions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
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
fn local_resource(resource: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
    let address: SocketAddr = "127.0.0.1:8006".parse()?;
    local_resource_at(resource, &address)
}

fn local_resource_at(resource: &str, address: &SocketAddr) -> Result<Option<Zeroizing<Vec<u8>>>> {
    let mut socket = TcpStream::connect_timeout(address, Duration::from_secs(2))?;
    // Native api-server-rest can wait up to 50 seconds for CDH.
    socket.set_read_timeout(Some(Duration::from_secs(60)))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        socket,
        "GET /cdh/resource/{resource} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = Zeroizing::new(Vec::new());
    socket.take(65_537).read_to_end(&mut response)?;
    ensure!(response.len() <= 65_536, "invalid local resource response");
    let split = response
        .windows(4)
        .position(|v| v == b"\r\n\r\n")
        .context("invalid local response")?;
    let header = std::str::from_utf8(&response[..split])?;
    let mut lines = header.split("\r\n");
    let status = lines.next().context("missing local response status")?;
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|part| part.parse::<u16>().ok())
        .filter(|code| (100..=599).contains(code))
        .context("invalid guest CDH HTTP status")?;
    if code != 200 {
        // Never include the response body: it can contain a resource or a
        // credential. The numeric status is safe for owner diagnostics.
        bail!("guest CDH returned HTTP {code}");
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
        !body.is_empty() && body.len() <= 64 * 1024 && length.is_none_or(|n| n == body.len()),
        "invalid local resource length"
    );
    Ok(Some(Zeroizing::new(body.to_vec())))
}

fn local_key(resource: &str) -> Result<Option<Zeroizing<[u8; 32]>>> {
    let Some(response) = local_resource(resource)? else {
        return Ok(None);
    };
    ensure!(response.len() == 32, "volume key must be exactly 32 bytes");
    let mut key = Zeroizing::new([0; 32]);
    key.copy_from_slice(&response);
    ensure!(key.iter().any(|b| *b != 0), "invalid volume key");
    Ok(Some(key))
}

/// The application receives only its measured allowlist over a dedicated
/// memory-backed Unix socket. Kernel peer credentials are checked for every
/// request; a matching path string alone is never authorization.
pub(crate) fn serve_resources(json: &str) -> Result<()> {
    let config = ResourceBroker::parse(json)?;
    // The socket must be private from its first instant, before the
    // application UID is assigned and before any client can connect.
    unsafe { libc::umask(0o077) };
    let mut listeners = Vec::with_capacity(config.clients.len());
    for client in &config.clients {
        let directory = format!("/run/nebula-resources/{}", client.name);
        tmpfs(&directory)?;
        let socket = format!("{directory}/resource.sock");
        if let Ok(stale) = fs::symlink_metadata(&socket) {
            ensure!(
                stale.file_type().is_socket() && stale.uid() == client.uid,
                "unexpected resource broker socket at restart"
            );
            // The old container is gone after a restart, but its socket inode
            // remains in the pod-lifetime tmpfs. The app mounts it read-only.
            fs::remove_file(&socket)?;
        }
        let listener = UnixListener::bind(&socket)?;
        let path = std::ffi::CString::new(socket)?;
        fs::set_permissions(path.to_str()?, Permissions::from_mode(0o600))?;
        ensure!(
            unsafe { libc::chown(path.as_ptr(), client.uid, client.gid) } == 0,
            "cannot assign resource socket"
        );
        listener.set_nonblocking(true)?;
        listeners.push(listener);
    }
    let busy: Vec<_> = (0..config.clients.len())
        .map(|_| Arc::new(AtomicBool::new(false)))
        .collect();
    loop {
        for (index, (client, listener)) in config.clients.iter().zip(&listeners).enumerate() {
            if busy[index].load(Ordering::Acquire) {
                continue;
            }
            if let Ok((stream, _)) = listener.accept() {
                if busy[index].swap(true, Ordering::AcqRel) {
                    continue;
                }
                let client = client.clone();
                let busy = Arc::clone(&busy[index]);
                // One bounded worker per declared recipient prevents an idle
                // client or native CDH timeout from stalling other recipients.
                thread::spawn(move || {
                    let _ = std::panic::catch_unwind(|| serve_resource_client(&client, stream));
                    busy.store(false, Ordering::Release);
                });
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn serve_resource_client(client: &ResourceClient, mut stream: UnixStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let (uid, gid) = handoff::peer_credentials(&stream)?;
    if uid != client.uid || gid != client.gid {
        return Ok(());
    }
    let mut request = [0u8; 512];
    let n = stream.read(&mut request)?;
    let path = request[..n]
        .strip_prefix(b"GET ")
        .and_then(|r| r.strip_suffix(b"\n"));
    let Some(path) = path.and_then(|r| std::str::from_utf8(r).ok()) else {
        return Ok(());
    };
    if !client.resources.iter().any(|allowed| allowed == path) {
        return Ok(());
    }
    if let Ok(Some(response)) = local_resource(path) {
        let len = u32::try_from(response.len())?.to_be_bytes();
        stream.write_all(&len)?;
        stream.write_all(&response)?;
    }
    Ok(())
}

fn retrieve(resource: &str) -> Result<Zeroizing<[u8; 32]>> {
    let mut last_error = String::new();
    loop {
        ensure!(
            handoff::SIGNAL.load(Ordering::SeqCst) == 0,
            "guest shutdown interrupted owner provisioning"
        );
        match local_key(resource) {
            Ok(Some(key)) => return Ok(key),
            Ok(None) => {}
            Err(error) => {
                let description = format!("{error:#}");
                if description != last_error {
                    publish_status("awaiting-owner", Some(&error), None)?;
                    last_error = description;
                }
            }
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn publish(phase: &str) -> Result<()> {
    publish_status(phase, None, None)
}

fn publish_status(
    phase: &str,
    error: Option<&anyhow::Error>,
    report: Option<&serde_json::Value>,
) -> Result<()> {
    let target = Path::new("/run/volume/status.json");
    let temporary = target.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut status = serde_json::json!({
        "version":1,"phase":phase,
        "error":error.map(|e| format!("{e:#}").chars().take(1024).collect::<String>())
    });
    if let Some(report) = report {
        for field in ["formatted", "marker_sha256", "luks_uuid"] {
            if let Some(value) = report.get(field) {
                status[field] = value.clone();
            }
        }
    }
    write_new(&temporary, &serde_json::to_vec(&status)?, 0o444)?;
    fs::rename(temporary, target)?;
    Ok(())
}

fn hold_refusal(phase: &str, error: anyhow::Error) -> Result<()> {
    publish_status(phase, Some(&error), None)?;
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
        // The app may chmod/chgrp its own exported directory. Its parent is
        // not writable through the handoff, so only type and owner matter.
        ensure!(
            stat.is_dir() && stat.uid() == client.uid,
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
    // Keep the mapping alive and the failure visible if a lease or listener
    // fails. Restarting this sidecar is never an owner-authorized disk retry.
    if let Err(error) = serve_mounted(&config, profile, &mut active, &report) {
        return hold_refusal("failed", error);
    }
    Ok(())
}

fn serve_mounted(
    config: &Volume,
    profile: &'static volume::Profile,
    active: &mut volume::ActiveVolume,
    report: &serde_json::Value,
) -> Result<()> {
    if let Err(error) = directories(
        config,
        report["formatted"] == true,
        Path::new(profile.mount),
    ) {
        return Err(error);
    }
    fs::set_permissions("/run/volume", Permissions::from_mode(0o755))?;
    let socket = "/run/volume/mount.sock";
    if let Ok(stale) = fs::symlink_metadata(socket) {
        ensure!(
            stale.file_type().is_socket() && stale.uid() == 0,
            "unexpected mount socket at restart"
        );
        fs::remove_file(socket)?;
    }
    let listener = UnixListener::bind(socket)?;
    fs::set_permissions(socket, Permissions::from_mode(0o666))?;
    listener.set_nonblocking(true)?;
    publish_status("ready", None, Some(report))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn local_cdh_reports_only_status_not_error_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let mut part = [0; 256];
                let n = socket.read(&mut part).unwrap();
                assert!(n > 0 && request.len() + n <= 512);
                request.extend_from_slice(&part[..n]);
            }
            socket
                .write_all(
                    b"HTTP/1.0 403 Forbidden\r\nContent-Length: 18\r\n\r\nprivate-key-secret",
                )
                .unwrap();
        });
        let error = local_resource_at("default/volume/data", &address)
            .unwrap_err()
            .to_string();
        server.join().unwrap();
        assert_eq!(error, "guest CDH returned HTTP 403");
    }

    #[test]
    fn reopening_a_client_directory_tolerates_client_chmod_and_chgrp() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let root = std::env::temp_dir().join(format!("nebula-client-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let config = Volume::parse(
            r#"{"version":1,"name":"data","sizeBytes":1073741824,
            "keyResource":"default/volume/data","initialization":"Never",
            "clients":[{"name":"app","uid":11000,"gid":11000}]}"#,
        )
        .unwrap();
        directories(&config, true, &root).unwrap();
        fs::set_permissions(root.join("app"), Permissions::from_mode(0o755)).unwrap();
        let path = std::ffi::CString::new(root.join("app").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::chown(path.as_ptr(), 11000, 10001) }, 0);
        directories(&config, false, &root).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
