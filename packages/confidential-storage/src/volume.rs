//! Fixed encrypted data volume; no storage key API and no disk discovery.
use crate::device::OwnedDevice;
use crate::{
    keyslots::Layout,
    lifecycle::{Exit, Format},
};
use anyhow::{bail, ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::os::unix::process::CommandExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{FileTypeExt, OpenOptionsExt},
    },
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub(crate) const DISK: &str = "/dev/coco-data";
pub(crate) const KEY_PIPE: &str = "/dev/coco-key-pipe";
const MAX_OUTPUT: usize = 64 * 1024;

/// One immutable profile from the measured storage configuration.
#[derive(Debug)]
pub(crate) struct Profile {
    pub bytes: u64,
    map: &'static str,
    mapped: &'static str,
    pub mount: &'static str,
    marker: &'static str,
    marker_prefix: &'static str,
}
impl Profile {
    /// A generic volume has fixed device/mount locations. The measured name
    /// makes device-mapper names unique across helpers in the same guest.
    pub(crate) fn generic(name: &str, bytes: u64) -> &'static Self {
        let keep = |value: String| -> &'static str { Box::leak(value.into_boxed_str()) };
        let map = keep(format!("nebula-{name}"));
        Box::leak(Box::new(Self {
            bytes,
            map,
            mapped: keep(format!("/dev/mapper/{map}")),
            mount: "/run/volume/data",
            marker: "/run/volume/data/coco-volume-marker",
            marker_prefix: "coco-encrypted-volume-v1:",
        }))
    }
}

pub(crate) fn discover() -> Result<()> {
    let checked = || -> Result<()> {
        for (name, expected) in [("sev-guest", "10:258"), ("device-mapper", "10:236")] {
            ensure!(
                fs::read_to_string(format!("/sys/class/misc/{name}/dev"))?.trim() == expected,
                "guest {name} device tuple changed"
            );
        }
        Ok(())
    };
    checked().context(crate::native::DevicePrerequisite)?;
    println!("guest SNP and device-mapper tuples confirmed");
    Ok(())
}

// Never put keys into argv, env, disk files, stdout or captured diagnostics.
pub(crate) fn crypt(disk: &OwnedDevice, args: &[&str], key: Option<&[u8; 32]>) -> Result<bool> {
    Ok(crypt_status(disk, args, key)? == 0)
}

pub(crate) fn crypt_status(
    disk: &OwnedDevice,
    args: &[&str],
    key: Option<&[u8; 32]>,
) -> Result<i32> {
    Ok(crypt_run(disk, args, key, None, false, None)?.0)
}

// A key named by KEY_PIPE reaches cryptsetup through its own pipe, not stdin.
// Captured stdout is bounded LUKS metadata, never key material. Past the
// deadline cryptsetup is killed and reaped; without one it runs to completion.
pub(crate) fn crypt_run(
    disk: &OwnedDevice,
    args: &[&str],
    key: Option<&[u8; 32]>,
    piped: Option<&[u8; 32]>,
    capture: bool,
    deadline: Option<Instant>,
) -> Result<(i32, Vec<u8>)> {
    ensure!(
        piped.is_some() == args.contains(&KEY_PIPE),
        "piped key requires exactly its own pipe argument"
    );
    // On an empty stdin read luksKillSlot skips its passphrase check and wipes.
    ensure!(
        args.first() != Some(&"luksKillSlot")
            || (key.is_none()
                && args.windows(2).any(|v| v == ["--key-file", KEY_PIPE])
                && args.windows(2).any(|v| v == ["--keyfile-size", "32"])),
        "luksKillSlot authenticates only through its key pipe"
    );
    ensure!(
        !expired(deadline),
        "cryptsetup deadline passed; nothing started"
    );
    let piped = piped.map(key_pipe).transpose()?;
    let path = format!("/proc/self/fd/{}", disk.as_raw_fd());
    let piped_path = piped
        .as_ref()
        .map(|pipe| format!("/proc/self/fd/{}", pipe.as_raw_fd()));
    let header = disk.header_fd();
    ensure!(
        header.is_none()
            || matches!(
                args.first().copied(),
                Some("open" | "luksDump" | "luksUUID" | "close")
            ),
        "pinned LUKS header is inspection/unlock only"
    );
    let mut fds = vec![disk.as_raw_fd()];
    fds.extend(piped.as_ref().map(AsRawFd::as_raw_fd));
    fds.extend(header);
    let mut command = Command::new("/usr/sbin/cryptsetup");
    // Closing addresses the active mapping only; no metadata is consulted.
    if let Some(fd) = header.filter(|_| args.first() != Some(&"close")) {
        command.args(["--header", &format!("/proc/self/fd/{fd}")]);
    }
    command
        .args(args.iter().map(|arg| match (*arg, &piped_path) {
            (DISK, _) => path.as_str(),
            (KEY_PIPE, Some(piped_path)) => piped_path.as_str(),
            (arg, _) => arg,
        }))
        .env_clear()
        .env("LC_ALL", "C")
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .stdin(if key.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if capture {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(if cfg!(test) {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    unsafe {
        command.pre_exec(move || {
            for fd in &fds {
                if libc::fcntl(*fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let mut child = command.spawn().context("start cryptsetup")?;
    drop(piped);
    let written = if let Some(key) = key {
        child
            .stdin
            .take()
            .context("key pipe unavailable")?
            .write_all(key)
    } else {
        Ok(())
    };
    let output = collect(&mut child, deadline);
    if output.is_err() {
        let _ = child.kill();
    }
    let status = child.wait()?;
    let output = output?;
    let code = status.code().context("cryptsetup terminated by signal")?;
    if code == 0 {
        written?;
    }
    Ok((code, output))
}

/// BLKGETSIZE64 on an open block device.
pub(crate) fn device_bytes(device: &impl AsRawFd) -> Result<u64> {
    let mut size = 0_u64;
    ensure!(
        unsafe { libc::ioctl(device.as_raw_fd(), 0x80081272_u64 as _, &mut size) } == 0,
        "disk size unavailable"
    );
    Ok(size)
}

fn expired(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|deadline| Instant::now() >= deadline)
}

// Nonblocking reads keep the deadline live while cryptsetup is silent. An
// unbounded call without output is left to the caller's blocking wait.
fn collect(child: &mut Child, deadline: Option<Instant>) -> Result<Vec<u8>> {
    let mut stdout = child.stdout.take();
    if let Some(pipe) = &stdout {
        let flags = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL) };
        ensure!(
            flags != -1
                && unsafe {
                    libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK)
                } != -1,
            "nonblocking output unavailable"
        );
    }
    let mut output = Vec::new();
    loop {
        if let Some(pipe) = &mut stdout {
            let mut bytes = [0; 4096];
            match pipe.read(&mut bytes) {
                Ok(0) => stdout = None,
                Ok(n) => {
                    ensure!(
                        output.len() + n <= MAX_OUTPUT,
                        "cryptsetup output limit exceeded"
                    );
                    output.extend_from_slice(&bytes[..n]);
                    continue;
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(e) => return Err(e.into()),
            }
        }
        if stdout.is_none() && (deadline.is_none() || child.try_wait()?.is_some()) {
            return Ok(output);
        }
        ensure!(
            !expired(deadline),
            "cryptsetup deadline exceeded; inspect before retry"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

// 32 bytes fit in an empty pipe. The writer closes before spawn, so the reader
// sees EOF and never a prompt; CLOEXEC is cleared only in the child.
fn key_pipe(key: &[u8; 32]) -> Result<File> {
    let mut fds = [-1; 2];
    ensure!(
        unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } == 0,
        "key pipe failed"
    );
    let read = unsafe { File::from_raw_fd(fds[0]) };
    unsafe { File::from_raw_fd(fds[1]) }.write_all(key)?;
    Ok(read)
}

fn command(program: &str, args: &[&str]) -> Result<()> {
    ensure!(
        Command::new(program)
            .args(args)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?
            .success(),
        "storage operation failed: {program}"
    );
    Ok(())
}

fn entirely_zero(reader: &mut impl Read, expected: u64) -> Result<bool> {
    let mut total = 0_u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        ensure!(
            crate::mount_handoff::SIGNAL.load(std::sync::atomic::Ordering::SeqCst) == 0,
            "storage initialization interrupted before formatting"
        );
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            ensure!(total == expected, "short disk read; refusing format");
            return Ok(true);
        }
        total += count as u64;
        ensure!(total <= expected, "disk size changed");
        if buffer[..count].iter().any(|v| *v != 0) {
            return Ok(false);
        }
    }
}

#[derive(Debug, PartialEq)]
enum Action {
    Create,
    Reopen,
}
fn action(luks: bool, blank: bool) -> Result<Action> {
    if luks {
        Ok(Action::Reopen)
    } else if blank {
        Ok(Action::Create)
    } else {
        bail!("nonblank unrecognized disk: refusing format")
    }
}

// Lifecycle mode formats only under STORAGE_FORMAT=allow: a denied release
// stops before the full-disk scan and before luksFormat (exit 6).
fn plan(luks: bool, format: Format, blank: impl FnOnce() -> Result<bool>) -> Result<Action> {
    if !luks && format == Format::Deny {
        return Err(anyhow::Error::from(Exit::FormatDenied)
            .context("disk is not LUKS2 and this release may not format"));
    }
    action(luks, !luks && blank()?)
}

// Multi-mount protection (D15) makes a second guest's mount fail while the
// first still updates the MMP block.
fn mkfs_args(profile: &Profile, mmp: bool) -> Vec<&str> {
    let mut args = vec!["-q", "-F"];
    if mmp {
        args.extend(["-O", "mmp", "-E", "mmp_update_interval=5"]);
    }
    args.push(profile.mapped);
    args
}

// mount(2) directly: MMP reports a lingering holder as EBUSY, which mount(8)
// folds into its generic exit status.
fn mount_ext4(profile: &Profile) -> std::io::Result<()> {
    let source = std::ffi::CString::new(profile.mapped)?;
    let target = std::ffi::CString::new(profile.mount)?;
    let flags = libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC;
    let fstype = c"ext4".as_ptr();
    match unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            fstype,
            flags,
            std::ptr::null(),
        )
    } {
        0 => Ok(()),
        _ => Err(std::io::Error::last_os_error()),
    }
}

fn retry_busy(
    mut attempt: impl FnMut() -> std::io::Result<()>,
    budget: Duration,
    pause: Duration,
    stopping: impl Fn() -> bool,
) -> Result<()> {
    let deadline = Instant::now() + budget;
    loop {
        match attempt() {
            Ok(()) => return Ok(()),
            Err(error)
                if error.raw_os_error() == Some(libc::EBUSY)
                    && Instant::now() + pause < deadline
                    && !stopping() =>
            {
                thread::sleep(pause)
            }
            Err(error) => return Err(error).context("volume mount failed"),
        }
    }
}

pub(crate) fn opened_status(
    created: bool,
    marker: &str,
    size: u64,
    layout: Option<&Layout>,
) -> serde_json::Value {
    let mut value = serde_json::json!({"role":"volume",
        "phase":if created {"created"}else{"reopened"},
        "formatted":created,"mounted":true,"marker_sha256":marker,
        "device_bytes":size,"base_key_exported":false});
    if let Some(layout) = layout {
        value["luks_uuid"] = layout.uuid.clone().into();
        value["keyslots"] = serde_json::json!({"occupied": layout.occupied, "own": layout.own});
    }
    value
}

pub(crate) struct ActiveVolume {
    profile: &'static Profile,
    pub(crate) disk: OwnedDevice,
    pub(crate) layout: Option<Layout>,
    open: bool,
    mounted: bool,
}
impl ActiveVolume {
    pub(crate) fn close(&mut self) -> Result<()> {
        if self.mounted {
            command("/usr/bin/umount", &[self.profile.mount])?;
            self.mounted = false;
        }
        if self.open {
            ensure!(
                crypt(&self.disk, &["close", self.profile.map], None)?,
                "mapping close failed"
            );
            self.open = false;
        }
        self.disk.sync_all()?;
        Ok(())
    }
}
impl Drop for ActiveVolume {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// Lifecycle mode: the format gate, MMP on create, the keyslot layout and a
/// bounded wait for a lingering holder's mount.
pub(crate) fn open_lifecycle(
    key: Zeroizing<[u8; 32]>,
    profile: &'static Profile,
    format: Format,
) -> Result<(Option<ActiveVolume>, serde_json::Value)> {
    open_with(key, profile, Some(format))
}

/// Every production open, including non-lifecycle modes, checks the exact
/// immutable metadata and encrypted keyslot bytes that cryptsetup will use.
pub(crate) fn prepare_unlock(disk: &mut OwnedDevice, deadline: Instant) -> Result<()> {
    ensure!(!expired(Some(deadline)), "LUKS inspection deadline passed");
    disk.pin_luks_header()?;
    crate::keyslots::validate(disk, deadline)
}

fn open_with(
    key: Zeroizing<[u8; 32]>,
    profile: &'static Profile,
    lifecycle: Option<Format>,
) -> Result<(Option<ActiveVolume>, serde_json::Value)> {
    let disk = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(DISK)
        .context("open explicit block device")?;
    ensure!(
        disk.metadata()?.file_type().is_block_device(),
        "explicit disk is not a block device"
    );
    let mut disk = OwnedDevice::open(disk)?;
    let size = device_bytes(&disk)?;
    ensure!(size == profile.bytes, "unexpected disk size");
    ensure!(
        !std::path::Path::new(profile.mapped).exists(),
        "mapping already exists"
    );
    fs::create_dir_all(profile.mount).context("create private mountpoint")?;
    let recognized = crypt_status(
        &disk,
        &["isLuks", "--type", "luks2", "--disable-locks", DISK],
        None,
    )?;
    // cryptsetup uses 1 for non-LUKS; permission/device/operational errors
    // must not be interpreted as a blank disk candidate.
    ensure!(
        recognized == 0 || recognized == 1,
        "LUKS header inspection failed: {recognized}"
    );
    let luks = recognized == 0;
    // A failed unlock, invalid header, unknown filesystem or partial format
    // can never reach luksFormat. The complete explicit disk must be zero.
    let chosen = plan(luks, lifecycle.unwrap_or(Format::Allow), || {
        entirely_zero(&mut disk, profile.bytes)
    })?;
    if chosen == Action::Create {
        ensure!(
            crypt(
                &disk,
                &[
                    "luksFormat",
                    "--type",
                    "luks2",
                    "--batch-mode",
                    "--cipher",
                    "aes-xts-plain64",
                    "--key-size",
                    "512",
                    "--pbkdf",
                    "pbkdf2",
                    "--pbkdf-force-iterations",
                    "1000",
                    "--hash",
                    "sha256",
                    "--disable-locks",
                    "--key-file",
                    "-",
                    DISK
                ],
                Some(&key)
            )?,
            "initial LUKS creation failed; do not retry format"
        );
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    prepare_unlock(&mut disk, deadline)?;
    let opened = crypt_run(
        &disk,
        &[
            "open",
            "--type",
            "luks2",
            "--disable-locks",
            "--disable-keyring",
            "--key-file",
            "-",
            DISK,
            profile.map,
        ],
        Some(&key),
        None,
        false,
        Some(deadline),
    )?
    .0;
    if opened != 0 {
        drop(key);
        ensure!(
            chosen == Action::Reopen && opened == 2,
            "unexpected LUKS open failure: {opened}"
        );
        Ok((
            None,
            serde_json::json!({"role":"volume", "phase":"unlock-denied",
            "cryptsetup_exit_code":opened,"formatted":false,"mounted":false}),
        ))
    } else {
        let mut active = ActiveVolume {
            profile,
            disk,
            layout: None,
            open: true,
            mounted: false,
        };
        if lifecycle.is_some() {
            active.layout = Some(crate::keyslots::layout(&active.disk, &key, deadline)?);
        }
        drop(key);
        if chosen == Action::Create {
            command(
                "/usr/sbin/mkfs.ext4",
                &mkfs_args(profile, lifecycle.is_some()),
            )?;
        }
        if lifecycle.is_some() {
            retry_busy(
                || mount_ext4(profile),
                Duration::from_secs(120),
                Duration::from_secs(5),
                crate::lifecycle::stopping,
            )?;
        } else {
            command(
                "/usr/bin/mount",
                &[
                    "-t",
                    "ext4",
                    "-o",
                    "nosuid,nodev,noexec",
                    profile.mapped,
                    profile.mount,
                ],
            )?;
        }
        active.mounted = true;
        if chosen == Action::Create {
            let mut random = Zeroizing::new([0; 32]);
            File::open("/dev/urandom")?.read_exact(&mut *random)?;
            let mut content = profile.marker_prefix.as_bytes().to_vec();
            content.extend_from_slice(hex::encode(random.as_slice()).as_bytes());
            let mut marker = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(profile.marker)?;
            marker.write_all(&content)?;
            marker.sync_all()?;
            File::open(profile.mount)?.sync_all()?;
        }
        // Missing or malformed existing marker is an error, never initialization.
        let mut marker = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(profile.marker)?;
        ensure!(
            marker.metadata()?.is_file()
                && marker.metadata()?.len() == (profile.marker_prefix.len() + 64) as u64,
            "invalid existing marker"
        );
        let mut content = Vec::new();
        marker.read_to_end(&mut content)?;
        ensure!(
            content.starts_with(profile.marker_prefix.as_bytes()),
            "marker mismatch"
        );
        ensure!(
            content[profile.marker_prefix.len()..]
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)),
            "invalid marker encoding"
        );
        let digest = hex::encode(Sha256::digest(&content));
        // An open file pins this mount: close it before unmounting.
        drop(marker);
        let status = opened_status(
            chosen == Action::Create,
            &digest,
            size,
            active.layout.as_ref(),
        );
        Ok((Some(active), status))
    }
}

#[cfg(test)]
mod tests {

    use super::*;
    #[test]
    fn entire_disk_scan_rejects_nonzero_tail_and_read_errors() {
        assert!(entirely_zero(&mut &vec![0; 131073][..], 131073).unwrap());
        assert!(entirely_zero(&mut &[0_u8; 8][..], 16).is_err());
        let mut data = vec![0; 131073];
        data[131072] = 1;
        assert!(!entirely_zero(&mut &data[..], 131073).unwrap());
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("disk error"))
            }
        }
        assert!(entirely_zero(&mut Broken, 131073).is_err());
    }
    // Refusals happen before spawn: cryptsetup would accept these arguments.
    fn memfd() -> OwnedDevice {
        let fd = unsafe { libc::memfd_create(c"crypt-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(fd >= 0);
        OwnedDevice::open(unsafe { File::from_raw_fd(fd) }).unwrap()
    }
    #[test]
    fn a_piped_key_needs_its_own_pipe_argument() {
        for (args, piped) in [
            (&["luksAddKey", DISK][..], Some(&[8; 32])),
            (&["luksAddKey", "--new-keyfile", KEY_PIPE, DISK][..], None),
        ] {
            let error = crypt_run(&memfd(), args, Some(&[7; 32]), piped, false, None).unwrap_err();
            assert!(error.to_string().contains("piped key"), "{error}");
        }
    }
    #[test]
    fn kill_slot_authenticates_only_through_its_key_pipe() {
        let key = Some(&[7; 32]);
        for (credential, stdin, piped) in [
            (&["--key-file", "-", "--keyfile-size", "32"][..], key, None),
            (&[][..], None, None),
            (&["--key-file", KEY_PIPE][..], None, key),
            (
                &["--key-file", KEY_PIPE, "--keyfile-size", "32"][..],
                key,
                key,
            ),
            (
                &["--new-keyfile", KEY_PIPE, "--keyfile-size", "32"][..],
                None,
                key,
            ),
        ] {
            let args = [
                &["luksKillSlot", "--disable-locks"],
                credential,
                &[DISK, "1"],
            ]
            .concat();
            let error = crypt_run(&memfd(), &args, stdin, piped, false, None).unwrap_err();
            assert!(
                error.to_string().contains("luksKillSlot"),
                "{args:?}: {error}"
            );
        }
    }
    #[test]
    fn an_expired_deadline_starts_no_command() {
        let args = ["isLuks", "--type", "luks2", "--disable-locks", DISK];
        let deadline = Some(std::time::Instant::now());
        let error = crypt_run(&memfd(), &args, None, None, false, deadline).unwrap_err();
        assert!(error.to_string().contains("nothing started"), "{error}");
    }
    #[test]
    fn state_machine_never_formats_recognized_or_nonblank_media() {
        assert_eq!(action(false, true).unwrap(), Action::Create);
        assert_eq!(action(true, false).unwrap(), Action::Reopen);
        assert!(action(false, false).is_err());
    }
    #[test]
    fn a_denied_format_stops_before_the_scan_and_luks_format() {
        let exit = crate::lifecycle::exit_code;
        let never = || -> Result<bool> { panic!("scanned a disk this release may not format") };
        assert_eq!(exit(&plan(false, Format::Deny, never).unwrap_err()), 6);
        assert_eq!(plan(true, Format::Deny, never).unwrap(), Action::Reopen);
        assert_eq!(plan(true, Format::Allow, never).unwrap(), Action::Reopen);
        assert_eq!(
            plan(false, Format::Allow, || Ok(true)).unwrap(),
            Action::Create
        );
        assert_eq!(
            exit(&plan(false, Format::Allow, || Ok(false)).unwrap_err()),
            1
        );
        assert_eq!(
            exit(&plan(false, Format::Allow, || bail!("read error")).unwrap_err()),
            1
        );
    }
    #[test]
    fn only_lifecycle_creates_ext4_with_multi_mount_protection() {
        let mapped = "/dev/mapper/nebula-data";
        assert_eq!(
            mkfs_args(Profile::generic("data", 1024 * 1024 * 1024), false),
            ["-q", "-F", mapped]
        );
        assert_eq!(
            mkfs_args(Profile::generic("data", 1024 * 1024 * 1024), true),
            [
                "-q",
                "-F",
                "-O",
                "mmp",
                "-E",
                "mmp_update_interval=5",
                mapped
            ]
        );
    }
    #[test]
    fn a_busy_mount_is_retried_only_within_its_budget() {
        let busy = || Err(std::io::Error::from_raw_os_error(libc::EBUSY));
        let started = Instant::now();
        let mut attempts = 0;
        let error = retry_busy(
            || {
                attempts += 1;
                busy()
            },
            Duration::from_millis(100),
            Duration::from_millis(10),
            || false,
        )
        .unwrap_err();
        assert_eq!(crate::lifecycle::exit_code(&error), 1);
        assert!(
            attempts >= 3 && started.elapsed() < Duration::from_secs(2),
            "{attempts}"
        );
        let mut attempts = 0;
        retry_busy(
            || {
                attempts += 1;
                if attempts < 3 {
                    busy()
                } else {
                    Ok(())
                }
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
            || false,
        )
        .unwrap();
        assert_eq!(attempts, 3);
        let mut attempts = 0;
        assert!(retry_busy(
            || {
                attempts += 1;
                Err(std::io::Error::from_raw_os_error(libc::EINVAL))
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
            || false,
        )
        .is_err());
        assert_eq!(attempts, 1);
        // SIGTERM ends the wait at once.
        let mut attempts = 0;
        assert!(retry_busy(
            || {
                attempts += 1;
                busy()
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
            || true,
        )
        .is_err());
        assert_eq!(attempts, 1);
    }
    #[test]
    fn lifecycle_open_adds_only_the_luks_uuid_and_keyslots() {
        let marker = "d".repeat(64);
        let legacy = opened_status(
            false,
            &marker,
            Profile::generic("data", 1024 * 1024 * 1024).bytes,
            None,
        );
        assert_eq!(
            legacy,
            serde_json::json!({"role":"volume", "phase":"reopened", "formatted":false,
                "mounted":true, "marker_sha256":marker, "device_bytes":Profile::generic("data", 1024 * 1024 * 1024).bytes,
                "base_key_exported":false})
        );
        assert_eq!(
            opened_status(
                true,
                &marker,
                Profile::generic("data", 1024 * 1024 * 1024).bytes,
                None
            )["phase"],
            "created"
        );
        let layout = Layout {
            uuid: "e25ab20d-0590-4c57-82bc-ed999b9b54a7".into(),
            occupied: vec![0, 1],
            own: 1,
        };
        let lifecycle = opened_status(
            false,
            &marker,
            Profile::generic("data", 1024 * 1024 * 1024).bytes,
            Some(&layout),
        );
        let mut added = lifecycle.as_object().unwrap().clone();
        for (key, value) in legacy.as_object().unwrap() {
            assert_eq!(added.remove(key).as_ref(), Some(value), "{key}");
        }
        assert_eq!(
            serde_json::Value::Object(added),
            serde_json::json!({"luks_uuid": layout.uuid,
                "keyslots": {"occupied": [0, 1], "own": 1}})
        );
    }
}
