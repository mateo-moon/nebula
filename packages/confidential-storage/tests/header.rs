// Included by keyslots::tests, beside the original owned-file fixture. These
// are synthetic local credentials and disks, never a hardware qualification.

// cryptsetup refuses to CREATE null-cipher keyslots, including in vulnerable
// versions. Build a real host-crafted header instead, without patching the tool:
// retain a genuine digest of a known synthetic volume key, replace the keyslot
// area with its unencrypted AF stripes, and recompute both public checksums.
// LUKS2 binary layout: cryptsetup's docs/on-disk-format-luks2.pdf, v2.8.8.
fn null_cipher_header(path: &Path) {
    let key_path = path.with_extension("test-key");
    let volume_key: [u8; 64] = std::array::from_fn(|index| index as u8 + 1);
    let mut key_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&key_path)
        .unwrap();
    key_file.write_all(&volume_key).unwrap();
    drop(key_file);
    format_with_args(path, &["--volume-key-file", key_path.to_str().unwrap()]);
    fs::remove_file(key_path).unwrap();
    let mut file = open(path);
    let metadata = inspect(&owned(path), soon()).unwrap();
    assert_eq!(metadata["keyslots"]["0"]["area"]["offset"], "32768");
    // The first 3999 stripes are zero, so their AF merge is repeated diffusion
    // of the previous state. The final stripe XORs that state with the test key.
    let mut state = [0_u8; 64];
    for _ in 0..3999 {
        for (index, block) in state.chunks_exact_mut(32).enumerate() {
            let mut hash = Sha256::new();
            hash.update((index as u32).to_be_bytes());
            hash.update(&*block);
            block.copy_from_slice(&hash.finalize());
        }
    }
    let mut stripes = vec![0_u8; 258048];
    for index in 0..64 {
        stripes[3999 * 64 + index] = state[index] ^ volume_key[index];
    }
    file.seek(SeekFrom::Start(32768)).unwrap();
    file.write_all(&stripes).unwrap();
    for offset in [0, 16384] {
        file.seek(SeekFrom::Start(offset)).unwrap();
        let mut header = vec![0; 16384];
        file.read_exact(&mut header).unwrap();
        assert_eq!(&header[8..16], &16384_u64.to_be_bytes());
        assert_eq!(&header[72..79], b"sha256\0");
        let mut value = metadata.clone();
        value["keyslots"]["0"]["area"]["encryption"] = json!("cipher_null-ecb");
        let json = serde_json::to_vec(&value).unwrap();
        assert!(json.len() < 12288);
        header[4096..].fill(0);
        header[4096..4096 + json.len()].copy_from_slice(&json);
        header[448..512].fill(0);
        let checksum = Sha256::digest(&header);
        header[448..480].copy_from_slice(&checksum);
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(&header).unwrap();
    }
    file.sync_all().unwrap();
}

#[test]
#[ignore = "explicit unprivileged Linux container, cryptsetup and owned tmpfs required"]
fn real_hostile_headers() {
    guard();
    let root = PathBuf::from(format!(
        "/tmp/coco-hostile-headers-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    DirBuilder::new().mode(0o700).create(&root).unwrap();
    let _fixture = Fixture(root.clone());
    let path = root.join("fixture.img");

    // The actual production preparation path pins both metadata and encrypted
    // keyslot bytes. Changing the host's disk afterwards must not change what
    // is inspected or which passphrase unlocks that snapshot.
    format(&path);
    let mut disk = owned(&path);
    crate::volume::prepare_unlock(&mut disk, soon()).unwrap();
    let metadata = inspect(&disk, soon()).unwrap();
    assert!(accepts(&disk, 0, &OWN, soon()).unwrap());
    assert!(!accepts(&disk, 0, &WRONG, soon()).unwrap());
    open(&path).write_all(&vec![0; PAYLOAD as usize]).unwrap();
    assert_eq!(inspect(&disk, soon()).unwrap(), metadata);
    assert!(accepts(&disk, 0, &OWN, soon()).unwrap());
    assert!(!accepts(&disk, 0, &WRONG, soon()).unwrap());
    assert!(crate::volume::prepare_unlock(&mut disk, soon()).is_err());
    // Pinned headers cannot be used to format or rewrite a keyslot.
    assert!(crypt(&disk, &["luksFormat", DISK], Some(&OWN)).is_err());
    assert!(crypt(&disk, &["luksKillSlot", DISK, "0"], Some(&OWN)).is_err());
    drop(disk);
    fs::remove_file(&path).unwrap();

    null_cipher_header(&path);
    let before = hash(&path, 0);
    let mut disk = owned(&path);
    let error = crate::volume::prepare_unlock(&mut disk, soon()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("unsupported keyslot area cipher"),
        "{error:#}"
    );
    // Defense in depth: the patched cryptsetup must independently reject this
    // header for ANY nonempty passphrase, not only the daemon's preflight.
    assert!(!accepts(&disk, 0, &OWN, soon()).unwrap());
    assert!(!accepts(&disk, 0, &WRONG, soon()).unwrap());
    drop(disk);
    assert_eq!(hash(&path, 0), before, "refused header was modified");
    fs::remove_file(&path).unwrap();

    // Real cryptsetup-generated headers, with a legitimate encrypted data
    // segment but an unacceptable keyslot cipher/size. Refusal is required
    // before unlocking and must leave every backing byte unchanged.
    for extra in [
        vec![
            "--keyslot-cipher",
            "aes-cbc-plain64",
            "--keyslot-key-size",
            "256",
        ],
        vec![
            "--keyslot-cipher",
            "aes-xts-plain64",
            "--keyslot-key-size",
            "256",
        ],
    ] {
        format_with_args(&path, &extra);
        let before = hash(&path, 0);
        let mut disk = owned(&path);
        let error = crate::volume::prepare_unlock(&mut disk, soon()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unsupported keyslot area cipher"),
            "{extra:?}: {error:#}"
        );
        drop(disk);
        assert_eq!(hash(&path, 0), before, "refused header was modified");
        fs::remove_file(&path).unwrap();
    }
}
