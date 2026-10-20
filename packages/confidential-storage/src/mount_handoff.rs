//! Measured-recipient mount leases. No path, device or key is accepted from a client.
use anyhow::{bail, ensure, Context, Result};
use std::{
    ffi::CString,
    fs,
    io::{Read, Write},
    mem,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Command, Stdio},
    sync::atomic::{AtomicI32, Ordering},
    thread,
    time::{Duration, Instant},
};

const MAGIC: &[u8; 4] = b"CM01";
const SYS_ADMIN: u64 = 1 << 21;
pub(crate) static SIGNAL: AtomicI32 = AtomicI32::new(0);

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

/// Terminate every other process in this container's PID namespace. The client
/// supervisor only waits for its direct child, but a client such as `sshd`
/// leaves per-connection children behind that still hold handed-over mounts.
fn stop_namespace_clients() {
    unsafe { libc::kill(-1, libc::SIGTERM) };
    thread::sleep(Duration::from_millis(500));
    unsafe { libc::kill(-1, libc::SIGKILL) };
    thread::sleep(Duration::from_millis(500));
}

pub(crate) fn launch_generic(
    config: &crate::generic_config::Launcher,
    args: &[String],
) -> Result<()> {
    ensure!(
        !args.is_empty() && args[0].starts_with('/'),
        "explicit client program required"
    );
    // Target directories must be part of the measured image; never follow a
    // symlink supplied by an application or a storage export.
    for mount in &config.mounts {
        let target = std::path::Path::new(&mount.path);
        ensure!(
            fs::canonicalize(target)? == target && fs::symlink_metadata(target)?.is_dir(),
            "mount target must be an existing real directory in the image"
        );
    }
    signals()?;
    // The measured Pod's fsGroup permits shared Memory volumes. Drop group 0,
    // and retain only this explicit group in the capability-free child.
    startup_credentials(config.uid, config.gid, &[10001])?;
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
    let mut command = Command::new(&args[0]);
    command.args(&args[1..]).stdin(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            set_caps(0)?;
            check(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) as _)?;
            check(libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) as _)?;
            Ok(())
        });
    }
    let mut child = command.spawn().context("client start failed")?;
    println!(
        "{}",
        serde_json::json!({"phase":"client-started", "role":name,
        "uid":uid, "all_child_capabilities_dropped":true, "no_new_privileges":true})
    );
    let mut stopping = None;
    let mut lease_failed = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        let mut stop_requested = false;
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
        if (stop_requested || SIGNAL.load(Ordering::SeqCst) != 0) && stopping.is_none() {
            let sent = unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            if sent != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                // Do not leave a child running if signalling it failed.
                let _ = child.kill();
                let _ = child.wait();
                bail!("client graceful shutdown could not be requested");
            }
            stopping = Some(Instant::now());
        }
        if stopping.is_some_and(|start| start.elapsed() > grace) {
            child.kill()?;
            let _ = child.wait();
            bail!("client graceful shutdown timed out");
        }
        thread::sleep(Duration::from_millis(100));
    };
    // The direct child is gone, but its descendants may still hold the mount.
    // Stop them, then release with bounded retries, and always answer the
    // supervisor: an unexplained lease end takes the whole guest down.
    stop_namespace_clients();
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
    // A failed or forcibly terminated client must never claim a clean handover.
    let clean = status.success() && !lease_failed && released;
    for lease in &mut leases {
        lease.stream.write_all(if clean { b"D" } else { b"F" })?;
    }
    println!(
        "{}",
        serde_json::json!({"phase":"client-unmounted", "role":name,
        "client_success":status.success(), "termination_requested":stopping.is_some(),
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
}
