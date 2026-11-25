//! Recover only journaled metadata steps; this module never formats a disk or
//! changes ownership of an existing recipient directory.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

const JOURNAL: &str = "coco-volume-initialization.json";
const RECIPIENTS: &str = "coco-volume-recipients.json";
const MARKER: &str = "coco-volume-marker";
const PREFIX: &str = "coco-encrypted-volume-v1:";
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u8,
    luks_uuid: String,
    phase: String,
    marker: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Recipient {
    name: String,
    uid: u32,
    gid: u32,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Recipients {
    version: u8,
    clients: Vec<Recipient>,
}

fn read(path: &Path, maximum: u64) -> Result<Option<Vec<u8>>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let stat = file.metadata()?;
    ensure!(
        stat.is_file()
            && stat.uid() == unsafe { libc::geteuid() }
            && stat.mode() & 0o7777 == 0o600
            && stat.len() <= maximum,
        "invalid private initialization metadata"
    );
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= maximum,
        "oversized initialization metadata"
    );
    Ok(Some(bytes))
}
fn atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut random = [0; 16];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    let temporary = path.with_extension(format!("{}.tmp", hex::encode(random)));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}
fn marker_valid(marker: &str) -> bool {
    marker.strip_prefix(PREFIX).is_some_and(|suffix| {
        suffix.len() == 64
            && suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn journal(root: &Path, uuid: &str) -> Result<Option<Journal>> {
    let Some(bytes) = read(&root.join(JOURNAL), 8192)? else {
        return Ok(None);
    };
    let value: Journal = serde_json::from_slice(&bytes)?;
    ensure!(
        value.version == 1
            && value.luks_uuid == uuid
            && ["initializing", "ready"].contains(&value.phase.as_str())
            && marker_valid(&value.marker),
        "invalid initialization journal"
    );
    Ok(Some(value))
}
pub(crate) fn marker(root: &Path, uuid: &str, initialize: bool) -> Result<()> {
    let value = if initialize {
        ensure!(
            !root.join(JOURNAL).exists(),
            "new filesystem already has initialization state"
        );
        let mut random = [0; 32];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let value = Journal {
            version: 1,
            luks_uuid: uuid.into(),
            phase: "initializing".into(),
            marker: format!("{PREFIX}{}", hex::encode(random)),
        };
        atomic(&root.join(JOURNAL), &value)?;
        Some(value)
    } else {
        journal(root, uuid)?
    };
    if let Some(value) = value {
        match read(&root.join(MARKER), 128)? {
            Some(bytes) => ensure!(
                bytes == value.marker.as_bytes(),
                "initialization marker differs from journal"
            ),
            None => {
                ensure!(
                    value.phase == "initializing",
                    "completed filesystem marker missing"
                );
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(root.join(MARKER))?;
                file.write_all(value.marker.as_bytes())?;
                file.sync_all()?;
                File::open(root)?.sync_all()?;
            }
        }
    }
    Ok(())
}
pub(crate) fn recipients(root: &Path, clients: &[crate::generic_config::Client]) -> Result<()> {
    let mut previous = BTreeMap::new();
    if let Some(bytes) = read(&root.join(RECIPIENTS), 16384)? {
        let value: Recipients = serde_json::from_slice(&bytes)?;
        ensure!(
            value.version == 1 && value.clients.len() <= 64,
            "invalid recipient journal"
        );
        for client in value.clients {
            ensure!(
                crate::generic_config::name(&client.name) && client.name != MARKER,
                "invalid recipient history name"
            );
            ensure!(
                previous.insert(client.name.clone(), client).is_none(),
                "duplicate recipient journal"
            );
        }
    }
    ensure!(
        previous.len()
            + clients
                .iter()
                .filter(|c| !previous.contains_key(&c.name))
                .count()
            <= 64,
        "recipient history exceeds bound"
    );
    for client in clients {
        ensure!(
            client.name != MARKER,
            "recipient conflicts with private volume marker"
        );
        if let Some(old) = previous.get(&client.name) {
            ensure!(
                old.uid == client.uid && old.gid == client.gid,
                "persistent recipient identity changed"
            );
        }
        let path = root.join(&client.name);
        match fs::symlink_metadata(&path) {
            Ok(stat) => ensure!(
                stat.is_dir() && !stat.file_type().is_symlink() && stat.uid() == client.uid,
                "invalid persistent client directory"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ensure!(
                    !previous.contains_key(&client.name),
                    "existing recipient directory missing"
                );
                // Prepare a private, unexported empty directory before an
                // exclusive rename. A crash cannot publish a root-owned client
                // path; retries may finish only this bounded empty staging dir.
                let staging = root.join(format!(".coco-recipient-{}", client.name));
                match fs::create_dir(&staging) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
                use std::os::fd::AsRawFd;
                let staging_name = std::ffi::CString::new(staging.as_os_str().as_encoded_bytes())?;
                let fd = unsafe {
                    libc::open(
                        staging_name.as_ptr(),
                        libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                ensure!(
                    fd >= 0,
                    "pin private recipient staging: {}",
                    std::io::Error::last_os_error()
                );
                use std::os::fd::FromRawFd;
                let pinned = unsafe { File::from_raw_fd(fd) };
                let stat = pinned.metadata()?;
                ensure!(stat.is_dir(), "unsafe recipient staging directory");
                if stat.uid() == unsafe { libc::geteuid() } {
                    // Before chown the helper owns the private staging inode;
                    // unknown contents are never removed or reassigned.
                    let directory = File::open(format!("/proc/self/fd/{}", pinned.as_raw_fd()))?;
                    ensure!(
                        fs::read_dir(&staging)?.next().is_none(),
                        "nonempty recipient staging directory"
                    );
                    directory.set_permissions(fs::Permissions::from_mode(0o700))?;
                    ensure!(
                        unsafe { libc::fchown(directory.as_raw_fd(), client.uid, client.gid) } == 0,
                        "client directory ownership failed"
                    );
                    directory.sync_all()?;
                } else {
                    // A crash after chown may leave this inaccessible to the
                    // capability-restricted root helper. It was never exported;
                    // publish only its already-correct identity, preserving bytes.
                    ensure!(
                        stat.uid() == client.uid
                            && stat.gid() == client.gid
                            && stat.mode() & 0o7777 == 0o700,
                        "unsafe staged recipient identity"
                    );
                }
                let from = std::ffi::CString::new(staging.as_os_str().as_encoded_bytes())?;
                let to = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
                ensure!(
                    unsafe {
                        libc::syscall(
                            libc::SYS_renameat2,
                            libc::AT_FDCWD,
                            from.as_ptr(),
                            libc::AT_FDCWD,
                            to.as_ptr(),
                            libc::RENAME_NOREPLACE,
                        )
                    } == 0,
                    "client directory publication failed"
                );
                File::open(root)
                    .context("open recipient parent")?
                    .sync_all()
                    .context("sync recipient parent")?;
            }
            Err(error) => return Err(error.into()),
        }
        previous.insert(
            client.name.clone(),
            Recipient {
                name: client.name.clone(),
                uid: client.uid,
                gid: client.gid,
            },
        );
    }
    File::open(root)
        .context("open recipient root")?
        .sync_all()
        .context("sync recipient root")?;
    atomic(
        &root.join(RECIPIENTS),
        &Recipients {
            version: 1,
            clients: previous.into_values().collect(),
        },
    )
    .context("publish recipient journal")
}
pub(crate) fn complete(root: &Path, uuid: &str) -> Result<()> {
    let mut value = match journal(root, uuid)? {
        Some(value) => value,
        None => {
            let bytes = read(&root.join(MARKER), 128)?
                .ok_or_else(|| anyhow::anyhow!("volume marker missing"))?;
            let marker = String::from_utf8(bytes)?;
            ensure!(marker_valid(&marker), "invalid legacy volume marker");
            Journal {
                version: 1,
                luks_uuid: uuid.into(),
                phase: "ready".into(),
                marker,
            }
        }
    };
    value.phase = "ready".into();
    atomic(&root.join(JOURNAL), &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> Fixture {
        let mut bytes = [0; 16];
        File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut bytes)
            .unwrap();
        let path = std::env::temp_dir().join(hex::encode(bytes));
        fs::create_dir(&path).unwrap();
        Fixture(path)
    }
    fn client(name: &str) -> crate::generic_config::Client {
        crate::generic_config::Client {
            name: name.into(),
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
        }
    }
    #[test]
    fn interrupted_metadata_resumes_and_new_recipients_preserve_existing_data() {
        let root = fixture();
        let uuid = "synthetic-volume";
        marker(&root.0, uuid, true).unwrap();
        fs::remove_file(root.0.join(MARKER)).unwrap();
        marker(&root.0, uuid, false).unwrap();
        recipients(&root.0, &[client("app")]).unwrap();
        fs::write(root.0.join("app/preserved"), b"owner data").unwrap();
        complete(&root.0, uuid).unwrap();
        recipients(&root.0, &[client("app"), client("audit")]).unwrap();
        assert_eq!(
            fs::read(root.0.join("app/preserved")).unwrap(),
            b"owner data"
        );
        fs::remove_file(root.0.join(MARKER)).unwrap();
        assert!(marker(&root.0, uuid, false).is_err());
    }
    #[test]
    fn interrupted_recipient_staging_is_resumable_but_never_replaces_unknown_data() {
        let root = fixture();
        fs::create_dir(root.0.join(".coco-recipient-app")).unwrap();
        recipients(&root.0, &[client("app")]).unwrap();
        assert!(root.0.join("app").is_dir());
        fs::create_dir(root.0.join(".coco-recipient-audit")).unwrap();
        fs::write(root.0.join(".coco-recipient-audit/unknown"), b"preserve").unwrap();
        assert!(recipients(&root.0, &[client("app"), client("audit")]).is_err());
        assert_eq!(
            fs::read(root.0.join(".coco-recipient-audit/unknown")).unwrap(),
            b"preserve"
        );
        std::os::unix::fs::symlink(root.0.join("app"), root.0.join(".coco-recipient-link"))
            .unwrap();
        assert!(recipients(&root.0, &[client("link")]).is_err());
    }
    #[test]
    fn ambiguous_marker_existing_files_and_recipient_identity_are_never_replaced() {
        let root = fixture();
        fs::write(root.0.join(MARKER), b"unrecognized old data").unwrap();
        assert!(complete(&root.0, "test").is_err());
        fs::write(root.0.join("app"), b"must not delete").unwrap();
        assert!(recipients(&root.0, &[client("app")]).is_err());
        assert_eq!(fs::read(root.0.join("app")).unwrap(), b"must not delete");
        fs::remove_file(root.0.join("app")).unwrap();
        recipients(&root.0, &[client("app")]).unwrap();
        let mut other = client("app");
        other.uid += 1;
        assert!(recipients(&root.0, &[other]).is_err());
        fs::remove_dir(root.0.join("app")).unwrap();
        assert!(recipients(&root.0, &[client("app")]).is_err());
    }
    #[test]
    fn private_journals_reject_symlinks_oversize_and_path_injection() {
        let root = fixture();
        let outside = root.0.join("preserved");
        fs::write(&outside, b"preserve").unwrap();
        std::os::unix::fs::symlink(&outside, root.0.join(JOURNAL)).unwrap();
        assert!(marker(&root.0, "test", false).is_err());
        fs::remove_file(root.0.join(JOURNAL)).unwrap();
        fs::write(root.0.join(JOURNAL), vec![0; 8193]).unwrap();
        fs::set_permissions(root.0.join(JOURNAL), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(marker(&root.0, "test", false).is_err());
        atomic(
            &root.0.join(RECIPIENTS),
            &Recipients {
                version: 1,
                clients: vec![Recipient {
                    name: "../preserved".into(),
                    uid: 11000,
                    gid: 11000,
                }],
            },
        )
        .unwrap();
        assert!(recipients(&root.0, &[client("app")]).is_err());
        assert_eq!(fs::read(outside).unwrap(), b"preserve");
    }
    #[test]
    #[ignore = "explicit disposable root helper container, only measured storage capabilities"]
    fn isolated_private_recipient_staging_survives_chown_interruption() {
        assert_eq!(
            std::env::var("COCO_RECIPIENT_TEST").as_deref(),
            Ok("isolated-tmpfs")
        );
        assert_eq!(unsafe { libc::geteuid() }, 0);
        let root = fixture();
        let pending = root.0.join(".coco-recipient-app");
        fs::create_dir(&pending).unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o700)).unwrap();
        let path = std::ffi::CString::new(pending.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::chown(path.as_ptr(), 11000, 11000) }, 0);
        crate::mount_handoff::storage_credentials().unwrap();
        assert!(
            fs::read_dir(&pending).is_err(),
            "fixture must match restricted helper without DAC override"
        );
        recipients(
            &root.0,
            &[crate::generic_config::Client {
                name: "app".into(),
                uid: 11000,
                gid: 11000,
            }],
        )
        .unwrap();
        let stat = fs::symlink_metadata(root.0.join("app")).unwrap();
        assert_eq!(
            (stat.uid(), stat.gid(), stat.mode() & 0o7777),
            (11000, 11000, 0o700)
        );
        assert!(!pending.exists());
    }
}
