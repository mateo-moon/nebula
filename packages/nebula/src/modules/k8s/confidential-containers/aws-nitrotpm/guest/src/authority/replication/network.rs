use super::*;
use crate::evidence::{
    self, AttestedIdentity, ChannelIdentity, Claims, Collector, ReleaseProfile, Role,
};
use openraft::{
    RaftNetwork, RaftNetworkFactory,
    error::{InstallSnapshotError, RPCError, RaftError, RemoteError, Unreachable},
    network::RPCOption,
    raft::{
        AppendEntriesRequest, AppendEntriesResponse, InstallSnapshotRequest,
        InstallSnapshotResponse, VoteRequest, VoteResponse,
    },
};
use std::{
    collections::BTreeSet,
    net::SocketAddr,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::net::TcpListener;

#[cfg(test)]
#[path = "wire_tests.rs"]
mod wire_tests;

pub(super) fn consensus_config(deployment: String) -> Result<Arc<openraft::Config>> {
    Ok(Arc::new(
        openraft::Config {
            cluster_name: deployment,
            // OpenRaft also uses heartbeat_interval as the read-index RPC
            // deadline. Each RPC establishes fresh mutual hardware evidence;
            // the former five-second budget cancelled responding majorities.
            election_timeout_min: 40000,
            election_timeout_max: 60000,
            heartbeat_interval: 10000,
            install_snapshot_timeout: 45000,
            snapshot_max_chunk_size: 64 * 1024,
            max_payload_entries: 16,
            snapshot_policy: openraft::SnapshotPolicy::LogsSinceLast(16),
            replication_lag_threshold: 32,
            max_in_snapshot_log_to_keep: 0,
            purge_batch_size: 1,
            ..Default::default()
        }
        .validate()?,
    ))
}

/// Public boot intent. The signed genesis commits to profile.release, which is
/// itself a digest of the complete measurement and firmware-verification policy.
pub struct ReplicaConfig {
    pub directory: PathBuf,
    pub genesis: Envelope,
    pub deployment: String,
    pub profile: ReleaseProfile,
    pub runtime_profiles: Vec<ReleaseProfile>,
    pub address: SocketAddr,
    pub publisher_address: SocketAddr,
    pub asvk: Vec<u8>,
}

/// Only a fresh evidence-bound connection or local hardware proof constructs an
/// enrollment candidate. It cannot be deserialized from a management object.
pub struct Enrollment {
    peer: Peer,
    identity: String,
    observed: Instant,
}
impl Enrollment {
    pub fn public_key(&self) -> &str {
        &self.peer.public_key
    }
    fn fresh(&self) -> Result<()> {
        ensure!(
            self.observed.elapsed() < Duration::from_secs(60),
            "enrollment evidence expired"
        );
        Ok(())
    }
}

struct Host {
    store: ReplicaStore,
    profile: ReleaseProfile,
    runtime_profiles: Vec<ReleaseProfile>,
    deployment: String,
    address: SocketAddr,
    publisher_address: SocketAddr,
    identity: Arc<ChannelIdentity>,
    asvk: Vec<u8>,
}
impl Host {
    async fn collector(&self) -> Result<Collector> {
        let (public, identity) = self
            .store
            .inspect(|data| {
                Ok((
                    data.local_identity.public_key(),
                    data.machine.authority.as_ref().map_or_else(
                        || data.expected_identity.clone().unwrap_or_default(),
                        |a| a.ledger.status.authority_identity.clone(),
                    ),
                ))
            })
            .await?;
        Collector::authority(
            self.identity.clone(),
            Claims {
                authority_identity: identity,
                deployment: self.deployment.clone(),
                policy: String::new(),
                release: self.profile.release.clone(),
                replica_public_key: public,
                role: Role::Authority,
                tls_sha256: String::new(),
                version: 1,
            },
            self.asvk.clone(),
            Arc::new(self.store.clone()),
        )
    }
    fn candidate(&self, address: SocketAddr, identity: &AttestedIdentity) -> Result<Enrollment> {
        let claims = identity.claims();
        ensure!(
            claims.role == Role::Authority
                && claims.deployment == self.deployment
                && claims.release == self.profile.release,
            "ineligible replica"
        );
        let peer = Peer {
            address,
            public_key: claims.replica_public_key.clone(),
            release: claims.release.clone(),
            module_id: identity.module_id().into(),
        };
        peer.id()?;
        Ok(Enrollment {
            peer,
            identity: claims.authority_identity.clone(),
            observed: Instant::now(),
        })
    }
    async fn admitted(&self, peer: &Peer) -> Result<bool> {
        let peer = peer.clone();
        let id = peer.id()?;
        Ok(self
            .store
            .inspect(move |data| {
                let known = if data.machine.membership.log_id().is_some() {
                    data.machine.membership.membership().get_node(&id)
                } else {
                    data.cohort.get(&id)
                };
                // Addresses are routing hints. The persistent key, release and
                // Nitro module identity are the authorization pin.
                Ok(known.is_some_and(|known| {
                    known.public_key == peer.public_key
                        && known.release == peer.release
                        && known.module_id == peer.module_id
                }))
            })
            .await?)
    }
    async fn connect(&self, peer: &Peer) -> Result<evidence::SecureChannel> {
        ensure!(
            self.admitted(peer).await?,
            "replica is not committed or pinned for genesis"
        );
        let local = self.collector().await?;
        let channel = evidence::connect(
            peer.address,
            &local,
            std::slice::from_ref(&self.profile),
            &self.deployment,
        )
        .await?;
        let actual = self.candidate(peer.address, channel.peer())?;
        ensure!(
            actual.peer == *peer,
            "discovery changed a pinned replica identity"
        );
        Ok(channel)
    }
}

#[derive(Clone)]
struct Network(Arc<Host>);
struct Connection {
    host: Arc<Host>,
    peer: Peer,
    id: u64,
}
impl RaftNetworkFactory<Types> for Network {
    type Network = Connection;
    async fn new_client(&mut self, id: u64, peer: &Peer) -> Connection {
        Connection {
            host: self.0.clone(),
            peer: peer.clone(),
            id,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Append(AppendEntriesRequest<Types>),
    Vote(VoteRequest<u64>),
    Snapshot(InstallSnapshotRequest<Types>),
    Probe,
    Join { remove: u64, address: SocketAddr },
    Resources { workload: String, generation: u64 },
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "camelCase",
    deny_unknown_fields
)]
enum Response {
    Resources {
        keys: ImageKeys,
    },
    Append(Result<AppendEntriesResponse<u64>, RaftError<u64>>),
    Vote(Result<VoteResponse<u64>, RaftError<u64>>),
    Snapshot(Result<InstallSnapshotResponse<u64>, RaftError<u64, InstallSnapshotError>>),
    Joined {
        status: LocalStatus,
    },
    Probe {
        status: Option<LocalStatus>,
        members: BTreeMap<u64, Peer>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum OwnerRequest {
    Status,
    Health,
    Canary,
    Approval { workload: String },
    Publish(Publication),
    Rotate(Envelope),
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum OwnerResponse {
    Status(LocalStatus),
    Health {
        status: LocalStatus,
        voters: BTreeMap<u64, Peer>,
        joint: bool,
        replacing: bool,
    },
    Canary {
        status: LocalStatus,
        bundle: canary::Bundle,
    },
    Approval {
        status: LocalStatus,
        approval: Approval,
    },
}
impl Connection {
    async fn call(&self, request: Request) -> Result<Response> {
        ensure!(self.peer.id()? == self.id, "replica ID mismatch");
        let mut channel = self.host.connect(&self.peer).await?;
        channel.send(&request).await?;
        tokio::time::timeout(Duration::from_secs(15), channel.receive()).await?
    }
}
fn unreachable<E: std::error::Error>() -> RPCError<u64, Peer, E> {
    RPCError::Unreachable(Unreachable::new(&std::io::Error::other(
        "attested replica unavailable",
    )))
}
impl RaftNetwork<Types> for Connection {
    async fn append_entries(
        &mut self,
        rpc: AppendEntriesRequest<Types>,
        _: RPCOption,
    ) -> Result<AppendEntriesResponse<u64>, RPCError<u64, Peer, RaftError<u64>>> {
        match self.call(Request::Append(rpc)).await {
            Ok(Response::Append(result)) => {
                result.map_err(|error| RPCError::RemoteError(RemoteError::new(self.id, error)))
            }
            _ => Err(unreachable()),
        }
    }
    async fn vote(
        &mut self,
        rpc: VoteRequest<u64>,
        _: RPCOption,
    ) -> Result<VoteResponse<u64>, RPCError<u64, Peer, RaftError<u64>>> {
        match self.call(Request::Vote(rpc)).await {
            Ok(Response::Vote(result)) => {
                result.map_err(|error| RPCError::RemoteError(RemoteError::new(self.id, error)))
            }
            _ => Err(unreachable()),
        }
    }
    async fn install_snapshot(
        &mut self,
        rpc: InstallSnapshotRequest<Types>,
        _: RPCOption,
    ) -> Result<
        InstallSnapshotResponse<u64>,
        RPCError<u64, Peer, RaftError<u64, InstallSnapshotError>>,
    > {
        match self.call(Request::Snapshot(rpc)).await {
            Ok(Response::Snapshot(result)) => {
                result.map_err(|error| RPCError::RemoteError(RemoteError::new(self.id, error)))
            }
            _ => Err(unreachable()),
        }
    }
}

/// Protected authority replication lifecycle. No method exports the identity
/// seed or accepts controller-authenticated Raft messages. Applications use
/// public status/owner envelopes; transport and membership stay internal.
#[derive(Clone)]
pub struct ProtectedReplicas {
    host: Arc<Host>,
    raft: Consensus,
}
impl ProtectedReplicas {
    pub async fn open(config: ReplicaConfig) -> Result<Self> {
        config.profile.validate()?;
        ensure!(
            config.profile.role == Role::Authority
                && config.address.port() != 0
                && config.publisher_address.port() != 0
                && config.address != config.publisher_address,
            "authority profile/address required"
        );
        let genesis = verify_genesis(&config.genesis, &config.deployment, &config.profile.release)?;
        ensure!(
            !config.runtime_profiles.is_empty() && config.runtime_profiles.len() <= 16,
            "runtime release profiles required"
        );
        for profile in &config.runtime_profiles {
            profile.validate()?;
            ensure!(
                profile.role == Role::Runtime
                    && genesis.runtime_releases.contains(&profile.release),
                "runtime release is not authorized by genesis"
            );
        }
        let profile = config.profile.clone();
        let deployment = config.deployment.clone();
        let store = tokio::task::spawn_blocking(move || {
            let boot = BootPolicy {
                pcr4: evidence::from_hex(&profile.pcr4)?,
                pcr12: evidence::from_hex(&profile.pcr12)?,
            };
            if config.directory.join("seal.json").exists() {
                ReplicaStore::recover(
                    &config.directory,
                    &boot,
                    &config.genesis,
                    &deployment,
                    &profile.release,
                )
            } else {
                // Provision never clears the TPM. A missing/corrupt disk on a
                // previously enrolled TPM fails its owner/NV preconditions.
                ReplicaStore::provision(
                    &config.directory,
                    &boot,
                    &config.genesis,
                    &deployment,
                    &profile.release,
                )
            }
        })
        .await??;
        let identity = Arc::new(tokio::task::spawn_blocking(ChannelIdentity::generate).await??);
        let host = Arc::new(Host {
            store,
            profile: config.profile,
            runtime_profiles: config.runtime_profiles,
            deployment: config.deployment,
            address: config.address,
            publisher_address: config.publisher_address,
            identity,
            asvk: config.asvk,
        });
        let public = host.store.replica_public_key().await?;
        let id = u64::from_str_radix(&public_identity(&public)?[..16], 16)?;
        let settings = consensus_config(host.deployment.clone())?;
        let raft = Consensus::new(
            id,
            settings,
            Network(host.clone()),
            host.store.clone(),
            host.store.clone(),
        )
        .await?;
        Ok(Self { host, raft })
    }
    pub async fn status(&self) -> Result<LocalStatus> {
        self.host.store.current_status(&self.raft).await
    }
    pub async fn health(&self) -> Result<OwnerResponse> {
        // A fresh barrier is mandatory: an isolated former leader must never
        // authorize infrastructure replacement using its retained membership.
        let status = self.status().await?;
        Ok(self
            .host
            .store
            .inspect(move |data| {
                let membership = data.machine.membership.membership();
                let voters = membership
                    .voter_ids()
                    .filter_map(|id| membership.get_node(&id).map(|peer| (id, peer.clone())))
                    .collect();
                Ok(OwnerResponse::Health {
                    status,
                    voters,
                    joint: membership.get_joint_config().len() != 1,
                    replacing: data.machine.replacement.is_some(),
                })
            })
            .await?)
    }
    pub async fn publish(&self, publication: Publication) -> Result<LocalStatus> {
        let status = self.status().await?;
        let genesis = self
            .host
            .store
            .inspect(|data| Ok(data.genesis.clone()))
            .await?;
        let grant = Grant::verify(&publication.grant, &status, &genesis)?;
        if grant.enabled {
            Approval {
                grant,
                owners: status.owners,
            }
            .verify_descriptor(&publication.descriptor, &genesis.authority_release)?;
        }
        let response = tokio::time::timeout(
            Duration::from_secs(30),
            self.raft.client_write(Operation::Publish {
                grant: publication.grant,
                keys: publication.keys,
            }),
        )
        .await??;
        match response.data {
            Outcome::Accepted { status } => Ok(status),
            _ => anyhow::bail!("workload publication rejected"),
        }
    }
    pub async fn approval(&self, workload: String) -> Result<(LocalStatus, Approval)> {
        let status = self.status().await?;
        let approval = self
            .host
            .store
            .inspect(move |data| {
                if workload == canary::NAME {
                    return Ok(canary::material(data)?.registered.approval);
                }
                let registered = data
                    .machine
                    .workloads
                    .get(&workload)
                    .context("unknown workload")?;
                ensure!(registered.approval.grant.enabled, "workload revoked");
                Ok(registered.approval.clone())
            })
            .await?;
        Ok((status, approval))
    }
    pub async fn rotate_owners(&self, envelope: Envelope) -> Result<LocalStatus> {
        let response = tokio::time::timeout(
            Duration::from_secs(30),
            self.raft.client_write(Operation::RotateOwners { envelope }),
        )
        .await??;
        match response.data {
            Outcome::Accepted { status } => Ok(status),
            _ => anyhow::bail!("owner rotation rejected"),
        }
    }
    pub async fn local_enrollment(&self) -> Result<Enrollment> {
        let collector = self.host.collector().await?;
        let mut nonce = [0; 32];
        OsRng.try_fill_bytes(&mut nonce)?;
        let proof = collector.collect(nonce).await?;
        let identity = evidence::verify(
            &proof,
            &nonce,
            &self.host.profile,
            &self.host.deployment,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs(),
        )?;
        self.host.candidate(self.host.address, &identity)
    }
    pub async fn discover(&self, address: SocketAddr) -> Result<Enrollment> {
        let collector = self.host.collector().await?;
        let mut channel = evidence::connect(
            address,
            &collector,
            std::slice::from_ref(&self.host.profile),
            &self.host.deployment,
        )
        .await?;
        let enrollment = self.host.candidate(address, channel.peer())?;
        // A probe carries no private state and is allowed before membership.
        channel.send(&Request::Probe).await?;
        let Response::Probe { .. } =
            tokio::time::timeout(Duration::from_secs(15), channel.receive()).await??
        else {
            anyhow::bail!("invalid enrollment response")
        };
        Ok(enrollment)
    }
    /// The three stable, module-owned network interfaces define discovery
    /// slots, not trust. Existing protected membership determines which key a
    /// replacement may displace at its slot.
    pub async fn enroll(&self, addresses: &[SocketAddr]) -> Result<()> {
        if self.raft.is_initialized().await? {
            return Ok(());
        }
        ensure!(
            addresses.len() == 3 && addresses.contains(&self.host.address),
            "invalid discovery cohort"
        );
        let mut candidates = vec![self.local_enrollment().await?];
        for address in addresses
            .iter()
            .filter(|address| **address != self.host.address)
        {
            let candidate = self.discover(*address).await?;
            if !candidate.identity.is_empty() {
                self.join_slot(*address).await?;
                return Ok(());
            }
            candidates.push(candidate);
        }
        self.initialize(candidates).await
    }
    async fn join_slot(&self, leader: SocketAddr) -> Result<()> {
        let collector = self.host.collector().await?;
        let mut channel = evidence::connect(
            leader,
            &collector,
            std::slice::from_ref(&self.host.profile),
            &self.host.deployment,
        )
        .await?;
        channel.send(&Request::Probe).await?;
        let Response::Probe {
            status: Some(_),
            members,
        } = tokio::time::timeout(Duration::from_secs(15), channel.receive()).await??
        else {
            anyhow::bail!("discovered peer has no current leader quorum");
        };
        let remove = *members
            .iter()
            .find(|(_, peer)| peer.address == self.host.address)
            .context("replacement slot is not in the protected membership")?
            .0;
        self.join(leader, remove).await
    }
    pub async fn initialize(&self, candidates: Vec<Enrollment>) -> Result<()> {
        ensure!(
            candidates.len() == 3,
            "three independent attested replicas required"
        );
        let mut members = BTreeMap::new();
        let mut modules = BTreeSet::new();
        for candidate in candidates {
            candidate.fresh()?;
            ensure!(
                candidate.identity.is_empty() && modules.insert(candidate.peer.module_id.clone()),
                "replica already enrolled or duplicate hardware"
            );
            ensure!(
                members
                    .insert(candidate.peer.id()?, candidate.peer)
                    .is_none(),
                "duplicate replica key"
            );
        }
        let public = self.host.store.replica_public_key().await?;
        ensure!(
            members.values().any(|peer| peer.public_key == public),
            "initial cohort excludes this replica"
        );
        let pins = members.clone();
        self.host
            .store
            .change(move |data| {
                ensure!(
                    data.cohort.is_empty() || data.cohort == pins,
                    "initial cohort cannot change"
                );
                ensure!(
                    data.machine.authority.is_none(),
                    "existing authority cannot initialize again"
                );
                data.cohort = pins;
                Ok(())
            })
            .await?;
        // OpenRaft handles simultaneous identical genesis attempts. An existing
        // log is never truncated/reinitialized as part of retry or recovery.
        match self.raft.initialize(members).await {
            Ok(()) | Err(RaftError::APIError(openraft::error::InitializeError::NotAllowed(_))) => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }
    pub async fn finish_initialization(&self) -> Result<LocalStatus> {
        self.raft.ensure_linearizable().await?;
        let ready = self
            .host
            .store
            .inspect(|data| Ok(data.machine.authority.is_some()))
            .await?;
        if !ready {
            let members = self
                .raft
                .metrics()
                .borrow()
                .membership_config
                .membership()
                .voter_ids()
                .count();
            ensure!(members == 3, "initial authority needs three voters");
            self.raft
                .client_write(Operation::Initialize {
                    seed: Seed::random()?,
                })
                .await?;
        }
        self.status().await
    }

    /// Run by a newly booted replacement. The existing leader first proves
    /// its current lineage over an attested channel; only then are its member
    /// pins persisted locally. No management-supplied seed or recovery key.
    pub async fn join(&self, leader: SocketAddr, remove: u64) -> Result<()> {
        let collector = self.host.collector().await?;
        let mut channel = evidence::connect(
            leader,
            &collector,
            std::slice::from_ref(&self.host.profile),
            &self.host.deployment,
        )
        .await?;
        channel.send(&Request::Probe).await?;
        let Response::Probe {
            status: Some(status),
            members,
        } = tokio::time::timeout(Duration::from_secs(15), channel.receive()).await??
        else {
            anyhow::bail!("a live authority quorum is required for replacement");
        };
        ensure!(
            channel.peer().claims().authority_identity == status.authority_identity
                && status.deployment == self.host.deployment
                && members.len() == 3,
            "invalid authority continuity proof"
        );
        let identity = status.authority_identity.clone();
        self.host
            .store
            .change(move |data| {
                ensure!(
                    data.expected_identity
                        .as_ref()
                        .is_none_or(|old| *old == identity)
                        && data.machine.authority.as_ref().is_none_or(|old| old
                            .ledger
                            .status
                            .authority_identity
                            == identity),
                    "replacement cannot change an established authority identity"
                );
                if data.cohort.is_empty() {
                    data.cohort = members;
                }
                data.expected_identity = Some(identity);
                Ok(())
            })
            .await?;
        // Reconnect so evidence is generated after the lineage pin is durable.
        drop(channel);
        let collector = self.host.collector().await?;
        let mut channel = evidence::connect(
            leader,
            &collector,
            std::slice::from_ref(&self.host.profile),
            &self.host.deployment,
        )
        .await?;
        ensure!(
            channel.peer().claims().authority_identity == status.authority_identity,
            "leader lineage changed"
        );
        channel
            .send(&Request::Join {
                remove,
                address: self.host.address,
            })
            .await?;
        let Response::Joined { status: confirmed } =
            tokio::time::timeout(Duration::from_secs(30), channel.receive()).await??
        else {
            anyhow::bail!("replacement rejected");
        };
        ensure!(
            confirmed.authority_identity == status.authority_identity,
            "replacement identity mismatch"
        );
        Ok(())
    }

    async fn start_replacement(&self, candidate: Enrollment, remove: u64) -> Result<LocalStatus> {
        candidate.fresh()?;
        let status = self.status().await?;
        ensure!(
            candidate.identity == status.authority_identity,
            "replacement must pin the existing authority first"
        );
        let id = candidate.peer.id()?;
        let membership = self.raft.metrics().borrow().membership_config.clone();
        if membership.membership().voter_ids().any(|voter| voter == id) {
            ensure!(
                self.host.admitted(&candidate.peer).await?,
                "replacement identity changed"
            );
            return Ok(status);
        }
        ensure!(
            remove != self.raft.metrics().borrow().id,
            "replace a follower before the leader"
        );
        // Confirm the advertised listening address terminates at this exact
        // attested key, not at another eligible instance or a controller proxy.
        let confirmed = self.discover(candidate.peer.address).await?;
        ensure!(
            confirmed.peer == candidate.peer && confirmed.identity == candidate.identity,
            "replacement endpoint mismatch"
        );
        let response = self
            .raft
            .client_write(Operation::BeginReplacement {
                remove,
                peer: candidate.peer,
            })
            .await?;
        ensure!(
            matches!(response.data, Outcome::Accepted { .. }),
            "replacement intent rejected"
        );
        Ok(status)
    }

    /// Idempotent continuation after a leader/process failure at any admission
    /// phase. The intent, learner pin and membership all live in protected Raft
    /// state. A leader never derives them anew from a mutable cloud object.
    pub async fn reconcile_replacement(&self) -> Result<()> {
        reconcile_replacement(&self.host.store, &self.raft).await
    }
    pub async fn shutdown(&self) -> Result<()> {
        self.raft.shutdown().await?;
        Ok(())
    }

    pub async fn serve(&self) -> Result<()> {
        let listener = TcpListener::bind(self.host.address).await?;
        let publisher = TcpListener::bind(self.host.publisher_address).await?;
        let permits = Arc::new(tokio::sync::Semaphore::new(16));
        let mut connections = tokio::task::JoinSet::new();
        let mut maintenance = tokio::task::JoinSet::new();
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                accepted = publisher.accept() => {
                    let (stream, _) = accepted?;
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                    let service = self.clone();
                    connections.spawn(async move {
                        let _permit = permit;
                        let _ = tokio::time::timeout(Duration::from_secs(60), service.handle_owner(stream)).await;
                    });
                }
                accepted = listener.accept() => {
                    let (stream, address) = accepted?;
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                    let service = self.clone();
                    connections.spawn(async move {
                        let _permit = permit;
                        let _ = tokio::time::timeout(Duration::from_secs(45), service.handle(stream, address)).await;
                        // Errors can contain confidential data. Never log bodies
                        // or upstream error chains. JoinSet owns cancellation.
                    });
                }
                _ = interval.tick(), if maintenance.is_empty() => {
                    if self.raft.metrics().borrow().state == openraft::ServerState::Leader {
                        let service = self.clone();
                        maintenance.spawn(async move {
                            let _ = tokio::time::timeout(Duration::from_secs(120), async {
                                let initialized = service.host.store.inspect(|data| Ok(data.machine.authority.is_some())).await?;
                                if !initialized {
                                    service.finish_initialization().await?;
                                }
                                service.reconcile_replacement().await
                            }).await;
                        });
                    }
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
                _ = maintenance.join_next(), if !maintenance.is_empty() => {}
            }
        }
    }
    async fn handle_owner(&self, stream: tokio::net::TcpStream) -> Result<()> {
        let collector = self.host.collector().await?;
        let mut channel = evidence::accept_publisher(stream, &collector).await?;
        let request: OwnerRequest = channel.receive().await?;
        let response = match request {
            OwnerRequest::Status => OwnerResponse::Status(self.status().await?),
            OwnerRequest::Health => self.health().await?,
            OwnerRequest::Canary => {
                let status = self.status().await?;
                let bundle = self
                    .host
                    .store
                    .inspect(|data| Ok(canary::material(data)?.bundle))
                    .await?;
                OwnerResponse::Canary { status, bundle }
            }
            OwnerRequest::Approval { workload } => {
                let (status, approval) = self.approval(workload).await?;
                OwnerResponse::Approval { status, approval }
            }
            OwnerRequest::Publish(publication) => {
                OwnerResponse::Status(self.publish(publication).await?)
            }
            OwnerRequest::Rotate(envelope) => {
                OwnerResponse::Status(self.rotate_owners(envelope).await?)
            }
        };
        channel.send(&response).await
    }
    async fn handle(&self, stream: tokio::net::TcpStream, address: SocketAddr) -> Result<()> {
        let collector = self.host.collector().await?;
        let profiles: Vec<_> = std::iter::once(self.host.profile.clone())
            .chain(self.host.runtime_profiles.clone())
            .collect();
        let mut channel =
            evidence::accept(stream, &collector, &profiles, &self.host.deployment).await?;
        let request: Request = channel.receive().await?;
        if channel.peer().claims().role == Role::Runtime {
            let Request::Resources {
                workload,
                generation,
            } = request
            else {
                anyhow::bail!("runtime request rejected");
            };
            let claims = channel.peer().claims().clone();
            // Every release uses a new quorum round, then checks the complete
            // evidence-bound lineage, policy, runtime and workload generation.
            let keys = self
                .host
                .store
                .release_keys(&self.raft, claims, workload, generation)
                .await?;
            return channel.send(&Response::Resources { keys }).await;
        }
        let mut candidate = self.host.candidate(address, channel.peer())?;
        let response = if let Request::Join {
            remove,
            address: advertised,
        } = request
        {
            ensure!(
                !advertised.ip().is_unspecified()
                    && !advertised.ip().is_multicast()
                    && advertised.port() != 0,
                "invalid replacement address"
            );
            candidate.peer.address = advertised;
            Response::Joined {
                status: self.start_replacement(candidate, remove).await?,
            }
        } else if matches!(request, Request::Probe) {
            let status = if self.raft.metrics().borrow().state == openraft::ServerState::Leader {
                self.status().await.ok()
            } else {
                None
            };
            let members = self
                .host
                .store
                .inspect(|data| {
                    let membership = data.machine.membership.membership();
                    Ok(membership
                        .voter_ids()
                        .filter_map(|id| membership.get_node(&id).map(|node| (id, node.clone())))
                        .collect())
                })
                .await?;
            Response::Probe { status, members }
        } else {
            ensure!(
                self.host.admitted(&candidate.peer).await?,
                "sender is not an admitted member"
            );
            let sender = candidate.peer.id()?;
            match request {
                Request::Append(rpc) => {
                    ensure!(
                        rpc.vote.leader_id.voted_for() == Some(sender),
                        "leader identity mismatch"
                    );
                    Response::Append(self.raft.append_entries(rpc).await)
                }
                Request::Vote(rpc) => {
                    ensure!(
                        rpc.vote.leader_id.voted_for() == Some(sender),
                        "candidate identity mismatch"
                    );
                    Response::Vote(self.raft.vote(rpc).await)
                }
                Request::Snapshot(rpc) => {
                    ensure!(
                        rpc.vote.leader_id.voted_for() == Some(sender),
                        "snapshot sender mismatch"
                    );
                    Response::Snapshot(self.raft.install_snapshot(rpc).await)
                }
                Request::Probe | Request::Join { .. } => unreachable!(),
                Request::Resources { .. } => {
                    anyhow::bail!("only measured runtimes may read workload keys")
                }
            }
        };
        channel.send(&response).await
    }
}

pub async fn fetch_runtime_keys(
    address: SocketAddr,
    local: &Collector,
    profile: &ReleaseProfile,
    deployment: &str,
    authority_identity: &str,
    workload: String,
    generation: u64,
) -> Result<ImageKeys> {
    let mut channel =
        evidence::connect(address, local, std::slice::from_ref(profile), deployment).await?;
    ensure!(
        channel.peer().claims().authority_identity == authority_identity,
        "authority identity changed"
    );
    channel
        .send(&Request::Resources {
            workload,
            generation,
        })
        .await?;
    let Response::Resources { keys } =
        tokio::time::timeout(Duration::from_secs(15), channel.receive()).await??
    else {
        anyhow::bail!("key release rejected");
    };
    Ok(keys)
}

pub(super) async fn reconcile_replacement<S: Store + Send + 'static>(
    store: &ReplicaStore<S>,
    raft: &Consensus,
) -> Result<()> {
    // An idle maintenance tick is not an authorization request. Avoid repeated
    // hardware-attested quorum rounds when there is no protected intent to
    // continue. If work exists, re-read it only AFTER a fresh quorum barrier.
    if !store
        .inspect(|data| Ok(data.machine.replacement.is_some()))
        .await?
    {
        return Ok(());
    }
    raft.ensure_linearizable().await?;
    let Some(intent) = store
        .inspect(|data| Ok(data.machine.replacement.clone()))
        .await?
    else {
        return Ok(());
    };
    let id = intent.peer.id()?;
    let membership = raft.metrics().borrow().membership_config.clone();
    let voters: BTreeSet<_> = membership.membership().voter_ids().collect();
    let joint = membership.membership().get_joint_config().len() != 1;
    if voters != intent.voters || joint {
        // A joint transition already contains the caught-up candidate. Adding
        // another learner here would conflict with that in-progress change.
        if !joint {
            raft.add_learner(id, intent.peer, true).await?;
        }
        raft.change_membership(intent.voters, false).await?;
    }
    let response = raft
        .client_write(Operation::CompleteReplacement { peer: id })
        .await?;
    ensure!(
        matches!(response.data, Outcome::Accepted { .. }),
        "replacement completion rejected"
    );
    Ok(())
}
