//! Experimental local persistence beneath the authority's eventual replicated log.
//!
//! This implements encrypted disk records and commit ordering, NOT a TPM seal,
//! TPM authorization policy, consensus protocol or permission to release keys.
//! `Anchor` must be backed by protected, non-replayable hardware state. An EBS
//! file, Kubernetes object or unsigned controller value cannot implement it.
use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result, ensure};
use rsa::rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha384};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

pub type Digest384 = [u8; 48];
pub const EMPTY: Digest384 = [0; 48];
const MAGIC: &[u8; 16] = b"NEBULA-STATE-V1\0";
const HEADER: usize = 16 + 32 + 8 + 48 + 12;
const MAX_STATE: usize = 1024 * 1024;
// Bound random-nonce use under one sealing key. Rotation requires a separately
// authenticated protocol; exhaustion fails closed instead of resetting history.
const MAX_COMMITS: u64 = 1 << 24;

/// Only approved authority code may advance an anchor. An untrusted replacement
/// OS must not delete/redefine it and then reuse an old sealed encryption key.
/// Operations are serialized by the authority; implementations must check the
/// expected current value, extend SHA384 once, and never blindly retry a write.
pub trait Anchor {
    fn read(&mut self) -> Result<Digest384>;
    fn extend(&mut self, expected: Digest384, digest: Digest384) -> Result<()>;
}

fn extend(previous: Digest384, digest: Digest384) -> Digest384 {
    Sha384::new()
        .chain_update(previous)
        .chain_update(digest)
        .finalize()
        .into()
}

fn name(anchor: &Digest384) -> String {
    let mut value: String = anchor.iter().map(|b| format!("{b:02x}")).collect();
    value.push_str(".state");
    value
}

/// Confidential bytes are zeroed when dropped; callers must do the same with
/// decoded key material and retain only quorum-authorized state for key release.
pub struct Snapshot {
    pub sequence: u64,
    pub bytes: Zeroizing<Vec<u8>>,
}

pub struct Journal<A: Anchor> {
    directory: PathBuf,
    _lock: File,
    anchor: A,
    current: Digest384,
    sequence: u64,
    key: Zeroizing<[u8; 32]>,
    deployment: [u8; 32],
    poisoned: bool,
}

impl<A: Anchor> Journal<A> {
    /// The caller supplies a key unsealed INSIDE the approved authority. Neither
    /// this key nor a recovery copy may come from management-cluster storage.
    /// An empty anchor is only a local uninitialized journal, never permission
    /// to re-enroll an existing deployment or generate replacement workload keys.
    pub fn open(
        directory: &Path,
        key: Zeroizing<[u8; 32]>,
        deployment: [u8; 32],
        mut anchor: A,
    ) -> Result<(Self, Option<Snapshot>)> {
        let metadata = fs::symlink_metadata(directory)?;
        ensure!(
            metadata.is_dir()
                && metadata.mode() & 0o077 == 0
                && metadata.uid() == unsafe { libc::geteuid() },
            "private state directory required"
        );
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join(".lock"))?;
        ensure!(lock.metadata()?.is_file(), "regular journal lock required");
        ensure!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "journal already in use"
        );
        let current = anchor.read()?;
        let mut journal = Self {
            directory: directory.into(),
            _lock: lock,
            anchor,
            current,
            sequence: 0,
            key,
            deployment,
            poisoned: false,
        };
        let snapshot = journal.recover()?;
        journal.sequence = snapshot.as_ref().map_or(0, |snapshot| snapshot.sequence);
        Ok((journal, snapshot))
    }

    fn recover(&self) -> Result<Option<Snapshot>> {
        if self.current == EMPTY {
            // Uncommitted records from a failed initial write are not authority.
            return Ok(None);
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.directory.join(name(&self.current)))
            .context("anchored state missing")?;
        ensure!(file.metadata()?.is_file(), "regular state record required");
        let mut record = Vec::new();
        (&mut file)
            .take((HEADER + MAX_STATE + 17) as u64)
            .read_to_end(&mut record)?;
        ensure!(
            (HEADER + 17..=HEADER + MAX_STATE + 16).contains(&record.len()),
            "invalid record size"
        );
        ensure!(
            &record[..16] == MAGIC && record[16..48] == self.deployment,
            "record identity mismatch"
        );
        let sequence = u64::from_be_bytes(record[48..56].try_into()?);
        let previous: Digest384 = record[56..104].try_into()?;
        ensure!(
            (1..=MAX_COMMITS).contains(&sequence) && (sequence == 1) == (previous == EMPTY),
            "invalid state sequence"
        );
        ensure!(
            extend(previous, Sha384::digest(&record).into()) == self.current,
            "state does not match protected anchor"
        );
        let nonce: [u8; 12] = record[104..HEADER].try_into()?;
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref())
            .map_err(|_| anyhow::anyhow!("invalid sealing key"))?;
        let bytes = cipher
            .decrypt(
                &nonce.into(),
                Payload {
                    msg: &record[HEADER..],
                    aad: &record[..HEADER],
                },
            )
            .map_err(|_| anyhow::anyhow!("state authentication failed"))?;
        Ok(Some(Snapshot {
            sequence,
            bytes: Zeroizing::new(bytes),
        }))
    }

    /// Acknowledge only after a durable ciphertext AND confirmed anchor update.
    /// No mutable disk head pointer or directory timestamp is trusted on recovery.
    pub fn commit(&mut self, bytes: &[u8]) -> Result<u64> {
        ensure!(!self.poisoned, "journal requires recovery");
        ensure!(
            !bytes.is_empty() && bytes.len() <= MAX_STATE && self.sequence < MAX_COMMITS,
            "state size or sealing-key lifetime exceeded"
        );
        // A concurrent/replaced anchor invalidates this session; never overwrite it.
        if self.anchor.read()? != self.current {
            self.poisoned = true;
            anyhow::bail!("protected anchor changed");
        }
        let sequence = self.sequence + 1;
        let mut nonce = [0; 12];
        OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| anyhow::anyhow!("entropy unavailable"))?;
        let mut record = Vec::with_capacity(HEADER + bytes.len() + 16);
        record.extend_from_slice(MAGIC);
        record.extend_from_slice(&self.deployment);
        record.extend_from_slice(&sequence.to_be_bytes());
        record.extend_from_slice(&self.current);
        record.extend_from_slice(&nonce);
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref())
            .map_err(|_| anyhow::anyhow!("invalid sealing key"))?;
        let encrypted = cipher
            .encrypt(
                &nonce.into(),
                Payload {
                    msg: bytes,
                    aad: &record,
                },
            )
            .map_err(|_| anyhow::anyhow!("state encryption failed"))?;
        record.extend_from_slice(&encrypted);
        let digest = Sha384::digest(&record).into();
        let next = extend(self.current, digest);
        let mut pending = tempfile::NamedTempFile::new_in(&self.directory)?;
        pending.write_all(&record)?;
        pending.as_file().sync_all()?;
        // Do not replace an existing record, including a symlink or partial file.
        pending.persist_noclobber(self.directory.join(name(&next)))?;
        File::open(&self.directory)?.sync_all()?;
        // From here an error may mean the TPM write succeeded but its reply was
        // lost. Poison first. Only a fresh matching anchor read resolves that.
        self.poisoned = true;
        let _ = self.anchor.extend(self.current, digest);
        ensure!(self.anchor.read()? == next, "anchor commit not confirmed");
        self.current = next;
        self.sequence = sequence;
        self.poisoned = false;
        Ok(sequence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    struct Hardware {
        value: Digest384,
        reject_write: bool,
        lose_reply: bool,
        lose_read_after_write: bool,
        writes: usize,
        directory: PathBuf,
    }
    #[derive(Clone)]
    struct TestAnchor(Rc<RefCell<Hardware>>);
    impl Anchor for TestAnchor {
        fn read(&mut self) -> Result<Digest384> {
            let state = self.0.borrow();
            ensure!(
                !(state.lose_read_after_write && state.writes > 0),
                "injected read failure"
            );
            Ok(state.value)
        }
        fn extend(&mut self, expected: Digest384, digest: Digest384) -> Result<()> {
            let mut state = self.0.borrow_mut();
            ensure!(state.value == expected, "conflicting write");
            let next = extend(expected, digest);
            // The write is never attempted before the exact encrypted record
            // exists. Durability ordering is explicit in Journal::commit.
            let record = fs::read(state.directory.join(name(&next)))?;
            assert_eq!(Digest384::from(Sha384::digest(record)), digest);
            ensure!(!state.reject_write, "injected pre-commit failure");
            state.value = next;
            state.writes += 1;
            ensure!(!state.lose_reply, "injected lost reply");
            Ok(())
        }
    }
    fn setup() -> (tempfile::TempDir, TestAnchor) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let anchor = TestAnchor(Rc::new(RefCell::new(Hardware {
            value: EMPTY,
            directory: directory.path().into(),
            reject_write: false,
            lose_reply: false,
            lose_read_after_write: false,
            writes: 0,
        })));
        (directory, anchor)
    }
    fn open(
        directory: &Path,
        anchor: TestAnchor,
    ) -> Result<(Journal<TestAnchor>, Option<Snapshot>)> {
        Journal::open(directory, Zeroizing::new([7; 32]), [9; 32], anchor)
    }
    #[test]
    fn restart_recovers_only_the_current_encrypted_state() {
        let (directory, anchor) = setup();
        let (mut journal, state) = open(directory.path(), anchor.clone()).unwrap();
        assert!(state.is_none());
        journal.commit(b"old-secret-and-policy").unwrap();
        journal.commit(b"new-secret-and-policy").unwrap();
        drop(journal);
        let (_, state) = open(directory.path(), anchor).unwrap();
        let state = state.unwrap();
        assert_eq!(state.sequence, 2);
        assert_eq!(state.bytes.as_slice(), b"new-secret-and-policy");
        for file in fs::read_dir(directory.path()).unwrap() {
            let bytes = fs::read(file.unwrap().path()).unwrap();
            assert!(!bytes.windows(6).any(|window| window == b"secret"));
        }
    }
    #[test]
    fn replay_tamper_wrong_key_and_wrong_deployment_fail_closed() {
        let (directory, anchor) = setup();
        let (mut journal, _) = open(directory.path(), anchor.clone()).unwrap();
        journal.commit(b"old-policy").unwrap();
        let old = fs::read(directory.path().join(name(&anchor.0.borrow().value))).unwrap();
        journal.commit(b"revoked-policy").unwrap();
        drop(journal);
        assert!(
            Journal::open(
                directory.path(),
                Zeroizing::new([8; 32]),
                [9; 32],
                anchor.clone()
            )
            .is_err()
        );
        assert!(
            Journal::open(
                directory.path(),
                Zeroizing::new([7; 32]),
                [8; 32],
                anchor.clone()
            )
            .is_err()
        );
        let path = directory.path().join(name(&anchor.0.borrow().value));
        let mut good = fs::read(&path).unwrap();
        fs::write(&path, old).unwrap();
        assert!(open(directory.path(), anchor.clone()).is_err());
        good[HEADER] ^= 1;
        fs::write(&path, good).unwrap();
        assert!(open(directory.path(), anchor.clone()).is_err());
        fs::remove_file(path).unwrap();
        assert!(open(directory.path(), anchor).is_err());
    }
    #[test]
    fn failed_precommit_ignores_orphans_and_requires_recovery_before_retry() {
        let (directory, anchor) = setup();
        let (mut journal, _) = open(directory.path(), anchor.clone()).unwrap();
        journal.commit(b"committed").unwrap();
        anchor.0.borrow_mut().reject_write = true;
        assert!(journal.commit(b"not-committed").is_err());
        assert!(journal.commit(b"retry-forbidden").is_err());
        drop(journal);
        let (mut journal, state) = open(directory.path(), anchor.clone()).unwrap();
        assert_eq!(state.unwrap().bytes.as_slice(), b"committed");
        anchor.0.borrow_mut().reject_write = false;
        assert_eq!(journal.commit(b"recovered-update").unwrap(), 2);
    }
    #[test]
    fn lost_write_reply_is_resolved_without_double_extension() {
        let (directory, anchor) = setup();
        let (mut journal, _) = open(directory.path(), anchor.clone()).unwrap();
        anchor.0.borrow_mut().lose_reply = true;
        assert_eq!(journal.commit(b"committed-once").unwrap(), 1);
        assert_eq!(anchor.0.borrow().writes, 1);
    }
    #[test]
    fn crash_after_commit_before_ack_recovers_the_new_state() {
        let (directory, anchor) = setup();
        let (mut journal, _) = open(directory.path(), anchor.clone()).unwrap();
        anchor.0.borrow_mut().lose_read_after_write = true;
        assert!(journal.commit(b"durable-but-unacknowledged").is_err());
        assert!(journal.commit(b"retry-forbidden").is_err());
        drop(journal);
        anchor.0.borrow_mut().lose_read_after_write = false;
        let (_, state) = open(directory.path(), anchor.clone()).unwrap();
        assert_eq!(
            state.unwrap().bytes.as_slice(),
            b"durable-but-unacknowledged"
        );
        assert_eq!(anchor.0.borrow().writes, 1);
    }
    #[test]
    fn concurrent_sessions_and_record_symlinks_are_rejected() {
        let (directory, anchor) = setup();
        let (mut journal, _) = open(directory.path(), anchor.clone()).unwrap();
        assert!(open(directory.path(), anchor.clone()).is_err());
        journal.commit(b"protected").unwrap();
        drop(journal);
        let path = directory.path().join(name(&anchor.0.borrow().value));
        let other = directory.path().join("elsewhere");
        fs::rename(&path, &other).unwrap();
        std::os::unix::fs::symlink(other, path).unwrap();
        assert!(open(directory.path(), anchor).is_err());
    }
}
