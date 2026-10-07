//! Protected local owner enrollment and rotation. This is a state-machine
//! component, not an attestation endpoint, replicated membership protocol or
//! key-release permission. No boot unit or configuration flag enables it.
use crate::{
    protected_state::Snapshot,
    tpm_state::{BootPolicy, TpmJournal},
    workload::{Envelope, Owners, decode, digest, hex, verify_envelope},
};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rsa::rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use zeroize::Zeroizing;

pub(crate) mod replication;
pub use replication::{
    Enrollment, OwnerRequest, OwnerResponse, ProtectedReplicas, ReplicaConfig, fetch_runtime_keys,
};
mod publication;
pub use publication::{
    Approval, GRANT_TYPE, Grant, ImageKey, ImageKeys, MAX_GRANT_BYTES, Publication,
};

pub const GENESIS_TYPE: &str = "application/vnd.nebula.aws-coco-genesis.v1+json";
pub const OWNERS_TYPE: &str = "application/vnd.nebula.aws-coco-owners.v1+json";
pub const MAX_BYTES: usize = 16 * 1024;
const MAX_GENERATION: u64 = 9_007_199_254_740_991;
const MAGIC: &[u8; 16] = b"NEBULA-OWNER-V1\0";

/// Canonical field order is part of this DSSE application profile. The
/// deployment ID is SHA256 of these bytes, including the complete owner set.
#[derive(Clone, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Genesis {
    pub authority_release: String,
    pub nonce: String,
    pub owners: Owners,
    pub runtime_releases: Vec<String>,
    pub version: u8,
}

fn canonical_owners(owners: &Owners) -> Result<()> {
    owners.validate()?;
    ensure!(
        owners.keys.windows(2).all(|pair| pair[0] < pair[1]),
        "owner keys must be sorted"
    );
    Ok(())
}

fn bounded_json(value: &impl Serialize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() <= MAX_BYTES, "authority payload too large");
    Ok(bytes)
}

impl Genesis {
    pub fn encode(&self) -> Result<Vec<u8>> {
        ensure!(
            self.version == 1 && digest(&self.authority_release) && digest(&self.nonce),
            "invalid genesis identity"
        );
        canonical_owners(&self.owners)?;
        ensure!(
            !self.runtime_releases.is_empty()
                && self.runtime_releases.len() <= 16
                && self.runtime_releases.iter().all(|value| digest(value))
                && self
                    .runtime_releases
                    .windows(2)
                    .all(|pair| pair[0] < pair[1]),
            "invalid runtime release set"
        );
        bounded_json(self)
    }

    pub fn deployment(&self) -> Result<String> {
        Ok(hex(Sha256::digest(self.encode()?)))
    }
}

/// The expected deployment MUST be independently pinned by the owner/client,
/// and release identity by authenticated software distribution. Checking a hash
/// supplied beside an untrusted envelope does not establish the intended owner.
pub fn verify_genesis(
    envelope: &Envelope,
    deployment: &str,
    authority_release: &str,
) -> Result<Genesis> {
    ensure!(
        digest(deployment) && digest(authority_release),
        "invalid genesis pins"
    );
    let payload = decode(&envelope.payload, MAX_BYTES)?;
    // Authenticate the owner-set commitment BEFORE treating embedded keys as
    // trusted verification keys. Self-signatures alone are not enrollment.
    ensure!(
        hex(Sha256::digest(&payload)) == deployment,
        "genesis commitment mismatch"
    );
    let genesis: Genesis = serde_json::from_slice(&payload).context("invalid genesis")?;
    ensure!(
        genesis.encode()? == payload && genesis.authority_release == authority_release,
        "genesis release or encoding mismatch"
    );
    let (verified, _) = verify_envelope(envelope, &genesis.owners, GENESIS_TYPE, MAX_BYTES, 16)?;
    ensure!(verified == payload, "genesis payload changed");
    Ok(genesis)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OwnerUpdate {
    pub authority_identity: String,
    pub deployment: String,
    pub generation: u64,
    pub owners: Owners,
    pub previous: String,
    pub version: u8,
}

impl OwnerUpdate {
    pub fn encode(&self) -> Result<Vec<u8>> {
        ensure!(
            self.version == 1
                && digest(&self.authority_identity)
                && digest(&self.deployment)
                && digest(&self.previous)
                && (2..=MAX_GENERATION).contains(&self.generation),
            "invalid owner transition"
        );
        canonical_owners(&self.owners)?;
        bounded_json(self)
    }
}

/// Public local status only. It cannot replace attestation, client continuity
/// pins, committed membership or a current quorum read barrier.
#[derive(Clone, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalStatus {
    pub authority_identity: String,
    pub authority_public_key: String,
    pub deployment: String,
    pub generation: u64,
    pub head: String,
    pub owners: Owners,
}

pub(crate) fn public_identity(encoded: &str) -> Result<String> {
    let bytes = decode(encoded, 32)?;
    ensure!(
        bytes.len() == 32 && STANDARD.encode(&bytes) == encoded,
        "invalid authority public key"
    );
    let key = VerifyingKey::from_bytes(bytes.as_slice().try_into()?)?;
    ensure!(!key.is_weak(), "weak authority public key");
    Ok(hex(Sha256::digest(bytes)))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    genesis: Genesis,
    status: LocalStatus,
}

impl Ledger {
    fn new(genesis: Genesis, public_key: String) -> Result<Self> {
        let deployment = genesis.deployment()?;
        let status = LocalStatus {
            authority_identity: public_identity(&public_key)?,
            authority_public_key: public_key,
            deployment: deployment.clone(),
            generation: 1,
            head: deployment,
            owners: genesis.owners.clone(),
        };
        Ok(Self { genesis, status })
    }

    fn validate(&self) -> Result<()> {
        canonical_owners(&self.status.owners)?;
        ensure!(
            self.genesis.deployment()? == self.status.deployment
                && public_identity(&self.status.authority_public_key)?
                    == self.status.authority_identity
                && (1..=MAX_GENERATION).contains(&self.status.generation)
                && digest(&self.status.head),
            "invalid protected owner ledger"
        );
        if self.status.generation == 1 {
            ensure!(
                self.status.head == self.status.deployment
                    && self.status.owners == self.genesis.owners,
                "genesis ledger mismatch"
            );
        } else {
            ensure!(
                self.status.head != self.status.deployment,
                "missing owner transition"
            );
        }
        Ok(())
    }

    fn next(&self, envelope: &Envelope) -> Result<Option<Self>> {
        let (payload, _) =
            verify_envelope(envelope, &self.status.owners, OWNERS_TYPE, MAX_BYTES, 32)?;
        let update: OwnerUpdate =
            serde_json::from_slice(&payload).context("invalid owner update")?;
        ensure!(update.encode()? == payload, "noncanonical owner update");
        ensure!(
            update.deployment == self.status.deployment
                && update.authority_identity == self.status.authority_identity,
            "owner lineage mismatch"
        );
        let head = hex(Sha256::digest(&payload));
        if update.generation == self.status.generation && head == self.status.head {
            // A lost acknowledgment can replay the SAME accepted payload. The
            // current owner threshold must still sign it. No new TPM write.
            return Ok(None);
        }
        ensure!(
            update.generation == self.status.generation + 1 && update.previous == self.status.head,
            "stale or forked owner update"
        );
        ensure!(
            update.owners != self.status.owners,
            "owner update has no change"
        );
        // Both the existing authority and the incoming owner threshold must
        // sign the SAME bytes. This also proves possession of incoming keys.
        let (incoming, _) = verify_envelope(envelope, &update.owners, OWNERS_TYPE, MAX_BYTES, 32)?;
        ensure!(incoming == payload, "owner update payload changed");
        let mut next = self.clone();
        next.status.generation = update.generation;
        next.status.head = head;
        next.status.owners = update.owners;
        Ok(Some(next))
    }
}

// Private trait: production construction always uses the protected TPM journal.
// Unit tests inject lost replies/storage failure without a public bypass switch.
pub(crate) trait Store {
    fn commit(&mut self, bytes: &[u8]) -> Result<u64>;
}
impl Store for TpmJournal {
    fn commit(&mut self, bytes: &[u8]) -> Result<u64> {
        TpmJournal::commit(self, bytes)
    }
}

struct State<S: Store> {
    store: S,
    ledger: Ledger,
    identity_seed: Zeroizing<[u8; 32]>,
    poisoned: bool,
}

impl<S: Store> State<S> {
    fn enroll(store: S, genesis: Genesis) -> Result<Self> {
        let mut seed = Zeroizing::new([0; 32]);
        OsRng
            .try_fill_bytes(seed.as_mut())
            .map_err(|_| anyhow::anyhow!("entropy unavailable"))?;
        let public_key = STANDARD.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        let ledger = Ledger::new(genesis, public_key)?;
        let mut state = Self {
            store,
            ledger,
            identity_seed: seed,
            poisoned: true,
        };
        let bytes = state.record(&state.ledger)?;
        ensure!(
            state.store.commit(&bytes)? == 1,
            "new authority journal required"
        );
        state.poisoned = false;
        Ok(state)
    }

    fn record(&self, ledger: &Ledger) -> Result<Zeroizing<Vec<u8>>> {
        ledger.validate()?;
        let public = serde_json::to_vec(ledger)?;
        ensure!(public.len() <= MAX_BYTES * 2, "owner ledger too large");
        // Never serialize the identity seed into a plaintext String or expose
        // it in public status/errors. The enclosing Journal encrypts this buffer.
        let mut bytes = Zeroizing::new(Vec::with_capacity(48 + public.len()));
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(self.identity_seed.as_ref());
        bytes.extend_from_slice(&public);
        Ok(bytes)
    }

    fn recover(
        store: S,
        snapshot: Snapshot,
        deployment: &str,
        identity: &str,
        release: &str,
    ) -> Result<Self> {
        ensure!(
            snapshot.bytes.len() > 48
                && snapshot.bytes.len() <= MAX_BYTES * 2 + 48
                && &snapshot.bytes[..16] == MAGIC,
            "invalid protected owner record"
        );
        let seed = Zeroizing::new(snapshot.bytes[16..48].try_into()?);
        let ledger: Ledger = serde_json::from_slice(&snapshot.bytes[48..])?;
        ledger.validate()?;
        let public_key = STANDARD.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        ensure!(
            ledger.status.authority_public_key == public_key
                && ledger.status.deployment == deployment
                && ledger.status.authority_identity == identity
                && ledger.genesis.authority_release == release
                && ledger.status.generation == snapshot.sequence,
            "protected owner continuity mismatch"
        );
        Ok(Self {
            store,
            ledger,
            identity_seed: seed,
            poisoned: false,
        })
    }

    fn status(&self) -> Result<&LocalStatus> {
        ensure!(!self.poisoned, "owner state requires recovery");
        Ok(&self.ledger.status)
    }

    fn apply(&mut self, envelope: &Envelope) -> Result<&LocalStatus> {
        self.status()?;
        if let Some(next) = self.ledger.next(envelope)? {
            let bytes = self.record(&next)?;
            // An error can mean the hardware committed but its response was
            // lost. No old in-memory owner set remains usable after that point.
            self.poisoned = true;
            ensure!(
                self.store.commit(&bytes)? == next.status.generation,
                "owner commit not confirmed"
            );
            self.ledger = next;
            self.poisoned = false;
        }
        self.status()
    }
}

/// Local persistent enrollment facade. The future attested/replicated service
/// must supply independently authenticated pins and apply only ordered committed
/// operations. This type offers no network admin endpoint or key-release API.
pub struct ProtectedOwners(State<TpmJournal>);

fn deployment_bytes(value: &str) -> Result<[u8; 32]> {
    ensure!(digest(value), "invalid deployment pin");
    let mut bytes = [0; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)?;
    }
    Ok(bytes)
}

impl ProtectedOwners {
    /// First enrollment only. Signature and commitment checks precede every
    /// hardware mutation. Only the confirmed initial commit exposes an identity.
    pub fn enroll(
        directory: &Path,
        boot: &BootPolicy,
        envelope: &Envelope,
        deployment: &str,
        authority_release: &str,
    ) -> Result<Self> {
        let genesis = verify_genesis(envelope, deployment, authority_release)?;
        let journal = TpmJournal::provision(directory, deployment_bytes(deployment)?, boot)?;
        Ok(Self(State::enroll(journal, genesis)?))
    }

    /// Both deployment AND original authority identity must come from retained
    /// authenticated continuity, never mutable discovery or this disk itself.
    /// An empty local journal is NOT permission to generate a replacement seed.
    pub fn recover(
        directory: &Path,
        boot: &BootPolicy,
        deployment: &str,
        authority_identity: &str,
        authority_release: &str,
    ) -> Result<Self> {
        ensure!(
            digest(authority_identity) && digest(authority_release),
            "invalid authority pins"
        );
        let (journal, snapshot) =
            TpmJournal::recover(directory, deployment_bytes(deployment)?, boot)?;
        Ok(Self(State::recover(
            journal,
            snapshot.context("owner enrollment missing")?,
            deployment,
            authority_identity,
            authority_release,
        )?))
    }

    pub fn local_status(&self) -> Result<&LocalStatus> {
        self.0.status()
    }
    pub fn apply_owner_update(&mut self, envelope: &Envelope) -> Result<&LocalStatus> {
        self.0.apply(envelope)
    }
}

/// Bounded public diagnostic for cross-language verification. It does not create
/// a service identity, touch a TPM, enroll an owner or authenticate its caller.
pub fn verify_stdin() -> Result<()> {
    use std::io::Read;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Request {
        genesis: Envelope,
        deployment: String,
        authority_release: String,
        authority_public_key: String,
        updates: Vec<Envelope>,
    }
    let mut input = Vec::new();
    std::io::stdin()
        .take(256 * 1024 + 1)
        .read_to_end(&mut input)?;
    ensure!(input.len() <= 256 * 1024, "authority diagnostic too large");
    let request: Request = serde_json::from_slice(&input)?;
    ensure!(request.updates.len() <= 8, "too many owner updates");
    let genesis = verify_genesis(
        &request.genesis,
        &request.deployment,
        &request.authority_release,
    )?;
    let mut ledger = Ledger::new(genesis, request.authority_public_key)?;
    for envelope in request.updates {
        if let Some(next) = ledger.next(&envelope)? {
            ledger = next;
        }
    }
    serde_json::to_writer(std::io::stdout(), &ledger.status)?;
    Ok(())
}

#[cfg(test)]
mod tests;
