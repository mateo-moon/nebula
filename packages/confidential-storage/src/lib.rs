//! Encrypted block storage and mount leases for measured Nebula PodVMs.
#[cfg(target_os = "linux")]
mod device;
mod generic_config;
#[cfg(target_os = "linux")]
mod generic_storage;
#[cfg(target_os = "linux")]
mod keyslots;
#[cfg(target_os = "linux")]
mod lifecycle;
#[cfg(target_os = "linux")]
mod mount_handoff;
#[cfg(target_os = "linux")]
mod native;
#[cfg(target_os = "linux")]
mod runtime;
#[cfg(target_os = "linux")]
mod volume;
#[cfg(target_os = "linux")]
pub use lifecycle::exit_code;
#[cfg(target_os = "linux")]
pub use runtime::run;
