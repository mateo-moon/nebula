use super::super::tests::{genesis, key, rotation, signed};
use super::*;
use openraft::{
    Config, RaftNetwork, RaftNetworkFactory, SnapshotPolicy,
    error::{InstallSnapshotError, RPCError, RaftError, RemoteError, Unreachable},
    network::RPCOption,
    raft::{
        AppendEntriesRequest, AppendEntriesResponse, InstallSnapshotRequest,
        InstallSnapshotResponse, VoteRequest, VoteResponse,
    },
};
use std::{collections::BTreeSet, time::Duration};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

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
    bytes: Zeroizing<Vec<u8>>,
    fault: Fault,
}
#[derive(Clone, Default)]
struct Memory(Arc<Mutex<Disk>>);
impl Store for Memory {
    fn commit(&mut self, bytes: &[u8]) -> Result<u64> {
        let mut disk = self.0.lock().unwrap();
        ensure!(
            !matches!(disk.fault, Fault::Before),
            "injected write failure"
        );
        disk.sequence += 1;
        disk.bytes = Zeroizing::new(bytes.to_vec());
        ensure!(!matches!(disk.fault, Fault::After), "injected lost reply");
        Ok(disk.sequence + u64::from(matches!(disk.fault, Fault::WrongSequence)))
    }
}
impl Memory {
    fn snapshot(&self) -> crate::protected_state::Snapshot {
        let disk = self.0.lock().unwrap();
        crate::protected_state::Snapshot {
            sequence: disk.sequence,
            bytes: disk.bytes.clone(),
        }
    }
    fn restore(&self) -> ReplicaStore<Self> {
        ReplicaStore::restore(self.clone(), self.snapshot(), &genesis()).unwrap()
    }
}

// Exercise OpenRaft itself, including elections, read-index heartbeats,
// snapshot transfer and membership transitions. This network only replaces
// transport; it never simulates a successful quorum or consensus result.
#[derive(Default)]
struct Routes {
    nodes: BTreeMap<u64, (Peer, Consensus)>,
    isolated: BTreeSet<u64>,
    snapshots: usize,
    append_delay: Duration,
}
#[derive(Clone, Default)]
struct Router(Arc<Mutex<Routes>>);
struct Factory {
    source: u64,
    router: Router,
}
struct Connection {
    source: u64,
    target: u64,
    peer: Peer,
    router: Router,
}
impl Connection {
    #[allow(clippy::result_large_err)] // OpenRaft's fixed RPC result type.
    fn destination<E: std::error::Error>(&self) -> Result<Consensus, RPCError<u64, Peer, E>> {
        let routes = self.router.0.lock().unwrap();
        if !routes.isolated.contains(&self.source)
            && !routes.isolated.contains(&self.target)
            && let Some((peer, raft)) = routes.nodes.get(&self.target)
            && *peer == self.peer
        {
            return Ok(raft.clone());
        }
        Err(RPCError::Unreachable(Unreachable::new(
            &std::io::Error::other("partition"),
        )))
    }
}
impl RaftNetworkFactory<Types> for Factory {
    type Network = Connection;
    async fn new_client(&mut self, target: u64, node: &Peer) -> Connection {
        Connection {
            source: self.source,
            target,
            peer: node.clone(),
            router: self.router.clone(),
        }
    }
}
impl RaftNetwork<Types> for Connection {
    async fn append_entries(
        &mut self,
        rpc: AppendEntriesRequest<Types>,
        _: RPCOption,
    ) -> Result<AppendEntriesResponse<u64>, RPCError<u64, Peer, RaftError<u64>>> {
        let delay = self.router.0.lock().unwrap().append_delay;
        tokio::time::sleep(delay).await;
        self.destination()?
            .append_entries(rpc)
            .await
            .map_err(|error| RPCError::RemoteError(RemoteError::new(self.target, error)))
    }
    async fn vote(
        &mut self,
        rpc: VoteRequest<u64>,
        _: RPCOption,
    ) -> Result<VoteResponse<u64>, RPCError<u64, Peer, RaftError<u64>>> {
        self.destination()?
            .vote(rpc)
            .await
            .map_err(|error| RPCError::RemoteError(RemoteError::new(self.target, error)))
    }
    async fn install_snapshot(
        &mut self,
        rpc: InstallSnapshotRequest<Types>,
        _: RPCOption,
    ) -> Result<
        InstallSnapshotResponse<u64>,
        RPCError<u64, Peer, RaftError<u64, InstallSnapshotError>>,
    > {
        let raft = self.destination()?;
        self.router.0.lock().unwrap().snapshots += 1;
        raft.install_snapshot(rpc)
            .await
            .map_err(|error| RPCError::RemoteError(RemoteError::new(self.target, error)))
    }
    fn backoff(&self) -> openraft::network::Backoff {
        openraft::network::Backoff::new(std::iter::repeat(Duration::from_millis(30)))
    }
}

struct Node {
    disk: Memory,
    store: ReplicaStore<Memory>,
    peer: Peer,
    raft: Consensus,
}
struct Cluster {
    router: Router,
    nodes: BTreeMap<u64, Node>,
    settings: Arc<Config>,
}
impl Cluster {
    fn config() -> Arc<Config> {
        Arc::new(
            Config {
                cluster_name: "protected-authority-fixture".into(),
                election_timeout_min: 150,
                election_timeout_max: 300,
                heartbeat_interval: 40,
                snapshot_policy: SnapshotPolicy::LogsSinceLast(8),
                max_in_snapshot_log_to_keep: 0,
                purge_batch_size: 1,
                max_payload_entries: 16,
                ..Default::default()
            }
            .validate()
            .unwrap(),
        )
    }
    async fn add(&mut self) -> u64 {
        let disk = Memory::default();
        let store = ReplicaStore::create(disk.clone(), genesis()).unwrap();
        let peer = Peer {
            address: ([127, 0, 0, 1], 9000 + self.nodes.len() as u16).into(),
            public_key: store.replica_public_key().await.unwrap(),
            release: genesis().authority_release,
            module_id: format!("fixture-module-{}", self.nodes.len()),
        };
        let id = peer.id().unwrap();
        let raft = Consensus::new(
            id,
            self.settings.clone(),
            Factory {
                source: id,
                router: self.router.clone(),
            },
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        self.router
            .0
            .lock()
            .unwrap()
            .nodes
            .insert(id, (peer.clone(), raft.clone()));
        assert!(
            self.nodes
                .insert(
                    id,
                    Node {
                        disk,
                        store,
                        peer,
                        raft
                    }
                )
                .is_none()
        );
        id
    }
    async fn new() -> Self {
        Self::with_config(Self::config()).await
    }
    async fn with_config(settings: Arc<Config>) -> Self {
        let mut cluster = Self {
            router: Router::default(),
            nodes: BTreeMap::new(),
            settings,
        };
        for _ in 0..3 {
            cluster.add().await;
        }
        let members: BTreeMap<_, _> = cluster
            .nodes
            .iter()
            .map(|(id, n)| (*id, n.peer.clone()))
            .collect();
        cluster
            .nodes
            .first_key_value()
            .unwrap()
            .1
            .raft
            .initialize(members)
            .await
            .unwrap();
        let leader = cluster.leader().await;
        let response = cluster.nodes[&leader]
            .raft
            .client_write(Operation::Initialize {
                seed: Seed::random().unwrap(),
            })
            .await
            .unwrap();
        assert!(matches!(response.data, Outcome::Accepted { .. }));
        cluster
    }
    async fn leader(&self) -> u64 {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let isolated = self.router.0.lock().unwrap().isolated.clone();
                for (id, node) in &self.nodes {
                    if isolated.contains(id) {
                        continue;
                    }
                    if node.raft.metrics().borrow().state == openraft::ServerState::Leader
                        && node.raft.ensure_linearizable().await.is_ok()
                    {
                        return *id;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("majority elects a leader")
    }
    async fn converge(&self, status: &LocalStatus) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let mut ready = true;
                for node in self.nodes.values() {
                    let actual = node
                        .store
                        .inspect(|data| {
                            Ok(data
                                .machine
                                .authority
                                .as_ref()
                                .map(|a| a.ledger.status.clone()))
                        })
                        .await
                        .unwrap();
                    if actual.as_ref() != Some(status) {
                        ready = false;
                    }
                }
                if ready {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("all replicas apply the committed owner history");
    }
    async fn shutdown(&self) {
        for node in self.nodes.values() {
            node.raft.shutdown().await.unwrap();
        }
        self.router.0.lock().unwrap().nodes.clear();
    }
    async fn restart(&mut self) {
        self.shutdown().await;
        for (id, node) in &mut self.nodes {
            node.store = node.disk.restore();
            node.raft = Consensus::new(
                *id,
                self.settings.clone(),
                Factory {
                    source: *id,
                    router: self.router.clone(),
                },
                node.store.clone(),
                node.store.clone(),
            )
            .await
            .unwrap();
            self.router
                .0
                .lock()
                .unwrap()
                .nodes
                .insert(*id, (node.peer.clone(), node.raft.clone()));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_quorum_budget_allows_attestation_latency_but_refuses_partition() {
    let cluster =
        Cluster::with_config(network::consensus_config("latency-fixture".into()).unwrap()).await;
    let leader = cluster.leader().await;
    let node = &cluster.nodes[&leader];
    let before = node.store.current_status(&node.raft).await.unwrap();
    // Model the time spent establishing a fresh mutual-attestation connection,
    // without replacing OpenRaft's actual quorum check with a mock success.
    cluster.router.0.lock().unwrap().append_delay = Duration::from_secs(6);
    let result = node.store.current_status(&node.raft).await;
    assert!(
        result.is_ok(),
        "a responding majority exceeded the production RPC budget: {result:?}"
    );
    assert_eq!(result.unwrap(), before);
    cluster.router.0.lock().unwrap().isolated.insert(leader);
    tokio::time::timeout(
        Duration::from_millis(100),
        network::reconcile_replacement(&node.store, &node.raft),
    )
    .await
    .expect("idle housekeeping must not start another attested quorum round")
    .unwrap();
    assert!(
        node.store.current_status(&node.raft).await.is_err(),
        "a cached successful read must not authorize an isolated leader"
    );
    cluster.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn majority_revokes_an_isolated_leader_and_restart_preserves_identity() {
    let mut cluster = Cluster::new().await;
    let old = cluster.leader().await;
    let initial = cluster.nodes[&old]
        .store
        .current_status(&cluster.nodes[&old].raft)
        .await
        .unwrap();
    cluster.converge(&initial).await;
    cluster.router.0.lock().unwrap().isolated.insert(old);
    assert!(
        cluster.nodes[&old]
            .store
            .current_status(&cluster.nodes[&old].raft)
            .await
            .is_err(),
        "a formerly valid leader cannot authorize from its local sealed state"
    );
    let leader = cluster.leader().await;
    assert_ne!(leader, old);
    let response = cluster.nodes[&leader]
        .raft
        .client_write(Operation::RotateOwners {
            envelope: rotation(&initial),
        })
        .await
        .unwrap();
    let Outcome::Accepted { status } = response.data else {
        panic!("rotation rejected")
    };
    assert_eq!(status.generation, 2);
    assert_eq!(status.authority_identity, initial.authority_identity);
    assert!(
        cluster.nodes[&old]
            .store
            .current_status(&cluster.nodes[&old].raft)
            .await
            .is_err()
    );
    cluster.router.0.lock().unwrap().isolated.clear();
    cluster.converge(&status).await;
    cluster.restart().await;
    let leader = cluster.leader().await;
    assert_eq!(
        cluster.nodes[&leader]
            .store
            .current_status(&cluster.nodes[&leader].raft)
            .await
            .unwrap(),
        status
    );
    cluster.converge(&status).await;
    cluster.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn key_import_release_and_revocation_require_owner_scope_and_a_current_quorum() {
    use crate::evidence::{Claims, Role};
    let mut cluster = Cluster::new().await;
    let leader = cluster.leader().await;
    let node = &cluster.nodes[&leader];
    let status = node.store.current_status(&node.raft).await.unwrap();
    let keys: ImageKeys = [("app/image_key/one".into(), ImageKey::from_bytes([7; 32]))].into();
    let mut grant = Grant {
        authority_identity: status.authority_identity.clone(),
        deployment: status.deployment.clone(),
        descriptor_sha384: "d".repeat(96),
        enabled: true,
        generation: 1,
        resources: keys
            .iter()
            .map(|(path, value)| (path.clone(), value.commitment()))
            .collect(),
        runtime_release: genesis().runtime_releases[0].clone(),
        version: 1,
        workload: "app".into(),
    };
    let envelope = signed(GRANT_TYPE, &grant.encode().unwrap(), &[&key(1), &key(2)]);
    let wrong_keys = [("app/image_key/one".into(), ImageKey::from_bytes([8; 32]))].into();
    assert_eq!(
        node.raft
            .client_write(Operation::Publish {
                grant: envelope.clone(),
                keys: wrong_keys
            })
            .await
            .unwrap()
            .data,
        Outcome::Rejected
    );
    assert!(matches!(
        node.raft
            .client_write(Operation::Publish {
                grant: envelope.clone(),
                keys: keys.clone()
            })
            .await
            .unwrap()
            .data,
        Outcome::Accepted { .. }
    ));
    assert!(matches!(
        node.raft
            .client_write(Operation::Publish {
                grant: envelope,
                keys: keys.clone()
            })
            .await
            .unwrap()
            .data,
        Outcome::Accepted { .. }
    ));
    let claims = Claims {
        authority_identity: status.authority_identity.clone(),
        deployment: status.deployment.clone(),
        policy: grant.descriptor_sha384.clone(),
        release: grant.runtime_release.clone(),
        replica_public_key: String::new(),
        role: Role::Runtime,
        tls_sha256: "e".repeat(64),
        version: 1,
    };
    let released = node
        .store
        .release_keys(&node.raft, claims.clone(), "app".into(), 1)
        .await
        .unwrap();
    assert_eq!(
        released["app/image_key/one"].commitment(),
        keys["app/image_key/one"].commitment()
    );
    for mutation in 0..5 {
        let mut bad = claims.clone();
        match mutation {
            0 => bad.authority_identity = "e".repeat(64),
            1 => bad.deployment = "e".repeat(64),
            2 => bad.release = "e".repeat(64),
            3 => bad.policy = "e".repeat(96),
            _ => bad.role = Role::Authority,
        }
        assert!(
            node.store
                .release_keys(&node.raft, bad, "app".into(), 1)
                .await
                .is_err()
        );
    }
    assert!(
        node.store
            .release_keys(&node.raft, claims.clone(), "another-workload".into(), 1)
            .await
            .is_err()
    );
    assert!(
        node.store
            .release_keys(&node.raft, claims.clone(), "app".into(), 2)
            .await
            .is_err()
    );
    // An isolated leader retains the key locally but cannot release it.
    cluster.router.0.lock().unwrap().isolated.insert(leader);
    assert!(
        node.store
            .release_keys(&node.raft, claims.clone(), "app".into(), 1)
            .await
            .is_err()
    );
    let majority = cluster.leader().await;
    let node = &cluster.nodes[&majority];
    node.raft
        .client_write(Operation::RotateOwners {
            envelope: rotation(&status),
        })
        .await
        .unwrap();
    grant.enabled = false;
    grant.generation = 2;
    let revoked_owners = signed(GRANT_TYPE, &grant.encode().unwrap(), &[&key(1), &key(2)]);
    assert_eq!(
        node.raft
            .client_write(Operation::Publish {
                grant: revoked_owners,
                keys: BTreeMap::new()
            })
            .await
            .unwrap()
            .data,
        Outcome::Rejected
    );
    let current_owners = signed(GRANT_TYPE, &grant.encode().unwrap(), &[&key(2), &key(3)]);
    assert!(matches!(
        node.raft
            .client_write(Operation::Publish {
                grant: current_owners,
                keys: BTreeMap::new()
            })
            .await
            .unwrap()
            .data,
        Outcome::Accepted { .. }
    ));
    assert!(
        node.store
            .release_keys(&node.raft, claims.clone(), "app".into(), 1)
            .await
            .is_err()
    );
    cluster.router.0.lock().unwrap().isolated.clear();
    cluster.restart().await;
    let elected = cluster.leader().await;
    assert!(
        cluster.nodes[&elected]
            .store
            .release_keys(&cluster.nodes[&elected].raft, claims, "app".into(), 1)
            .await
            .is_err()
    );
    let retained = cluster.nodes[&elected]
        .store
        .inspect(|data| Ok(data.machine.workloads["app"].keys.is_empty()))
        .await
        .unwrap();
    assert!(
        retained,
        "revocation removes the current plaintext key material"
    );
    // Unauthenticated publication transport has no resource-read or Raft RPC.
    assert!(
        serde_json::from_str::<OwnerRequest>(
            r#"{"kind":"resources","body":{"workload":"app","generation":1}}"#
        )
        .is_err()
    );
    cluster.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installation_canary_has_a_fixed_public_key_and_cannot_be_overwritten_by_a_workload_owner()
{
    let cluster = Cluster::new().await;
    let leader = cluster.leader().await;
    let node = &cluster.nodes[&leader];
    let material = node
        .store
        .inspect(|data| {
            canary::from_spec(
                data,
                canary::Spec {
                    image: format!("ghcr.io/example/canary@sha256:{}", "a".repeat(64)),
                    policy: "package agent_policy\ndefault AllowRequestsFailingPolicy = false\n"
                        .into(),
                },
            )
        })
        .await
        .unwrap();
    let approval = &material.registered.approval;
    let verified = approval
        .verify_descriptor(&material.bundle.descriptor, &genesis().authority_release)
        .unwrap();
    assert_eq!(verified.descriptor.workload, canary::NAME);
    assert_eq!(
        verified.descriptor.resources,
        vec!["nebula-canary/image_key/v1"]
    );
    assert_eq!(material.registered.keys.len(), 1);
    assert_eq!(
        material.registered.keys["nebula-canary/image_key/v1"].commitment(),
        ImageKey::from_bytes(Sha256::digest(b"nebula-coco-public-canary-v1").into()).commitment()
    );
    let (payload, _) = crate::workload::verify_envelope(
        &material.bundle.grant,
        &approval.owners,
        GRANT_TYPE,
        MAX_GRANT_BYTES,
        16,
    )
    .unwrap();
    assert_eq!(payload, approval.grant.encode().unwrap());
    let envelope = signed(GRANT_TYPE, &payload, &[&key(1), &key(2)]);
    assert_eq!(
        node.raft
            .client_write(Operation::Publish {
                grant: envelope,
                keys: material.registered.keys
            })
            .await
            .unwrap()
            .data,
        Outcome::Rejected
    );
    assert!(
        node.store
            .inspect(|data| Ok(data.machine.workloads.is_empty()))
            .await
            .unwrap()
    );
    cluster.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replacement_catches_up_from_snapshot_and_does_not_copy_replica_identity() {
    let mut cluster = Cluster::new().await;
    let leader = cluster.leader().await;
    let status = cluster.nodes[&leader]
        .store
        .current_status(&cluster.nodes[&leader].raft)
        .await
        .unwrap();
    // These rejected writes still advance the committed Raft log. They test
    // compaction without manufacturing state-machine or snapshot success.
    for _ in 0..14 {
        assert_eq!(
            cluster.nodes[&leader]
                .raft
                .client_write(Operation::Initialize {
                    seed: Seed::random().unwrap()
                })
                .await
                .unwrap()
                .data,
            Outcome::Rejected
        );
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while cluster.nodes[&leader]
            .raft
            .metrics()
            .borrow()
            .purged
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let learner = cluster.add().await;
    let local_key = cluster.nodes[&learner]
        .store
        .replica_public_key()
        .await
        .unwrap();
    let removed = *cluster
        .nodes
        .keys()
        .find(|id| **id != leader && **id != learner)
        .unwrap();
    let intent = Operation::BeginReplacement {
        remove: removed,
        peer: cluster.nodes[&learner].peer.clone(),
    };
    assert!(matches!(
        cluster.nodes[&leader]
            .raft
            .client_write(intent.clone())
            .await
            .unwrap()
            .data,
        Outcome::Accepted { .. }
    ));
    // A different candidate cannot overwrite a pending admission, and a voter
    // cannot be removed until the committed transition has actually finished.
    let other = Peer {
        module_id: "another-instance".into(),
        ..cluster.nodes[&learner].peer.clone()
    };
    assert_eq!(
        cluster.nodes[&leader]
            .raft
            .client_write(Operation::BeginReplacement {
                remove: removed,
                peer: other
            })
            .await
            .unwrap()
            .data,
        Outcome::Rejected
    );
    assert_eq!(
        cluster.nodes[&leader]
            .raft
            .client_write(Operation::CompleteReplacement { peer: learner })
            .await
            .unwrap()
            .data,
        Outcome::Rejected
    );
    cluster.nodes[&leader]
        .raft
        .add_learner(learner, cluster.nodes[&learner].peer.clone(), true)
        .await
        .unwrap();
    cluster.converge(&status).await;
    // Crash after learner catch-up, before changing the voters. The replacement
    // plan must come from protected state after election, with no controller input.
    cluster.restart().await;
    let leader = cluster.leader().await;
    assert!(matches!(
        cluster.nodes[&leader]
            .raft
            .client_write(intent)
            .await
            .unwrap()
            .data,
        Outcome::Accepted { .. }
    ));
    network::reconcile_replacement(&cluster.nodes[&leader].store, &cluster.nodes[&leader].raft)
        .await
        .unwrap();
    network::reconcile_replacement(&cluster.nodes[&leader].store, &cluster.nodes[&leader].raft)
        .await
        .unwrap();
    assert!(
        cluster.nodes[&leader]
            .store
            .inspect(|data| Ok(data.machine.replacement.is_none()))
            .await
            .unwrap()
    );
    assert!(cluster.router.0.lock().unwrap().snapshots > 0);
    assert_eq!(
        cluster.nodes[&learner]
            .store
            .replica_public_key()
            .await
            .unwrap(),
        local_key
    );
    assert_ne!(
        local_key,
        cluster.nodes[&leader]
            .store
            .replica_public_key()
            .await
            .unwrap()
    );
    assert_eq!(
        cluster.nodes[&learner]
            .store
            .inspect(|data| Ok(data
                .machine
                .authority
                .as_ref()
                .unwrap()
                .ledger
                .status
                .clone()))
            .await
            .unwrap(),
        status
    );
    assert!(
        cluster.nodes[&removed]
            .store
            .current_status(&cluster.nodes[&removed].raft)
            .await
            .is_err()
    );
    cluster.restart().await;
    let leader = cluster.leader().await;
    assert_eq!(
        cluster.nodes[&leader]
            .store
            .current_status(&cluster.nodes[&leader].raft)
            .await
            .unwrap(),
        status
    );
    cluster.shutdown().await;
}

#[tokio::test]
async fn persistence_failures_poison_the_live_replica_and_recovery_uses_durable_votes() {
    for fault in [Fault::Before, Fault::After, Fault::WrongSequence] {
        let disk = Memory::default();
        let mut store = ReplicaStore::create(disk.clone(), genesis()).unwrap();
        let identity = store.replica_public_key().await.unwrap();
        store.save_vote(&Vote::new(1, 11)).await.unwrap();
        disk.0.lock().unwrap().fault = fault;
        assert!(store.save_vote(&Vote::new(2, 12)).await.is_err());
        assert!(store.replica_public_key().await.is_err());
        assert!(store.read_vote().await.is_err());
        disk.0.lock().unwrap().fault = Fault::None;
        let mut recovered = disk.restore();
        assert_eq!(recovered.replica_public_key().await.unwrap(), identity);
        let durable = if matches!(fault, Fault::Before) {
            Vote::new(1, 11)
        } else {
            Vote::new(2, 12)
        };
        assert_eq!(recovered.read_vote().await.unwrap(), Some(durable));
        assert!(recovered.save_vote(&Vote::new(0, 11)).await.is_err());
        assert_eq!(recovered.read_vote().await.unwrap(), Some(durable));
    }
}

#[tokio::test]
async fn snapshot_transfer_rejects_rollback_deployment_and_conflicting_state() {
    let disk = Memory::default();
    let mut store = ReplicaStore::create(disk.clone(), genesis()).unwrap();
    let log = |index| LogId::new(openraft::CommittedLeaderId::new(1, 1), index);
    store
        .apply([Entry {
            log_id: log(0),
            payload: EntryPayload::Normal(Operation::Initialize {
                seed: Seed::random().unwrap(),
            }),
        }])
        .await
        .unwrap();
    let previous = store.build_snapshot().await.unwrap();
    store
        .apply([Entry {
            log_id: log(1),
            payload: EntryPayload::Blank,
        }])
        .await
        .unwrap();
    assert!(
        store
            .install_snapshot(&previous.meta, previous.snapshot)
            .await
            .is_err()
    );
    let current = store.build_snapshot().await.unwrap();
    let mut transfer: Transfer = serde_json::from_slice(&current.snapshot.bytes).unwrap();
    transfer.machine.authority.as_mut().unwrap().identity = Seed::random().unwrap();
    let bad = SnapshotBuffer::new(Zeroizing::new(serde_json::to_vec(&transfer).unwrap()));
    assert!(
        store
            .install_snapshot(&current.meta, Box::new(bad))
            .await
            .is_err()
    );
    let mut foreign = genesis();
    foreign.nonce = "e".repeat(64);
    let foreign_disk = Memory::default();
    let mut target = ReplicaStore::create(foreign_disk, foreign).unwrap();
    assert!(
        target
            .install_snapshot(&current.meta, current.snapshot)
            .await
            .is_err()
    );
    assert!(store.truncate(log(0)).await.is_err());
    assert!(store.purge(log(2)).await.is_err());
    let mut incompatible = genesis();
    incompatible.nonce = "f".repeat(64);
    assert!(ReplicaStore::restore(disk.clone(), disk.snapshot(), &incompatible).is_err());
    let mut wrong_revision = disk.snapshot();
    wrong_revision.sequence += 1;
    assert!(ReplicaStore::restore(disk, wrong_revision, &genesis()).is_err());
}

#[tokio::test]
async fn snapshot_streams_are_bounded_and_secrets_are_redacted() {
    let mut buffer = SnapshotBuffer::default();
    buffer.write_all(b"state").await.unwrap();
    buffer.rewind().await.unwrap();
    let mut bytes = Vec::new();
    buffer.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"state");
    assert!(
        buffer
            .seek(std::io::SeekFrom::Start(MAX_REPLICA_BYTES as u64 + 1))
            .await
            .is_err()
    );
    buffer
        .seek(std::io::SeekFrom::Start(MAX_REPLICA_BYTES as u64))
        .await
        .unwrap();
    assert!(buffer.write_all(&[1]).await.is_err());
    assert_eq!(buffer.bytes.len(), 5);
    let secret = Seed([99; 32]);
    assert_eq!(format!("{secret:?}"), "[protected seed]");
    assert_eq!(
        format!("{:?}", Operation::Initialize { seed: secret }),
        "Initialize([protected])"
    );
    assert!(Peer::default().id().is_err());
}

#[test]
#[ignore = "requires isolated Linux software TPMs, tmpfs and no swap"]
fn emulator_raft_votes_membership_and_owner_identity_survive_all_replica_restarts() {
    use crate::tpm_state::tests::{EMULATION, Emulator};
    let _serial = EMULATION.lock().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut hardware: Vec<_> = (0..3).map(|_| Emulator::new()).collect();
    runtime.block_on(async {
        let router = Router::default();
        let mut stores = Vec::new();
        let mut peers = BTreeMap::new();
        let mut nodes = BTreeMap::new();
        let config = Arc::new(
            Config {
                cluster_name: "tpm-authority-fixture".into(),
                election_timeout_min: 4000,
                election_timeout_max: 8000,
                heartbeat_interval: 1000,
                snapshot_policy: SnapshotPolicy::LogsSinceLast(8),
                max_in_snapshot_log_to_keep: 0,
                purge_batch_size: 1,
                max_payload_entries: 16,
                ..Default::default()
            }
            .validate()
            .unwrap(),
        );
        let deployment = deployment_bytes(&genesis().deployment().unwrap()).unwrap();
        for (index, tpm) in hardware.iter().enumerate() {
            let store = ReplicaStore::create(tpm.provision_for(deployment), genesis()).unwrap();
            let peer = Peer {
                address: ([127, 0, 0, 1], 9200 + index as u16).into(),
                public_key: store.replica_public_key().await.unwrap(),
                release: genesis().authority_release,
                module_id: format!("fixture-module-{index}"),
            };
            let id = peer.id().unwrap();
            let raft = Consensus::new(
                id,
                config.clone(),
                Factory {
                    source: id,
                    router: router.clone(),
                },
                store.clone(),
                store.clone(),
            )
            .await
            .unwrap();
            router
                .0
                .lock()
                .unwrap()
                .nodes
                .insert(id, (peer.clone(), raft.clone()));
            peers.insert(id, peer);
            stores.push(store);
            nodes.insert(id, raft);
        }
        let initial = nodes.first_key_value().unwrap().1;
        initial.initialize(peers.clone()).await.unwrap();
        initial
            .wait(Some(Duration::from_secs(60)))
            .state(openraft::ServerState::Leader, "initial election")
            .await
            .unwrap();
        let outcome = initial
            .client_write(Operation::Initialize {
                seed: Seed::random().unwrap(),
            })
            .await
            .unwrap()
            .data;
        let Outcome::Accepted { status } = outcome else {
            panic!("initialization failed")
        };
        let outcome = initial
            .client_write(Operation::RotateOwners {
                envelope: rotation(&status),
            })
            .await
            .unwrap()
            .data;
        let Outcome::Accepted { status } = outcome else {
            panic!("rotation failed")
        };
        for store in &stores {
            tokio::time::timeout(Duration::from_secs(60), async {
                loop {
                    let applied = store
                        .inspect(|data| {
                            Ok(data
                                .machine
                                .authority
                                .as_ref()
                                .map(|a| a.ledger.status.generation))
                        })
                        .await
                        .unwrap();
                    if applied == Some(status.generation) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .unwrap();
        }
        for raft in nodes.values() {
            raft.shutdown().await.unwrap();
        }
        nodes.clear();
        router.0.lock().unwrap().nodes.clear();
        let mut votes = Vec::new();
        let mut local = Vec::new();
        for store in &mut stores {
            votes.push(store.read_vote().await.unwrap());
            local.push(store.replica_public_key().await.unwrap());
        }
        stores.clear();
        for (index, tpm) in hardware.iter_mut().enumerate() {
            tpm.restart();
            let (journal, snapshot) = tpm.recover_for(deployment).unwrap();
            let mut recovered =
                ReplicaStore::restore(journal, snapshot.unwrap(), &genesis()).unwrap();
            assert_eq!(recovered.read_vote().await.unwrap(), votes[index]);
            assert_eq!(recovered.replica_public_key().await.unwrap(), local[index]);
            assert_eq!(
                recovered
                    .inspect(|data| Ok(data
                        .machine
                        .authority
                        .as_ref()
                        .unwrap()
                        .ledger
                        .status
                        .clone()))
                    .await
                    .unwrap(),
                status
            );
            assert_eq!(
                recovered
                    .applied_state()
                    .await
                    .unwrap()
                    .1
                    .membership()
                    .nodes()
                    .count(),
                3
            );
        }
    });
}
