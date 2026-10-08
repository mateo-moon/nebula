//! Fixed local NitroTPM collector. Owner authorization crosses an anonymous
//! pipe only; the caller serializes it with the protected journal writer.
use super::*;
use crate::startup::Stage;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[async_trait::async_trait]
pub(crate) trait NitroSource: Send + Sync {
    async fn document(&self, request: NitroRequest) -> Result<Vec<u8>>;
}

pub(crate) struct NitroRequest {
    nonce: [u8; 32],
    public: Vec<u8>,
    binding: Vec<u8>,
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl NitroRequest {
    pub(crate) fn new(nonce: [u8; 32], public: Vec<u8>, binding: Vec<u8>) -> Result<Self> {
        ensure!(
            !public.is_empty()
                && public.len() <= 1024
                && !binding.is_empty()
                && binding.len() <= 1024,
            "invalid NitroTPM binding size"
        );
        Ok(Self {
            nonce,
            public,
            binding,
        })
    }

    pub(crate) fn document(&self, owner_auth: Option<&[u8; 32]>) -> Result<Vec<u8>> {
        let memory = Path::new("/run/nebula/evidence");
        crate::require_memory_directory(memory)?;
        self.execute(
            memory,
            owner_auth,
            Path::new("/usr/local/bin/nebula-nitro-tpm-attest"),
        )
    }

    fn execute(
        &self,
        memory: &Path,
        owner_auth: Option<&[u8; 32]>,
        program: &Path,
    ) -> Result<Vec<u8>> {
        let directory = tempfile::tempdir_in(memory)?;
        std::fs::write(directory.path().join("nonce"), self.nonce)?;
        std::fs::write(directory.path().join("public.der"), &self.public)?;
        std::fs::write(directory.path().join("binding.json"), &self.binding)?;
        // This file contains public attestation evidence only. No owner secret
        // is written to a file, an argument, an environment variable or a log.
        let mut output = tempfile::tempfile_in(directory.path())?;
        let mut command = Command::new(program);
        command.args([
            "--nonce",
            "nonce",
            "--public-key",
            "public.der",
            "--user-data",
            "binding.json",
        ]);
        if owner_auth.is_some() {
            command.arg("--owner-auth-stdin");
        }
        unsafe {
            command.pre_exec(|| {
                libc::umask(0o077);
                let core = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                let files = libc::rlimit {
                    rlim_cur: MAX_DOCUMENT as libc::rlim_t,
                    rlim_max: MAX_DOCUMENT as libc::rlim_t,
                };
                if libc::setrlimit(libc::RLIMIT_CORE, &core) != 0
                    || libc::setrlimit(libc::RLIMIT_FSIZE, &files) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = Running(
            command
                .current_dir(directory.path())
                .env_clear()
                .env("TSS2_LOG", "all+NONE")
                .env("LC_ALL", "C")
                .stdin(if owner_auth.is_some() {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(output.try_clone()?)
                .stderr(Stdio::null())
                .spawn()
                .context("cannot start fixed NitroTPM collector")?,
        );
        if let Some(auth) = owner_auth {
            let mut input = child.0.stdin.take().context("attester input unavailable")?;
            input
                .write_all(auth)
                .context("attester authentication input failed")?;
            // EOF is part of the exact 32-byte input contract.
            drop(input);
        }
        let start = Instant::now();
        loop {
            ensure!(
                start.elapsed() <= Duration::from_secs(10)
                    && output.metadata()?.len() <= MAX_DOCUMENT as u64,
                Stage::NitroTimeout
            );
            if let Some(status) = child.0.try_wait()? {
                if !status.success() {
                    let stage = match status.code() {
                        Some(64) => Stage::NitroEndorsement,
                        Some(65) => Stage::NitroBuffer,
                        Some(66) => Stage::NitroRequest,
                        Some(67) => Stage::NitroTss,
                        Some(68 | 69) => Stage::NitroResponse,
                        Some(70) => Stage::NitroEkHandles,
                        Some(71) => Stage::NitroEkDevice,
                        Some(72) => Stage::NitroEkPrimaryAuth,
                        Some(73) => Stage::NitroEkPersistAuth,
                        Some(74) => Stage::NitroEkAuth,
                        Some(75) => Stage::NitroEkLockout,
                        Some(76) => Stage::NitroEkObjectMemory,
                        Some(77) => Stage::NitroEkSessionMemory,
                        Some(78) => Stage::NitroEkMemory,
                        Some(79) => Stage::NitroEkHandle,
                        Some(80) => Stage::NitroEkPrimary,
                        Some(81) => Stage::NitroEkPersist,
                        Some(82) => Stage::NitroEkTss,
                        Some(83) => Stage::NitroEkWrapper,
                        Some(84) => Stage::NitroEkPublicKey,
                        Some(85) => Stage::NitroEkEncoding,
                        Some(86) => Stage::NitroEkParameters,
                        _ => Stage::NitroEvidence,
                    };
                    return Err(anyhow::anyhow!("NitroTPM evidence unavailable").context(stage));
                }
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        read_document(&mut output)
    }
}

fn read_document(output: &mut File) -> Result<Vec<u8>> {
    output.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::with_capacity(MAX_DOCUMENT + 1);
    output
        .take((MAX_DOCUMENT + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_DOCUMENT,
        "invalid NitroTPM output size"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn owner_auth_uses_stdin_only_and_collector_failures_do_not_echo_secrets() {
        // Synthetic authentication bytes; production always requires restricted
        // tmpfs before entering this fixed-process adapter.
        let memory = tempfile::tempdir().unwrap();
        let program = memory.path().join("attester");
        let request = NitroRequest::new([1; 32], vec![2; 32], vec![3; 32]).unwrap();
        std::fs::write(&program, "#!/bin/sh\nset -eu\ntest \"$#\" = 7\ntest \"$7\" = --owner-auth-stdin\ntest \"$(/bin/cat)\" = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\ntest -z \"${TPM_DEVICE:-}\"\ntest -z \"${AWS_SECRET_ACCESS_KEY:-}\"\nprintf quote\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            request
                .execute(memory.path(), Some(&[b'B'; 32]), &program)
                .unwrap(),
            b"quote"
        );
        assert!(
            request
                .execute(memory.path(), Some(&[b'C'; 32]), &program)
                .is_err()
        );
        std::fs::write(&program, "#!/bin/sh\n/bin/cat >&2\nexit 1\n").unwrap();
        let failure = request
            .execute(memory.path(), Some(&[b'B'; 32]), &program)
            .unwrap_err();
        assert!(failure.downcast_ref::<Stage>().is_some());
        assert!(!format!("{failure:#}").contains("BBBBBBBB"));
        std::fs::write(&program, "#!/bin/sh\n/usr/bin/head -c 32769 /dev/zero\n").unwrap();
        assert!(request.execute(memory.path(), None, &program).is_err());
        assert_eq!(std::fs::read_dir(memory.path()).unwrap().count(), 1);
        assert!(NitroRequest::new([0; 32], vec![0; 1025], vec![0]).is_err());
        assert!(NitroRequest::new([0; 32], vec![0], vec![]).is_err());
    }

    #[test]
    fn classified_collector_exits_remain_failures_and_discard_output() {
        let memory = tempfile::tempdir().unwrap();
        let program = memory.path().join("attester");
        let request = NitroRequest::new([1; 32], vec![2; 32], vec![3; 32]).unwrap();
        for (code, expected) in [
            (64, "nitro-endorsement"),
            (65, "nitro-buffer"),
            (66, "nitro-request"),
            (67, "nitro-tss"),
            (68, "nitro-response"),
            (69, "nitro-response"),
            (70, "nitro-ek-handle-capacity"),
            (71, "nitro-ek-device"),
            (72, "nitro-ek-primary-auth"),
            (73, "nitro-ek-persist-auth"),
            (74, "nitro-ek-auth"),
            (75, "nitro-ek-lockout"),
            (76, "nitro-ek-object-memory"),
            (77, "nitro-ek-session-memory"),
            (78, "nitro-ek-memory"),
            (79, "nitro-ek-handle"),
            (80, "nitro-ek-primary"),
            (81, "nitro-ek-persist"),
            (82, "nitro-ek-tss"),
            (83, "nitro-ek-wrapper"),
            (84, "nitro-ek-public-key"),
            (85, "nitro-ek-encoding"),
            (86, "nitro-ek-parameters"),
            (87, "nitro-evidence"),
        ] {
            std::fs::write(
                &program,
                format!(
                    "#!/bin/sh\nprintf private-output\nprintf private-error >&2\nexit {code}\n"
                ),
            )
            .unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
            let error = request.execute(memory.path(), None, &program).unwrap_err();
            assert_eq!(
                error.to_string(),
                format!("NEBULA_STARTUP_FAILURE:{expected}")
            );
            assert!(!format!("{error:#}").contains("private-"));
            assert_eq!(std::fs::read_dir(memory.path()).unwrap().count(), 1);
        }
    }
}
