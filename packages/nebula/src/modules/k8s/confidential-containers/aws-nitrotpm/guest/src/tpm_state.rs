//! Local TPM persistence for the future measured authority, not its enrollment
//! or quorum protocol. No boot unit or operator CLI calls these entry points.
//!
//! The appliance must authenticate its deployment and immutable release before
//! calling this module. It exclusively owns this TPM; all appliance TPM users
//! must take the same lock. Recovery never provisions, clears or replaces state.
use crate::protected_state::{Anchor, Digest384, EMPTY, Journal, Snapshot};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rsa::rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha384};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{fs::MetadataExt, fs::OpenOptionsExt, io::AsRawFd, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MEMORY: &str = "/run/nebula/authority-tpm";
const PARENT: &str = "0x81010010";
const INDEX: &str = "0x01810010";
const INDEX_NUMBER: u32 = 0x01810010;
const PCRS: &str = "sha384:4,12";
const NV_ATTRIBUTES: u32 = 0x02040048; // policywrite | extend | authread | no_da
const NV_WRITTEN: u32 = 0x20000000;
const MAX_FILE: usize = 16 * 1024;

/// Measurements from the authenticated release, never values learned from the
/// current machine or supplied by its management cluster as a trust decision.
#[derive(Clone)]
pub struct BootPolicy {
    pub pcr4: Digest384,
    pub pcr12: Digest384,
}

/// Keys and TPM authorization are deliberately not exposed by this facade.
pub struct TpmJournal(Journal<HardwareAnchor>);

impl TpmJournal {
    /// Only for an authenticated NEW authority member. This one-attempt local
    /// provisioner is not permission to replace an existing deployment's keys.
    /// An interrupted provisioner cannot acknowledge state; the future enrollment
    /// protocol must replace that uncommitted member, not reset a live journal.
    pub fn provision(directory: &Path, deployment: [u8; 32], boot: &BootPolicy) -> Result<Self> {
        provision(directory, deployment, boot, Driver::hardware()?)
    }

    /// A restart must use this method. Missing state, wrong boot, TPM clear,
    /// a copied seal or replayed disk is an error, never a new initialization.
    pub fn recover(
        directory: &Path,
        deployment: [u8; 32],
        boot: &BootPolicy,
    ) -> Result<(Self, Option<Snapshot>)> {
        recover(directory, deployment, boot, Driver::hardware()?)
    }

    pub fn commit(&mut self, bytes: &[u8]) -> Result<u64> {
        self.0.commit(bytes)
    }
}

fn private_directory(directory: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(directory)?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0,
        "private state directory required"
    );
    Ok(())
}

fn read_file(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = input.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= MAX_FILE as u64,
        "invalid TPM file"
    );
    // Avoid reallocations leaving an old plaintext buffer behind.
    let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_FILE + 1));
    (&mut input)
        .take((MAX_FILE + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_FILE, "oversize TPM file");
    Ok(bytes)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    output.write_all(bytes)?;
    output.sync_all()?;
    Ok(())
}

fn lock(directory: &Path) -> Result<File> {
    private_directory(directory)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join(".tpm-lock"))?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.mode() & 0o077 == 0
            && metadata.uid() == unsafe { libc::geteuid() },
        "private TPM lock required"
    );
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "TPM already in use"
    );
    Ok(file)
}

struct Driver {
    scratch: tempfile::TempDir,
    _lock: File,
    // No public constructor/config/env override. Only unit tests can choose an
    // emulator endpoint; the shipped entry points always use the local RM.
    endpoint: String,
    initial_transients: Option<BTreeSet<String>>,
}

impl Driver {
    fn hardware() -> Result<Self> {
        crate::require_memory_directory(Path::new(MEMORY))?;
        Self::new(Path::new(MEMORY), "device:/dev/tpmrm0".into())
    }

    fn new(memory: &Path, endpoint: String) -> Result<Self> {
        let lock = lock(memory)?;
        let mut driver = Self {
            scratch: tempfile::tempdir_in(memory)?,
            _lock: lock,
            endpoint,
            initial_transients: None,
        };
        driver.initial_transients = Some(driver.handles("handles-transient")?);
        Ok(driver)
    }

    fn write(&self, name: &str, bytes: &[u8]) -> Result<()> {
        write_private(&self.scratch.path().join(name), bytes)
    }

    fn read(&self, name: &str) -> Result<Zeroizing<Vec<u8>>> {
        read_file(&self.scratch.path().join(name))
    }

    fn remove(&self, name: &str) -> Result<()> {
        fs::remove_file(self.scratch.path().join(name))?;
        Ok(())
    }

    /// Bounded fixed tools, no shell, inherited environment, secret argument or
    /// error output. Cleartext tool files live only in the restricted tmpfs.
    fn run(&self, tool: &str, args: &[&str]) -> Result<Vec<u8>> {
        ensure!(
            matches!(
                tool,
                "tpm2_getcap"
                    | "tpm2_createprimary"
                    | "tpm2_evictcontrol"
                    | "tpm2_flushcontext"
                    | "tpm2_readpublic"
                    | "tpm2_startauthsession"
                    | "tpm2_policypcr"
                    | "tpm2_policycommandcode"
                    | "tpm2_pcrread"
                    | "tpm2_create"
                    | "tpm2_changeauth"
                    | "tpm2_nvdefine"
                    | "tpm2_nvreadpublic"
                    | "tpm2_nvread"
                    | "tpm2_nvextend"
                    | "tpm2_load"
                    | "tpm2_unseal"
            ),
            "unsupported TPM operation"
        );
        let output = tempfile::tempfile_in(self.scratch.path())?;
        let mut command = Command::new(format!("/usr/bin/{tool}"));
        command.args(["-T", &self.endpoint]);
        if !matches!(tool, "tpm2_nvreadpublic" | "tpm2_getcap") {
            command.arg("-Q");
        }
        // Only async-signal-safe syscalls between fork and exec. Do not allow
        // tool-created plaintext files to inherit a permissive caller umask.
        unsafe {
            command.pre_exec(|| {
                libc::umask(0o077);
                let core = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                let files = libc::rlimit {
                    rlim_cur: MAX_FILE as libc::rlim_t,
                    rlim_max: MAX_FILE as libc::rlim_t,
                };
                if libc::setrlimit(libc::RLIMIT_CORE, &core) != 0
                    || libc::setrlimit(libc::RLIMIT_FSIZE, &files) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .args(args)
            .current_dir(self.scratch.path())
            .env_clear()
            .env("LC_ALL", "C")
            .env("TSS2_LOG", "all+NONE")
            .stdin(Stdio::null())
            .stdout(output.try_clone()?)
            .stderr(Stdio::null())
            .spawn()
            .context("cannot start TPM operation")?;
        let start = Instant::now();
        let result = (|| loop {
            // The tools are part of the measured root. Bound even their public
            // output and elapsed time; never retry a possibly completed write.
            if start.elapsed() > Duration::from_secs(10)
                || output.metadata()?.len() > MAX_FILE as u64
            {
                anyhow::bail!("TPM operation exceeded limits: {tool}");
            }
            if let Some(status) = child.try_wait()? {
                break Ok(status);
            }
            thread::sleep(Duration::from_millis(10));
        })();
        if result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let status = result?;
        ensure!(status.success(), "TPM operation failed: {tool}");
        use std::io::{Seek, SeekFrom};
        let mut output = output;
        output.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        output.take((MAX_FILE + 1) as u64).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= MAX_FILE, "oversize TPM output");
        Ok(bytes)
    }

    fn handles(&self, capability: &str) -> Result<BTreeSet<String>> {
        let bytes = self.run("tpm2_getcap", &[capability])?;
        let mut handles = BTreeSet::new();
        for line in std::str::from_utf8(&bytes)?
            .lines()
            .filter(|line| !line.is_empty())
        {
            let handle = line
                .strip_prefix("- 0x")
                .context("unexpected TPM handles")?;
            ensure!(
                (1..=8).contains(&handle.len()) && handle.bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid TPM handle"
            );
            ensure!(
                handles.insert(format!("0x{:08x}", u32::from_str_radix(handle, 16)?)),
                "duplicate TPM handle"
            );
        }
        Ok(handles)
    }

    fn flush_owned(&self) -> Result<()> {
        // A failed initial inventory must never turn every existing handle
        // into something this driver believes it owns.
        let Some(initial) = &self.initial_transients else {
            return Ok(());
        };
        for handle in self.handles("handles-transient")?.difference(initial) {
            self.run("tpm2_flushcontext", &[handle])?;
        }
        Ok(())
    }

    fn check_boot(&self, boot: &BootPolicy) -> Result<()> {
        ensure!(
            boot.pcr4 != EMPTY && boot.pcr12 != EMPTY,
            "measured authority boot required"
        );
        let mut expected = boot.pcr4.to_vec();
        expected.extend_from_slice(&boot.pcr12);
        self.write("approved.pcr", &expected)?;
        self.run("tpm2_pcrread", &[PCRS, "-o", "boot.pcr"])?;
        ensure!(
            *self.read("boot.pcr")? == expected,
            "authority boot mismatch"
        );
        Ok(())
    }

    fn policy<T>(
        &self,
        hash: &str,
        code: &str,
        trial: bool,
        action: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let mut args = vec!["-g", hash, "-S", "policy.ctx"];
        if !trial {
            args.push("--policy-session");
        }
        self.run("tpm2_startauthsession", &args)?;
        let result = (|| {
            self.run(
                "tpm2_policypcr",
                &["-S", "policy.ctx", "-l", PCRS, "-f", "approved.pcr"],
            )?;
            self.run(
                "tpm2_policycommandcode",
                &["-S", "policy.ctx", "-L", "policy.digest", code],
            )?;
            action()
        })();
        let cleanup = self.run("tpm2_flushcontext", &["policy.ctx"]);
        let value = result?;
        cleanup?;
        Ok(value)
    }

    fn policies(&self) -> Result<(Vec<u8>, Digest384)> {
        let seal = self.policy("sha256", "TPM2_CC_Unseal", true, || {
            Ok(self.read("policy.digest")?.to_vec())
        })?;
        let nv = self.policy("sha384", "TPM2_CC_NV_Extend", true, || {
            Ok(self.read("policy.digest")?.to_vec())
        })?;
        Ok((
            seal,
            nv.try_into()
                .map_err(|_| anyhow::anyhow!("invalid NV policy"))?,
        ))
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        // Best effort for failed operations. No hierarchy clear, persistent-key
        // eviction, NV deletion, or flushing another user's existing handles.
        let _ = self.flush_owned();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SealedBlobs {
    parent_name: String,
    public: String,
    private: String,
}

fn check_seal_public(bytes: &[u8], policy: &[u8]) -> Result<()> {
    // Exact TPM2B_PUBLIC keyed-hash seal: SHA256 name, fixed TPM/parent,
    // admin policy, no DA; no password-unseal bit or duplicable object.
    ensure!(
        policy.len() == 32 && bytes.len() == 80,
        "invalid seal public size"
    );
    ensure!(
        bytes[..12] == [0, 78, 0, 8, 0, 11, 0, 0, 4, 146, 0, 32]
            && &bytes[12..44] == policy
            && bytes[44..48] == [0, 16, 0, 32],
        "invalid seal public policy"
    );
    Ok(())
}

fn provision(
    directory: &Path,
    deployment: [u8; 32],
    boot: &BootPolicy,
    driver: Driver,
) -> Result<TpmJournal> {
    private_directory(directory)?;
    ensure!(
        fs::read_dir(directory)?.next().is_none(),
        "new authority directory required"
    );
    driver.check_boot(boot)?;
    ensure!(
        driver.handles("handles-persistent")?.is_empty()
            && driver.handles("handles-nv-index")?.is_empty(),
        "unprovisioned TPM required"
    );
    // Persist intent before hardware mutation. Never silently repeat genesis.
    write_private(
        &directory.join("provisioning"),
        b"nebula-authority-tpm-v1\n",
    )?;
    File::open(directory)?.sync_all()?;
    let (seal_policy, nv_policy) = driver.policies()?;
    driver.run(
        "tpm2_createprimary",
        &["-C", "o", "-G", "ecc", "-g", "sha256", "-c", "parent.ctx"],
    )?;
    driver.run(
        "tpm2_evictcontrol",
        &["-C", "o", "-c", "parent.ctx", PARENT],
    )?;
    driver.flush_owned()?;
    driver.run("tpm2_readpublic", &["-c", PARENT, "-n", "parent.name"])?;
    let mut secrets = Zeroizing::new([0u8; 96]);
    secrets[..32].copy_from_slice(&deployment);
    OsRng
        .try_fill_bytes(&mut secrets[32..])
        .map_err(|_| anyhow::anyhow!("entropy unavailable"))?;
    driver.write("secrets", secrets.as_ref())?;
    driver.write("seal.policy", &seal_policy)?;
    driver.run(
        "tpm2_create",
        &[
            "-C",
            PARENT,
            "-g",
            "sha256",
            "-i",
            "secrets",
            "-u",
            "sealed.pub",
            "-r",
            "sealed.priv",
            "-L",
            "seal.policy",
            "-a",
            "fixedtpm|fixedparent|adminwithpolicy|noda",
        ],
    )?;
    driver.remove("secrets")?;
    let public = driver.read("sealed.pub")?;
    check_seal_public(&public, &seal_policy)?;
    let blobs = SealedBlobs {
        parent_name: STANDARD.encode(driver.read("parent.name")?),
        public: STANDARD.encode(&public),
        private: STANDARD.encode(driver.read("sealed.priv")?),
    };
    // Only TPM-encrypted blobs reach persistent storage, durably BEFORE owner
    // authorization is changed. A failed provision never releases a journal.
    write_private(&directory.join("seal.json"), &serde_json::to_vec(&blobs)?)?;
    File::open(directory)?.sync_all()?;
    driver.write("owner.auth", &secrets[64..])?;
    driver.run("tpm2_changeauth", &["-c", "o", "file:owner.auth"])?;
    driver.write("nv.policy", &nv_policy)?;
    driver.run(
        "tpm2_nvdefine",
        &[
            INDEX,
            "-C",
            "o",
            "-P",
            "file:owner.auth",
            "-s",
            "48",
            "-g",
            "sha384",
            "-a",
            "nt=extend|policywrite|authread|no_da",
            "-L",
            "nv.policy",
        ],
    )?;
    driver.remove("owner.auth")?;
    let key = Zeroizing::new(secrets[32..64].try_into()?);
    let anchor = HardwareAnchor {
        driver,
        policy: nv_policy,
    };
    let (journal, snapshot) = Journal::open(directory, key, deployment, anchor)?;
    ensure!(snapshot.is_none(), "new authority already contains state");
    Ok(TpmJournal(journal))
}

fn recover(
    directory: &Path,
    deployment: [u8; 32],
    boot: &BootPolicy,
    driver: Driver,
) -> Result<(TpmJournal, Option<Snapshot>)> {
    private_directory(directory)?;
    driver.check_boot(boot)?;
    let (seal_policy, nv_policy) = driver.policies()?;
    let blobs: SealedBlobs = serde_json::from_slice(&read_file(&directory.join("seal.json"))?)?;
    let public = STANDARD.decode(blobs.public)?;
    check_seal_public(&public, &seal_policy)?;
    let parent = STANDARD.decode(blobs.parent_name)?;
    ensure!(
        parent.len() == 34 && parent[..2] == [0, 11],
        "invalid parent name"
    );
    driver.run("tpm2_readpublic", &["-c", PARENT, "-n", "parent.name"])?;
    ensure!(*driver.read("parent.name")? == parent, "TPM parent changed");
    driver.write("sealed.pub", &public)?;
    driver.write("sealed.priv", &STANDARD.decode(blobs.private)?)?;
    driver.run(
        "tpm2_load",
        &[
            "-C",
            PARENT,
            "-u",
            "sealed.pub",
            "-r",
            "sealed.priv",
            "-c",
            "sealed.ctx",
        ],
    )?;
    let result = driver.policy("sha256", "TPM2_CC_Unseal", false, || {
        driver.run(
            "tpm2_unseal",
            &[
                "-c",
                "sealed.ctx",
                "-p",
                "session:policy.ctx",
                "-o",
                "unsealed",
            ],
        )?;
        let secrets = driver.read("unsealed")?;
        driver.remove("unsealed")?;
        ensure!(
            secrets.len() == 96 && secrets[..32] == deployment,
            "sealed deployment mismatch"
        );
        Ok(secrets)
    });
    let cleanup = driver.flush_owned();
    let secrets = result?;
    cleanup?;
    // Authenticate the sealed owner credential with a transient primary. No
    // owner-auth reset, persistent eviction or NV creation is allowed here.
    driver.write("owner.auth", &secrets[64..])?;
    let owner = driver.run(
        "tpm2_createprimary",
        &[
            "-C",
            "o",
            "-P",
            "file:owner.auth",
            "-G",
            "ecc",
            "-g",
            "sha256",
            "-c",
            "owner-check.ctx",
        ],
    );
    driver.remove("owner.auth")?;
    owner?;
    driver.flush_owned()?;
    let key = Zeroizing::new(secrets[32..64].try_into()?);
    let anchor = HardwareAnchor {
        driver,
        policy: nv_policy,
    };
    let (journal, snapshot) = Journal::open(directory, key, deployment, anchor)?;
    Ok((TpmJournal(journal), snapshot))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Parse only the fixed tpm2-tools 5.x presentation, rejecting extra/missing or
/// duplicate fields. Friendly attribute names are informational (some versions
/// print the extend type incorrectly); numeric attributes and Name are checked.
fn validate_nv_public(output: &[u8], policy: &Digest384) -> Result<bool> {
    let text = std::str::from_utf8(output)?;
    let lines: Vec<_> = text.trim_end().lines().collect();
    ensure!(
        lines.len() == 10
            && lines[0] == "0x1810010:"
            && lines[2] == "  hash algorithm:"
            && lines[3] == "    friendly: sha384"
            && lines[4] == "    value: 0xC"
            && lines[5] == "  attributes:"
            && lines[6].starts_with("    friendly: ")
            && lines[8] == "  size: 48",
        "unexpected NV public definition"
    );
    let attributes = u32::from_str_radix(
        lines[7]
            .strip_prefix("    value: 0x")
            .context("missing NV attributes")?,
        16,
    )?;
    ensure!(
        attributes == NV_ATTRIBUTES || attributes == NV_ATTRIBUTES | NV_WRITTEN,
        "unsafe NV attributes"
    );
    ensure!(
        lines[9]
            .strip_prefix("  authorization policy: ")
            .context("missing NV policy")?
            .eq_ignore_ascii_case(&hex(policy)),
        "NV policy mismatch"
    );
    // TPM Name = nameAlg || H(TPMS_NV_PUBLIC), including the WRITTEN bit. This
    // checks the numeric definition, not version-dependent friendly labels.
    let mut public = INDEX_NUMBER.to_be_bytes().to_vec();
    public.extend_from_slice(&[0, 12]);
    public.extend_from_slice(&attributes.to_be_bytes());
    public.extend_from_slice(&[0, 48]);
    public.extend_from_slice(policy);
    public.extend_from_slice(&[0, 48]);
    let expected_name = format!("000c{}", hex(&Sha384::digest(public)));
    ensure!(
        lines[1]
            .strip_prefix("  name: ")
            .context("missing NV name")?
            .eq_ignore_ascii_case(&expected_name),
        "NV name mismatch"
    );
    Ok(attributes & NV_WRITTEN != 0)
}

struct HardwareAnchor {
    driver: Driver,
    policy: Digest384,
}

impl Anchor for HardwareAnchor {
    fn read(&mut self) -> Result<Digest384> {
        let public = self.driver.run("tpm2_nvreadpublic", &[INDEX])?;
        if !validate_nv_public(&public, &self.policy)? {
            return Ok(EMPTY);
        }
        self.driver.run(
            "tpm2_nvread",
            &[INDEX, "-C", INDEX, "-s", "48", "-o", "anchor"],
        )?;
        let bytes = self.driver.read("anchor")?;
        bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid NV anchor size"))
    }

    fn extend(&mut self, expected: Digest384, digest: Digest384) -> Result<()> {
        ensure!(self.read()? == expected, "protected anchor changed");
        // One write attempt. Journal resolves an ambiguous response by reading
        // the protected anchor; this layer never retries the extension.
        self.driver.write("event", &digest)?;
        let result = self
            .driver
            .policy("sha384", "TPM2_CC_NV_Extend", false, || {
                self.driver.run(
                    "tpm2_nvextend",
                    &[
                        INDEX,
                        "-C",
                        INDEX,
                        "-P",
                        "session:policy.ctx",
                        "-i",
                        "event",
                    ],
                )?;
                Ok(())
            });
        self.driver.remove("event")?;
        result
    }
}

#[cfg(test)]
mod tests;
