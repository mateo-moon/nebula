//! Generic-guest activation component. Not enabled in the prototype's boot units:
//! authenticated authority enrollment/transport and PCR15 hardware qualification
//! must exist before a generic release can call this and start Kata.
use crate::workload::{self, Envelope, Expectation, Owners, Verified};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use sha2::{Digest, Sha384};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    process::Stdio,
    time::Duration,
};

pub const DIRECTORY: &str = "/run/nebula/workload";
pub const POLICY: &str = "/run/nebula/workload/policy.rego";

/// Only successful policy installation AND confirmed measurement can produce
/// this result. It is not a key-service authorization or a quorum read barrier.
pub struct ActiveWorkload {
    verified: Verified,
}
impl ActiveWorkload {
    pub fn verified(&self) -> &Verified {
        &self.verified
    }
}

#[async_trait]
trait Pcr {
    async fn read(&mut self) -> Result<[u8; 48]>;
    async fn extend(&mut self, digest: [u8; 48]) -> Result<()>;
}

struct HardwarePcr<'a> {
    directory: &'a Path,
}

async fn command(tool: &str, args: &[&std::ffi::OsStr]) -> Result<()> {
    let status = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(tool)
            .args(["-T", "device:/dev/tpmrm0", "-Q"])
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await??;
    ensure!(status.success(), "TPM measurement command failed");
    Ok(())
}

#[async_trait]
impl Pcr for HardwarePcr<'_> {
    async fn read(&mut self) -> Result<[u8; 48]> {
        let temporary = tempfile::tempdir_in(self.directory)?;
        let output = temporary.path().join("pcr");
        command(
            "/usr/bin/tpm2_pcrread",
            &["sha384:15".as_ref(), "-o".as_ref(), output.as_os_str()],
        )
        .await?;
        ensure!(fs::metadata(&output)?.len() == 48, "unexpected PCR output");
        fs::read(output)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid PCR length"))
    }
    async fn extend(&mut self, digest: [u8; 48]) -> Result<()> {
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        command(
            "/usr/bin/tpm2_pcrextend",
            &[format!("15:sha384={hex}").as_ref()],
        )
        .await
    }
}

/// `owners` and `expected` MUST come from the evidence-authenticated authority
/// and accepted owner lineage. Reading them from the same untrusted envelope,
/// a ConfigMap, annotation or unauthenticated endpoint would defeat this check.
/// This function deliberately offers no CLI/config-file shortcut to that trust.
pub async fn activate(
    envelope: &Envelope,
    owners: &Owners,
    expected: &Expectation,
) -> Result<ActiveWorkload> {
    let directory = Path::new(DIRECTORY);
    crate::require_memory_directory(directory)?;
    activate_checked(
        directory,
        &mut HardwarePcr { directory },
        envelope,
        owners,
        expected,
    )
    .await
}

async fn activate_checked(
    directory: &Path,
    pcr: &mut impl Pcr,
    envelope: &Envelope,
    owners: &Owners,
    expected: &Expectation,
) -> Result<ActiveWorkload> {
    // Authentication precedes any filesystem or PCR mutation.
    let verified = workload::verify(envelope, owners, expected)?;
    // One attempt per boot. Crash, ambiguous extension or file substitution
    // requires a new VM boot; never reset/extend again to manufacture readiness.
    let mut started = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join(".activation-started"))?;
    started.write_all(verified.descriptor_sha384.as_bytes())?;
    started.sync_all()?;
    ensure!(pcr.read().await? == [0; 48], "PCR15 already used");
    let destination = directory.join("policy.rego");
    let mut policy = tempfile::NamedTempFile::new_in(directory)?;
    policy.write_all(verified.descriptor.policy.as_bytes())?;
    policy.as_file().sync_all()?;
    policy.persist_noclobber(&destination)?;
    // Measure the bytes actually installed for Kata, not an independently
    // parsed or controller-reported policy value.
    ensure!(
        fs::read(&destination)? == verified.descriptor.policy.as_bytes(),
        "installed policy mismatch"
    );
    let payload = verified.descriptor.encode()?;
    let measurement: [u8; 48] = Sha384::digest(payload).into();
    let expected_pcr: [u8; 48] = Sha384::new()
        .chain_update([0; 48])
        .chain_update(measurement)
        .finalize()
        .into();
    // Even a lost response is a failed activation. No caller can mistake an
    // unconfirmed result for permission to start the agent or retrieve secrets.
    pcr.extend(measurement).await?;
    ensure!(
        pcr.read().await? == expected_pcr,
        "workload measurement not confirmed"
    );
    Ok(ActiveWorkload { verified })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workload::tests::fixture;

    struct MemoryPcr {
        value: [u8; 48],
        writes: usize,
        fail: bool,
        wrong: bool,
    }
    impl Default for MemoryPcr {
        fn default() -> Self {
            Self {
                value: [0; 48],
                writes: 0,
                fail: false,
                wrong: false,
            }
        }
    }
    #[async_trait]
    impl Pcr for MemoryPcr {
        async fn read(&mut self) -> Result<[u8; 48]> {
            Ok(self.value)
        }
        async fn extend(&mut self, digest: [u8; 48]) -> Result<()> {
            self.writes += 1;
            self.value = Sha384::new()
                .chain_update(self.value)
                .chain_update(digest)
                .finalize()
                .into();
            if self.wrong {
                self.value[0] ^= 1;
            }
            ensure!(!self.fail, "injected lost TPM reply");
            Ok(())
        }
    }
    #[tokio::test]
    async fn exact_policy_is_installed_and_measured_once_before_activation() {
        let directory = tempfile::tempdir().unwrap();
        let (envelope, owners, expected) = fixture();
        let mut pcr = MemoryPcr::default();
        let active = activate_checked(directory.path(), &mut pcr, &envelope, &owners, &expected)
            .await
            .unwrap();
        assert_eq!(
            fs::read(directory.path().join("policy.rego")).unwrap(),
            active.verified().descriptor.policy.as_bytes()
        );
        assert_eq!(pcr.writes, 1);
        assert!(
            activate_checked(directory.path(), &mut pcr, &envelope, &owners, &expected)
                .await
                .is_err()
        );
        assert_eq!(pcr.writes, 1);
    }
    #[tokio::test]
    async fn bad_signature_never_installs_policy_or_mutates_pcr() {
        let directory = tempfile::tempdir().unwrap();
        let (mut envelope, owners, expected) = fixture();
        envelope.signatures.clear();
        let mut pcr = MemoryPcr::default();
        assert!(
            activate_checked(directory.path(), &mut pcr, &envelope, &owners, &expected)
                .await
                .is_err()
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
        assert_eq!(pcr.writes, 0);
    }
    #[tokio::test]
    async fn used_pcr_missing_confirmation_and_lost_reply_never_activate_or_retry() {
        let (envelope, owners, expected) = fixture();
        for mut pcr in [
            MemoryPcr {
                value: [1; 48],
                ..Default::default()
            },
            MemoryPcr {
                fail: true,
                ..Default::default()
            },
            MemoryPcr {
                wrong: true,
                ..Default::default()
            },
        ] {
            let directory = tempfile::tempdir().unwrap();
            assert!(
                activate_checked(directory.path(), &mut pcr, &envelope, &owners, &expected)
                    .await
                    .is_err()
            );
            let writes = pcr.writes;
            assert!(
                activate_checked(directory.path(), &mut pcr, &envelope, &owners, &expected)
                    .await
                    .is_err()
            );
            assert_eq!(pcr.writes, writes);
        }
    }
    #[tokio::test]
    async fn existing_policy_and_symlink_cannot_replace_the_signed_bytes() {
        let (envelope, owners, expected) = fixture();
        for link in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("policy.rego");
            if link {
                std::os::unix::fs::symlink("/not-written", &path).unwrap();
            } else {
                fs::write(&path, b"old-policy").unwrap();
            }
            let mut pcr = MemoryPcr::default();
            assert!(
                activate_checked(directory.path(), &mut pcr, &envelope, &owners, &expected)
                    .await
                    .is_err()
            );
            assert_eq!(pcr.writes, 0);
            if link {
                assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
            } else {
                assert_eq!(fs::read(path).unwrap(), b"old-policy");
            }
        }
    }
}
