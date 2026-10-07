//! The installation canary has one public, non-customer key and one immutable
//! release-built policy. It cannot import keys or substitute workload policy.
use super::*;
use crate::workload::{Descriptor, EnvelopeSignature, PAYLOAD_TYPE, signed_bytes};
use ed25519_dalek::Signer;
use sha2::Sha384;

pub const NAME: &str = "nebula-runtime-canary";
const RESOURCE: &str = "nebula-canary/image_key/v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Spec {
    pub image: String,
    pub policy: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub descriptor: Envelope,
    pub grant: Envelope,
}
pub(crate) struct Material {
    pub bundle: Bundle,
    pub registered: Registered,
}
pub(crate) fn material(data: &Data) -> Result<Material> {
    let path = Path::new("/usr/share/nebula/canary.json");
    crate::require_readonly_file(path)?;
    let bytes = std::fs::read(path)?;
    ensure!(
        bytes.len() <= crate::workload::MAX_BYTES,
        "canary definition too large"
    );
    let spec: Spec = serde_json::from_slice(&bytes)?;
    from_spec(data, spec)
}
pub(super) fn from_spec(data: &Data, spec: Spec) -> Result<Material> {
    let authority = data
        .machine
        .authority
        .as_ref()
        .context("authority unavailable")?;
    let status = &authority.ledger.status;
    // This well-known key is deliberately public. Its only use is encrypting
    // the module's test image; it never shares a path with customer material.
    let key = ImageKey::from_bytes(Sha256::digest(b"nebula-coco-public-canary-v1").into());
    let descriptor = Descriptor {
        authority_release: data.genesis.authority_release.clone(),
        deployment: status.deployment.clone(),
        generation: 1,
        images: vec![spec.image],
        policy_sha256: hex(Sha256::digest(spec.policy.as_bytes())),
        policy: spec.policy,
        resources: vec![RESOURCE.into()],
        runtime_release: data
            .genesis
            .runtime_releases
            .first()
            .context("runtime missing")?
            .clone(),
        version: 1,
        workload: NAME.into(),
    };
    let payload = descriptor.encode()?;
    let grant = Grant {
        authority_identity: status.authority_identity.clone(),
        deployment: status.deployment.clone(),
        descriptor_sha384: hex(Sha384::digest(&payload)),
        enabled: true,
        generation: 1,
        resources: BTreeMap::from([(RESOURCE.into(), key.commitment())]),
        runtime_release: descriptor.runtime_release.clone(),
        version: 1,
        workload: NAME.into(),
    };
    let sign = |kind: &str, bytes: &[u8], limit| -> Result<Envelope> {
        let signature =
            SigningKey::from_bytes(&authority.identity.0).sign(&signed_bytes(kind, bytes, limit)?);
        Ok(Envelope {
            payload_type: kind.into(),
            payload: STANDARD.encode(bytes),
            signatures: vec![EnvelopeSignature {
                keyid: status.authority_identity.clone(),
                sig: STANDARD.encode(signature.to_bytes()),
            }],
        })
    };
    let bundle = Bundle {
        descriptor: sign(PAYLOAD_TYPE, &payload, crate::workload::MAX_BYTES)?,
        grant: sign(GRANT_TYPE, &grant.encode()?, MAX_GRANT_BYTES)?,
    };
    let registered = Registered {
        approval: Approval {
            grant,
            owners: Owners {
                keys: vec![status.authority_public_key.clone()],
                threshold: 1,
            },
        },
        keys: BTreeMap::from([(RESOURCE.into(), key)]),
    };
    registered.validate()?;
    Ok(Material { bundle, registered })
}
