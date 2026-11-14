//! Layout rules run everywhere; real cryptsetup runs only in the owned-file lane.
use super::*;
use serde_json::json;
const UUID: &str = "e25ab20d-0590-4c57-82bc-ed999b9b54a7";
fn dump() -> Value {
    let slot = json!({"type": "luks2", "key_size": 64,
        "af": {"type": "luks1", "stripes": 4000, "hash": "sha256"},
        "area": {"type": "raw", "offset": "32768", "size": "258048",
            "encryption": "aes-xts-plain64", "key_size": 64},
        "kdf": {"type": "pbkdf2", "hash": "sha256", "iterations": 1000,
            "salt": "c2FsdA=="}});
    let mut second = slot.clone();
    second["area"]["offset"] = json!("290816");
    json!({
        "keyslots": {"0": slot, "1": second},
        "tokens": {},
        "segments": {"0": {"type": "crypt", "offset": "16777216", "size": "dynamic",
            "iv_tweak": "0", "encryption": "aes-xts-plain64", "sector_size": 512}},
        "digests": {"0": {"type": "pbkdf2", "keyslots": ["0", "1"], "segments": ["0"],
            "hash": "sha256", "iterations": 1000, "salt": "c2FsdA==", "digest": "ZA=="}},
        "config": {"json_size": "12288", "keyslots_size": "16744448"}
    })
}

#[test]
fn layout_accepts_only_two_pbkdf2_slots_one_digest_and_one_xts_segment() {
    assert_eq!(slots(&dump()).unwrap(), [0, 1]);
    for (only, other) in [("0", "1"), ("1", "0")] {
        let mut single = dump();
        single["keyslots"].as_object_mut().unwrap().remove(other);
        single["digests"]["0"]["keyslots"] = json!([only]);
        assert_eq!(slots(&single).unwrap(), [only.parse::<u8>().unwrap()]);
    }
    let rejected = |reason: &str, mutate: fn(&mut Value)| {
        let mut value = dump();
        mutate(&mut value);
        assert!(slots(&value).is_err(), "{reason}");
    };
    rejected("token", |v| {
        v["tokens"]["0"] = json!({"type": "luks2-keyring", "keyslots": []})
    });
    rejected("tokens absent", |v| {
        v.as_object_mut().unwrap().remove("tokens");
    });
    rejected("extra slot", |v| {
        v["keyslots"]["2"] = v["keyslots"]["0"].clone();
        v["digests"]["0"]["keyslots"] = json!(["0", "1", "2"]);
    });
    rejected("no slot", |v| {
        v["keyslots"] = json!({});
        v["digests"]["0"]["keyslots"] = json!([]);
    });
    rejected("argon2id", |v| {
        v["keyslots"]["1"]["kdf"] = json!({"type": "argon2id", "time": 4,
            "memory": 32, "cpus": 1, "salt": "c2FsdA=="})
    });
    rejected("kdf hash", |v| {
        v["keyslots"]["1"]["kdf"]["hash"] = json!("sha512")
    });
    rejected("kdf iterations", |v| {
        v["keyslots"]["0"]["kdf"]["iterations"] = json!(2000)
    });
    rejected("key size", |v| v["keyslots"]["1"]["key_size"] = json!(32));
    rejected("null keyslot cipher", |v| {
        v["keyslots"]["0"]["area"]["encryption"] = json!("cipher_null")
    });
    rejected("null ECB keyslot cipher", |v| {
        v["keyslots"]["0"]["area"]["encryption"] = json!("cipher_null-ecb")
    });
    rejected("metadata size", |v| {
        v["config"]["json_size"] = json!("16384")
    });
    rejected("keyslot region size", |v| {
        v["config"]["keyslots_size"] = json!("33554432")
    });
    rejected("persistent flags", |v| {
        v["config"]["flags"] = json!(["allow-discards"])
    });
    rejected("requirements", |v| {
        v["config"]["requirements"] = json!({"mandatory":["offline-reencrypt"]})
    });
    rejected("other keyslot cipher", |v| {
        v["keyslots"]["1"]["area"]["encryption"] = json!("aes-cbc-plain64")
    });
    rejected("area absent", |v| {
        v["keyslots"]["0"].as_object_mut().unwrap().remove("area");
    });
    rejected("area type", |v| {
        v["keyslots"]["0"]["area"]["type"] = json!("unknown")
    });
    rejected("area key size", |v| {
        v["keyslots"]["0"]["area"]["key_size"] = json!(32)
    });
    rejected("AF hash", |v| {
        v["keyslots"]["0"]["af"]["hash"] = json!("sha1")
    });
    rejected("AF stripes", |v| {
        v["keyslots"]["0"]["af"]["stripes"] = json!(1)
    });
    rejected("area exceeds snapshot", |v| {
        v["keyslots"]["0"]["area"]["offset"] = json!("16777216")
    });
    rejected("area points into metadata", |v| {
        v["keyslots"]["0"]["area"]["offset"] = json!("4096")
    });
    rejected("area is not aligned", |v| {
        v["keyslots"]["0"]["area"]["offset"] = json!("32769")
    });
    rejected("area overlaps", |v| {
        v["keyslots"]["1"]["area"]["offset"] = json!("32768")
    });
    rejected("area size", |v| {
        v["keyslots"]["0"]["area"]["size"] = json!("4096")
    });
    rejected("area overflow", |v| {
        v["keyslots"]["0"]["area"]["offset"] = json!("18446744073709551615")
    });
    rejected("noncanonical number", |v| {
        v["keyslots"]["0"]["area"]["offset"] = json!("032768")
    });
    rejected("numeric not string", |v| {
        v["keyslots"]["0"]["area"]["offset"] = json!(32768)
    });
    rejected("negative number", |v| {
        v["keyslots"]["0"]["area"]["size"] = json!("-1")
    });
    rejected("volume digest type", |v| {
        v["digests"]["0"]["type"] = json!("unknown")
    });
    rejected("volume digest hash", |v| {
        v["digests"]["0"]["hash"] = json!("sha1")
    });
    rejected("sector size", |v| {
        v["segments"]["0"]["sector_size"] = json!(1024)
    });
    rejected("second digest", |v| {
        v["digests"]["1"] = v["digests"]["0"].clone()
    });
    rejected("unbound slot", |v| {
        v["digests"]["0"]["keyslots"] = json!(["0"])
    });
    rejected("doubly bound slot", |v| {
        v["digests"]["0"]["keyslots"] = json!(["0", "0"])
    });
    rejected("digest segments", |v| {
        v["digests"]["0"]["segments"] = json!(["0", "1"])
    });
    rejected("second segment", |v| {
        v["segments"]["1"] = v["segments"]["0"].clone()
    });
    rejected("cipher", |v| {
        v["segments"]["0"]["encryption"] = json!("aes-cbc-essiv:sha256")
    });
    rejected("integrity", |v| {
        v["segments"]["0"]["integrity"] = json!({"type": "hmac(sha256)"})
    });
    rejected("offset", |v| {
        v["segments"]["0"]["offset"] = json!("8388608")
    });
    rejected("size", |v| v["segments"]["0"]["size"] = json!("1048576"));
    rejected("flags", |v| {
        v["segments"]["0"]["flags"] = json!(["in-reencryption"])
    });
    rejected("slot type", |v| {
        v["keyslots"]["0"]["type"] = json!("reencrypt")
    });
    let mut renamed = dump();
    let digest = renamed["digests"].as_object_mut().unwrap().remove("0");
    renamed["digests"]["1"] = digest.unwrap();
    let error = slots(&renamed).unwrap_err().to_string();
    assert!(error.contains("unexpected volume digests"), "{error}");
}

#[test]
fn only_the_other_slot_and_its_digest_binding_may_change() {
    let check = |own: u8, mutate: fn(&mut Value)| {
        let mut after = dump();
        mutate(&mut after);
        unchanged(&dump(), &after, own)
    };
    let allowed = |own, mutate| assert!(check(own, mutate).is_ok());
    allowed(0, |_| {});
    allowed(1, |_| {});
    allowed(0, |v| v["keyslots"]["1"]["kdf"]["salt"] = json!("b3RoZXI="));
    allowed(1, |v| v["keyslots"]["0"]["kdf"]["salt"] = json!("b3RoZXI="));
    allowed(0, |v| {
        v["keyslots"].as_object_mut().unwrap().remove("1");
        v["digests"]["0"]["keyslots"] = json!(["0"]);
    });
    allowed(1, |v| v["digests"]["0"]["keyslots"] = json!(["1", "0"]));
    let rejected = |reason: &str, own, mutate| {
        let error = check(own, mutate).unwrap_err().to_string();
        assert!(error.contains(reason), "{reason}: {error}");
    };
    rejected("own slot", 0, |v| {
        v["keyslots"]["0"]["kdf"]["salt"] = json!("b3RoZXI=")
    });
    rejected("own slot", 1, |v| {
        v["keyslots"]["1"]["area"]["offset"] = json!("548864")
    });
    rejected("own slot", 0, |v| {
        v["keyslots"].as_object_mut().unwrap().remove("0");
    });
    rejected("data segment", 0, |v| {
        v["segments"]["0"]["sector_size"] = json!(4096)
    });
    rejected("volume key digest", 1, |v| {
        v["digests"]["0"]["salt"] = json!("b3RoZXI=")
    });
    rejected("volume key digest", 0, |v| {
        v["digests"]["0"]["digest"] = json!("ZQ==")
    });
}

#[test]
fn only_canonical_lowercase_uuids_are_accepted() {
    assert!(valid_uuid(UUID));
    for uuid in [
        "",
        "../device",
        "E25ab20d-0590-4c57-82bc-ed999b9b54a7",
        &UUID[1..],
    ] {
        assert!(!valid_uuid(uuid), "{uuid}");
    }
}

// Keep the ignored owned-file worker names stable for the isolated harness.
include!("../../tests/keyslots.rs");
include!("../../tests/header.rs");
