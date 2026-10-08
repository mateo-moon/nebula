use super::*;
use crate::authority::tests::{genesis, key};
use openraft::{CommittedLeaderId, Membership};
use serde::de::DeserializeOwned;

fn members() -> BTreeMap<u64, Peer> {
    (11..=13)
        .map(|value| {
            let peer = Peer {
                address: ([127, 0, 0, 1], 9400 + u16::from(value)).into(),
                public_key: STANDARD.encode(key(value).verifying_key().to_bytes()),
                release: genesis().authority_release,
                module_id: format!("synthetic-module-{value}"),
            };
            let id = peer.id().unwrap();
            // Exercise the full integer range, beyond JavaScript's safe integer.
            assert!(serde_json::to_string(&id).unwrap().parse::<u64>().unwrap() > 1 << 53);
            (id, peer)
        })
        .collect()
}

fn round_trip<T: Serialize + DeserializeOwned>(value: &T) {
    let encoded = serde_json::to_vec(value).unwrap();
    let decoded: T = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(serde_json::to_vec(&decoded).unwrap(), encoded);
}

#[test]
fn health_round_trip_preserves_all_voter_ids() {
    let status = Ledger::new(
        genesis(),
        STANDARD.encode(key(14).verifying_key().to_bytes()),
    )
    .unwrap()
    .status;
    round_trip(&OwnerResponse::Health {
        status,
        voters: members(),
        joint: false,
        replacing: false,
    });
}

#[test]
fn discovery_round_trip_preserves_all_member_ids() {
    round_trip(&Response::Probe {
        status: None,
        members: members(),
    });
}

#[test]
fn append_round_trip_preserves_membership() {
    let peers = members();
    let leader = *peers.first_key_value().unwrap().0;
    let log_id = LogId::new(CommittedLeaderId::new(3, leader), 5);
    let membership = Membership::new(vec![peers.keys().copied().collect()], peers);
    round_trip(&Request::Append(AppendEntriesRequest {
        vote: Vote::new_committed(3, leader),
        prev_log_id: None,
        entries: vec![Entry {
            log_id,
            payload: EntryPayload::Membership(membership),
        }],
        leader_commit: Some(log_id),
    }));
}

#[test]
fn snapshot_round_trip_preserves_membership() {
    let peers = members();
    let leader = *peers.first_key_value().unwrap().0;
    let log_id = LogId::new(CommittedLeaderId::new(3, leader), 5);
    let membership = Membership::new(vec![peers.keys().copied().collect()], peers);
    round_trip(&Request::Snapshot(InstallSnapshotRequest {
        vote: Vote::new_committed(3, leader),
        meta: SnapshotMeta {
            last_log_id: Some(log_id),
            last_membership: StoredMembership::new(Some(log_id), membership),
            snapshot_id: "synthetic-membership-snapshot".into(),
        },
        offset: 0,
        data: vec![1, 2, 3],
        done: true,
    }));
}
