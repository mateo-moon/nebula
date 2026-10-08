//! Service identity under the AWS-Nitro-rooted profile. The immutable collector
//! binds its own channel key and locally obtained SNP report into the NitroTPM
//! document. This composition trusts Nitro and the measured collector; matching
//! nonces alone do not establish locality against a malicious hypervisor.
use crate::workload::{digest, hex};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ciborium::Value;
use openssl::{
    bn::BigNum,
    ecdsa::EcdsaSig,
    nid::Nid,
    pkey::PKey,
    stack::Stack,
    x509::{X509, X509StoreContext, store::X509StoreBuilder, verify::X509VerifyParam},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha384, Sha512};
use std::collections::{BTreeMap, BTreeSet};

mod snp;
pub use snp::Tcb;
mod channel;
pub use channel::{ChannelIdentity, SecureChannel, accept, connect};
pub use channel::{PublisherChannel, accept_publisher, connect_publisher};
mod collect;
pub use collect::Collector;
mod nitro;
pub(crate) use nitro::{NitroRequest, NitroSource};
#[cfg(test)]
mod tests;

const AWS_ROOT: &[u8] = include_bytes!("../../trust/aws-nitro-root-g1.crt");
const AMD_ROOT: &[u8] = include_bytes!("../../trust/amd-milan-ark.pem");
const MAX_DOCUMENT: usize = 32768;
const MAX_CERTIFICATE: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Authority,
    Runtime,
}

/// Distributed with the authenticated software release, never learned from a
/// running instance or taken from mutable management-cluster approval flags.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReleaseProfile {
    pub release: String,
    pub role: Role,
    pub pcr4: String,
    pub pcr12: String,
    pub minimum_tcb: Tcb,
}
impl ReleaseProfile {
    /// The owner-signed release ID commits to the complete verification policy.
    /// Measurements may travel through an untrusted controller without becoming
    /// a controller-selected trust decision.
    pub fn commitment(&self) -> Result<String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            minimum_tcb: &'a Tcb,
            pcr4: &'a str,
            pcr12: &'a str,
            role: Role,
            version: u8,
        }
        Ok(hex(Sha256::digest(serde_json::to_vec(&Payload {
            minimum_tcb: &self.minimum_tcb,
            pcr4: &self.pcr4,
            pcr12: &self.pcr12,
            role: self.role,
            version: 1,
        })?)))
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            digest(&self.release)
                && hex_size(&self.pcr4, 48)
                && hex_size(&self.pcr12, 48)
                && self.pcr4 != "0".repeat(96),
            "invalid release measurements"
        );
        ensure!(
            self.release == self.commitment()?,
            "release policy commitment mismatch"
        );
        self.minimum_tcb.validate()
    }
}

/// Canonical bytes are included in NitroTPM user_data. Every field is computed
/// inside the measured appliance. Discovery supplies none of these assertions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Claims {
    pub authority_identity: String,
    pub deployment: String,
    pub policy: String,
    pub release: String,
    pub replica_public_key: String,
    pub role: Role,
    pub tls_sha256: String,
    pub version: u8,
}
impl Claims {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && digest(&self.deployment)
                && digest(&self.release)
                && digest(&self.tls_sha256),
            "invalid service identity"
        );
        ensure!(
            self.authority_identity.is_empty() || digest(&self.authority_identity),
            "invalid authority identity"
        );
        match self.role {
            Role::Authority => {
                crate::authority::public_identity(&self.replica_public_key)?;
                ensure!(
                    self.policy.is_empty(),
                    "authority cannot claim a workload policy"
                );
            }
            Role::Runtime => ensure!(
                self.replica_public_key.is_empty()
                    && hex_size(&self.policy, 48)
                    && digest(&self.authority_identity),
                "invalid runtime identity"
            ),
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Binding {
    claims: Claims,
    snp_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Evidence {
    pub nitro: String,
    pub snp: String,
    pub vlek: String,
    pub asvk: String,
    pub tls_certificate: String,
}

/// Unforgeable in the application type system: only full verification creates
/// this value. It is neither a serializable assertion nor a controller input.
#[derive(Clone)]
pub struct AttestedIdentity {
    claims: Claims,
    certificate: Vec<u8>,
    module: String,
}
impl AttestedIdentity {
    pub fn claims(&self) -> &Claims {
        &self.claims
    }
    pub fn certificate(&self) -> &[u8] {
        &self.certificate
    }
    pub fn module_id(&self) -> &str {
        &self.module
    }
}

pub fn verify(
    evidence: &Evidence,
    nonce: &[u8; 32],
    profile: &ReleaseProfile,
    deployment: &str,
    now: u64,
) -> Result<AttestedIdentity> {
    let roots = Roots {
        nitro: X509::from_pem(AWS_ROOT)?,
        snp: X509::from_pem(AMD_ROOT)?,
    };
    verify_with_roots(evidence, nonce, profile, deployment, now, &roots)
}

#[derive(Clone)]
struct Roots {
    nitro: X509,
    snp: X509,
}
fn verify_with_roots(
    evidence: &Evidence,
    nonce: &[u8; 32],
    profile: &ReleaseProfile,
    deployment: &str,
    now: u64,
    roots: &Roots,
) -> Result<AttestedIdentity> {
    profile.validate()?;
    ensure!(digest(deployment), "invalid deployment");
    let nitro = decode(&evidence.nitro, MAX_DOCUMENT)?;
    let doc = verify_nitro(&nitro, &roots.nitro, nonce, now)?;
    let binding: Binding = serde_json::from_slice(&doc.user_data)?;
    binding.claims.validate()?;
    ensure!(
        serde_json::to_vec(&binding)? == doc.user_data,
        "noncanonical identity binding"
    );
    let claims = binding.claims;
    ensure!(
        claims.deployment == deployment
            && claims.release == profile.release
            && claims.role == profile.role,
        "unexpected service identity"
    );
    ensure!(
        doc.pcrs
            .get(&4)
            .is_some_and(|value| hex(value) == profile.pcr4)
            && doc
                .pcrs
                .get(&12)
                .is_some_and(|value| hex(value) == profile.pcr12),
        "unapproved measured boot"
    );
    if claims.role == Role::Runtime {
        let expected = Sha384::new()
            .chain_update([0; 48])
            .chain_update(from_hex::<48>(&claims.policy)?)
            .finalize();
        ensure!(
            doc.pcrs
                .get(&15)
                .is_some_and(|value| value.as_slice() == &expected[..]),
            "workload activation is not measured"
        );
    }
    let certificate = decode(&evidence.tls_certificate, MAX_CERTIFICATE)?;
    let tls = X509::from_der(&certificate)?;
    ensure!(
        tls.to_der()? == certificate && hex(Sha256::digest(&certificate)) == claims.tls_sha256,
        "channel certificate mismatch"
    );
    let public = tls.public_key()?;
    ensure!(
        public.public_key_to_der()? == doc.public_key,
        "channel key mismatch"
    );
    let report = decode(&evidence.snp, 1184)?;
    ensure!(
        hex(Sha256::digest(&report)) == binding.snp_sha256,
        "SNP report substitution"
    );
    let expected = report_data(nonce, &claims, &doc.public_key)?;
    snp::verify(
        &report,
        &decode(&evidence.vlek, MAX_CERTIFICATE)?,
        &decode(&evidence.asvk, MAX_CERTIFICATE)?,
        &expected,
        &profile.minimum_tcb,
        now,
        &roots.snp,
    )?;
    Ok(AttestedIdentity {
        claims,
        certificate,
        module: doc.module,
    })
}

pub(crate) fn report_data(nonce: &[u8; 32], claims: &Claims, public: &[u8]) -> Result<[u8; 64]> {
    claims.validate()?;
    Ok(Sha512::new()
        .chain_update(b"nebula.aws-coco.local-snp.v1\0")
        .chain_update(nonce)
        .chain_update(Sha256::digest(serde_json::to_vec(claims)?))
        .chain_update(Sha256::digest(public))
        .finalize()
        .into())
}

fn decode(text: &str, limit: usize) -> Result<Vec<u8>> {
    ensure!(
        text.len() <= limit.div_ceil(3) * 4,
        "evidence field too large"
    );
    let bytes = STANDARD.decode(text)?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= limit && STANDARD.encode(&bytes) == text,
        "invalid evidence encoding"
    );
    Ok(bytes)
}
fn hex_size(value: &str, size: usize) -> bool {
    value.len() == size * 2
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn from_hex<const N: usize>(value: &str) -> Result<[u8; N]> {
    ensure!(hex_size(value, N), "invalid digest encoding");
    let mut result = [0; N];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)?;
    }
    Ok(result)
}

fn cbor(bytes: &[u8]) -> Result<Value> {
    let mut cursor = std::io::Cursor::new(bytes);
    let value = ciborium::de::from_reader_with_recursion_limit(&mut cursor, 12)?;
    ensure!(
        cursor.position() == bytes.len() as u64,
        "trailing CBOR bytes"
    );
    Ok(value)
}
fn bytes(value: &Value) -> Result<&[u8]> {
    value
        .as_bytes()
        .map(Vec::as_slice)
        .context("expected CBOR bytes")
}
fn integer(value: &Value) -> Result<i128> {
    value
        .as_integer()
        .map(Into::into)
        .context("expected CBOR integer")
}

struct NitroDocument {
    module: String,
    pcrs: BTreeMap<u8, Vec<u8>>,
    public_key: Vec<u8>,
    user_data: Vec<u8>,
}
fn verify_nitro(blob: &[u8], root: &X509, nonce: &[u8; 32], now: u64) -> Result<NitroDocument> {
    ensure!(
        !blob.is_empty() && blob.len() <= MAX_DOCUMENT,
        "invalid NitroTPM document size"
    );
    let envelope = match cbor(blob)? {
        Value::Tag(18, value) => *value,
        value => value,
    };
    let values = envelope.as_array().context("COSE Sign1 required")?;
    ensure!(values.len() == 4, "invalid COSE fields");
    let protected = bytes(&values[0])?;
    ensure!(
        cbor(protected)?
            == Value::Map(vec![(
                Value::Integer(1.into()),
                Value::Integer((-35).into())
            )])
            && values[1] == Value::Map(vec![]),
        "ES384 COSE header required"
    );
    let payload = bytes(&values[2])?;
    let signature = bytes(&values[3])?;
    ensure!(signature.len() == 96, "invalid COSE signature length");
    let raw = cbor(payload)?;
    let pairs = raw.as_map().context("invalid NitroTPM payload")?;
    let mut doc = BTreeMap::new();
    for (key, value) in pairs {
        ensure!(
            doc.insert(key.as_text().context("invalid document key")?, value)
                .is_none(),
            "duplicate document field"
        );
    }
    let allowed = BTreeSet::from([
        "module_id",
        "timestamp",
        "digest",
        "nitrotpm_pcrs",
        "certificate",
        "cabundle",
        "nonce",
        "public_key",
        "user_data",
    ]);
    ensure!(
        doc.keys().copied().collect::<BTreeSet<_>>() == allowed,
        "NitroTPM binding schema required"
    );
    let module = doc["module_id"].as_text().context("module ID missing")?;
    ensure!(
        !module.is_empty() && module.len() <= 256 && doc["digest"].as_text() == Some("SHA384"),
        "invalid NitroTPM identity"
    );
    let timestamp = integer(doc["timestamp"])?;
    ensure!(
        timestamp >= i128::from(now.saturating_sub(60)) * 1000
            && timestamp <= (i128::from(now) + 5) * 1000,
        "stale or future evidence"
    );
    ensure!(bytes(doc["nonce"])? == nonce, "challenge mismatch");
    let public = bytes(doc["public_key"])?;
    ensure!(public.len() <= 1024, "oversized channel key");
    let key = PKey::public_key_from_der(public)?;
    let rsa = key.rsa()?;
    ensure!(
        [2048, 3072, 4096].contains(&rsa.n().num_bits())
            && rsa.e().to_vec() == [1, 0, 1]
            && key.public_key_to_der()? == public,
        "canonical RSA channel key required"
    );
    let user_data = bytes(doc["user_data"])?;
    ensure!(
        !user_data.is_empty() && user_data.len() <= 1024,
        "identity binding required"
    );
    let mut pcrs = BTreeMap::new();
    let entries = doc["nitrotpm_pcrs"].as_map().context("PCR map missing")?;
    ensure!(
        !entries.is_empty() && entries.len() <= 32,
        "invalid PCR count"
    );
    for (index, value) in entries {
        let index: u8 = integer(index)?.try_into()?;
        let value = bytes(value)?;
        ensure!(
            index < 32 && value.len() == 48 && pcrs.insert(index, value.to_vec()).is_none(),
            "invalid or duplicate PCR"
        );
    }
    let bundle = doc["cabundle"]
        .as_array()
        .context("certificate bundle missing")?;
    ensure!(
        !bundle.is_empty() && bundle.len() <= 8,
        "invalid certificate bundle"
    );
    let cert_bytes = bytes(doc["certificate"])?;
    ensure!(
        cert_bytes.len() <= 1024,
        "invalid attestation certificate size"
    );
    let leaf = X509::from_der(cert_bytes)?;
    let mut certificates = Vec::new();
    for cert in bundle {
        let raw = bytes(cert)?;
        ensure!(
            !raw.is_empty() && raw.len() <= 1024,
            "invalid attestation certificate size"
        );
        certificates.push(X509::from_der(raw)?);
    }
    verify_chain(&leaf, &certificates, root, now)?;
    let key = leaf.public_key()?.ec_key()?;
    ensure!(
        key.group().curve_name() == Some(Nid::SECP384R1),
        "P384 attestation signer required"
    );
    let mut signed = Vec::new();
    ciborium::ser::into_writer(
        &Value::Array(vec![
            Value::Text("Signature1".into()),
            Value::Bytes(protected.to_vec()),
            Value::Bytes(vec![]),
            Value::Bytes(payload.to_vec()),
        ]),
        &mut signed,
    )?;
    let sig = EcdsaSig::from_private_components(
        BigNum::from_slice(&signature[..48])?,
        BigNum::from_slice(&signature[48..])?,
    )?;
    ensure!(
        sig.verify(&Sha384::digest(&signed), &key)?,
        "invalid NitroTPM signature"
    );
    Ok(NitroDocument {
        module: module.into(),
        pcrs,
        public_key: public.to_vec(),
        user_data: user_data.to_vec(),
    })
}
fn verify_chain(leaf: &X509, intermediates: &[X509], root: &X509, now: u64) -> Result<()> {
    let mut builder = X509StoreBuilder::new()?;
    builder.add_cert(root.clone())?;
    let mut parameters = X509VerifyParam::new()?;
    parameters.set_depth(8);
    parameters.set_time(now.try_into()?);
    builder.set_param(&parameters)?;
    let store = builder.build();
    let mut chain = Stack::new()?;
    for cert in intermediates {
        chain.push(cert.clone())?;
    }
    ensure!(
        X509StoreContext::new()?.init(&store, leaf, &chain, |context| context.verify_cert())?,
        "invalid attestation certificate chain"
    );
    Ok(())
}
