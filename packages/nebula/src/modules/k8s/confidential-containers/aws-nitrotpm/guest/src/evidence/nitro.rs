//! Fixed local NitroTPM collector. Owner authorization crosses an anonymous
//! pipe only; the caller serializes it with the protected journal writer.
use super::*;
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
                "NitroTPM collector exceeded limits"
            );
            if let Some(status) = child.0.try_wait()? {
                ensure!(status.success(), "NitroTPM evidence unavailable");
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
        assert_eq!(failure.to_string(), "NitroTPM evidence unavailable");
        std::fs::write(&program, "#!/bin/sh\n/usr/bin/head -c 32769 /dev/zero\n").unwrap();
        assert!(request.execute(memory.path(), None, &program).is_err());
        assert_eq!(std::fs::read_dir(memory.path()).unwrap().count(), 1);
        assert!(NitroRequest::new([0; 32], vec![0; 1025], vec![0]).is_err());
        assert!(NitroRequest::new([0; 32], vec![0], vec![]).is_err());
    }
}
