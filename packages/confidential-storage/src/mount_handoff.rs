//! Measured-recipient mount leases. No path, device or key is accepted from a client.
use anyhow::{bail, ensure, Context, Result};
use std::{
    ffi::CString,
    fs,
    io::{Read, Write},
    mem,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::MetadataExt, net::UnixStream, process::CommandExt},
    },
    process::{Command, Stdio},
    sync::atomic::{AtomicI32, Ordering},
    thread,
    time::{Duration, Instant},
};

const MAGIC: &[u8; 4] = b"CM01";
const SYS_ADMIN: u64 = 1 << 21;
pub(crate) static SIGNAL: AtomicI32 = AtomicI32::new(0);

/// Kubernetes receives only the stage's numeric exit code when guest
/// diagnostic retrieval is denied by the measured policy. No resource bytes or
/// application output are returned to the host.
#[derive(Clone, Copy, Debug)]
pub(crate) enum LauncherStage {
    Guard = 10,
    Owner = 11,
    Image = 12,
    Credentials = 13,
    Client = 14,
}
impl std::fmt::Display for LauncherStage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "launcher stage {}", *self as i32)
    }
}
impl std::error::Error for LauncherStage {}

fn check(result: libc::c_long) -> std::io::Result<libc::c_long> {
    if result == -1 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(result)
    }
}
extern "C" fn stop(signal: libc::c_int) {
    SIGNAL.store(signal, Ordering::SeqCst);
}
pub(crate) fn signals() -> Result<()> {
    for signal in [libc::SIGTERM, libc::SIGINT] {
        ensure!(
            unsafe { libc::signal(signal, stop as *const () as usize) } != libc::SIG_ERR,
            "signal handler failed"
        );
    }
    Ok(())
}

/// The peer's uid and gid as the kernel recorded them at connect time.
pub(crate) fn peer_credentials(stream: &UnixStream) -> Result<(u32, u32)> {
    let mut peer: libc::ucred = unsafe { mem::zeroed() };
    let mut length = mem::size_of::<libc::ucred>() as libc::socklen_t;
    check(unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut peer as *mut libc::ucred).cast(),
            &mut length,
        )
    } as _)?;
    ensure!(
        length as usize == mem::size_of::<libc::ucred>(),
        "unexpected peer credentials"
    );
    Ok((peer.uid, peer.gid))
}

/// An authenticated local caller has not received a mount lease yet. Keep one
/// bounded, nonblocking handshake per fixed role so a slow caller cannot stall
/// other recipients, storage heartbeats or signal handling.
pub(crate) struct PendingMount {
    stream: UnixStream,
    version: [u8; 4],
    received: usize,
    deadline: Instant,
}

impl PendingMount {
    pub(crate) fn new(stream: UnixStream, now: Instant) -> Result<Self> {
        stream.set_nonblocking(true)?;
        Ok(Self {
            stream,
            version: [0; 4],
            received: 0,
            deadline: now + Duration::from_secs(1),
        })
    }

    pub(crate) fn ready(&mut self, now: Instant) -> Result<bool> {
        ensure!(now < self.deadline, "mount request deadline exceeded");
        while self.received < MAGIC.len() {
            match self.stream.read(&mut self.version[self.received..]) {
                Ok(0) => bail!("mount request closed before handshake"),
                Ok(count) => self.received += count,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    return Ok(false)
                }
                Err(error) => return Err(error.into()),
            }
        }
        ensure!(&self.version == MAGIC, "unsupported mount protocol");
        Ok(true)
    }

    pub(crate) fn grant(mut self, directory: &str) -> Result<UnixStream> {
        ensure!(
            self.received == MAGIC.len() && &self.version == MAGIC,
            "mount request not ready"
        );
        // Errors after export starts are NOT retryable admission failures: a
        // descriptor might have escaped. The storage supervisor still fails
        // closed rather than risk granting a second lease for the same role.
        export_mount(&mut self.stream, directory)?;
        Ok(self.stream)
    }
}

fn export_mount(stream: &mut UnixStream, directory: &str) -> Result<()> {
    let path = CString::new(directory)?;
    // A detached clone exports this subtree only, with its nosuid/nodev/noexec flags.
    let fd = check(unsafe {
        libc::syscall(
            libc::SYS_open_tree,
            libc::AT_FDCWD,
            path.as_ptr(),
            1_u32 | libc::O_CLOEXEC as u32,
        )
    })?;
    let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    let mut iov = libc::iovec {
        iov_base: MAGIC.as_ptr() as *mut _,
        iov_len: MAGIC.len(),
    };
    let mut control = [0_usize; 4]; // aligned and large enough for exactly one descriptor
    let mut msg: libc::msghdr = unsafe { mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = unsafe { libc::CMSG_SPACE(mem::size_of::<i32>() as u32) } as _;
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&msg);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(mem::size_of::<i32>() as u32) as _;
        libc::CMSG_DATA(header).cast::<i32>().write(fd.as_raw_fd());
    }
    ensure!(
        check(unsafe { libc::sendmsg(stream.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) } as _)? == 4,
        "partial mount response"
    );
    Ok(())
}

fn receive_mount(stream: &mut UnixStream) -> Result<OwnedFd> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.write_all(MAGIC)?;
    let mut body = [0; 4];
    let mut iov = libc::iovec {
        iov_base: body.as_mut_ptr().cast(),
        iov_len: body.len(),
    };
    let mut control = [0_usize; 4];
    let mut msg: libc::msghdr = unsafe { mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = mem::size_of_val(&control) as _;
    let count = check(unsafe {
        libc::recvmsg(
            stream.as_raw_fd(),
            &mut msg,
            libc::MSG_CMSG_CLOEXEC | libc::MSG_WAITALL,
        )
    } as _)?;
    // Always take ownership of received descriptors before rejecting malformed input.
    let mut fds = Vec::new();
    let mut valid = true;
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&msg);
        while !header.is_null() {
            if (*header).cmsg_level != libc::SOL_SOCKET || (*header).cmsg_type != libc::SCM_RIGHTS {
                valid = false;
            } else {
                let bytes =
                    ((*header).cmsg_len as usize).saturating_sub(libc::CMSG_LEN(0) as usize);
                if !bytes.is_multiple_of(mem::size_of::<i32>()) {
                    valid = false;
                }
                for i in 0..bytes / mem::size_of::<i32>() {
                    fds.push(OwnedFd::from_raw_fd(
                        libc::CMSG_DATA(header).cast::<i32>().add(i).read(),
                    ));
                }
            }
            header = libc::CMSG_NXTHDR(&msg, header);
        }
    }
    ensure!(
        count == 4
            && &body == MAGIC
            && msg.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) == 0
            && valid
            && fds.len() == 1,
        "invalid mount response"
    );
    Ok(fds.pop().unwrap())
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}
fn set_caps(bits: u64) -> std::io::Result<()> {
    let header = CapHeader {
        version: 0x20080522,
        pid: 0,
    };
    let data = [
        CapData {
            effective: bits as u32,
            permitted: bits as u32,
            inheritable: 0,
        },
        CapData {
            effective: (bits >> 32) as u32,
            permitted: (bits >> 32) as u32,
            inheritable: 0,
        },
    ];
    check(unsafe { libc::syscall(libc::SYS_capset, &header, data.as_ptr()) })?;
    Ok(())
}

pub(crate) fn storage_credentials() -> Result<()> {
    // CHOWN, SYS_ADMIN and MKNOD only. In particular the native module cannot
    // change the firewall, impersonate an app UID or regain other capabilities.
    let keep = (1_u64 << 0) | (1_u64 << 21) | (1_u64 << 27);
    let last: u32 = fs::read_to_string("/proc/sys/kernel/cap_last_cap")?
        .trim()
        .parse()?;
    ensure!(
        last < 64 && unsafe { libc::getuid() } == 0,
        "invalid storage credentials"
    );
    for cap in 0..=last {
        if keep & (1_u64 << cap) == 0 {
            check(unsafe { libc::prctl(libc::PR_CAPBSET_DROP, cap, 0, 0, 0) } as _)?;
        }
    }
    set_caps(keep)?;
    check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } as _)?;
    Ok(())
}

fn startup_credentials(uid: u32, gid: u32, groups: &[u32]) -> Result<()> {
    ensure!(
        unsafe { libc::getuid() } == 0,
        "launcher must start with its fixed startup credentials"
    );
    let last: u32 = fs::read_to_string("/proc/sys/kernel/cap_last_cap")?
        .trim()
        .parse()?;
    ensure!(last < 64, "unsupported capability ABI");
    // Current permitted capabilities survive bounding-set removal until capset below.
    for cap in 0..=last {
        check(unsafe { libc::prctl(libc::PR_CAPBSET_DROP, cap, 0, 0, 0) } as _)?;
    }
    check(unsafe { libc::prctl(libc::PR_SET_KEEPCAPS, 1, 0, 0, 0) } as _)?;
    check(unsafe { libc::setgroups(groups.len(), groups.as_ptr()) } as _)?;
    check(unsafe { libc::setgid(gid) } as _)?;
    check(unsafe { libc::setuid(uid) } as _)?;
    set_caps(SYS_ADMIN)?;
    check(unsafe { libc::prctl(libc::PR_SET_KEEPCAPS, 0, 0, 0, 0) } as _)?;
    check(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } as _)?;
    // UID transitions can reset dumpability. Reapply after the transition.
    check(unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } as _)?;
    Ok(())
}

fn private_pid_init() -> Result<()> {
    // Never use namespace-wide signals from an ordinary host process, a joined
    // PID namespace, or a procfs mounted for a different namespace. Native OCI
    // policy independently requires this container's own PID namespace.
    ensure!(
        unsafe { libc::getpid() } == 1,
        "launcher must own its private PID namespace"
    );
    ensure!(
        fs::read_link("/proc/self")? == std::path::Path::new("1"),
        "launcher procfs namespace differs"
    );
    Ok(())
}

/// PID1 is the only supervisor. Its capability-free children keep the same
/// kernel UID, even across nested namespaces; no CAP_KILL is retained. Reap all
/// adopted descendants and require the namespace empty before another exec.
fn stop_namespace_clients() -> Result<()> {
    private_pid_init()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let gentle = Instant::now() + Duration::from_millis(500);
    unsafe { libc::kill(-1, libc::SIGTERM) };
    loop {
        loop {
            let result = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
            if result > 0 {
                continue;
            }
            ensure!(
                result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD),
                "descendant reap failed"
            );
            break;
        }
        let alive = fs::read_dir("/proc")?
            .filter_map(|entry| entry.ok())
            .any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.parse::<u32>().ok())
                    .is_some_and(|pid| pid > 1)
            });
        if !alive {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "application descendants did not stop"
        );
        if Instant::now() >= gentle {
            unsafe { libc::kill(-1, libc::SIGKILL) };
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub(crate) fn launch_generic(
    config: &crate::generic_config::Launcher,
    args: &[String],
) -> Result<()> {
    private_pid_init().context(LauncherStage::Credentials)?;
    // Only the trusted static launcher can report startup failures. The
    // application child gets no host-visible standard streams; a wrapper from
    // the application image must never run with the launcher's credentials.
    // A malicious kubelet may request a measured application before the
    // regular guard init container has completed. The trusted static launcher
    // must refuse to exec application code until the guest kernel boundary is
    // installed; the marker is in a root-owned guest tmpfs, mounted read-only.
    wait_marker(
        "/run/nebula-guard/installed",
        0,
        None,
        0o600,
        b"nebula-guest-guard-v1\n",
        Duration::from_secs(60),
    )
    .context(LauncherStage::Guard)?;
    wait_marker(
        "/run/nebula-owner-ready/ready",
        10001,
        Some(10001),
        0o640,
        b"nebula-owner-ready-v1\n",
        Duration::from_secs(1800),
    )
    .context(LauncherStage::Owner)?;
    ensure!(
        !args.is_empty() && args[0].starts_with('/'),
        "explicit client program required"
    );
    // Target directories must be part of the measured image; never follow a
    // symlink supplied by an application or a storage export.
    for mount in &config.mounts {
        let target = std::path::Path::new(&mount.path);
        ensure!(
            fs::canonicalize(target).context(LauncherStage::Image)? == target
                && fs::symlink_metadata(target)
                    .context(LauncherStage::Image)?
                    .is_dir(),
            "mount target must be an existing real directory in the image"
        );
    }
    signals()?;
    // The measured Pod's fsGroup permits shared Memory volumes. Drop group 0,
    // and retain only this explicit group in the capability-free child.
    startup_credentials(config.uid, config.gid, &[10001]).context(LauncherStage::Credentials)?;
    let mounts: Vec<_> = config
        .mounts
        .iter()
        .map(|m| (m.socket.as_str(), m.path.as_str()))
        .collect();
    supervise(
        "application",
        config.uid,
        Duration::from_secs(30),
        &mounts,
        args,
    )
    .context(LauncherStage::Client)
}

fn wait_marker(
    path: &str,
    uid: u32,
    gid: Option<u32>,
    mode: u32,
    contents: &[u8],
    timeout: Duration,
) -> Result<()> {
    let start = Instant::now();
    loop {
        match fs::symlink_metadata(path) {
            Ok(info) => {
                ensure!(
                    info.is_file()
                        && info.uid() == uid
                        && gid.is_none_or(|expected| info.gid() == expected)
                        && info.mode() & 0o7777 == mode
                        && info.len() == contents.len() as u64
                        && fs::read(path)? == contents,
                    "invalid guest readiness marker"
                );
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        ensure!(start.elapsed() < timeout, "guest readiness unavailable");
        thread::sleep(Duration::from_millis(100));
    }
}

struct MountLease {
    stream: UnixStream,
    target: CString,
    attached: bool,
}
impl MountLease {
    fn close(&mut self) -> Result<()> {
        if self.attached {
            check(unsafe { libc::umount2(self.target.as_ptr(), 0) } as _)?;
            self.attached = false;
        }
        Ok(())
    }
}
impl Drop for MountLease {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn supervise(
    name: &str,
    uid: u32,
    grace: Duration,
    mounts: &[(&str, &str)],
    args: &[String],
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(1800);
    let mut leases = Vec::new();
    for (socket, target) in mounts {
        let mut stream = loop {
            ensure!(
                SIGNAL.load(Ordering::SeqCst) == 0 && Instant::now() < deadline,
                "mount service unavailable"
            );
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                    ) =>
                {
                    thread::sleep(Duration::from_millis(250))
                }
                Err(error) => return Err(error.into()),
            }
        };
        let fd = receive_mount(&mut stream)?;
        let target = CString::new(*target)?;
        check(unsafe {
            libc::syscall(
                libc::SYS_move_mount,
                fd.as_raw_fd(),
                c"".as_ptr(),
                libc::AT_FDCWD,
                target.as_ptr(),
                4_u32,
            )
        })?;
        drop(fd);
        stream.set_nonblocking(true)?;
        leases.push(MountLease {
            stream,
            target,
            attached: true,
        });
    }
    supervise_leases(name, uid, grace, args, leases)
}

fn supervise_leases(
    name: &str,
    uid: u32,
    grace: Duration,
    args: &[String],
    mut leases: Vec<MountLease>,
) -> Result<()> {
    private_pid_init()?;
    let mut restarts = 0_u64;
    let mut consecutive = 0_u32;
    let mut lease_failed = false;
    'lifetime: loop {
        if SIGNAL.load(Ordering::SeqCst) != 0 {
            break;
        }
        for lease in &mut leases {
            let mut request = [0];
            match lease.stream.read(&mut request) {
                Ok(1) if request == *b"S" => break 'lifetime,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                _ => {
                    lease_failed = true;
                    break 'lifetime;
                }
            }
        }
        let mut command = Command::new(&args[0]);
        command
            .args(&args[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                set_caps(0)?;
                check(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) as _)?;
                check(libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) as _)?;
                Ok(())
            });
        }
        let mut child = command.spawn().context("client start failed")?;
        for lease in &mut leases {
            lease.stream.write_all(b"B")?;
        }
        println!(
            "{}",
            serde_json::json!({"phase":"client-started","role":name,"uid":uid,
            "restart_count":restarts,"all_child_capabilities_dropped":true,"no_new_privileges":true})
        );
        let started = Instant::now();
        let mut stopping = None;
        loop {
            if child.try_wait()?.is_some() {
                break;
            }
            let mut stop_requested = SIGNAL.load(Ordering::SeqCst) != 0;
            for lease in &mut leases {
                let mut request = [0];
                stop_requested |= match lease.stream.read(&mut request) {
                    Ok(1) if request == *b"S" => true,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
                    _ => {
                        lease_failed = true;
                        true
                    }
                };
            }
            if stop_requested && stopping.is_none() {
                let sent = unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
                if sent != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    bail!("client graceful shutdown could not be requested");
                }
                stopping = Some(Instant::now());
            }
            if stopping.is_some_and(|start| start.elapsed() > grace) {
                child.kill()?;
                let _ = child.wait();
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        stop_namespace_clients()?;
        if stopping.is_some() || SIGNAL.load(Ordering::SeqCst) != 0 || lease_failed {
            break;
        }
        for lease in &mut leases {
            lease.stream.write_all(b"X")?;
        }
        println!(
            "{}",
            serde_json::json!({"phase":"client-backoff","role":name,"restart_count":restarts.saturating_add(1)})
        );
        consecutive = if started.elapsed() >= Duration::from_secs(60) {
            0
        } else {
            consecutive.saturating_add(1)
        };
        let pause = Duration::from_millis(
            250_u64
                .saturating_mul(1_u64 << consecutive.min(7))
                .min(30_000),
        );
        let retry_at = Instant::now() + pause;
        while Instant::now() < retry_at {
            if SIGNAL.load(Ordering::SeqCst) != 0 {
                break 'lifetime;
            }
            for lease in &mut leases {
                let mut request = [0];
                match lease.stream.read(&mut request) {
                    Ok(1) if request == *b"S" => break 'lifetime,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    _ => {
                        lease_failed = true;
                        break 'lifetime;
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        restarts = restarts.saturating_add(1);
    }
    let release_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        for lease in leases.iter_mut().rev() {
            let _ = lease.close();
        }
        if leases.iter().all(|lease| !lease.attached) || Instant::now() >= release_deadline {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let released = leases.iter().all(|lease| !lease.attached);
    // Only this same trusted PID1, after reaping every child and unmounting, can
    // finish its original lease. Ordinary child failures never release/regrant it.
    let clean = !lease_failed && released;
    for lease in &mut leases {
        lease.stream.write_all(if clean { b"D" } else { b"F" })?;
    }
    println!(
        "{}",
        serde_json::json!({"phase":"client-unmounted", "role":name,
        "restart_count":restarts,"termination_requested":SIGNAL.load(Ordering::SeqCst) != 0,
        "mount_released":released})
    );
    ensure!(clean, "client failed or mount owner disappeared");
    Ok(())
}

#[cfg(test)]
#[path = "../tests/mount_admission.rs"]
mod admission_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_unattached_mount_is_already_released() {
        let (stream, _) = UnixStream::pair().unwrap();
        let mut lease = MountLease {
            stream,
            target: CString::new("/data").unwrap(),
            attached: false,
        };
        assert!(lease.close().is_ok());
    }

    #[test]
    fn launcher_refuses_missing_or_tampered_owner_readiness() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("nebula-owner-gate-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        let contents = b"nebula-owner-ready-v1\n";
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        assert!(wait_marker(
            path.to_str().unwrap(),
            uid,
            Some(gid),
            0o640,
            contents,
            Duration::from_millis(1)
        )
        .is_err());
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(wait_marker(
            path.to_str().unwrap(),
            uid,
            Some(gid),
            0o640,
            contents,
            Duration::from_millis(1)
        )
        .is_ok());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(wait_marker(
            path.to_str().unwrap(),
            uid,
            Some(gid),
            0o640,
            contents,
            Duration::from_millis(1)
        )
        .is_err());
        fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
#[path = "../tests/supervisor.rs"]
mod supervisor_tests;
