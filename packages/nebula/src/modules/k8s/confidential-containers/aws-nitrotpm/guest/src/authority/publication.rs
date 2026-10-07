//! Owner authorization for importing keys. The small grant commits to the full
//! public descriptor; policies never occupy the replicated secret journal.
use super::*;
use crate::workload::{self, Expectation, hex, verify_envelope};
use std::{collections::BTreeMap, fmt};
use zeroize::Zeroize;

pub const GRANT_TYPE: &str = "application/vnd.nebula.aws-coco-key-grant.v1+json";
pub const MAX_GRANT_BYTES: usize = 8192;
pub(crate) const MAX_WORKLOADS: usize = 16;

/// Field order is the canonical signed representation. Hashes authenticate the
/// exact imported AES-256 image keys; replay cannot substitute different keys.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Grant {
    pub authority_identity: String,
    pub deployment: String,
    pub descriptor_sha384: String,
    pub enabled: bool,
    pub generation: u64,
    pub resources: BTreeMap<String, String>,
    pub runtime_release: String,
    pub version: u8,
    pub workload: String,
}
impl Grant {
    pub fn encode(&self) -> Result<Vec<u8>> {
        ensure!(
            self.version == 1
                && digest(&self.authority_identity)
                && digest(&self.deployment)
                && crate::label(&self.workload)
                && self.generation > 0
                && self.generation <= MAX_GENERATION
                && digest(&self.runtime_release),
            "invalid workload grant"
        );
        crate::evidence::from_hex::<48>(&self.descriptor_sha384)?;
        ensure!(
            !self.resources.is_empty() && self.resources.len() <= 20,
            "invalid key scope"
        );
        for (path, hash) in &self.resources {
            let parts: Vec<_> = path.split('/').collect();
            ensure!(
                parts.len() == 3
                    && crate::label(parts[0])
                    && parts[1] == "image_key"
                    && crate::label(parts[2])
                    && digest(hash),
                "invalid key commitment"
            );
        }
        let bytes = serde_json::to_vec(self)?;
        ensure!(bytes.len() <= MAX_GRANT_BYTES, "grant too large");
        Ok(bytes)
    }
    pub(crate) fn verify(
        envelope: &Envelope,
        status: &LocalStatus,
        genesis: &Genesis,
    ) -> Result<Self> {
        let (bytes, _) =
            verify_envelope(envelope, &status.owners, GRANT_TYPE, MAX_GRANT_BYTES, 16)?;
        let grant: Self = serde_json::from_slice(&bytes)?;
        ensure!(
            grant.encode()? == bytes
                && grant.authority_identity == status.authority_identity
                && grant.deployment == status.deployment
                && genesis.runtime_releases.contains(&grant.runtime_release),
            "grant identity mismatch"
        );
        Ok(grant)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ImageKey([u8; 32]);
impl ImageKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub fn commitment(&self) -> String {
        hex(Sha256::digest(self.0))
    }
    pub fn encoded(&self) -> String {
        STANDARD.encode(self.0)
    }
}
impl Drop for ImageKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl fmt::Debug for ImageKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[protected image key]")
    }
}
pub type ImageKeys = BTreeMap<String, ImageKey>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub descriptor: Envelope,
    pub grant: Envelope,
    pub keys: ImageKeys,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Approval {
    pub grant: Grant,
    /// The owners who approved this exact descriptor, retained through later
    /// owner rotation. Live quorum state decides whether it is still enabled.
    pub owners: Owners,
}
impl Approval {
    pub fn verify_descriptor(
        &self,
        envelope: &Envelope,
        authority_release: &str,
    ) -> Result<workload::Verified> {
        let verified = workload::verify(
            envelope,
            &self.owners,
            &Expectation {
                deployment: self.grant.deployment.clone(),
                workload: self.grant.workload.clone(),
                generation: self.grant.generation,
                runtime_release: self.grant.runtime_release.clone(),
                authority_release: authority_release.into(),
            },
        )?;
        ensure!(
            self.grant.enabled
                && verified.descriptor_sha384 == self.grant.descriptor_sha384
                && verified.descriptor.resources
                    == self.grant.resources.keys().cloned().collect::<Vec<_>>(),
            "descriptor is not the approved key scope"
        );
        Ok(verified)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Registered {
    pub approval: Approval,
    pub keys: ImageKeys,
}
impl Registered {
    pub(crate) fn validate(&self) -> Result<()> {
        self.approval.grant.encode()?;
        self.approval.owners.validate()?;
        let expected = &self.approval.grant.resources;
        ensure!(
            if self.approval.grant.enabled {
                self.keys.len() == expected.len()
                    && self
                        .keys
                        .iter()
                        .all(|(path, key)| expected.get(path) == Some(&key.commitment()))
            } else {
                self.keys.is_empty()
            },
            "imported keys do not match owner commitments"
        );
        Ok(())
    }
}
