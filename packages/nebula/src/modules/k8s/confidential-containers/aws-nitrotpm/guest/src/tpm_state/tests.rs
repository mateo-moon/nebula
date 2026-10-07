use super::*;
// Parallel fork/exec briefly inherits other tests' flock descriptors until
// CLOEXEC takes effect. Serialize process-based fixtures; contention itself is
// tested explicitly with two drivers pointing at the same emulated hardware.
static EMULATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
use std::{
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    process::Child,
};

fn public_fixture(policy: &Digest384, attributes: u32) -> String {
    let mut public = INDEX_NUMBER.to_be_bytes().to_vec();
    public.extend_from_slice(&[0, 12]);
    public.extend_from_slice(&attributes.to_be_bytes());
    public.extend_from_slice(&[0, 48]);
    public.extend_from_slice(policy);
    public.extend_from_slice(&[0, 48]);
    format!(
        "0x1810010:\n  name: 000c{}\n  hash algorithm:\n    friendly: sha384\n    value: 0xC\n  attributes:\n    friendly: policywrite|nt=0x1|authread|no_da\n    value: 0x{attributes:x}\n  size: 48\n  authorization policy: {}\n\n",
        hex(&Sha384::digest(public)),
        hex(policy).to_ascii_uppercase()
    )
}

#[test]
fn nv_definition_requires_exact_policy_permissions_name_size_and_written_flag() {
    let policy = [11; 48];
    let good = public_fixture(&policy, NV_ATTRIBUTES);
    assert!(!validate_nv_public(good.as_bytes(), &policy).unwrap());
    assert!(
        validate_nv_public(
            public_fixture(&policy, NV_ATTRIBUTES | NV_WRITTEN).as_bytes(),
            &policy
        )
        .unwrap()
    );
    // Correctly hashed Names do not excuse dangerous permissions or a changed
    // type, reset semantics, size, authorization policy, or ambiguous metadata.
    for bit in [
        1, 2, 4, 16, 32, 256, 1024, 2048, 0x10000, 0x20000, 0x80000, 0x40000000, 0x80000000,
    ] {
        assert!(
            validate_nv_public(
                public_fixture(&policy, NV_ATTRIBUTES ^ bit).as_bytes(),
                &policy
            )
            .is_err()
        );
    }
    for bad in [
        good.replace("size: 48", "size: 32"),
        good.replace("0x1810010:", "0x1810011:"),
        good.replace("value: 0xC", "value: 0xB"),
        good.replace("name: 000c", "name: 000b"),
        format!("{good}  size: 48\n"),
        good.replace("authorization policy:", "different policy:"),
        good.replace("0B0B", "0B0C"),
    ] {
        assert!(validate_nv_public(bad.as_bytes(), &policy).is_err());
    }
    assert!(validate_nv_public(b"", &policy).is_err());
    assert!(validate_nv_public(&[255], &policy).is_err());
}

#[test]
fn sealed_public_rejects_password_auth_migration_and_different_policy() {
    let policy = [12; 32];
    let mut public = vec![0, 78, 0, 8, 0, 11, 0, 0, 4, 146, 0, 32];
    public.extend_from_slice(&policy);
    public.extend_from_slice(&[0, 16, 0, 32]);
    public.extend_from_slice(&[7; 32]);
    check_seal_public(&public, &policy).unwrap();
    for (offset, bit) in [
        (9, 0x40),
        (9, 2),
        (9, 16),
        (8, 4),
        (12, 1),
        (45, 1),
        (47, 1),
    ] {
        let mut bad = public.clone();
        bad[offset] ^= bit;
        assert!(check_seal_public(&bad, &policy).is_err());
    }
    assert!(check_seal_public(&public[..79], &policy).is_err());
}

struct Emulator {
    root: tempfile::TempDir,
    port: u16,
    process: Option<Child>,
    boot: BootPolicy,
}

impl Emulator {
    fn new() -> Self {
        assert_eq!(
            std::env::var("NEBULA_SWTPM_TEST").as_deref(),
            Ok("1"),
            "isolated software-TPM job only"
        );
        let root = tempfile::tempdir_in("/dev/shm").unwrap();
        for directory in ["hardware", "memory", "disk"] {
            fs::create_dir(root.path().join(directory)).unwrap();
            fs::set_permissions(
                root.path().join(directory),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        crate::require_memory_directory(&root.path().join("memory")).unwrap();
        let port = (0..100)
            .find_map(|_| {
                let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
                let port = server.local_addr().unwrap().port();
                if port == u16::MAX {
                    return None;
                }
                let _control = TcpListener::bind(("127.0.0.1", port + 1)).ok()?;
                Some(port)
            })
            .expect("free emulator ports");
        let measured = |value: u8| -> Digest384 {
            Sha384::new()
                .chain_update(EMPTY)
                .chain_update([value; 48])
                .finalize()
                .into()
        };
        let mut instance = Self {
            root,
            port,
            process: None,
            boot: BootPolicy {
                pcr4: measured(4),
                pcr12: measured(12),
            },
        };
        instance.start();
        instance
    }

    fn endpoint(&self) -> String {
        format!("swtpm:host=127.0.0.1,port={}", self.port)
    }
    fn disk(&self) -> std::path::PathBuf {
        self.root.path().join("disk")
    }
    fn driver(&self) -> Driver {
        Driver::new(&self.root.path().join("memory"), self.endpoint()).unwrap()
    }

    fn command(&self, tool: &str, args: &[&str]) -> Vec<u8> {
        let result = Command::new(format!("/usr/bin/{tool}"))
            .args(["-T", &self.endpoint()])
            .args(args)
            .env_clear()
            .env("TSS2_LOG", "all+NONE")
            .current_dir(self.root.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "test setup operation {tool}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        result.stdout
    }

    fn start(&mut self) {
        self.process = Some(
            Command::new("/usr/bin/swtpm")
                .args([
                    "socket",
                    "--tpm2",
                    "--tpmstate",
                    &format!("dir={}", self.root.path().join("hardware").display()),
                    "--server",
                    &format!("type=tcp,bindaddr=127.0.0.1,port={}", self.port),
                    "--ctrl",
                    &format!("type=tcp,bindaddr=127.0.0.1,port={}", self.port + 1),
                    "--flags",
                    "not-need-init",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let start = Instant::now();
        while TcpStream::connect(("127.0.0.1", self.port)).is_err() {
            assert!(self.process.as_mut().unwrap().try_wait().unwrap().is_none());
            assert!(start.elapsed() < Duration::from_secs(5));
            thread::sleep(Duration::from_millis(10));
        }
        self.command("tpm2_startup", &["-c"]);
        for pcr in [4u8, 12] {
            self.command(
                "tpm2_pcrextend",
                &[&format!("{pcr}:sha384={}", hex(&[pcr; 48]))],
            );
        }
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.process.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }

    fn provision(&self) -> TpmJournal {
        provision(&self.disk(), [7; 32], &self.boot, self.driver()).unwrap()
    }
    fn recover(&self) -> Result<(TpmJournal, Option<Snapshot>)> {
        recover(&self.disk(), [7; 32], &self.boot, self.driver())
    }

    fn value(&self) -> Vec<u8> {
        self.command(
            "tpm2_nvread",
            &[INDEX, "-C", INDEX, "-s", "48", "-o", "value"],
        );
        fs::read(self.root.path().join("value")).unwrap()
    }
}

impl Drop for Emulator {
    fn drop(&mut self) {
        self.stop();
    }
}

#[test]
#[ignore = "isolated Linux swtpm fixture with restricted tmpfs and no swap"]
fn emulator_recovers_encrypted_journal_after_restart_and_refuses_disk_rollback() {
    let _serial = EMULATION.lock().unwrap();
    let mut emulator = Emulator::new();
    let mut journal = emulator.provision();
    assert_eq!(journal.commit(b"first confidential state").unwrap(), 1);
    let first = emulator.value();
    let record = |value: &[u8]| emulator.disk().join(format!("{}.state", hex(value)));
    let old = fs::read(record(&first)).unwrap();
    assert!(!old.windows(12).any(|bytes| bytes == b"confidential"));
    assert_eq!(journal.commit(b"second confidential state").unwrap(), 2);
    let second = emulator.value();
    let latest_path = record(&second);
    let latest = fs::read(&latest_path).unwrap();
    // The lock is for the hardware, even if another caller chooses a new disk.
    assert!(Driver::new(&emulator.root.path().join("memory"), emulator.endpoint()).is_err());
    drop(journal);
    emulator.command("tpm2_shutdown", &["-c"]);
    emulator.stop();
    emulator.start();
    let (journal, snapshot) = emulator.recover().unwrap();
    let snapshot = snapshot.unwrap();
    assert_eq!(snapshot.sequence, 2);
    assert_eq!(&*snapshot.bytes, b"second confidential state");
    drop(journal);
    fs::remove_file(&latest_path).unwrap();
    assert!(format!("{:#}", emulator.recover().err().unwrap()).contains("anchored state missing"));
    fs::write(&latest_path, old).unwrap();
    assert!(
        format!("{:#}", emulator.recover().err().unwrap())
            .contains("state does not match protected anchor")
    );
    fs::write(&latest_path, latest).unwrap();
    assert_eq!(emulator.recover().unwrap().1.unwrap().sequence, 2);
    assert_eq!(emulator.value(), second);
}

#[test]
#[ignore = "isolated Linux swtpm fixture with restricted tmpfs and no swap"]
fn emulator_rejects_changed_boot_and_never_advances_the_journal_on_failed_extend() {
    let _serial = EMULATION.lock().unwrap();
    for pcr in [4, 12] {
        let mut emulator = Emulator::new();
        let mut journal = emulator.provision();
        journal.commit(b"approved state").unwrap();
        let before = emulator.value();
        emulator.command(
            "tpm2_pcrextend",
            &[&format!("{pcr}:sha384={}", hex(&[1; 48]))],
        );
        assert!(journal.commit(b"forged history").is_err());
        assert_eq!(emulator.value(), before);
        assert!(journal.commit(b"blind retry").is_err());
        drop(journal);
        assert!(
            emulator
                .recover()
                .err()
                .unwrap()
                .to_string()
                .contains("authority boot mismatch")
        );
        // Abrupt process loss, followed by the original measured boot, recovers
        // the acknowledged history, ignoring the uncommitted ciphertext.
        emulator.stop();
        emulator.start();
        assert_eq!(emulator.recover().unwrap().1.unwrap().sequence, 1);
    }
}

#[test]
#[ignore = "isolated Linux swtpm fixture with restricted tmpfs and no swap"]
fn emulator_rejects_wrong_deployment_missing_seal_clear_and_cloned_disk() {
    let _serial = EMULATION.lock().unwrap();
    let emulator = Emulator::new();
    let mut journal = emulator.provision();
    journal.commit(b"retained state").unwrap();
    drop(journal);
    assert!(
        recover(&emulator.disk(), [8; 32], &emulator.boot, emulator.driver())
            .err()
            .unwrap()
            .to_string()
            .contains("sealed deployment mismatch")
    );
    let seal = fs::read(emulator.disk().join("seal.json")).unwrap();
    fs::remove_file(emulator.disk().join("seal.json")).unwrap();
    assert!(emulator.recover().is_err());
    assert!(provision(&emulator.disk(), [7; 32], &emulator.boot, emulator.driver()).is_err());
    fs::write(emulator.disk().join("seal.json"), &seal).unwrap();
    let other = Emulator::new();
    drop(other.provision());
    fs::write(other.disk().join("seal.json"), &seal).unwrap();
    assert!(
        other
            .recover()
            .err()
            .unwrap()
            .to_string()
            .contains("TPM parent changed")
    );
    emulator.command("tpm2_clear", &["-c", "l"]);
    assert!(emulator.recover().is_err());
    // Clearing cannot turn recovery into creation, even with the old disk.
    assert!(provision(&emulator.disk(), [7; 32], &emulator.boot, emulator.driver()).is_err());
}

#[test]
#[ignore = "isolated Linux swtpm fixture with restricted tmpfs and no swap"]
fn emulator_distinguishes_valid_unwritten_index_from_missing_or_unreachable_tpm() {
    let _serial = EMULATION.lock().unwrap();
    let mut emulator = Emulator::new();
    drop(emulator.provision());
    let (journal, snapshot) = emulator.recover().unwrap();
    assert!(snapshot.is_none());
    // No cleartext root key/owner credential remains in the scratch directory.
    for entry in fs::read_dir(emulator.root.path().join("memory")).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            for secret in ["secrets", "owner.auth", "unsealed"] {
                assert!(!path.join(secret).exists());
            }
        }
    }
    drop(journal);
    emulator.command("tpm2_clear", &["-c", "l"]);
    assert!(emulator.recover().is_err());
    emulator.stop();
    assert!(Driver::new(&emulator.root.path().join("memory"), emulator.endpoint()).is_err());
}

#[test]
#[ignore = "isolated Linux swtpm fixture with restricted tmpfs and no swap"]
fn emulator_rejects_missing_and_redefined_nv_instead_of_treating_them_as_empty() {
    let _serial = EMULATION.lock().unwrap();
    let emulator = Emulator::new();
    let mut journal = emulator.provision();
    journal.commit(b"existing history").unwrap();
    drop(journal);
    // The test runs as approved code and extracts its own FAKE owner credential
    // to inject invalid definitions. The production facade has no such API.
    let driver = emulator.driver();
    driver.check_boot(&emulator.boot).unwrap();
    let (_, policy) = driver.policies().unwrap();
    let blobs: SealedBlobs =
        serde_json::from_slice(&fs::read(emulator.disk().join("seal.json")).unwrap()).unwrap();
    driver
        .write("sealed.pub", &STANDARD.decode(blobs.public).unwrap())
        .unwrap();
    driver
        .write("sealed.priv", &STANDARD.decode(blobs.private).unwrap())
        .unwrap();
    driver
        .run(
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
        )
        .unwrap();
    driver
        .policy("sha256", "TPM2_CC_Unseal", false, || {
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
            let fake = driver.read("unsealed")?;
            write_private(&emulator.root.path().join("owner.auth"), &fake[64..])
        })
        .unwrap();
    drop(driver);
    emulator.command(
        "tpm2_nvundefine",
        &[INDEX, "-C", "o", "-P", "file:owner.auth"],
    );
    assert!(
        emulator
            .recover()
            .err()
            .unwrap()
            .to_string()
            .contains("tpm2_nvreadpublic")
    );
    assert!(
        emulator
            .command("tpm2_getcap", &["handles-nv-index"])
            .is_empty()
    );
    write_private(&emulator.root.path().join("nv.policy"), &policy).unwrap();
    emulator.command(
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
            "nt=extend|policywrite|authwrite|authread|no_da",
            "-L",
            "nv.policy",
        ],
    );
    assert!(
        emulator
            .recover()
            .err()
            .unwrap()
            .to_string()
            .contains("unsafe NV attributes")
    );
}
