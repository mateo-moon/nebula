use anyhow::{ensure, Result};
use std::fs;

/// A fixed guest-device prerequisite is absent or inconsistent. Replacing the
/// guest without repairing host/device provisioning cannot fix this condition.
/// It is not an attestation verdict and never permits a fallback key or device.
#[derive(Debug)]
pub struct DevicePrerequisite;
impl DevicePrerequisite {
    pub const EXIT_CODE: i32 = 8;
}
impl std::fmt::Display for DevicePrerequisite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("guest-device-prerequisite")
    }
}
impl std::error::Error for DevicePrerequisite {}

pub fn protect_process() -> Result<()> {
    let limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    ensure!(
        unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } == 0,
        "cannot disable core dumps"
    );
    ensure!(
        unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } == 0,
        "cannot disable process dumping"
    );
    ensure!(
        fs::read_to_string("/proc/swaps")?.lines().count() == 1,
        "guest swap must be disabled"
    );
    Ok(())
}
