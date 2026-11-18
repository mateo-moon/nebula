//! LUKS2 layout inspection on the holder's owned device, with no key export,
//! formatting or authorization API. Staging primitives compile only into the
//! disposable-header test binary; no production handoff can call them.
//!
//! In the isolated fixture, the own slot is the one the holder's own passphrase
//! opens and is never written. The other slot receives the target passphrase; a stale occupant is
//! killed first, so the previous release keeps its slot until the next stage.
//! Overwriting a slot does not rotate the volume key and is not revocation.
use crate::device::{OwnedDevice, LUKS_HEADER_BYTES};
#[cfg(test)]
use crate::volume::KEY_PIPE;
use crate::volume::{crypt_run, DISK};
use anyhow::{bail, ensure, Context, Result};
use serde_json::Value;
use std::time::Instant;

#[derive(Debug, PartialEq, Eq)]
#[cfg(test)]
pub(crate) enum Outcome {
    Staged,
    Overwritten,
    AlreadyStaged,
}

#[derive(Debug, PartialEq, Eq)]
#[cfg(test)]
pub(crate) struct Staged {
    pub outcome: Outcome,
    pub own: u8,
    pub slot: u8,
    pub uuid: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Layout {
    pub uuid: String,
    pub occupied: Vec<u8>,
    pub own: u8,
}

/// Public-to-the-crate entry point for all production unlock paths. A separate
/// read of the mutable backing device cannot establish this check/use binding.
pub(crate) fn validate(disk: &OwnedDevice, deadline: Instant) -> Result<()> {
    ensure!(
        disk.header_fd().is_some(),
        "LUKS inspection requires a pinned header"
    );
    inspect(disk, deadline)?;
    Ok(())
}

/// The accepted layout and the one slot the own passphrase opens.
pub(crate) fn layout(disk: &OwnedDevice, own: &[u8; 32], deadline: Instant) -> Result<Layout> {
    let uuid = volume_uuid(disk, deadline)?;
    let occupied = slots(&inspect(disk, deadline)?)?;
    let own = own_slot(disk, &occupied, own, deadline)?;
    Ok(Layout {
        uuid,
        occupied,
        own,
    })
}

fn own_slot(disk: &OwnedDevice, occupied: &[u8], own: &[u8; 32], deadline: Instant) -> Result<u8> {
    let mut opened = Vec::new();
    for slot in occupied {
        if accepts(disk, *slot, own, deadline)? {
            opened.push(*slot);
        }
    }
    match opened[..] {
        [slot] => Ok(slot),
        [] => bail!("own passphrase denied"),
        _ => bail!("own passphrase opens both slots"),
    }
}

/// Put `new` into the slot the own passphrase does not open. Callers supply
/// only domain-separated 32-byte LUKS passphrases, never raw SNP keys. No
/// cryptsetup call outlives `deadline`: it is killed and reaped instead.
#[cfg(test)]
pub(crate) fn stage_overwrite(
    disk: &OwnedDevice,
    own: &[u8; 32],
    new: &[u8; 32],
    deadline: Instant,
) -> Result<Staged> {
    stage_with(disk, own, new, deadline, || Ok(()))
}

#[cfg(test)]
fn stage_with(
    disk: &OwnedDevice,
    own: &[u8; 32],
    new: &[u8; 32],
    deadline: Instant,
    before_add: impl FnOnce() -> Result<()>,
) -> Result<Staged> {
    ensure!(
        own != new,
        "stage requires a passphrase distinct from the own one"
    );
    let uuid = volume_uuid(disk, deadline)?;
    let before = inspect(disk, deadline)?;
    let occupied = slots(&before)?;
    let own_slot = own_slot(disk, &occupied, own, deadline)?;
    let slot = 1 - own_slot;
    let (own_arg, slot_arg) = (own_slot.to_string(), slot.to_string());
    let staged = |outcome| Staged {
        outcome,
        own: own_slot,
        slot,
        uuid: uuid.clone(),
    };
    let mut outcome = Outcome::Staged;
    if occupied.contains(&slot) {
        if accepts(disk, slot, new, deadline)? {
            return Ok(staged(Outcome::AlreadyStaged));
        }
        ensure!(
            kill(disk, slot, own, deadline)? == 0,
            "stale slot removal failed; inspect before retry"
        );
        disk.sync_all()?;
        let killed = inspect(disk, deadline)?;
        ensure!(
            slots(&killed)? == [own_slot],
            "stale slot removal incomplete"
        );
        unchanged(&before, &killed, own_slot)?;
        outcome = Outcome::Overwritten;
    }
    before_add()?;
    let (code, _) = crypt_run(
        disk,
        &[
            "luksAddKey",
            "--type",
            "luks2",
            "--disable-locks",
            "--key-slot",
            &own_arg,
            "--new-key-slot",
            &slot_arg,
            "--pbkdf",
            "pbkdf2",
            "--pbkdf-force-iterations",
            "1000",
            "--hash",
            "sha256",
            "--key-file",
            "-",
            "--keyfile-size",
            "32",
            "--new-keyfile",
            KEY_PIPE,
            "--new-keyfile-size",
            "32",
            DISK,
        ],
        Some(own),
        Some(new),
        false,
        Some(deadline),
    )?;
    ensure!(code == 0, "stage failed ({code}); inspect before retry");
    disk.sync_all()?;
    let after = inspect(disk, deadline)?;
    ensure!(slots(&after)? == [0, 1], "stage incomplete");
    unchanged(&before, &after, own_slot)?;
    ensure!(
        accepts(disk, own_slot, own, deadline)? && accepts(disk, slot, new, deadline)?,
        "staged passphrase verification failed"
    );
    ensure!(volume_uuid(disk, deadline)? == uuid, "LUKS UUID changed");
    Ok(staged(outcome))
}

// Only a passphrase for a remaining slot authorizes the wipe; exit 2 denies it.
// No batch mode, no luksRemoveKey, and the credential never comes from stdin.
#[cfg(test)]
fn kill(disk: &OwnedDevice, slot: u8, own: &[u8; 32], deadline: Instant) -> Result<i32> {
    let (code, _) = crypt_run(
        disk,
        &[
            "luksKillSlot",
            "--type",
            "luks2",
            "--disable-locks",
            "--key-file",
            KEY_PIPE,
            "--keyfile-size",
            "32",
            DISK,
            &slot.to_string(),
        ],
        None,
        Some(own),
        false,
        Some(deadline),
    )?;
    Ok(code)
}

// Only the other slot and its digest binding may change.
#[cfg(test)]
fn unchanged(before: &Value, after: &Value, own: u8) -> Result<()> {
    let own = own.to_string();
    ensure!(
        before["segments"] == after["segments"],
        "data segment changed"
    );
    ensure!(
        before["keyslots"][&own] == after["keyslots"][&own],
        "own slot changed"
    );
    let digest = |v: &Value| {
        let mut digest = v["digests"]["0"].clone();
        if let Some(digest) = digest.as_object_mut() {
            digest.remove("keyslots");
        }
        digest
    };
    ensure!(digest(before) == digest(after), "volume key digest changed");
    Ok(())
}

// The only accepted layout: slots 0 and 1 at most, each pbkdf2-sha256 with the
// fixed iterations and AES-XTS keyslot areas inside the sealed header prefix,
// one aes-xts segment, one digest bound to every slot and no token.
// Returns the occupied slots in order.
fn slots(metadata: &Value) -> Result<Vec<u8>> {
    let config = &metadata["config"];
    ensure!(
        config["json_size"] == "12288"
            && config["keyslots_size"] == "16744448"
            && config.get("requirements").is_none()
            && config
                .get("flags")
                .is_none_or(|v| v.as_array().is_some_and(|v| v.is_empty())),
        "unsupported LUKS metadata layout or persistent requirements"
    );
    let slots = metadata["keyslots"]
        .as_object()
        .context("missing LUKS2 slots")?;
    ensure!(
        !slots.is_empty() && slots.len() <= 2,
        "unexpected number of slots"
    );
    let mut occupied = Vec::new();
    let mut areas = Vec::new();
    for (id, slot) in slots {
        match id.as_str() {
            "0" => occupied.push(0),
            "1" => occupied.push(1),
            _ => bail!("unexpected keyslot"),
        }
        ensure!(
            slot["type"] == "luks2" && slot["key_size"] == 64,
            "unsupported keyslot"
        );
        ensure!(
            slot["kdf"]["type"] == "pbkdf2"
                && slot["kdf"]["hash"] == "sha256"
                && slot["kdf"]["iterations"] == 1000,
            "unsupported keyslot KDF"
        );
        let area = &slot["area"];
        ensure!(
            area["type"] == "raw"
                && area["encryption"] == "aes-xts-plain64"
                && area["key_size"] == 64,
            "unsupported keyslot area cipher"
        );
        ensure!(
            slot["af"]["type"] == "luks1"
                && slot["af"]["stripes"] == 4000
                && slot["af"]["hash"] == "sha256",
            "unsupported keyslot AF parameters"
        );
        let offset = decimal(&area["offset"]).context("invalid keyslot area offset")?;
        let size = decimal(&area["size"]).context("invalid keyslot area size")?;
        let end = offset.checked_add(size).context("keyslot area overflow")?;
        ensure!(
            offset >= 32768
                && offset % 4096 == 0
                && size == 258048
                && end <= LUKS_HEADER_BYTES
                && areas
                    .iter()
                    .all(|(start, end_before)| end <= *start || offset >= *end_before),
            "keyslot area outside pinned header or overlapping"
        );
        areas.push((offset, end));
    }
    occupied.sort();
    ensure!(
        metadata["tokens"].as_object().is_some_and(|v| v.is_empty()),
        "unexpected LUKS token"
    );
    let segments = metadata["segments"]
        .as_object()
        .context("missing LUKS segments")?;
    let segment = &metadata["segments"]["0"];
    ensure!(
        segments.len() == 1
            && segment["type"] == "crypt"
            && segment["encryption"] == "aes-xts-plain64"
            && segment["size"] == "dynamic"
            && segment["offset"] == "16777216"
            && segment["iv_tweak"] == "0"
            && matches!(segment["sector_size"].as_u64(), Some(512 | 4096))
            && segment.get("integrity").is_none()
            && segment
                .get("flags")
                .is_none_or(|v| v.as_array().is_some_and(|v| v.is_empty())),
        "unsupported data segment"
    );
    let digests = metadata["digests"]
        .as_object()
        .context("missing volume digest")?;
    ensure!(
        digests.len() == 1 && digests.contains_key("0"),
        "unexpected volume digests"
    );
    ensure!(
        metadata["digests"]["0"]["type"] == "pbkdf2"
            && metadata["digests"]["0"]["hash"] == "sha256",
        "unsupported volume key digest"
    );
    let linked = metadata["digests"]["0"]["keyslots"]
        .as_array()
        .context("missing bound slots")?;
    ensure!(
        metadata["digests"]["0"]["segments"] == serde_json::json!(["0"])
            && linked.len() == slots.len()
            && slots
                .keys()
                .all(|id| linked.iter().filter(|v| v.as_str() == Some(id)).count() == 1),
        "unbound or unexpected volume keys"
    );
    Ok(occupied)
}

fn decimal(value: &Value) -> Option<u64> {
    let value = value.as_str()?;
    if value.is_empty()
        || value.len() > 1 && value.starts_with('0')
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

fn inspect(disk: &OwnedDevice, deadline: Instant) -> Result<Value> {
    let (code, raw) = crypt_run(
        disk,
        &["luksDump", "--dump-json-metadata", "--disable-locks", DISK],
        None,
        None,
        true,
        Some(deadline),
    )?;
    ensure!(code == 0, "LUKS2 metadata unavailable ({code})");
    let metadata: Value = serde_json::from_slice(&raw)?;
    slots(&metadata)?;
    Ok(metadata)
}

fn accepts(disk: &OwnedDevice, slot: u8, key: &[u8; 32], deadline: Instant) -> Result<bool> {
    let (code, _) = crypt_run(
        disk,
        &[
            "open",
            "--type",
            "luks2",
            "--test-passphrase",
            "--disable-locks",
            "--disable-keyring",
            "--key-slot",
            &slot.to_string(),
            "--key-file",
            "-",
            "--keyfile-size",
            "32",
            DISK,
        ],
        Some(key),
        None,
        false,
        Some(deadline),
    )?;
    match code {
        0 => Ok(true),
        2 => Ok(false),
        _ => bail!("passphrase check failed operationally ({code})"),
    }
}

pub(crate) fn volume_uuid(disk: &OwnedDevice, deadline: Instant) -> Result<String> {
    let (code, raw) = crypt_run(
        disk,
        &["luksUUID", "--disable-locks", DISK],
        None,
        None,
        true,
        Some(deadline),
    )?;
    let uuid = std::str::from_utf8(&raw)?.trim();
    ensure!(
        code == 0 && valid_uuid(uuid),
        "cannot establish the LUKS UUID"
    );
    Ok(uuid.into())
}

pub(crate) fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

#[cfg(test)]
mod tests;
