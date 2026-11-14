// Included only by the owning crate's cfg(test) module; its private API stays private.
use crate::volume::crypt;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            fs::{DirBuilderExt, OpenOptionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const PAYLOAD: u64 = 16 * 1024 * 1024;
// Only disposable software test credentials. Never compiled into the daemon.
const OWN: [u8; 32] = [7; 32];
const NEXT: [u8; 32] = [8; 32];
const WRONG: [u8; 32] = [9; 32];
const LATER: [u8; 32] = [10; 32];
const AGAIN: [u8; 32] = [11; 32];

fn guard() {
    assert_eq!(
        std::env::var("COCO_KEYSLOT_TEST").as_deref(),
        Ok("isolated-owned-file")
    );
}

fn open(path: &Path) -> File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .unwrap()
}

fn owned(path: &Path) -> OwnedDevice {
    OwnedDevice::open(open(path)).unwrap()
}

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(60)
}

fn hash_range(path: &Path, offset: u64, length: u64) -> Vec<u8> {
    let mut file = File::open(path).unwrap();
    file.seek(SeekFrom::Start(offset)).unwrap();
    let mut hash = Sha256::new();
    std::io::copy(&mut file.take(length), &mut hash).unwrap();
    hash.finalize().to_vec()
}

fn hash(path: &Path, offset: u64) -> Vec<u8> {
    hash_range(path, offset, u64::MAX)
}

// The own slot's binary key material, located by its own metadata.
fn area(path: &Path, slot: u8) -> Vec<u8> {
    let metadata = inspect(&owned(path), soon()).unwrap();
    let area = &metadata["keyslots"][slot.to_string()]["area"];
    let number = |field: &str| area[field].as_str().unwrap().parse::<u64>().unwrap();
    hash_range(path, number("offset"), number("size"))
}

fn digest(path: &Path) -> Value {
    let mut digest = inspect(&owned(path), soon()).unwrap()["digests"]["0"].clone();
    digest.as_object_mut().unwrap().remove("keyslots");
    digest
}

fn kdf(path: &Path, slot: u8) -> Value {
    inspect(&owned(path), soon()).unwrap()["keyslots"][slot.to_string()]["kdf"].clone()
}

// Same arguments as the production format, plus the fixture's UUID.
fn format(path: &Path) {
    format_with_args(path, &[]);
}

fn format_with_args(path: &Path, extra: &[&str]) {
    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .unwrap();
    file.set_len(64 * 1024 * 1024).unwrap();
    let disk = OwnedDevice::open(file).unwrap();
    let mut args = vec![
        "luksFormat",
        "--type",
        "luks2",
        "--batch-mode",
        "--uuid",
        UUID,
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
    ];
    args.extend_from_slice(extra);
    args.push(DISK);
    let (code, _) =
        crate::volume::crypt_run(&disk, &args, Some(&OWN), None, false, Some(soon())).unwrap();
    assert_eq!(code, 0, "format failed for {extra:?}");
}

fn add_args<'a>(slot: &'a str, kdf: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec![
        "luksAddKey",
        "--type",
        "luks2",
        "--disable-locks",
        "--key-slot",
        "0",
    ];
    args.extend(["--new-key-slot", slot]);
    args.extend(kdf);
    args.extend(["--key-file", "-", "--new-keyfile", KEY_PIPE, DISK]);
    args
}

fn add(path: &Path, slot: &str, new: &[u8; 32], kdf: &[&str]) {
    let args = add_args(slot, kdf);
    let (code, _) = crypt_run(&owned(path), &args, Some(&OWN), Some(new), false, None).unwrap();
    assert_eq!(code, 0, "fixture slot {slot}");
}

const PBKDF2: &[&str] = &[
    "--pbkdf",
    "pbkdf2",
    "--pbkdf-force-iterations",
    "1000",
    "--hash",
    "sha256",
];

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Run one step in a separate process that exits at the named point without
// returning to a caller. The parent must reopen and inspect the header.
fn worker(path: &Path, step: &str) {
    let disk = open(path);
    let fd = disk.as_raw_fd();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "keyslots::tests::stage_worker",
            "--exact",
            "--ignored",
            "--test-threads=1",
        ])
        .env("COCO_KEYSLOT_FD", fd.to_string())
        .env("COCO_KEYSLOT_STEP", step)
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(73), "stage worker {step} failed");
            return;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("stage worker {step} timed out");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "subprocess of the isolated owned-file keyslot fixture"]
fn stage_worker() {
    guard();
    let fd: i32 = std::env::var("COCO_KEYSLOT_FD").unwrap().parse().unwrap();
    assert!(fd > 2);
    let disk = OwnedDevice::open(unsafe { File::from_raw_fd(fd) }).unwrap();
    match std::env::var("COCO_KEYSLOT_STEP").unwrap().as_str() {
        "stage" => assert_eq!(
            stage_overwrite(&disk, &OWN, &LATER, soon())
                .unwrap()
                .outcome,
            Outcome::Overwritten
        ),
        "kill" => {
            let _ = stage_with(&disk, &OWN, &NEXT, soon(), || std::process::exit(73));
            panic!("stage returned without reaching its add");
        }
        _ => panic!("unknown worker step"),
    }
    std::process::exit(73);
}

fn refused(path: &Path, own: &[u8; 32], new: &[u8; 32], reason: &str) {
    let header = hash(path, 0);
    let error = format!(
        "{:#}",
        stage_overwrite(&owned(path), own, new, soon()).unwrap_err()
    );
    assert!(error.contains(reason), "{reason}: {error}");
    assert_eq!(header, hash(path, 0), "{reason}: refused stage wrote");
}

#[test]
#[ignore = "explicit unprivileged Linux container, cryptsetup and owned tmpfs required"]
fn real_luks_keyslots() {
    guard();
    let root = PathBuf::from(format!(
        "/tmp/coco-keyslots-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    DirBuilder::new().mode(0o700).create(&root).unwrap();
    let fixture = Fixture(root.clone());
    let path = root.join("fixture.img");
    format(&path);
    // A payload-region preservation check, not an encrypted filesystem.
    let mut file = open(&path);
    file.seek(SeekFrom::Start(PAYLOAD)).unwrap();
    file.write_all(b"disposable payload region must remain byte-for-byte unchanged")
        .unwrap();
    file.sync_all().unwrap();
    drop(file);
    let payload = hash(&path, PAYLOAD);
    let volume = digest(&path);
    let first = area(&path, 0);
    let staged = |outcome, own, slot| Staged {
        outcome,
        own,
        slot,
        uuid: UUID.into(),
    };

    refused(&path, &WRONG, &NEXT, "own passphrase denied");
    refused(&path, &OWN, &OWN, "distinct");
    let described = |own: &[u8; 32]| layout(&owned(&path), own, soon());
    let expected = |occupied: &[u8], own| Layout {
        uuid: UUID.into(),
        occupied: occupied.to_vec(),
        own,
    };
    assert_eq!(described(&OWN).unwrap(), expected(&[0], 0));
    let error = described(&WRONG).unwrap_err().to_string();
    assert!(error.contains("own passphrase denied"), "{error}");

    let result = stage_overwrite(&owned(&path), &OWN, &NEXT, soon()).unwrap();
    assert_eq!(result, staged(Outcome::Staged, 0, 1));
    assert_eq!(described(&OWN).unwrap(), expected(&[0, 1], 0));
    assert_eq!(described(&NEXT).unwrap(), expected(&[0, 1], 1));
    let disk = owned(&path);
    assert!(accepts(&disk, 0, &OWN, soon()).unwrap() && accepts(&disk, 1, &NEXT, soon()).unwrap());
    assert!(
        !accepts(&disk, 1, &OWN, soon()).unwrap() && !accepts(&disk, 0, &NEXT, soon()).unwrap()
    );
    drop(disk);
    let added = kdf(&path, 1);
    assert_eq!(
        (&added["type"], &added["hash"], &added["iterations"]),
        (&json!("pbkdf2"), &json!("sha256"), &json!(1000))
    );

    // A kill needs a passphrase for a remaining slot: neither a wrong one nor
    // the killed slot's own passes, and neither writes.
    let header = hash(&path, 0);
    for key in [&WRONG, &NEXT] {
        assert_eq!(kill(&owned(&path), 1, key, soon()).unwrap(), 2);
    }
    assert_eq!(header, hash(&path, 0), "denied kill wrote");

    let header = hash(&path, 0);
    let result = stage_overwrite(&owned(&path), &OWN, &NEXT, soon()).unwrap();
    assert_eq!(result, staged(Outcome::AlreadyStaged, 0, 1));
    assert_eq!(header, hash(&path, 0), "idempotent stage wrote");

    let result = stage_overwrite(&owned(&path), &OWN, &LATER, soon()).unwrap();
    assert_eq!(result, staged(Outcome::Overwritten, 0, 1));
    let disk = owned(&path);
    assert!(
        accepts(&disk, 1, &LATER, soon()).unwrap() && !accepts(&disk, 1, &NEXT, soon()).unwrap()
    );
    drop(disk);
    assert_eq!(first, area(&path, 0));

    worker(&path, "kill");
    let disk = owned(&path);
    assert_eq!(slots(&inspect(&disk, soon()).unwrap()).unwrap(), [0]);
    assert!(accepts(&disk, 0, &OWN, soon()).unwrap());
    drop(disk);
    assert_eq!(first, area(&path, 0));
    assert_eq!(volume, digest(&path));
    assert_eq!(payload, hash(&path, PAYLOAD));

    // Past its deadline an add is killed and reaped before it writes, and an
    // expired stage starts nothing.
    let header = hash(&path, 0);
    let started = Instant::now();
    let slow = [
        "--pbkdf",
        "pbkdf2",
        "--pbkdf-force-iterations",
        "2000000000",
    ];
    let deadline = Some(started + Duration::from_millis(500));
    let error = crypt_run(
        &owned(&path),
        &add_args("1", &slow),
        Some(&OWN),
        Some(&NEXT),
        false,
        deadline,
    );
    let error = error.unwrap_err().to_string();
    assert!(error.contains("inspect before retry"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(10));
    let reaped = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD);
    assert!(reaped, "cryptsetup left unreaped");
    let error = stage_overwrite(&owned(&path), &OWN, &NEXT, Instant::now()).unwrap_err();
    assert!(error.to_string().contains("nothing started"), "{error}");
    assert_eq!(header, hash(&path, 0), "interrupted stage wrote");

    let result = stage_overwrite(&owned(&path), &OWN, &NEXT, soon()).unwrap();
    assert_eq!(result, staged(Outcome::Staged, 0, 1));

    worker(&path, "stage");
    let header = hash(&path, 0);
    let result = stage_overwrite(&owned(&path), &OWN, &LATER, soon()).unwrap();
    assert_eq!(result, staged(Outcome::AlreadyStaged, 0, 1));
    assert_eq!(header, hash(&path, 0), "retry after a lost reply wrote");

    // The staged release now holds the disk and stages its own successor over
    // the previous holder's slot.
    let second = area(&path, 1);
    let result = stage_overwrite(&owned(&path), &LATER, &NEXT, soon()).unwrap();
    assert_eq!(result, staged(Outcome::Overwritten, 1, 0));
    assert_eq!(described(&LATER).unwrap(), expected(&[0, 1], 1));
    assert!(described(&OWN).is_err());
    let disk = owned(&path);
    assert!(accepts(&disk, 0, &NEXT, soon()).unwrap() && !accepts(&disk, 0, &OWN, soon()).unwrap());
    drop(disk);
    assert_eq!(second, area(&path, 1));
    refused(&path, &OWN, &AGAIN, "own passphrase denied");

    // Staging follows the owned descriptor, never a replaced pathname.
    let disk = owned(&path);
    let moved = root.join("moved.img");
    fs::rename(&path, &moved).unwrap();
    fs::write(&path, b"must not be opened or mutated").unwrap();
    let result = stage_overwrite(&disk, &LATER, &AGAIN, soon()).unwrap();
    assert_eq!(result, staged(Outcome::Overwritten, 1, 0));
    drop(disk);
    assert_eq!(fs::read(&path).unwrap(), b"must not be opened or mutated");
    assert_eq!(second, area(&moved, 1));
    assert_eq!(volume, digest(&moved));
    assert_eq!(payload, hash(&moved, PAYLOAD));
    assert_eq!(volume_uuid(&owned(&moved), soon()).unwrap(), UUID);
    fs::remove_file(&moved).unwrap();
    fs::remove_file(&path).unwrap();

    // Incompatible layouts are refused before any write, never repaired.
    let layout = root.join("layout.img");
    for (case, reason) in [
        ("token", "unexpected LUKS token"),
        ("extra slot", "unexpected keyslot"),
        ("argon2id", "unsupported keyslot KDF"),
        ("same passphrase", "opens both slots"),
        ("not LUKS", "LUKS UUID"),
    ] {
        if case == "not LUKS" {
            let file = File::create(&layout).unwrap();
            file.set_len(64 * 1024 * 1024).unwrap();
        } else {
            format(&layout);
        }
        match case {
            "token" => assert!(crypt(
                &owned(&layout),
                &[
                    "token",
                    "add",
                    "--key-description",
                    "coco-test",
                    "--disable-locks",
                    DISK
                ],
                None
            )
            .unwrap()),
            "extra slot" => add(&layout, "2", &NEXT, PBKDF2),
            "argon2id" => add(
                &layout,
                "1",
                &NEXT,
                &[
                    "--pbkdf",
                    "argon2id",
                    "--pbkdf-memory",
                    "32",
                    "--pbkdf-parallel",
                    "1",
                    "--pbkdf-force-iterations",
                    "4",
                ],
            ),
            "same passphrase" => add(&layout, "1", &OWN, PBKDF2),
            _ => {}
        }
        refused(&layout, &OWN, &NEXT, reason);
        fs::remove_file(&layout).unwrap();
    }

    let version = Command::new("/usr/sbin/cryptsetup")
        .arg("--version")
        .output()
        .unwrap();
    assert!(version.status.success());
    drop(fixture);
    assert!(!root.exists());
    println!(
        "COCO_KEYSLOT_RESULT={}",
        json!({
            "schema": 1, "result": "passed", "fixture_cleanup": true,
            "cryptsetup_version": String::from_utf8(version.stdout).unwrap().trim(),
            "fixture_uuid": UUID,
            "stages": ["negative-guards", "stage-free-slot", "pbkdf2-only", "stage-retry",
                "overwrite-stale-slot", "own-slot-unchanged", "exit-between-kill-and-add",
                "process-exit-before-ack", "reverse-direction", "retired-own-denied",
                "descriptor-pinning", "payload-region-unchanged", "volume-digest-unchanged",
                "tokens-rejected", "extra-slot-rejected", "argon2id-rejected",
                "ambiguous-own-refused", "non-luks-refused", "kill-needs-remaining-passphrase",
                "deadline-kills-and-reaps", "expired-deadline-refused",
                "layout-reports-own-slot"],
            "power_loss_qualified": false, "filesystem_recovery_qualified": false,
            "attested_handoff_qualified": false
        })
    );
}
