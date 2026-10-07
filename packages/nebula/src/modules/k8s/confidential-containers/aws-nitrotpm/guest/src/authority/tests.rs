use super::*;
use crate::workload::{EnvelopeSignature, signed_bytes};
use ed25519_dalek::Signer;
use std::{cell::RefCell, rc::Rc};

fn key(value: u8) -> SigningKey {
    SigningKey::from_bytes(&[value; 32])
}

fn owners(keys: &[&SigningKey], threshold: usize) -> Owners {
    let mut public: Vec<_> = keys
        .iter()
        .map(|key| STANDARD.encode(key.verifying_key().to_bytes()))
        .collect();
    public.sort();
    Owners {
        keys: public,
        threshold,
    }
}

fn signed(kind: &str, payload: &[u8], keys: &[&SigningKey]) -> Envelope {
    let message = signed_bytes(kind, payload, MAX_BYTES).unwrap();
    Envelope {
        payload_type: kind.into(),
        payload: STANDARD.encode(payload),
        signatures: keys
            .iter()
            .map(|key| EnvelopeSignature {
                keyid: hex(Sha256::digest(key.verifying_key().to_bytes())),
                sig: STANDARD.encode(key.sign(&message).to_bytes()),
            })
            .collect(),
    }
}

fn genesis() -> Genesis {
    Genesis {
        authority_release: "a".repeat(64),
        nonce: "b".repeat(64),
        owners: owners(&[&key(1), &key(2)], 2),
        runtime_releases: vec!["c".repeat(64)],
        version: 1,
    }
}

fn update(status: &LocalStatus, incoming: Owners) -> OwnerUpdate {
    OwnerUpdate {
        authority_identity: status.authority_identity.clone(),
        deployment: status.deployment.clone(),
        generation: status.generation + 1,
        owners: incoming,
        previous: status.head.clone(),
        version: 1,
    }
}

fn rotation(status: &LocalStatus) -> Envelope {
    let update = update(status, owners(&[&key(2), &key(3)], 2));
    signed(
        OWNERS_TYPE,
        &update.encode().unwrap(),
        &[&key(1), &key(2), &key(3)],
    )
}

#[derive(Clone, Copy, Default)]
enum Fault {
    #[default]
    None,
    Before,
    After,
    WrongSequence,
}

#[derive(Default)]
struct Disk {
    sequence: u64,
    bytes: Vec<u8>,
    calls: usize,
    fault: Fault,
}

#[derive(Clone, Default)]
struct Memory(Rc<RefCell<Disk>>);

impl Store for Memory {
    fn commit(&mut self, bytes: &[u8]) -> Result<u64> {
        let mut disk = self.0.borrow_mut();
        disk.calls += 1;
        ensure!(!matches!(disk.fault, Fault::Before), "write failed");
        disk.sequence += 1;
        disk.bytes = bytes.to_vec();
        ensure!(!matches!(disk.fault, Fault::After), "response lost");
        Ok(disk.sequence + u64::from(matches!(disk.fault, Fault::WrongSequence)))
    }
}

impl Memory {
    fn snapshot(&self) -> Snapshot {
        let disk = self.0.borrow();
        Snapshot {
            sequence: disk.sequence,
            bytes: Zeroizing::new(disk.bytes.clone()),
        }
    }

    fn restore(&self, deployment: &str, identity: &str) -> Result<State<Self>> {
        State::recover(
            self.clone(),
            self.snapshot(),
            deployment,
            identity,
            &genesis().authority_release,
        )
    }
}

#[test]
fn genesis_requires_an_independent_commitment_release_and_distinct_threshold() {
    let good = genesis();
    let payload = good.encode().unwrap();
    let envelope = signed(GENESIS_TYPE, &payload, &[&key(1), &key(2)]);
    let deployment = good.deployment().unwrap();
    assert_eq!(
        verify_genesis(&envelope, &deployment, &good.authority_release).unwrap(),
        good
    );
    assert!(verify_genesis(&envelope, &"e".repeat(64), &good.authority_release).is_err());
    assert!(verify_genesis(&envelope, &deployment, &"e".repeat(64)).is_err());
    for keys in [vec![key(1)], vec![key(1), key(1)], vec![key(3), key(4)]] {
        let refs: Vec<_> = keys.iter().collect();
        assert!(
            verify_genesis(
                &signed(GENESIS_TYPE, &payload, &refs),
                &deployment,
                &good.authority_release
            )
            .is_err()
        );
    }
    let mut substituted = good.clone();
    substituted.owners = owners(&[&key(3)], 1);
    let malicious = signed(GENESIS_TYPE, &substituted.encode().unwrap(), &[&key(3)]);
    assert!(verify_genesis(&malicious, &deployment, &good.authority_release).is_err());
    let other_domain = signed(OWNERS_TYPE, &payload, &[&key(1), &key(2)]);
    assert!(verify_genesis(&other_domain, &deployment, &good.authority_release).is_err());
}

#[test]
fn genesis_rejects_ambiguous_json_and_unsafe_owner_or_release_sets() {
    let good = genesis();
    let text = String::from_utf8(good.encode().unwrap()).unwrap();
    for payload in [
        format!(" {text}"),
        text.replace("\"version\":1", "\"version\":0,\"version\":1"),
        text.replace("\"version\":1", "\"version\":1,\"unknown\":true"),
    ] {
        let envelope = signed(GENESIS_TYPE, payload.as_bytes(), &[&key(1), &key(2)]);
        let commitment = hex(Sha256::digest(payload.as_bytes()));
        assert!(verify_genesis(&envelope, &commitment, &good.authority_release).is_err());
    }
    let mut bad = good.clone();
    bad.owners.keys.reverse();
    assert!(bad.encode().is_err());
    bad = good.clone();
    bad.owners.keys[1] = bad.owners.keys[0].clone();
    assert!(bad.encode().is_err());
    for threshold in [0, 3] {
        bad = good.clone();
        bad.owners.threshold = threshold;
        assert!(bad.encode().is_err());
    }
    // Encoded identity point is a structurally valid but weak Ed25519 key.
    let mut weak = [0; 32];
    weak[0] = 1;
    bad = good.clone();
    bad.owners = Owners {
        keys: vec![STANDARD.encode(weak)],
        threshold: 1,
    };
    assert!(bad.encode().is_err());
    for releases in [
        vec![],
        vec!["c".repeat(64); 2],
        vec!["d".repeat(64), "c".repeat(64)],
        vec!["bad".into()],
    ] {
        bad = good.clone();
        bad.runtime_releases = releases;
        assert!(bad.encode().is_err());
    }
}

#[test]
fn rotation_requires_both_owner_sets_and_revokes_old_keys() {
    let memory = Memory::default();
    let mut state = State::enroll(memory.clone(), genesis()).unwrap();
    let initial = state.status().unwrap().clone();
    let candidate = update(&initial, owners(&[&key(2), &key(3)], 2));
    let payload = candidate.encode().unwrap();
    for keys in [
        vec![key(1), key(2)],
        vec![key(2), key(3)],
        vec![key(1), key(1), key(3)],
        vec![key(1), key(2), key(2)],
    ] {
        let refs: Vec<_> = keys.iter().collect();
        assert!(state.apply(&signed(OWNERS_TYPE, &payload, &refs)).is_err());
        assert_eq!(state.status().unwrap(), &initial);
        assert_eq!(memory.0.borrow().calls, 1);
    }
    let envelope = rotation(&initial);
    let accepted = state.apply(&envelope).unwrap().clone();
    assert_eq!(accepted.generation, 2);
    assert_eq!(accepted.owners, candidate.owners);
    assert_eq!(memory.0.borrow().sequence, 2);
    assert_eq!(state.apply(&envelope).unwrap(), &accepted);
    assert_eq!(
        memory.0.borrow().calls,
        2,
        "retry must not write the TPM again"
    );
    let third = update(&accepted, owners(&[&key(4)], 1));
    assert!(
        state
            .apply(&signed(
                OWNERS_TYPE,
                &third.encode().unwrap(),
                &[&key(1), &key(2), &key(4)]
            ))
            .is_err()
    );
    let third_envelope = signed(
        OWNERS_TYPE,
        &third.encode().unwrap(),
        &[&key(2), &key(3), &key(4)],
    );
    assert_eq!(state.apply(&third_envelope).unwrap().generation, 3);
    assert!(
        state.apply(&envelope).is_err(),
        "old accepted updates are not valid current retries"
    );
}

#[test]
fn rotation_accepts_disjoint_full_thresholds_but_bounds_signature_work() {
    let old: Vec<_> = (1..=16).map(key).collect();
    let new: Vec<_> = (17..=32).map(key).collect();
    let mut initial = genesis();
    initial.owners = owners(&old.iter().collect::<Vec<_>>(), 16);
    let mut ledger =
        Ledger::new(initial, STANDARD.encode(key(40).verifying_key().to_bytes())).unwrap();
    let candidate = update(&ledger.status, owners(&new.iter().collect::<Vec<_>>(), 16));
    let all: Vec<_> = old.iter().chain(new.iter()).collect();
    let mut envelope = signed(OWNERS_TYPE, &candidate.encode().unwrap(), &all);
    ledger = ledger.next(&envelope).unwrap().unwrap();
    assert_eq!(ledger.status.owners.threshold, 16);
    envelope.signatures.push(envelope.signatures[0].clone());
    assert!(ledger.next(&envelope).is_err());
}

#[test]
fn rotation_rejects_cross_lineage_stale_forked_and_noncanonical_operations() {
    let mut state = State::enroll(Memory::default(), genesis()).unwrap();
    let initial = state.status().unwrap().clone();
    let good = update(&initial, owners(&[&key(2), &key(3)], 2));
    let mut variants = Vec::new();
    for field in ["identity", "deployment", "previous", "generation", "owners"] {
        let mut bad = good.clone();
        match field {
            "identity" => bad.authority_identity = "e".repeat(64),
            "deployment" => bad.deployment = "e".repeat(64),
            "previous" => bad.previous = "e".repeat(64),
            "generation" => bad.generation = 3,
            _ => bad.owners = initial.owners.clone(),
        }
        variants.push(bad.encode().unwrap());
    }
    let encoded = String::from_utf8(good.encode().unwrap()).unwrap();
    variants.push(
        encoded
            .replace("\"generation\":2", "\"generation\":1,\"generation\":2")
            .into_bytes(),
    );
    variants.push(format!("{encoded}\n").into_bytes());
    for payload in variants {
        assert!(
            state
                .apply(&signed(OWNERS_TYPE, &payload, &[&key(1), &key(2), &key(3)]))
                .is_err()
        );
        assert_eq!(state.status().unwrap(), &initial);
    }
    state.apply(&rotation(&initial)).unwrap();
    let mut fork = good;
    fork.owners.threshold = 1;
    assert!(
        state
            .apply(&signed(
                OWNERS_TYPE,
                &fork.encode().unwrap(),
                &[&key(1), &key(2), &key(3)]
            ))
            .is_err()
    );
}

#[test]
fn failed_or_unconfirmed_commits_poison_state_and_recovery_resolves_lost_replies() {
    for fault in [Fault::Before, Fault::After, Fault::WrongSequence] {
        let memory = Memory::default();
        let mut state = State::enroll(memory.clone(), genesis()).unwrap();
        let initial = state.status().unwrap().clone();
        let envelope = rotation(&initial);
        memory.0.borrow_mut().fault = fault;
        assert!(state.apply(&envelope).is_err());
        assert!(state.status().is_err());
        assert!(state.apply(&envelope).is_err());
        assert_eq!(
            memory.0.borrow().calls,
            2,
            "poisoned state cannot retry a write"
        );
        drop(state);
        memory.0.borrow_mut().fault = Fault::None;
        let mut recovered = memory
            .restore(&initial.deployment, &initial.authority_identity)
            .unwrap();
        assert_eq!(
            recovered.status().unwrap().generation,
            if matches!(fault, Fault::Before) { 1 } else { 2 }
        );
        let calls = memory.0.borrow().calls;
        assert_eq!(recovered.apply(&envelope).unwrap().generation, 2);
        assert_eq!(
            memory.0.borrow().calls,
            calls + usize::from(matches!(fault, Fault::Before))
        );
    }
}

#[test]
fn enrollment_requires_confirmed_first_commit_and_never_returns_a_partial_identity() {
    for fault in [Fault::Before, Fault::After, Fault::WrongSequence] {
        let memory = Memory::default();
        memory.0.borrow_mut().fault = fault;
        assert!(State::enroll(memory.clone(), genesis()).is_err());
        assert_eq!(memory.0.borrow().calls, 1);
    }
    let memory = Memory::default();
    memory.0.borrow_mut().sequence = 7;
    assert!(State::enroll(memory, genesis()).is_err());
}

#[test]
fn recovery_preserves_the_private_identity_and_requires_independent_continuity_pins() {
    let memory = Memory::default();
    let mut state = State::enroll(memory.clone(), genesis()).unwrap();
    let initial = state.status().unwrap().clone();
    state.apply(&rotation(&initial)).unwrap();
    let accepted = state.status().unwrap().clone();
    drop(state);
    let recovered = memory
        .restore(&accepted.deployment, &accepted.authority_identity)
        .unwrap();
    assert_eq!(recovered.status().unwrap(), &accepted);
    assert_eq!(accepted.authority_identity, initial.authority_identity);
    assert!(
        memory
            .restore(&"e".repeat(64), &accepted.authority_identity)
            .is_err()
    );
    assert!(
        memory
            .restore(&accepted.deployment, &"e".repeat(64))
            .is_err()
    );
    assert!(
        State::recover(
            memory.clone(),
            memory.snapshot(),
            &accepted.deployment,
            &accepted.authority_identity,
            &"e".repeat(64)
        )
        .is_err()
    );
    // A second fresh local instance has the same genesis but NOT the original
    // authority identity. Replaying genesis cannot claim that prior lineage.
    let other = State::enroll(Memory::default(), genesis()).unwrap();
    assert_eq!(other.status().unwrap().deployment, accepted.deployment);
    assert_ne!(
        other.status().unwrap().authority_identity,
        accepted.authority_identity
    );
}

#[test]
fn recovery_rejects_empty_malformed_seed_or_sequence_mismatched_records() {
    let memory = Memory::default();
    let state = State::enroll(memory.clone(), genesis()).unwrap();
    let status = state.status().unwrap().clone();
    for mutation in 0..6 {
        let mut snapshot = memory.snapshot();
        match mutation {
            0 => snapshot.bytes.clear(),
            1 => snapshot.bytes[0] ^= 1,
            2 => snapshot.bytes[16] ^= 1,
            3 => snapshot.sequence += 1,
            4 => snapshot.bytes.extend_from_slice(b"{}"),
            _ => snapshot.bytes.truncate(48),
        }
        assert!(
            State::recover(
                memory.clone(),
                snapshot,
                &status.deployment,
                &status.authority_identity,
                &genesis().authority_release
            )
            .is_err()
        );
    }
    assert!(!serde_json::to_string(&status).unwrap().contains("seed"));
}

#[test]
#[ignore = "isolated Linux swtpm fixture with restricted tmpfs and no swap"]
fn emulator_owner_rotation_survives_restart_and_refuses_rollback() {
    use crate::tpm_state::tests::{EMULATION, Emulator};
    let _serial = EMULATION.lock().unwrap();
    let mut emulator = Emulator::new();
    let genesis = genesis();
    let deployment = genesis.deployment().unwrap();
    let deployment_bytes = deployment_bytes(&deployment).unwrap();
    let mut state =
        State::enroll(emulator.provision_for(deployment_bytes), genesis.clone()).unwrap();
    let initial = state.status().unwrap().clone();
    let first_anchor = emulator.value();
    let old_record = std::fs::read(
        emulator
            .disk()
            .join(format!("{}.state", hex(&first_anchor))),
    )
    .unwrap();
    let envelope = rotation(&initial);
    let accepted = state.apply(&envelope).unwrap().clone();
    let current_anchor = emulator.value();
    let current_path = emulator
        .disk()
        .join(format!("{}.state", hex(&current_anchor)));
    let current_record = std::fs::read(&current_path).unwrap();
    assert!(
        !current_record
            .windows(32)
            .any(|bytes| bytes == state.identity_seed.as_ref())
    );
    state.apply(&envelope).unwrap();
    assert_eq!(
        emulator.value(),
        current_anchor,
        "retry does not extend protected history"
    );
    drop(state);
    emulator.restart();
    let (store, snapshot) = emulator.recover_for(deployment_bytes).unwrap();
    let mut recovered = State::recover(
        store,
        snapshot.unwrap(),
        &deployment,
        &initial.authority_identity,
        &genesis.authority_release,
    )
    .unwrap();
    assert_eq!(recovered.status().unwrap(), &accepted);
    assert_eq!(recovered.apply(&envelope).unwrap(), &accepted);
    let forged = update(&accepted, owners(&[&key(1)], 1));
    assert!(
        recovered
            .apply(&signed(
                OWNERS_TYPE,
                &forged.encode().unwrap(),
                &[&key(1), &key(2)]
            ))
            .is_err()
    );
    drop(recovered);
    std::fs::write(&current_path, old_record).unwrap();
    assert!(emulator.recover_for(deployment_bytes).is_err());
    std::fs::write(&current_path, current_record).unwrap();
    assert_eq!(
        emulator
            .recover_for(deployment_bytes)
            .unwrap()
            .1
            .unwrap()
            .sequence,
        2
    );
    assert_eq!(emulator.value(), current_anchor);
}
