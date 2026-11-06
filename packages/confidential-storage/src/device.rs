//! One cooperative device owner, held from opening through unmount and close.
//! A sealed in-guest LUKS header snapshot binds inspection to unlock. It does not
//! authenticate the backing payload or prevent rollback. Measured policy must
//! exclude other guest writers; flock cannot constrain the host.
use anyhow::{ensure, Result};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::fs::{FileTypeExt, OpenOptionsExt},
    },
};

// The supported LUKS2 layout puts its data segment at this fixed offset.
// Copy metadata AND encrypted keyslot material, not merely the JSON header.
pub(crate) const LUKS_HEADER_BYTES: u64 = 16 * 1024 * 1024;
const HEADER_SEALS: libc::c_int =
    libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;

pub struct OwnedDevice {
    file: File,
    header: Option<File>,
}

impl OwnedDevice {
    pub fn open(file: File) -> Result<Self> {
        let kind = file.metadata()?.file_type();
        ensure!(
            kind.is_block_device() || (cfg!(test) && kind.is_file()),
            "storage requires a block device"
        );
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
        ensure!(
            flags != -1 && flags & libc::O_ACCMODE == libc::O_RDWR,
            "writable device descriptor required"
        );
        // A distinct open description prevents a caller's dup from bypassing or
        // prolonging this lock. Reopening through proc pins the same inode.
        let owned = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_CLOEXEC)
            .open(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        ensure!(
            unsafe { libc::flock(owned.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "storage device is already owned"
        );
        Ok(Self {
            file: owned,
            header: None,
        })
    }

    pub fn sync_all(&self) -> io::Result<()> {
        self.file.sync_all()
    }

    /// Freeze the bounded header/keyslot area before inspecting or unlocking.
    /// Every subsequent cryptsetup read uses this same sealed, anonymous file.
    /// No plaintext volume key or SNP-derived passphrase is copied here.
    pub(crate) fn pin_luks_header(&mut self) -> Result<()> {
        ensure!(self.header.is_none(), "LUKS header already pinned");
        let fd = unsafe {
            libc::memfd_create(
                c"coco-luks-header".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        ensure!(fd >= 0, "LUKS header memory unavailable");
        let mut header = unsafe { File::from_raw_fd(fd) };
        // A distinct description starts at offset zero without moving the
        // owner's cursor or following a host-replaced device pathname.
        let source = File::open(format!("/proc/self/fd/{}", self.file.as_raw_fd()))?;
        ensure!(
            io::copy(&mut source.take(LUKS_HEADER_BYTES), &mut header)? == LUKS_HEADER_BYTES,
            "truncated LUKS header area"
        );
        ensure!(
            unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, HEADER_SEALS) } == 0
                && unsafe { libc::fcntl(fd, libc::F_GET_SEALS) } == HEADER_SEALS,
            "LUKS header sealing failed"
        );
        self.header = Some(header);
        Ok(())
    }

    pub(crate) fn header_fd(&self) -> Option<RawFd> {
        self.header.as_ref().map(AsRawFd::as_raw_fd)
    }
}

impl AsRawFd for OwnedDevice {
    fn as_raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }
}
impl Read for OwnedDevice {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.file.read(bytes)
    }
}
impl Drop for OwnedDevice {
    fn drop(&mut self) {
        unsafe { libc::flock(self.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;
    use std::os::unix::fs::FileExt;

    pub(crate) fn fixture() -> File {
        let fd = unsafe { libc::memfd_create(c"owned-device-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(fd >= 0);
        unsafe { File::from_raw_fd(fd) }
    }

    #[test]
    fn duplicate_descriptors_cannot_bypass_or_prolong_ownership() {
        let file = fixture();
        let owner = OwnedDevice::open(file.try_clone().unwrap()).unwrap();
        assert!(OwnedDevice::open(file.try_clone().unwrap()).is_err());
        drop(owner);
        drop(OwnedDevice::open(file.try_clone().unwrap()).unwrap());
        // The caller still holds its original descriptor throughout.
        assert!(file.metadata().unwrap().is_file());
    }

    #[test]
    fn refuses_read_only_descriptors_and_non_device_objects() {
        let file = fixture();
        let read_only = File::open(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap();
        assert!(OwnedDevice::open(read_only).is_err());
        assert!(OwnedDevice::open(File::open("/dev/null").unwrap()).is_err());
    }

    #[test]
    fn header_snapshot_is_bounded_sealed_and_independent_of_the_backing_device() {
        let file = fixture();
        file.set_len(LUKS_HEADER_BYTES + 4096).unwrap();
        file.write_all_at(b"original", 0).unwrap();
        let mut disk = OwnedDevice::open(file.try_clone().unwrap()).unwrap();
        disk.pin_luks_header().unwrap();
        let header = OpenOptions::new()
            .read(true)
            .write(true)
            .open(format!("/proc/self/fd/{}", disk.header_fd().unwrap()))
            .unwrap();
        assert_eq!(header.metadata().unwrap().len(), LUKS_HEADER_BYTES);
        file.write_all_at(b"replaced", 0).unwrap();
        let mut bytes = [0; 8];
        header.read_exact_at(&mut bytes, 0).unwrap();
        assert_eq!(&bytes, b"original");
        assert_eq!(
            header.write_at(b"changed!", 0).unwrap_err().raw_os_error(),
            Some(libc::EPERM)
        );
        assert!(header.set_len(0).is_err());
        assert!(header.set_len(LUKS_HEADER_BYTES + 1).is_err());
        assert!(disk.pin_luks_header().is_err());
    }

    #[test]
    fn truncated_header_does_not_become_a_snapshot() {
        let file = fixture();
        file.set_len(LUKS_HEADER_BYTES - 1).unwrap();
        let mut disk = OwnedDevice::open(file).unwrap();
        assert!(disk
            .pin_luks_header()
            .unwrap_err()
            .to_string()
            .contains("truncated"));
        assert!(disk.header_fd().is_none());
    }
}
