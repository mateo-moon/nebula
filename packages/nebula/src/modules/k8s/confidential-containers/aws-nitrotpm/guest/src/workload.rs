//! Public signed workload descriptors. Trust comes from authenticated owner state,
//! never from a public key included in the descriptor itself.
use anyhow::{Context, Result, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha384};
use std::collections::BTreeSet;

pub const PAYLOAD_TYPE: &str = "application/vnd.nebula.aws-coco-workload.v1+json";
pub const MAX_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Owners {
    pub keys: Vec<String>,
    pub threshold: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Expectation {
    pub deployment: String,
    pub workload: String,
    pub generation: u64,
    pub runtime_release: String,
    pub authority_release: String,
}

/// Field order defines this application's canonical JSON payload encoding.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Descriptor {
    pub authority_release: String,
    pub deployment: String,
    pub generation: u64,
    pub images: Vec<String>,
    pub policy: String,
    pub policy_sha256: String,
    pub resources: Vec<String>,
    pub runtime_release: String,
    pub version: u8,
    pub workload: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Envelope {
    pub payload_type: String,
    pub payload: String,
    pub signatures: Vec<EnvelopeSignature>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvelopeSignature {
    pub keyid: String,
    pub sig: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub descriptor: Descriptor,
    pub descriptor_sha384: String,
    pub pcr15: String,
    pub signer_ids: Vec<String>,
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn decode(value: &str, max: usize) -> Result<Vec<u8>> {
    ensure!(
        !value.is_empty() && value.len() <= max.div_ceil(3) * 4,
        "encoded field size invalid"
    );
    let bytes = STANDARD
        .decode(value)
        .or_else(|_| STANDARD_NO_PAD.decode(value))
        .or_else(|_| URL_SAFE.decode(value))
        .or_else(|_| URL_SAFE_NO_PAD.decode(value))?;
    ensure!(bytes.len() <= max, "decoded field too large");
    ensure!(
        [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD]
            .iter()
            .any(|engine| engine.encode(&bytes) == value),
        "noncanonical base64"
    );
    Ok(bytes)
}

fn image(value: &str) -> bool {
    if value.len() > 512 || !value.is_ascii() {
        return false;
    }
    let Some((name, hash)) = value.split_once("@sha256:") else {
        return false;
    };
    if !digest(hash) {
        return false;
    }
    let Some((registry, path)) = name.split_once('/') else {
        return false;
    };
    let (host, port) = registry
        .split_once(':')
        .map_or((registry, None), |(h, p)| (h, Some(p)));
    if port.is_some_and(|p| p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    fn segments(value: &str, separators: &[u8]) -> bool {
        let parts: Vec<_> = value
            .split(|c: char| separators.contains(&(c as u8)))
            .collect();
        !parts.is_empty()
            && parts.iter().all(|p| {
                !p.is_empty()
                    && p.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            })
    }
    segments(host, b".-") && path.split('/').all(|part| segments(part, b"._-"))
}

impl Descriptor {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && digest(&self.deployment)
                && crate::label(&self.workload)
                && self.generation > 0
                && self.generation <= 9_007_199_254_740_991
                && digest(&self.runtime_release)
                && digest(&self.authority_release),
            "invalid workload identity"
        );
        ensure!(
            !self.policy.is_empty()
                && !self.policy.contains('\0')
                && digest(&self.policy_sha256)
                && hex(Sha256::digest(self.policy.as_bytes())) == self.policy_sha256,
            "policy digest mismatch"
        );
        for (values, limit) in [(&self.images, 32), (&self.resources, 20)] {
            ensure!(
                !values.is_empty()
                    && values.len() <= limit
                    && values.windows(2).all(|pair| pair[0] < pair[1]),
                "entries must be sorted, unique and bounded"
            );
        }
        ensure!(
            self.images.iter().all(|value| image(value)),
            "digest-pinned images required"
        );
        ensure!(
            self.resources.iter().all(|value| {
                let fields: Vec<_> = value.split('/').collect();
                fields.len() == 3
                    && crate::label(fields[0])
                    && fields[1] == "image_key"
                    && crate::label(fields[2])
            }),
            "exact image-key paths required"
        );
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)?;
        ensure!(bytes.len() <= MAX_BYTES, "descriptor too large");
        Ok(bytes)
    }
}

pub fn signing_bytes(payload: &[u8]) -> Result<Vec<u8>> {
    ensure!(
        !payload.is_empty() && payload.len() <= MAX_BYTES,
        "payload size invalid"
    );
    let mut bytes = format!(
        "DSSEv1 {} {} {} ",
        PAYLOAD_TYPE.len(),
        PAYLOAD_TYPE,
        payload.len()
    )
    .into_bytes();
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

pub fn verify(envelope: &Envelope, owners: &Owners, expected: &Expectation) -> Result<Verified> {
    ensure!(
        !owners.keys.is_empty()
            && owners.keys.len() <= 16
            && owners.threshold > 0
            && owners.threshold <= owners.keys.len(),
        "invalid owner threshold"
    );
    let mut keys = Vec::new();
    let mut distinct = BTreeSet::new();
    for encoded in &owners.keys {
        let raw = decode(encoded, 32)?;
        ensure!(
            raw.len() == 32 && STANDARD.encode(&raw) == *encoded && distinct.insert(encoded),
            "invalid or duplicate owner key"
        );
        let key = VerifyingKey::from_bytes(raw.as_slice().try_into()?)?;
        ensure!(!key.is_weak(), "weak owner key");
        keys.push((hex(Sha256::digest(&raw)), key));
    }
    ensure!(
        envelope.payload_type == PAYLOAD_TYPE
            && !envelope.signatures.is_empty()
            && envelope.signatures.len() <= 16,
        "invalid envelope type or signatures"
    );
    let payload = decode(&envelope.payload, MAX_BYTES)?;
    let message = signing_bytes(&payload)?;
    let mut accepted = BTreeSet::new();
    for entry in &envelope.signatures {
        ensure!(digest(&entry.keyid), "invalid signer hint");
        let signature = Signature::from_slice(&decode(&entry.sig, 64)?)?;
        if let Some((id, key)) = keys.iter().find(|(id, _)| *id == entry.keyid)
            && key.verify_strict(&message, &signature).is_ok()
        {
            accepted.insert(id.clone());
        }
    }
    ensure!(
        accepted.len() >= owners.threshold,
        "owner signature threshold not met"
    );
    // Deserialize the same verified bytes. Typed deserialization rejects duplicate fields.
    let descriptor: Descriptor = serde_json::from_slice(&payload).context("invalid descriptor")?;
    ensure!(descriptor.encode()? == payload, "noncanonical descriptor");
    ensure!(
        descriptor.deployment == expected.deployment
            && descriptor.workload == expected.workload
            && descriptor.generation == expected.generation
            && descriptor.runtime_release == expected.runtime_release
            && descriptor.authority_release == expected.authority_release,
        "workload identity mismatch"
    );
    let measurement = Sha384::digest(&payload);
    let pcr = Sha384::new()
        .chain_update([0_u8; 48])
        .chain_update(measurement)
        .finalize();
    Ok(Verified {
        descriptor,
        descriptor_sha384: hex(measurement),
        pcr15: hex(pcr),
        signer_ids: accepted.into_iter().collect(),
    })
}

/// Bounded public-data diagnostic used by publishers and cross-language tests.
/// The caller must already trust `owners` and `expected`; this does not authorize
/// a running guest or read/write protected service state.
pub fn verify_stdin() -> Result<()> {
    use std::io::Read;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        envelope: Envelope,
        owners: Owners,
        expected: Expectation,
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((MAX_BYTES * 2 + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_BYTES * 2, "request too large");
    let request: Request = serde_json::from_slice(&bytes)?;
    let verified = verify(&request.envelope, &request.owners, &request.expected)?;
    serde_json::to_writer(std::io::stdout(), &verified)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub(crate) fn fixture() -> (Envelope, Owners, Expectation) {
        let key = SigningKey::from_bytes(&[17; 32]);
        let policy = "package agent_policy\ndefault ExecProcessRequest := false\n";
        let descriptor = Descriptor {
            authority_release: "f".repeat(64),
            deployment: "d".repeat(64),
            generation: 1,
            images: vec![format!(
                "ghcr.io/example/workload@sha256:{}",
                "a".repeat(64)
            )],
            policy: policy.into(),
            policy_sha256: hex(Sha256::digest(policy)),
            resources: vec!["default/image_key/workload".into()],
            runtime_release: "e".repeat(64),
            version: 1,
            workload: "worker".into(),
        };
        let payload = descriptor.encode().unwrap();
        let public = key.verifying_key().to_bytes();
        let envelope = Envelope {
            payload_type: PAYLOAD_TYPE.into(),
            payload: STANDARD.encode(&payload),
            signatures: vec![EnvelopeSignature {
                keyid: hex(Sha256::digest(public)),
                sig: STANDARD.encode(key.sign(&signing_bytes(&payload).unwrap()).to_bytes()),
            }],
        };
        (
            envelope,
            Owners {
                keys: vec![STANDARD.encode(public)],
                threshold: 1,
            },
            Expectation {
                deployment: descriptor.deployment,
                workload: descriptor.workload,
                generation: 1,
                runtime_release: descriptor.runtime_release,
                authority_release: descriptor.authority_release,
            },
        )
    }

    #[test]
    fn signed_identity_and_exact_policy_are_bound_to_a_dynamic_measurement() {
        let (envelope, owners, expected) = fixture();
        let result = verify(&envelope, &owners, &expected).unwrap();
        assert_eq!(result.descriptor_sha384.len(), 96);
        assert_eq!(result.pcr15.len(), 96);
        assert_eq!(result.signer_ids.len(), 1);
        let mut changed = expected;
        changed.generation += 1;
        assert!(verify(&envelope, &owners, &changed).is_err());
    }

    #[test]
    fn type_payload_signature_and_owner_substitution_fail() {
        let (mut envelope, mut owners, expected) = fixture();
        let original = envelope.payload.clone();
        envelope.payload = STANDARD.encode(b"{}");
        assert!(verify(&envelope, &owners, &expected).is_err());
        envelope.payload = original;
        envelope.payload_type.push(' ');
        assert!(verify(&envelope, &owners, &expected).is_err());
        envelope.payload_type = PAYLOAD_TYPE.into();
        owners.keys[0] =
            STANDARD.encode(SigningKey::from_bytes(&[18; 32]).verifying_key().to_bytes());
        assert!(verify(&envelope, &owners, &expected).is_err());
    }

    #[test]
    fn duplicates_do_not_satisfy_a_signature_threshold() {
        let (mut envelope, mut owners, expected) = fixture();
        owners
            .keys
            .push(STANDARD.encode(SigningKey::from_bytes(&[18; 32]).verifying_key().to_bytes()));
        owners.threshold = 2;
        envelope.signatures.push(EnvelopeSignature {
            keyid: envelope.signatures[0].keyid.clone(),
            sig: envelope.signatures[0].sig.clone(),
        });
        assert!(verify(&envelope, &owners, &expected).is_err());
    }

    #[test]
    fn duplicate_fields_and_unknown_configuration_are_rejected() {
        assert!(
            serde_json::from_str::<Envelope>(
                r#"{"payloadType":"x","payloadType":"y","payload":"eA==","signatures":[]}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Owners>(r#"{"keys":[],"threshold":1,"privateKey":"forbidden"}"#)
                .is_err()
        );
        assert!(!image("ghcr.io/example/workload:latest"));
        assert!(!image(&format!(
            "ghcr.io/example/../workload@sha256:{}",
            "a".repeat(64)
        )));
    }
}
