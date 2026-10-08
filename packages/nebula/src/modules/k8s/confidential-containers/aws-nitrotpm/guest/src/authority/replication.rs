//! OpenRaft with one encrypted, TPM-anchored persistence boundary for votes,
//! log entries, applied authority state and membership. The network adapter
//! must authenticate the precise peer key before sending any RPC or snapshot.
use super::publication::{MAX_WORKLOADS, Registered};
use super::*;
use openraft::{
    Entry, EntryPayload, LogId, LogState, RaftLogReader, RaftSnapshotBuilder, SnapshotMeta,
    StorageError, StorageIOError, StoredMembership, Vote,
    storage::{LogFlushed, RaftLogStorage, RaftStateMachine},
};
use std::{
    collections::BTreeMap,
    fmt,
    ops::RangeBounds,
    sync::{Arc, Mutex},
};
use zeroize::Zeroize;

mod buffer;
mod canary;
mod network;
pub(crate) use buffer::SnapshotBuffer;
pub use network::{
    Enrollment, OwnerRequest, OwnerResponse, ProtectedReplicas, ReplicaConfig, fetch_runtime_keys,
};
#[cfg(test)]
mod tests;

// Stay below the journal's hard bound, leaving space for the local header.
pub const MAX_REPLICA_BYTES: usize = 960 * 1024;
const MAX_ENTRIES: usize = 128;

/// These are committed peer pins, not sufficient evidence of membership by
/// themselves. Discovery may supply addresses, never replacement public keys.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Peer {
    pub address: std::net::SocketAddr,
    pub public_key: String,
    pub release: String,
    pub module_id: String,
}

impl Default for Peer {
    fn default() -> Self {
        // Required by OpenRaft's Node trait. It is deliberately not an admissible
        // peer; only explicit authenticated keys may enter membership.
        Self {
            address: ([0, 0, 0, 0], 0).into(),
            public_key: String::new(),
            release: String::new(),
            module_id: String::new(),
        }
    }
}

impl Peer {
    pub fn id(&self) -> Result<u64> {
        ensure!(
            digest(&self.release)
                && self.address.port() != 0
                && !self.module_id.is_empty()
                && self.module_id.len() <= 256,
            "invalid replica pin"
        );
        let identity = public_identity(&self.public_key)?;
        let id = u64::from_str_radix(&identity[..16], 16)?;
        ensure!(id != 0, "invalid replica identity");
        Ok(id)
    }
}

/// Secret application data is always redacted by Debug, including when the
/// consensus library logs requests or errors. It only crosses attested channels.
#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct Seed([u8; 32]);

impl Seed {
    pub(crate) fn random() -> Result<Self> {
        let mut seed = Self([0; 32]);
        OsRng
            .try_fill_bytes(&mut seed.0)
            .map_err(|_| anyhow::anyhow!("entropy unavailable"))?;
        Ok(seed)
    }
    fn public_key(&self) -> String {
        STANDARD.encode(SigningKey::from_bytes(&self.0).verifying_key().to_bytes())
    }
}
impl Drop for Seed {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl fmt::Debug for Seed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[protected seed]")
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "camelCase")]
pub(crate) enum Operation {
    // Constructed internally, once a mutually attested initial cohort is
    // established. No public HTTP deserializer may expose this operation.
    Initialize { seed: Seed },
    RotateOwners { envelope: Envelope },
    BeginReplacement { remove: u64, peer: Peer },
    CompleteReplacement { peer: u64 },
    Publish { grant: Envelope, keys: ImageKeys },
}
impl fmt::Debug for Operation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Initialize { .. } => "Initialize([protected])",
            Self::RotateOwners { .. } => "RotateOwners",
            Self::BeginReplacement { .. } => "BeginReplacement",
            Self::CompleteReplacement { .. } => "CompleteReplacement",
            Self::Publish { .. } => "Publish([protected])",
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "result", rename_all = "camelCase")]
pub(crate) enum Outcome {
    #[default]
    Noop,
    Accepted {
        status: LocalStatus,
    },
    Rejected,
}

openraft::declare_raft_types!(
    pub(crate) Types:
        D = Operation,
        R = Outcome,
        Node = Peer,
        SnapshotData = SnapshotBuffer,
);
pub(crate) type Consensus = openraft::Raft<Types>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Authority {
    identity: Seed,
    ledger: Ledger,
}

impl Authority {
    fn validate(&self, genesis: &Genesis) -> Result<()> {
        self.ledger.validate()?;
        ensure!(
            self.ledger.genesis == *genesis
                && self.identity.public_key() == self.ledger.status.authority_public_key,
            "authority snapshot identity mismatch"
        );
        Ok(())
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Machine {
    applied: Option<LogId<u64>>,
    membership: StoredMembership<u64, Peer>,
    authority: Option<Authority>,
    replacement: Option<Replacement>,
    workloads: BTreeMap<String, Registered>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Replacement {
    remove: u64,
    peer: Peer,
    voters: std::collections::BTreeSet<u64>,
}

impl Machine {
    fn validate(&self, genesis: &Genesis) -> Result<()> {
        ensure!(
            self.membership.log_id() <= &self.applied,
            "snapshot membership ahead of application"
        );
        let members: Vec<_> = self.membership.nodes().collect();
        ensure!(members.len() <= 7, "too many authority members");
        let mut modules = std::collections::BTreeSet::new();
        for (id, peer) in members {
            ensure!(
                *id == peer.id()? && modules.insert(&peer.module_id),
                "replica identity does not match its key or hardware is duplicated"
            );
        }
        if let Some(authority) = &self.authority {
            authority.validate(genesis)?;
        }
        if let Some(replacement) = &self.replacement {
            ensure!(
                replacement.voters.len() == 3
                    && replacement.voters.contains(&replacement.peer.id()?)
                    && !replacement.voters.contains(&replacement.remove),
                "invalid replacement intent"
            );
        }
        ensure!(
            self.workloads.len() <= MAX_WORKLOADS,
            "too many protected workloads"
        );
        for (name, registered) in &self.workloads {
            registered.validate()?;
            ensure!(
                *name == registered.approval.grant.workload
                    && self.authority.as_ref().is_some_and(|a| registered
                        .approval
                        .grant
                        .authority_identity
                        == a.ledger.status.authority_identity
                        && registered.approval.grant.deployment == a.ledger.status.deployment),
                "workload lineage mismatch"
            );
        }
        Ok(())
    }

    fn apply(&mut self, genesis: &Genesis, operation: &Operation) -> Outcome {
        let result = match operation {
            Operation::Initialize { seed } => {
                if self.authority.is_none() {
                    if let Ok(ledger) = Ledger::new(genesis.clone(), seed.public_key()) {
                        self.authority = Some(Authority {
                            identity: seed.clone(),
                            ledger,
                        });
                    } else {
                        return Outcome::Rejected;
                    }
                }
                let authority = self.authority.as_ref().expect("initialized above");
                if authority.ledger.status.authority_public_key != seed.public_key() {
                    return Outcome::Rejected;
                }
                Ok(authority.ledger.clone())
            }
            Operation::RotateOwners { envelope } => {
                let Some(authority) = self.authority.as_ref() else {
                    return Outcome::Rejected;
                };
                authority
                    .ledger
                    .next(envelope)
                    .map(|next| next.unwrap_or_else(|| authority.ledger.clone()))
            }
            Operation::BeginReplacement { remove, peer } => {
                let Some(authority) = &self.authority else {
                    return Outcome::Rejected;
                };
                let Ok(id) = peer.id() else {
                    return Outcome::Rejected;
                };
                if let Some(existing) = &self.replacement {
                    if existing.remove != *remove || existing.peer != *peer {
                        return Outcome::Rejected;
                    }
                } else {
                    let membership = self.membership.membership();
                    let mut voters: std::collections::BTreeSet<_> =
                        membership.voter_ids().collect();
                    if membership.get_joint_config().len() != 1
                        || voters.len() != 3
                        || !voters.remove(remove)
                        || voters.contains(&id)
                        || peer.release != genesis.authority_release
                        || membership
                            .nodes()
                            .any(|(_, member)| member.module_id == peer.module_id)
                    {
                        return Outcome::Rejected;
                    }
                    voters.insert(id);
                    self.replacement = Some(Replacement {
                        remove: *remove,
                        peer: peer.clone(),
                        voters,
                    });
                }
                Ok(authority.ledger.clone())
            }
            Operation::CompleteReplacement { peer } => {
                let Some(authority) = &self.authority else {
                    return Outcome::Rejected;
                };
                let Some(replacement) = &self.replacement else {
                    return Outcome::Rejected;
                };
                let voters: std::collections::BTreeSet<_> =
                    self.membership.membership().voter_ids().collect();
                if replacement.peer.id().ok() != Some(*peer)
                    || voters != replacement.voters
                    || self.membership.membership().get_joint_config().len() != 1
                {
                    return Outcome::Rejected;
                }
                self.replacement = None;
                Ok(authority.ledger.clone())
            }
            Operation::Publish { grant, keys } => {
                let Some(authority) = &self.authority else {
                    return Outcome::Rejected;
                };
                let Ok(grant) = Grant::verify(grant, &authority.ledger.status, genesis) else {
                    return Outcome::Rejected;
                };
                if grant.workload == canary::NAME {
                    return Outcome::Rejected;
                }
                let registered = Registered {
                    approval: Approval {
                        grant,
                        owners: authority.ledger.status.owners.clone(),
                    },
                    keys: keys.clone(),
                };
                if registered.validate().is_err() {
                    return Outcome::Rejected;
                }
                let grant = &registered.approval.grant;
                if let Some(previous) = self.workloads.get(&grant.workload) {
                    let previous = &previous.approval.grant;
                    if grant == previous {
                        return Outcome::Accepted {
                            status: authority.ledger.status.clone(),
                        };
                    }
                    if grant.generation != previous.generation + 1 {
                        return Outcome::Rejected;
                    }
                } else if grant.generation != 1 || self.workloads.len() >= MAX_WORKLOADS {
                    return Outcome::Rejected;
                }
                self.workloads.insert(grant.workload.clone(), registered);
                Ok(authority.ledger.clone())
            }
        };
        match result {
            Ok(ledger) => {
                let status = ledger.status.clone();
                self.authority.as_mut().expect("initialized above").ledger = ledger;
                Outcome::Accepted { status }
            }
            Err(_) => Outcome::Rejected,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Data {
    version: u8,
    revision: u64,
    genesis: Genesis,
    local_identity: Seed,
    cohort: BTreeMap<u64, Peer>,
    expected_identity: Option<String>,
    vote: Option<Vote<u64>>,
    committed: Option<LogId<u64>>,
    purged: Option<LogId<u64>>,
    logs: BTreeMap<u64, Entry<Types>>,
    machine: Machine,
    snapshot: Option<Machine>,
}

impl Data {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1 && self.revision > 0 && self.logs.len() <= MAX_ENTRIES,
            "invalid replica record"
        );
        self.genesis.encode()?;
        ensure!(
            self.cohort.is_empty() || self.cohort.len() == 3,
            "initial cohort requires three replicas"
        );
        let mut modules = std::collections::BTreeSet::new();
        for (id, peer) in &self.cohort {
            ensure!(
                *id == peer.id()? && modules.insert(&peer.module_id),
                "invalid initial cohort"
            );
        }
        self.machine.validate(&self.genesis)?;
        if let Some(identity) = &self.expected_identity {
            ensure!(
                digest(identity)
                    && self.machine.authority.as_ref().is_none_or(|a| a
                        .ledger
                        .status
                        .authority_identity
                        == *identity),
                "authority lineage changed after enrollment"
            );
        }
        let mut previous = self.purged.map(|id| id.index);
        for (index, entry) in &self.logs {
            ensure!(
                *index == entry.log_id.index && *index == previous.map_or(0, |index| index + 1),
                "nonconsecutive replica log"
            );
            previous = Some(*index);
        }
        if let Some(snapshot) = &self.snapshot {
            snapshot.validate(&self.genesis)?;
            ensure!(
                snapshot.applied <= self.machine.applied,
                "snapshot ahead of authority state"
            );
        }
        Ok(())
    }
}

struct Inner<S: Store> {
    journal: S,
    data: Data,
    poisoned: bool,
}

/// Cloneable OpenRaft storage handles share a single serialized hardware writer.
/// Secrets, votes, log and applied membership are committed in the same record.
pub(crate) struct ReplicaStore<S: Store + Send + 'static = TpmJournal>(Arc<Mutex<Inner<S>>>);

impl<S: Store + Send + 'static> Clone for ReplicaStore<S> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

fn unavailable() -> StorageError<u64> {
    StorageIOError::new(
        openraft::ErrorSubject::Store,
        openraft::ErrorVerb::Write,
        openraft::AnyError::error("protected replica storage unavailable"),
    )
    .into()
}

impl<S: Store + Send + 'static> ReplicaStore<S> {
    fn create(mut journal: S, genesis: Genesis) -> Result<Self> {
        let data = Data {
            version: 1,
            revision: 1,
            genesis,
            local_identity: Seed::random()?,
            cohort: BTreeMap::new(),
            expected_identity: None,
            vote: None,
            committed: None,
            purged: None,
            logs: BTreeMap::new(),
            machine: Machine::default(),
            snapshot: None,
        };
        let bytes = encode(&data)?;
        ensure!(
            journal.commit(&bytes)? == 1,
            "empty replica journal required"
        );
        Ok(Self(Arc::new(Mutex::new(Inner {
            journal,
            data,
            poisoned: false,
        }))))
    }

    fn restore(
        journal: S,
        snapshot: crate::protected_state::Snapshot,
        genesis: &Genesis,
    ) -> Result<Self> {
        ensure!(
            snapshot.bytes.len() <= MAX_REPLICA_BYTES,
            "replica record too large"
        );
        let data: Data = serde_json::from_slice(&snapshot.bytes)?;
        data.validate()?;
        ensure!(
            data.genesis == *genesis && data.revision == snapshot.sequence,
            "replica continuity mismatch"
        );
        Ok(Self(Arc::new(Mutex::new(Inner {
            journal,
            data,
            poisoned: false,
        }))))
    }

    // OpenRaft's storage trait fixes this error type; boxing it here would
    // merely box/unbox at every adapter call without reducing the trait error.
    #[allow(clippy::result_large_err)]
    async fn inspect<R: Send + 'static>(
        &self,
        read: impl FnOnce(&Data) -> Result<R> + Send + 'static,
    ) -> Result<R, StorageError<u64>> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let locked = inner.lock().map_err(|_| unavailable())?;
            if locked.poisoned {
                return Err(unavailable());
            }
            read(&locked.data).map_err(|_| unavailable())
        })
        .await
        .map_err(|_| unavailable())?
    }

    #[allow(clippy::result_large_err)]
    async fn change<R: Send + 'static>(
        &self,
        change: impl FnOnce(&mut Data) -> Result<R> + Send + 'static,
    ) -> Result<R, StorageError<u64>> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut locked = inner.lock().map_err(|_| unavailable())?;
            if locked.poisoned {
                return Err(unavailable());
            }
            let mut next = locked.data.clone();
            let result = change(&mut next).map_err(|_| unavailable())?;
            next.revision = next.revision.checked_add(1).ok_or_else(unavailable)?;
            let bytes = encode(&next).map_err(|_| unavailable())?;
            locked.poisoned = true;
            let sequence = locked.journal.commit(&bytes).map_err(|_| unavailable())?;
            if sequence != next.revision {
                return Err(unavailable());
            }
            locked.data = next;
            locked.poisoned = false;
            Ok(result)
        })
        .await
        .map_err(|_| unavailable())?
    }

    pub async fn replica_public_key(&self) -> Result<String> {
        self.inspect(|data| Ok(data.local_identity.public_key()))
            .await
            .map_err(|_| anyhow::anyhow!("replica unavailable"))
    }
    async fn release_keys(
        &self,
        raft: &Consensus,
        claims: crate::evidence::Claims,
        workload: String,
        generation: u64,
    ) -> Result<ImageKeys> {
        self.current_status(raft).await?;
        Ok(self
            .inspect(move |data| {
                let canary = if workload == canary::NAME {
                    Some(canary::material(data)?.registered)
                } else {
                    None
                };
                let registered = canary
                    .as_ref()
                    .or_else(|| data.machine.workloads.get(&workload))
                    .context("unknown workload")?;
                let grant = &registered.approval.grant;
                ensure!(
                    claims.role == crate::evidence::Role::Runtime
                        && grant.enabled
                        && grant.generation == generation
                        && grant.authority_identity == claims.authority_identity
                        && grant.deployment == claims.deployment
                        && grant.runtime_release == claims.release
                        && grant.descriptor_sha384 == claims.policy,
                    "guest is not authorized for these keys"
                );
                Ok(registered.keys.clone())
            })
            .await?)
    }

    /// Every authorization must perform a NEW quorum round before inspecting
    /// policy. The returned status alone is public information, not a capability.
    pub async fn current_status(&self, raft: &Consensus) -> Result<LocalStatus> {
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            raft.ensure_linearizable(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("authority quorum unavailable"))?
        .map_err(|_| anyhow::anyhow!("authority quorum unavailable"))?;
        self.inspect(|data| {
            Ok(data
                .machine
                .authority
                .as_ref()
                .context("authority not initialized")?
                .ledger
                .status
                .clone())
        })
        .await
        .map_err(|_| anyhow::anyhow!("authority unavailable"))
    }
}

fn encode(data: &Data) -> Result<Zeroizing<Vec<u8>>> {
    data.validate()?;
    let bytes = Zeroizing::new(serde_json::to_vec(data)?);
    ensure!(
        bytes.len() <= MAX_REPLICA_BYTES,
        "replica capacity exceeded"
    );
    Ok(bytes)
}

impl ReplicaStore<TpmJournal> {
    pub fn provision(
        directory: &Path,
        boot: &BootPolicy,
        envelope: &Envelope,
        deployment: &str,
        release: &str,
    ) -> Result<Self> {
        let genesis = verify_genesis(envelope, deployment, release)?;
        let journal = TpmJournal::provision(directory, deployment_bytes(deployment)?, boot)?;
        Self::create(journal, genesis)
    }

    pub fn recover(
        directory: &Path,
        boot: &BootPolicy,
        envelope: &Envelope,
        deployment: &str,
        release: &str,
    ) -> Result<Self> {
        let genesis = verify_genesis(envelope, deployment, release)?;
        let (journal, snapshot) =
            TpmJournal::recover(directory, deployment_bytes(deployment)?, boot)?;
        Self::restore(
            journal,
            snapshot.context("replica enrollment missing")?,
            &genesis,
        )
    }
}

#[async_trait::async_trait]
impl crate::evidence::NitroSource for ReplicaStore<TpmJournal> {
    async fn document(&self, request: crate::evidence::NitroRequest) -> Result<Vec<u8>> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut locked = inner
                .lock()
                .map_err(|_| anyhow::anyhow!("protected TPM writer unavailable"))?;
            ensure!(!locked.poisoned, "protected TPM writer unavailable");
            locked.journal.attest(request)
        })
        .await?
    }
}

impl<S: Store + Send + 'static> RaftLogReader<Types> for ReplicaStore<S> {
    async fn try_get_log_entries<RB: RangeBounds<u64> + Clone + fmt::Debug + Send>(
        &mut self,
        range: RB,
    ) -> Result<Vec<Entry<Types>>, StorageError<u64>> {
        let start = range.start_bound().cloned();
        let end = range.end_bound().cloned();
        self.inspect(move |data| {
            // Filtering a bounded log avoids BTreeMap::range's panic on an
            // empty/inverted pair of inclusive or exclusive bounds.
            let range = (start, end);
            Ok(data
                .logs
                .iter()
                .filter(|(index, _)| range.contains(*index))
                .map(|(_, entry)| entry.clone())
                .collect())
        })
        .await
    }
}

impl<S: Store + Send + 'static> RaftLogStorage<Types> for ReplicaStore<S> {
    type LogReader = Self;

    async fn get_log_state(&mut self) -> Result<LogState<Types>, StorageError<u64>> {
        self.inspect(|data| {
            Ok(LogState {
                last_purged_log_id: data.purged,
                last_log_id: data
                    .logs
                    .last_key_value()
                    .map(|(_, entry)| entry.log_id)
                    .or(data.purged),
            })
        })
        .await
    }
    async fn get_log_reader(&mut self) -> Self::LogReader {
        self.clone()
    }

    async fn save_vote(&mut self, vote: &Vote<u64>) -> Result<(), StorageError<u64>> {
        let vote = *vote;
        if self
            .inspect(move |data| Ok(data.vote == Some(vote)))
            .await?
        {
            return Ok(());
        }
        self.change(move |data| {
            ensure!(
                data.vote.is_none_or(|previous| vote >= previous),
                "vote cannot move backwards"
            );
            data.vote = Some(vote);
            Ok(())
        })
        .await
    }
    async fn read_vote(&mut self) -> Result<Option<Vote<u64>>, StorageError<u64>> {
        self.inspect(|data| Ok(data.vote)).await
    }

    async fn save_committed(
        &mut self,
        committed: Option<LogId<u64>>,
    ) -> Result<(), StorageError<u64>> {
        if self
            .inspect(move |data| Ok(data.committed == committed))
            .await?
        {
            return Ok(());
        }
        self.change(move |data| {
            ensure!(committed >= data.committed, "commit cannot move backwards");
            data.committed = committed;
            Ok(())
        })
        .await
    }
    async fn read_committed(&mut self) -> Result<Option<LogId<u64>>, StorageError<u64>> {
        self.inspect(|data| Ok(data.committed.max(data.machine.applied)))
            .await
    }

    async fn append<I>(
        &mut self,
        entries: I,
        callback: LogFlushed<Types>,
    ) -> Result<(), StorageError<u64>>
    where
        I: IntoIterator<Item = Entry<Types>> + Send,
        I::IntoIter: Send,
    {
        let entries: Vec<_> = entries.into_iter().take(MAX_ENTRIES + 1).collect();
        if entries.is_empty() {
            // Heartbeats/read barriers must not consume NV endurance or write
            // another full protected state record when no log changed.
            callback.log_io_completed(Ok(()));
            return Ok(());
        }
        let result = self
            .change(move |data| {
                ensure!(entries.len() <= MAX_ENTRIES, "replica append too large");
                for entry in entries {
                    if let Some(existing) = data.logs.get(&entry.log_id.index) {
                        let before = Zeroizing::new(serde_json::to_vec(existing)?);
                        let after = Zeroizing::new(serde_json::to_vec(&entry)?);
                        ensure!(
                            *before == *after,
                            "truncate conflicting uncommitted entries first"
                        );
                    } else {
                        data.logs.insert(entry.log_id.index, entry);
                    }
                }
                Ok(())
            })
            .await;
        callback.log_io_completed(if result.is_ok() {
            Ok(())
        } else {
            Err(std::io::Error::other("protected log not durable"))
        });
        result
    }

    async fn truncate(&mut self, log_id: LogId<u64>) -> Result<(), StorageError<u64>> {
        self.change(move |data| {
            ensure!(
                data.machine
                    .applied
                    .is_none_or(|id| log_id.index > id.index)
                    && data.committed.is_none_or(|id| log_id.index > id.index),
                "cannot truncate committed history"
            );
            data.logs.split_off(&log_id.index);
            Ok(())
        })
        .await
    }

    async fn purge(&mut self, log_id: LogId<u64>) -> Result<(), StorageError<u64>> {
        self.change(move |data| {
            ensure!(
                Some(log_id) >= data.purged
                    && Some(log_id) <= data.machine.applied
                    && data
                        .snapshot
                        .as_ref()
                        .is_some_and(|snapshot| Some(log_id) <= snapshot.applied),
                "durable snapshot required before purging history"
            );
            data.purged = Some(log_id);
            data.logs = data.logs.split_off(&(log_id.index + 1));
            Ok(())
        })
        .await
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Transfer {
    version: u8,
    genesis: Genesis,
    machine: Machine,
}

fn snapshot(genesis: &Genesis, machine: Machine) -> Result<openraft::Snapshot<Types>> {
    machine.validate(genesis)?;
    let deployment = genesis.deployment()?;
    let meta = SnapshotMeta {
        last_log_id: machine.applied,
        last_membership: machine.membership.clone(),
        snapshot_id: format!(
            "{}-{}",
            deployment,
            machine
                .applied
                .map_or_else(|| "empty".into(), |id| id.to_string())
        ),
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&Transfer {
        version: 1,
        genesis: genesis.clone(),
        machine,
    })?);
    ensure!(
        bytes.len() <= MAX_REPLICA_BYTES,
        "replica snapshot too large"
    );
    Ok(openraft::Snapshot {
        meta,
        snapshot: Box::new(SnapshotBuffer::new(bytes)),
    })
}

impl<S: Store + Send + 'static> RaftSnapshotBuilder<Types> for ReplicaStore<S> {
    async fn build_snapshot(&mut self) -> Result<openraft::Snapshot<Types>, StorageError<u64>> {
        self.change(|data| {
            data.snapshot = Some(data.machine.clone());
            snapshot(&data.genesis, data.machine.clone())
        })
        .await
    }
}

impl<S: Store + Send + 'static> RaftStateMachine<Types> for ReplicaStore<S> {
    type SnapshotBuilder = Self;

    async fn applied_state(
        &mut self,
    ) -> Result<(Option<LogId<u64>>, StoredMembership<u64, Peer>), StorageError<u64>> {
        self.inspect(|data| Ok((data.machine.applied, data.machine.membership.clone())))
            .await
    }

    async fn apply<I>(&mut self, entries: I) -> Result<Vec<Outcome>, StorageError<u64>>
    where
        I: IntoIterator<Item = Entry<Types>> + Send,
        I::IntoIter: Send,
    {
        let entries: Vec<_> = entries.into_iter().take(MAX_ENTRIES + 1).collect();
        self.change(move |data| {
            ensure!(
                entries.len() <= MAX_ENTRIES,
                "replica application too large"
            );
            let mut results = Vec::new();
            for entry in entries {
                let next = data.machine.applied.map_or(0, |id| id.index + 1);
                ensure!(
                    entry.log_id.index == next,
                    "state application must be consecutive"
                );
                data.machine.applied = Some(entry.log_id);
                data.committed = data.committed.max(data.machine.applied);
                results.push(match entry.payload {
                    EntryPayload::Blank => Outcome::Noop,
                    EntryPayload::Membership(membership) => {
                        data.machine.membership =
                            StoredMembership::new(Some(entry.log_id), membership);
                        Outcome::Noop
                    }
                    EntryPayload::Normal(operation) => {
                        data.machine.apply(&data.genesis, &operation)
                    }
                });
            }
            Ok(results)
        })
        .await
    }

    async fn get_snapshot_builder(&mut self) -> Self::SnapshotBuilder {
        self.clone()
    }
    async fn begin_receiving_snapshot(&mut self) -> Result<Box<SnapshotBuffer>, StorageError<u64>> {
        Ok(Box::default())
    }

    async fn install_snapshot(
        &mut self,
        meta: &SnapshotMeta<u64, Peer>,
        incoming: Box<SnapshotBuffer>,
    ) -> Result<(), StorageError<u64>> {
        let meta = meta.clone();
        self.change(move |data| {
            ensure!(
                incoming.bytes.len() <= MAX_REPLICA_BYTES,
                "snapshot capacity exceeded"
            );
            let transfer: Transfer = serde_json::from_slice(&incoming.bytes)?;
            ensure!(
                transfer.version == 1 && transfer.genesis == data.genesis,
                "snapshot deployment mismatch"
            );
            transfer.machine.validate(&data.genesis)?;
            ensure!(
                transfer.machine.applied == meta.last_log_id
                    && transfer.machine.membership == meta.last_membership
                    && transfer.machine.applied >= data.machine.applied,
                "stale or inconsistent snapshot"
            );
            if transfer.machine.applied == data.machine.applied {
                let before = Zeroizing::new(serde_json::to_vec(&data.machine)?);
                let after = Zeroizing::new(serde_json::to_vec(&transfer.machine)?);
                ensure!(*before == *after, "conflicting snapshot at applied index");
            }
            if let Some(original) = &data.machine.authority {
                ensure!(
                    transfer.machine.authority.as_ref().is_some_and(|next| next
                        .ledger
                        .status
                        .authority_identity
                        == original.ledger.status.authority_identity),
                    "snapshot changes the original authority identity"
                );
            }
            data.committed = data.committed.max(transfer.machine.applied);
            data.machine = transfer.machine;
            data.snapshot = Some(data.machine.clone());
            Ok(())
        })
        .await
    }

    async fn get_current_snapshot(
        &mut self,
    ) -> Result<Option<openraft::Snapshot<Types>>, StorageError<u64>> {
        self.inspect(|data| {
            data.snapshot
                .clone()
                .map(|state| snapshot(&data.genesis, state))
                .transpose()
        })
        .await
    }
}
