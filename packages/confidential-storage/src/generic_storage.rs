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

const MAX_APPLICATION_RESOURCE_BYTES: usize = 2 * 1024 * 1024;
// Includes the status line and the terminating CRLF pair, independently of
// the application payload. One extra transport byte detects total overflow.
const MAX_LOCAL_HTTP_HEADER_BYTES: usize = 16 * 1024;
const MAX_LOCAL_RESOURCE_RESPONSE_BYTES: usize =
    MAX_LOCAL_HTTP_HEADER_BYTES + MAX_APPLICATION_RESOURCE_BYTES;

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
    let target = Path::new("/run/nebula-runtime/nebula-confidential-storage");
    if let Ok(info) = fs::symlink_metadata(target) {
        ensure!(
            info.is_file()
                && info.uid() == 0
                && info.mode() & 0o7777 == 0o555
                && fs::read(target)? == bytes,
            "installed launcher changed"
        );
        return Ok(());
    }
    write_new(target, &bytes, 0o555).map(|_| ())
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
    socket
        .take((MAX_LOCAL_RESOURCE_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut response)?;
    ensure!(
        response.len() <= MAX_LOCAL_RESOURCE_RESPONSE_BYTES,
        "invalid local resource response"
    );
    let split = response
        .windows(4)
        .position(|v| v == b"\r\n\r\n")
        .context("invalid local response")?;
    ensure!(
        split + 4 <= MAX_LOCAL_HTTP_HEADER_BYTES,
        "local response headers too large"
    );
    let header = std::str::from_utf8(&response[..split])?;
    let mut lines = header.split("\r\n");
    let status = lines.next().context("missing local response status")?;
    let mut status_parts = status.split_whitespace();
    let version = status_parts
        .next()
        .context("missing local response version")?;
    ensure!(
        matches!(version, "HTTP/1.0" | "HTTP/1.1"),
        "invalid local response version"
    );
    let code = status_parts
        .next()
        .and_then(|part| part.parse::<u16>().ok())
        .filter(|code| (100..=599).contains(code))
        .context("invalid guest CDH HTTP status")?;
    if code != 200 {
        // Never include the response body: it can contain a resource or a
        // credential. The numeric status is safe for owner diagnostics.
        bail!("guest CDH returned HTTP {code}");
    }
    let mut length = None;
    let mut connection_close = false;
    let mut connection_keep_alive = false;
    for line in lines {
        let (name, value) = line.split_once(':').context("invalid response header")?;
        ensure!(
            !name.is_empty()
                && name.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
                })
                && !value
                    .bytes()
                    .any(|byte| byte.is_ascii_control() && byte != b'\t'),
            "invalid response header"
        );
        ensure!(
            !name.eq_ignore_ascii_case("transfer-encoding"),
            "unsupported transfer coding"
        );
        if name.eq_ignore_ascii_case("content-length") {
            ensure!(length.is_none(), "duplicate response length");
            let value = value.trim();
            ensure!(
                !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
                "invalid response length"
            );
            let declared = value.parse::<usize>()?;
            ensure!(
                declared <= MAX_APPLICATION_RESOURCE_BYTES,
                "invalid local resource length"
            );
            length = Some(declared);
        }
        if name.eq_ignore_ascii_case("connection") {
            for token in value.split(',').map(str::trim) {
                connection_close |= token.eq_ignore_ascii_case("close");
                connection_keep_alive |= token.eq_ignore_ascii_case("keep-alive");
            }
        }
    }
    ensure!(
        length.is_some() || connection_close || version == "HTTP/1.0" && !connection_keep_alive,
        "local response needs a length or connection close"
    );
    let body = &response[split + 4..];
    ensure!(
        !body.is_empty()
            && body.len() <= MAX_APPLICATION_RESOURCE_BYTES
            && length.is_none_or(|n| n == body.len()),
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
    serve_resource_module(config)
}

pub(crate) fn serve_resource_module(config: ResourceBroker) -> Result<()> {
    serve_resource_module_ready(config, None)
}
pub(crate) fn serve_resource_module_ready(
    config: ResourceBroker,
    ready: Option<crate::recovery::BrokerReady>,
) -> Result<()> {
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
    if let Some(ready) = ready {
        ready.ready();
    }
    let busy: Vec<_> = (0..config.clients.len())
        .map(|_| Arc::new(AtomicBool::new(false)))
        .collect();
    while handoff::SIGNAL.load(Ordering::SeqCst) == 0 {
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
    Ok(())
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

fn retrieve(resource: &str, profile: &volume::Profile) -> Result<Zeroizing<[u8; 32]>> {
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
                    publish_status(profile, "awaiting-owner", Some(&error), None)?;
                    last_error = description;
                }
            }
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn publish(profile: &volume::Profile, phase: &str) -> Result<()> {
    publish_status(profile, phase, None, None)
}

fn publish_status(
    profile: &volume::Profile,
    phase: &str,
    error: Option<&anyhow::Error>,
    report: Option<&serde_json::Value>,
) -> Result<()> {
    let target = Path::new(profile.state).join("status.json");
    let mut status = serde_json::json!({
        "version":1,"phase":phase,
        "error":error.map(|e| format!("{e:#}").chars().take(1024).collect::<String>())
    });
    if let Some(report) = report {
        for field in ["formatted", "marker_sha256", "luks_uuid", "supervisors"] {
            if let Some(value) = report.get(field) {
                status[field] = value.clone();
            }
        }
    }
    write_status(&target, &serde_json::to_vec(&status)?)
}

fn write_status(target: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = target.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let file = write_new(&temporary, bytes, 0o444)?;
    // Native storage keeps umask 077 for keys and sockets. Only this public,
    // root-owned status inode is readable by the unprivileged HTTP agent.
    // Set the mode through the newly created descriptor before publication.
    file.set_permissions(Permissions::from_mode(0o444))?;
    file.sync_all()?;
    fs::rename(temporary, target)?;
    Ok(())
}

fn hold_refusal(profile: &volume::Profile, phase: &str, error: anyhow::Error) -> Result<()> {
    publish_status(profile, phase, Some(&error), None)?;
    // Keep the measured helper and its diagnosis alive. A Kubernetes restart
    // is not an owner-authorized retry, and must not reset the refusal state.
    while handoff::SIGNAL.load(Ordering::SeqCst) == 0 {
        thread::sleep(Duration::from_millis(100));
    }
    Err(error)
}

fn directories(config: &Volume, _created: bool, root: &Path) -> Result<()> {
    crate::initialization::recipients(root, &config.clients)
}

pub(crate) fn serve(json: &str) -> Result<()> {
    let config = Volume::parse(json)?;
    handoff::signals()?;
    let profile = volume::Profile::generic(&config.name, config.size_bytes);
    serve_volume(config, profile, false, None)
}

pub(crate) fn serve_volume(
    config: Volume,
    profile: &'static volume::Profile,
    owner_gate: bool,
    recovery: Option<crate::recovery::VolumeRecovery>,
) -> Result<()> {
    tmpfs(profile.state)?;
    volume::discover()?;
    publish(profile, "awaiting-owner")?;
    if owner_gate {
        wait_owner()?;
    }
    let format = match config.initialization {
        Initialization::Never => Format::Deny,
        Initialization::IfEmpty => Format::Allow,
    };
    let (mut active, report) = loop {
        let key = retrieve(&config.key_resource, profile)?;
        // Key acquisition is complete. A full-capacity empty-media proof may
        // now run; do not keep reporting that the volume awaits its owner.
        publish(profile, "initializing")?;
        match volume::open_lifecycle(Zeroizing::new(*key), profile, format) {
            Ok((Some(active), report)) => break (active, report),
            opened => {
                let error = match opened {
                    Err(error) => error,
                    _ => Exit::UnlockDenied.into(),
                };
                let Some(control) = &recovery else {
                    return hold_refusal(profile, "failed", error);
                };
                let header = volume::recovery_candidate(&key, profile).ok().flatten();
                control.candidate(header.clone());
                publish_status(
                    profile,
                    if header.is_some() {
                        "recovery-required"
                    } else {
                        "manual-recovery-required"
                    },
                    Some(&error),
                    None,
                )?;
                // A failed volume never stops the control plane. Only a native
                // one-shot authorization for this exact candidate can retry.
                loop {
                    ensure!(
                        handoff::SIGNAL.load(Ordering::SeqCst) == 0,
                        "recovery interrupted by shutdown"
                    );
                    if let Some(expected) = control.requested(Duration::from_millis(100)) {
                        publish(profile, "recovering")?;
                        let recovered = volume::recover_empty_filesystem(
                            Zeroizing::new(*key),
                            profile,
                            &expected,
                        );
                        if recovered.is_ok() {
                            break;
                        }
                        let fresh = volume::recovery_candidate(&key, profile).ok().flatten();
                        control.candidate(fresh.clone());
                        publish(
                            profile,
                            if fresh.is_some() {
                                "recovery-required"
                            } else {
                                "manual-recovery-required"
                            },
                        )?;
                    }
                }
            }
        }
    };
    if let Some(control) = &recovery {
        control.candidate(None);
    }
    // Keep the mapping alive and the failure visible if a lease or listener
    // fails. Restarting this sidecar is never an owner-authorized disk retry.
    let result = serve_mounted(&config, profile, &mut active, &report, recovery.as_ref());
    if let Some(control) = &recovery {
        control.ready(false);
    }
    if let Err(error) = result {
        return hold_refusal(profile, "failed", error);
    }
    Ok(())
}

fn serve_mounted(
    config: &Volume,
    profile: &'static volume::Profile,
    active: &mut volume::ActiveVolume,
    report: &serde_json::Value,
    ready: Option<&crate::recovery::VolumeRecovery>,
) -> Result<()> {
    if let Err(error) = directories(
        config,
        report["formatted"] == true,
        Path::new(profile.mount),
    ) {
        return Err(error);
    }
    if let Some(layout) = &active.layout {
        crate::initialization::complete(Path::new(profile.mount), &layout.uuid)?;
    }
    fs::set_permissions(profile.state, Permissions::from_mode(0o755))?;
    let socket = Path::new(profile.state).join("mount.sock");
    if let Ok(stale) = fs::symlink_metadata(&socket) {
        ensure!(
            stale.file_type().is_socket() && stale.uid() == 0,
            "unexpected mount socket at restart"
        );
        fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, Permissions::from_mode(0o666))?;
    listener.set_nonblocking(true)?;
    let mut initial_report = report.clone();
    initial_report["supervisors"]=serde_json::Value::Object(config.clients.iter().map(|client| (client.name.clone(),serde_json::json!({"phase":"starting","restartCount":0,"applicationReady":null}))).collect());
    publish_status(profile, "ready", None, Some(&initial_report))?;
    if let Some(control) = ready {
        control.ready(true);
    }
    let count = config.clients.len();
    let mut leases: Vec<Option<UnixStream>> = (0..count).map(|_| None).collect();
    let mut pending: Vec<Option<handoff::PendingMount>> = (0..count).map(|_| None).collect();
    let mut used = vec![false; count];
    let mut starts = vec![0_u64; count];
    let mut phases = vec!["starting"; count];
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
        let mut supervision_changed = false;
        for (index, lease) in leases.iter_mut().enumerate() {
            if let Some(stream) = lease {
                let mut byte = [0];
                match stream.read(&mut byte) {
                    Ok(1) if byte == *b"B" => {
                        starts[index] = starts[index].saturating_add(1);
                        phases[index] = "running";
                        supervision_changed = true;
                    }
                    Ok(1) if byte == *b"X" => {
                        phases[index] = "backoff";
                        supervision_changed = true;
                    }
                    Ok(1) if byte == *b"D" => {
                        *lease = None;
                        phases[index] = "stopped";
                        supervision_changed = true;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    _ => bail!("mount lease ended without clean unmount"),
                }
            }
        }
        if supervision_changed {
            let mut public_report = report.clone();
            public_report["supervisors"] = serde_json::Value::Object(config.clients.iter().enumerate().map(|(index, client)| {
                (client.name.clone(), serde_json::json!({"phase":phases[index],"restartCount":starts[index].saturating_sub(1),"applicationReady":null}))
            }).collect());
            publish_status(profile, "ready", None, Some(&public_report))?;
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
    publish(profile, "closed")
}

fn wait_owner() -> Result<()> {
    let marker = "/run/nebula-owner-ready/configured";
    tmpfs("/run/nebula-owner-ready")?;
    loop {
        ensure!(
            handoff::SIGNAL.load(Ordering::SeqCst) == 0,
            "owner provisioning interrupted"
        );
        match fs::symlink_metadata(marker) {
            Ok(info) => {
                ensure!(
                    info.is_file()
                        && info.uid() == 10001
                        && info.mode() & 0o7777 == 0o640
                        && fs::read(marker)? == b"nebula-owner-configured-v1\n",
                    "invalid owner gate"
                );
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    fn cdh_response(listener: TcpListener, response: Vec<u8>) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let mut part = [0; 256];
                let n = socket.read(&mut part).unwrap();
                assert!(n > 0 && request.len() + n <= 512);
                request.extend_from_slice(&part[..n]);
            }
            assert!(request.starts_with(b"GET /cdh/resource/"));
            // Overflow cases can close the client before every fixture byte
            // is written. A bounded reader must never drain an excess body.
            let _ = socket.write_all(&response);
        })
    }

    fn fetch_cdh_response(response: Vec<u8>) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = cdh_response(listener, response);
        let result = local_resource_at("default/config/app", &address);
        server.join().unwrap();
        result
    }

    #[test]
    fn local_cdh_serves_exact_application_limit_with_an_independent_header_budget() {
        let body = vec![0xa5; MAX_APPLICATION_RESOURCE_BYTES];
        let prefix = format!(
            "HTTP/1.0 200 OK\r\nContent-Length: {}\r\nX-Padding: ",
            body.len()
        );
        let mut response = prefix.into_bytes();
        response.resize(MAX_LOCAL_HTTP_HEADER_BYTES - 4, b'x');
        response.extend_from_slice(b"\r\n\r\n");
        response.extend_from_slice(&body);
        assert_eq!(response.len(), MAX_LOCAL_RESOURCE_RESPONSE_BYTES);
        let result = fetch_cdh_response(response).unwrap().unwrap();
        assert_eq!(result.len(), body.len());
        assert!(
            result.as_slice() == body.as_slice(),
            "resource bytes changed"
        );
    }

    #[test]
    fn local_cdh_rejects_oversized_bodies_headers_and_transport_responses() {
        for header in [
            format!(
                "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_APPLICATION_RESOURCE_BYTES + 1
            ),
            "HTTP/1.0 200 OK\r\n\r\n".to_owned(),
        ] {
            let mut response = header.into_bytes();
            response.resize(response.len() + MAX_APPLICATION_RESOURCE_BYTES + 1, b'x');
            assert_eq!(
                fetch_cdh_response(response).unwrap_err().to_string(),
                "invalid local resource length"
            );
        }
        let mut header = b"HTTP/1.0 200 OK\r\nX-Padding: ".to_vec();
        header.resize(MAX_LOCAL_HTTP_HEADER_BYTES - 3, b'x');
        header.extend_from_slice(b"\r\n\r\nx");
        assert_eq!(
            fetch_cdh_response(header).unwrap_err().to_string(),
            "local response headers too large"
        );
        let mut response = b"HTTP/1.0 200 OK\r\nX-Padding: ".to_vec();
        response.resize(MAX_LOCAL_HTTP_HEADER_BYTES - 4, b'x');
        response.extend_from_slice(b"\r\n\r\n");
        response.resize(MAX_LOCAL_RESOURCE_RESPONSE_BYTES + 1, b'x');
        assert_eq!(
            fetch_cdh_response(response).unwrap_err().to_string(),
            "invalid local resource response"
        );
    }

    #[test]
    fn local_cdh_accepts_only_complete_length_or_connection_close_frames() {
        for response in [
            &b"HTTP/1.0 200 OK\r\n\r\nx"[..],
            &b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nx"[..],
        ] {
            assert_eq!(
                fetch_cdh_response(response.to_vec())
                    .unwrap()
                    .unwrap()
                    .as_slice(),
                b"x"
            );
        }
        for response in [
            &b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nx"[..],
            &b"HTTP/1.0 200 OK\r\nContent-Length: 1\r\n\r\nxy"[..],
            &b"HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n"[..],
            &b"HTTP/1.0 200 OK\r\nContent-Length: 1\r\ncontent-length: 1\r\n\r\nx"[..],
            &b"HTTP/1.0 200 OK\r\nContent-Length: +1\r\n\r\nx"[..],
            &b"HTTP/1.0 200 OK\r\nContent-Length : 2\r\n\r\nx"[..],
            &b"HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n"[..],
            &b"HTTP/1.0 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: identity\r\n\r\nx"[..],
            &b"HTTP/1.1 200 OK\r\n\r\nx"[..],
            &b"HTTP/1.0 200 OK\r\nConnection: keep-alive\r\n\r\nx"[..],
            &b"HTTP/1.0 200 OK\r\nContent-Length: 1\r\nx"[..],
            &b"NOT-HTTP 200 OK\r\nContent-Length: 1\r\n\r\nx"[..],
            &b"HTTP/1.0 200 OK\r\nX-Value: \0\r\n\r\nx"[..],
        ] {
            assert!(fetch_cdh_response(response.to_vec()).is_err());
        }
    }

    #[test]
    fn application_socket_delivers_two_mib_only_to_the_matching_peer_and_resource() {
        // The production endpoint stays fixed. This is the only test binding
        // that port, inside the isolated Linux test environment.
        let listener = TcpListener::bind("127.0.0.1:8006").unwrap();
        let body = vec![0xa5; MAX_APPLICATION_RESOURCE_BYTES];
        let mut response =
            format!("HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        response.extend_from_slice(&body);
        let server = cdh_response(listener, response);
        // Use the test process's real kernel credentials. Production config
        // validation separately restricts application identities to non-root.
        let client = ResourceClient {
            name: "app".to_owned(),
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
            resources: vec!["default/config/app".to_owned()],
        };
        for denied in [
            ResourceClient {
                uid: client.uid + 1,
                ..client.clone()
            },
            ResourceClient {
                gid: client.gid + 1,
                ..client.clone()
            },
        ] {
            let (mut caller, broker) = UnixStream::pair().unwrap();
            serve_resource_client(&denied, broker).unwrap();
            assert_eq!(caller.read(&mut [0]).unwrap(), 0);
        }
        let (mut caller, broker) = UnixStream::pair().unwrap();
        caller.write_all(b"GET default/volume/agent\n").unwrap();
        serve_resource_client(&client, broker).unwrap();
        assert_eq!(caller.read(&mut [0]).unwrap(), 0);

        let (mut caller, broker) = UnixStream::pair().unwrap();
        caller
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let broker = thread::spawn(move || serve_resource_client(&client, broker));
        caller.write_all(b"GET default/config/app\n").unwrap();
        let mut length = [0; 4];
        caller.read_exact(&mut length).unwrap();
        assert_eq!(u32::from_be_bytes(length) as usize, body.len());
        let mut received = vec![0; body.len()];
        caller.read_exact(&mut received).unwrap();
        assert!(received == body, "application resource bytes changed");
        assert_eq!(caller.read(&mut [0]).unwrap(), 0);
        broker.join().unwrap().unwrap();
        server.join().unwrap();
    }

    #[test]
    fn status_publication_permissions_under_private_umask() {
        const CHILD: &str = "NEBULA_STATUS_PERMISSION_CHILD";
        const ROOT: &str = "NEBULA_STATUS_PERMISSION_ROOT";
        const TEST: &str =
            "generic_storage::tests::status_publication_permissions_under_private_umask";
        if let Ok(stage) = std::env::var(CHILD) {
            let root = std::path::PathBuf::from(std::env::var_os(ROOT).unwrap());
            let status = root.join("status.json");
            let key = root.join("volume.key");
            if stage == "reader" {
                assert_eq!(unsafe { libc::geteuid() }, 10001);
                assert_eq!(unsafe { libc::getegid() }, 10001);
                assert_eq!(unsafe { libc::getgroups(0, std::ptr::null_mut()) }, 0);
                assert_eq!(fs::read(&status).unwrap(), b"{\"phase\":\"ready\"}");
                assert_eq!(
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&status)
                        .unwrap_err()
                        .kind(),
                    std::io::ErrorKind::PermissionDenied
                );
                assert_eq!(
                    fs::remove_file(&status).unwrap_err().kind(),
                    std::io::ErrorKind::PermissionDenied
                );
                assert_eq!(
                    fs::read(&key).unwrap_err().kind(),
                    std::io::ErrorKind::PermissionDenied
                );
                return;
            }
            assert_eq!(stage, "writer");
            assert_eq!(unsafe { libc::geteuid() }, 0);
            // This is a dedicated subprocess: no parallel Rust test observes
            // a changed process-wide mask or UID.
            unsafe { libc::umask(0o077) };
            write_new(&key, b"private-test-key", 0o600).unwrap();
            write_status(&status, b"{\"phase\":\"ready\"}").unwrap();
            let public = fs::metadata(&status).unwrap();
            assert_eq!(public.uid(), 0);
            assert_eq!(public.mode() & 0o7777, 0o444);
            assert_eq!(fs::metadata(&key).unwrap().mode() & 0o7777, 0o600);
            let mut reader = Command::new(std::env::current_exe().unwrap());
            reader
                .args(["--exact", TEST, "--nocapture"])
                .env(CHILD, "reader");
            unsafe {
                reader.pre_exec(|| {
                    if libc::setgroups(0, std::ptr::null()) != 0
                        || libc::setgid(10001) != 0
                        || libc::setuid(10001) != 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            assert!(reader.status().unwrap().success());
            return;
        }
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "nebula-status-permissions-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, Permissions::from_mode(0o755)).unwrap();
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "writer")
            .env(ROOT, &root)
            .status();
        fs::remove_dir_all(root).unwrap();
        assert!(result.unwrap().success());
    }

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
