use super::*;
use openssl::{
    asn1::{Asn1Integer, Asn1Object, Asn1OctetString, Asn1Time},
    ec::{EcGroup, EcKey},
    hash::MessageDigest,
    pkey::Private,
    rsa::Rsa,
    x509::{
        X509Extension, X509NameBuilder,
        extension::{BasicConstraints, KeyUsage},
    },
};
use std::sync::atomic::{AtomicU32, Ordering};
const NOW: u64 = 1_780_000_000;
fn ec() -> PKey<Private> {
    PKey::from_ec_key(EcKey::generate(&EcGroup::from_curve_name(Nid::SECP384R1).unwrap()).unwrap())
        .unwrap()
}
fn certificate(
    key: &PKey<Private>,
    parent: Option<(&X509, &PKey<Private>)>,
    ca: bool,
    spl: bool,
) -> X509 {
    static SERIAL: AtomicU32 = AtomicU32::new(1);
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    let mut name = X509NameBuilder::new().unwrap();
    name.append_entry_by_text("CN", &format!("fixture-{serial}"))
        .unwrap();
    let name = name.build();
    let mut cert = X509::builder().unwrap();
    cert.set_version(2).unwrap();
    cert.set_serial_number(&Asn1Integer::from_bn(&BigNum::from_u32(serial).unwrap()).unwrap())
        .unwrap();
    cert.set_subject_name(&name).unwrap();
    cert.set_issuer_name(parent.map_or(&name, |(c, _)| c.subject_name()))
        .unwrap();
    cert.set_pubkey(key).unwrap();
    cert.set_not_before(&Asn1Time::from_unix((NOW - 600) as i64).unwrap())
        .unwrap();
    cert.set_not_after(&Asn1Time::from_unix((NOW + 600) as i64).unwrap())
        .unwrap();
    let mut constraints = BasicConstraints::new();
    constraints.critical();
    if ca {
        constraints.ca();
    }
    cert.append_extension(constraints.build().unwrap()).unwrap();
    let mut usage = KeyUsage::new();
    usage.digital_signature();
    if ca {
        usage.key_cert_sign().crl_sign();
    }
    cert.append_extension(usage.build().unwrap()).unwrap();
    if spl {
        for (field, value) in [(1, 10), (2, 0), (3, 24), (8, 160)] {
            let der = if value < 128 {
                vec![2, 1, value]
            } else {
                vec![2, 2, 0, value]
            };
            cert.append_extension(
                X509Extension::new_from_der(
                    &Asn1Object::from_str(&format!("1.3.6.1.4.1.3704.1.3.{field}")).unwrap(),
                    false,
                    &Asn1OctetString::new_from_bytes(&der).unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        }
    }
    cert.sign(parent.map_or(key, |(_, k)| k), MessageDigest::sha384())
        .unwrap();
    cert.build()
}
fn encode(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    ciborium::ser::into_writer(value, &mut out).unwrap();
    out
}
fn integer(value: u64) -> Value {
    Value::Integer(value.into())
}
fn bytes(value: impl AsRef<[u8]>) -> Value {
    Value::Bytes(value.as_ref().to_vec())
}

#[derive(Clone)]
struct Fixture {
    roots: Roots,
    nitro_key: PKey<Private>,
    nitro_cert: X509,
    vlek_key: PKey<Private>,
    vlek: X509,
    asvk: X509,
    tls: X509,
    claims: Claims,
    profile: ReleaseProfile,
    nonce: [u8; 32],
}
impl Fixture {
    fn new() -> Self {
        let nitro_root_key = ec();
        let nitro_root = certificate(&nitro_root_key, None, true, false);
        let nitro_key = ec();
        let nitro_cert = certificate(
            &nitro_key,
            Some((&nitro_root, &nitro_root_key)),
            false,
            false,
        );
        let amd_key = ec();
        let amd_root = certificate(&amd_key, None, true, false);
        let ask_key = ec();
        let asvk = certificate(&ask_key, Some((&amd_root, &amd_key)), true, false);
        let vlek_key = ec();
        let vlek = certificate(&vlek_key, Some((&asvk, &ask_key)), false, true);
        let tls_key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let tls = certificate(&tls_key, None, true, false);
        let mut profile = ReleaseProfile {
            release: "a".repeat(64),
            role: Role::Authority,
            pcr4: "04".repeat(48),
            pcr12: "12".repeat(48),
            minimum_tcb: Tcb {
                bootloader: 10,
                tee: 0,
                snp: 24,
                microcode: 160,
            },
        };
        profile.release = profile.commitment().unwrap();
        let public = ed25519_dalek::SigningKey::from_bytes(&[7; 32]).verifying_key();
        let claims = Claims {
            authority_identity: "c".repeat(64),
            deployment: "b".repeat(64),
            policy: String::new(),
            release: profile.release.clone(),
            replica_public_key: STANDARD.encode(public.to_bytes()),
            role: Role::Authority,
            tls_sha256: hex(Sha256::digest(tls.to_der().unwrap())),
            version: 1,
        };
        Self {
            roots: Roots {
                nitro: nitro_root,
                snp: amd_root,
            },
            nitro_key,
            nitro_cert,
            vlek_key,
            vlek,
            asvk,
            tls,
            claims,
            profile,
            nonce: [42; 32],
        }
    }
    fn report(&self, edit: impl FnOnce(&mut [u8])) -> Vec<u8> {
        let mut report = vec![0; 1184];
        report[..4].copy_from_slice(&2u32.to_le_bytes());
        report[8..16].copy_from_slice(&(1u64 << 17).to_le_bytes()); // ABI-required bit
        report[52..56].copy_from_slice(&1u32.to_le_bytes());
        report[72..76].copy_from_slice(&4u32.to_le_bytes()); // Signed with VLEK
        let data = report_data(
            &self.nonce,
            &self.claims,
            &self.tls.public_key().unwrap().public_key_to_der().unwrap(),
        )
        .unwrap();
        report[80..144].copy_from_slice(&data);
        report[144..192].fill(3);
        for offset in [56, 384, 480, 496] {
            report[offset..offset + 8].copy_from_slice(&[10, 0, 0, 0, 0, 0, 24, 160]);
        }
        edit(&mut report);
        let signature = EcdsaSig::sign(
            &Sha384::digest(&report[..672]),
            &self.vlek_key.ec_key().unwrap(),
        )
        .unwrap();
        for (offset, number) in [(672, signature.r()), (744, signature.s())] {
            let encoded = number.to_vec_padded(48).unwrap();
            let little: Vec<_> = encoded.into_iter().rev().collect();
            report[offset..offset + 48].copy_from_slice(&little);
        }
        report
    }
    fn document(&self, report: &[u8], edit: impl FnOnce(&mut Vec<(Value, Value)>)) -> Vec<u8> {
        let binding = Binding {
            claims: self.claims.clone(),
            snp_sha256: hex(Sha256::digest(report)),
        };
        let values = [
            ("module_id", Value::Text("fixture-module".into())),
            ("timestamp", integer(NOW * 1000)),
            ("digest", Value::Text("SHA384".into())),
            ("nonce", bytes(self.nonce)),
            (
                "public_key",
                bytes(self.tls.public_key().unwrap().public_key_to_der().unwrap()),
            ),
            ("user_data", bytes(serde_json::to_vec(&binding).unwrap())),
            (
                "nitrotpm_pcrs",
                Value::Map(vec![
                    (integer(4), bytes([4; 48])),
                    (integer(12), bytes([0x12; 48])),
                ]),
            ),
            ("certificate", bytes(self.nitro_cert.to_der().unwrap())),
            (
                "cabundle",
                Value::Array(vec![bytes(self.roots.nitro.to_der().unwrap())]),
            ),
        ];
        let mut entries: Vec<_> = values
            .into_iter()
            .map(|(k, v)| (Value::Text(k.into()), v))
            .collect();
        edit(&mut entries);
        let payload = encode(&Value::Map(entries));
        let protected = encode(&Value::Map(vec![(
            integer(1),
            Value::Integer((-35).into()),
        )]));
        let signed = encode(&Value::Array(vec![
            Value::Text("Signature1".into()),
            bytes(&protected),
            bytes([]),
            bytes(&payload),
        ]));
        let signature =
            EcdsaSig::sign(&Sha384::digest(&signed), &self.nitro_key.ec_key().unwrap()).unwrap();
        let mut raw = signature.r().to_vec_padded(48).unwrap();
        raw.extend(signature.s().to_vec_padded(48).unwrap());
        encode(&Value::Tag(
            18,
            Box::new(Value::Array(vec![
                bytes(protected),
                Value::Map(vec![]),
                bytes(payload),
                bytes(raw),
            ])),
        ))
    }
    fn evidence(&self) -> Evidence {
        self.with_report(self.report(|_| {}))
    }
    fn with_report(&self, report: Vec<u8>) -> Evidence {
        Evidence {
            nitro: STANDARD.encode(self.document(&report, |_| {})),
            snp: STANDARD.encode(report),
            vlek: STANDARD.encode(self.vlek.to_der().unwrap()),
            asvk: STANDARD.encode(self.asvk.to_der().unwrap()),
            tls_certificate: STANDARD.encode(self.tls.to_der().unwrap()),
        }
    }
    fn verify(&self, evidence: &Evidence) -> Result<AttestedIdentity> {
        verify_with_roots(
            evidence,
            &self.nonce,
            &self.profile,
            &self.claims.deployment,
            NOW,
            &self.roots,
        )
    }
}
#[test]
fn attests_the_channel_identity_and_rejects_fixture_roots_in_production() {
    let fixture = Fixture::new();
    let evidence = fixture.evidence();
    let identity = fixture.verify(&evidence).unwrap();
    assert_eq!(identity.claims(), &fixture.claims);
    assert_eq!(identity.certificate(), fixture.tls.to_der().unwrap());
    assert_eq!(identity.module_id(), "fixture-module");
    assert!(
        verify(
            &evidence,
            &fixture.nonce,
            &fixture.profile,
            &fixture.claims.deployment,
            NOW
        )
        .is_err()
    );
    assert_eq!(
        hex(X509::from_pem(AWS_ROOT)
            .unwrap()
            .digest(MessageDigest::sha256())
            .unwrap()),
        "641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b"
    );
}
#[test]
fn channel_and_snp_substitution_cannot_reuse_a_valid_nitro_quote() {
    let fixture = Fixture::new();
    let mut evidence = fixture.evidence();
    evidence.snp = STANDARD.encode(fixture.report(|r| r[144] ^= 1));
    assert!(fixture.verify(&evidence).is_err());
    let mut evidence = fixture.evidence();
    evidence.tls_certificate = STANDARD.encode(fixture.vlek.to_der().unwrap());
    assert!(fixture.verify(&evidence).is_err());
    let mut evidence = fixture.evidence();
    let mut raw = decode(&evidence.nitro, MAX_DOCUMENT).unwrap();
    *raw.last_mut().unwrap() ^= 1;
    evidence.nitro = STANDARD.encode(raw);
    assert!(fixture.verify(&evidence).is_err());
    assert!(
        verify_with_roots(
            &fixture.evidence(),
            &[43; 32],
            &fixture.profile,
            &fixture.claims.deployment,
            NOW,
            &fixture.roots
        )
        .is_err()
    );
    assert!(
        verify_with_roots(
            &fixture.evidence(),
            &fixture.nonce,
            &fixture.profile,
            &"e".repeat(64),
            NOW,
            &fixture.roots
        )
        .is_err()
    );
    let mut other = fixture.profile.clone();
    other.pcr12 = "01".repeat(48);
    assert!(
        verify_with_roots(
            &fixture.evidence(),
            &fixture.nonce,
            &other,
            &fixture.claims.deployment,
            NOW,
            &fixture.roots
        )
        .is_err()
    );
    other = fixture.profile.clone();
    other.role = Role::Runtime;
    assert!(
        verify_with_roots(
            &fixture.evidence(),
            &fixture.nonce,
            &other,
            &fixture.claims.deployment,
            NOW,
            &fixture.roots
        )
        .is_err()
    );
}
#[test]
fn genuine_signatures_cannot_excuse_unsafe_snp_state_or_firmware() {
    let fixture = Fixture::new();
    for (offset, value) in [
        (0, 4),
        (48, 1),
        (52, 0),
        (72, 0),
        (10, 8),
        (10, 4),
        (56, 9),
        (384, 9),
        (480, 9),
        (496, 9),
        (390, 25),
        (80, 1),
    ] {
        let report = fixture.report(|raw| raw[offset] = value);
        assert!(
            fixture.verify(&fixture.with_report(report)).is_err(),
            "accepted dangerous report field {offset}"
        );
    }
    let mut evidence = fixture.evidence();
    let mut report = decode(&evidence.snp, 1184).unwrap();
    report[674] ^= 1;
    evidence.nitro = STANDARD.encode(fixture.document(&report, |_| {}));
    evidence.snp = STANDARD.encode(report);
    assert!(fixture.verify(&evidence).is_err());
    let v3 = fixture.report(|raw| {
        raw[0] = 3;
        raw[392] = 0x19;
        raw[393] = 1;
    });
    fixture.verify(&fixture.with_report(v3)).unwrap();
    let wrong_processor = fixture.report(|raw| {
        raw[0] = 3;
        raw[392] = 0x1a;
    });
    assert!(
        fixture
            .verify(&fixture.with_report(wrong_processor))
            .is_err()
    );
}

#[test]
fn known_snp_versions_preserve_the_signed_report_layout() {
    let fixture = Fixture::new();
    for version in [2u32, 3, 5] {
        let report = fixture.report(|raw| {
            raw[..4].copy_from_slice(&version.to_le_bytes());
            if version != 2 {
                raw[392] = 0x19;
                raw[393] = 1;
                raw[394] = 2;
                raw[64] = 0x20; // Alias-check status added in v3.
            }
            if version == 5 {
                raw[11] |= 2; // PAGE_SWAP_DISABLE is defined in v5.
                raw[64] |= 0x80; // SEV-TIO status is defined in v5.
                raw[504..512].copy_from_slice(&1u64.to_le_bytes());
                raw[512..520].copy_from_slice(&3u64.to_le_bytes());
            }
        });
        fixture.verify(&fixture.with_report(report)).unwrap();
    }
}

#[test]
fn version_five_never_relaxes_identity_state_or_firmware_checks() {
    let fixture = Fixture::new();
    for (offset, value) in [
        (0, 0),
        (0, 4),
        (0, 6),
        (0, 255), // Unknown layouts remain unsupported.
        (48, 1),
        (52, 0),
        (72, 0),
        (72, 6),
        (73, 1),
        (10, 0),
        (10, 6),
        (10, 10),
        (11, 4), // Policy, including its required bit.
        (64, 0x40),
        (65, 1), // Reserved platform flags in the v5 layout.
        (76, 1),
        (392, 0x1a),
        (393, 0x10),
        (395, 1),
        (491, 1),
        (495, 1),
        (520, 1),
        (671, 1),
        (720, 1),
        (792, 1),
        (816, 1),
        (1183, 1),
        (56, 9),
        (384, 9),
        (480, 9),
        (496, 9),
        (62, 23),
        (63, 159),
        (390, 25),
        (80, 1),
    ] {
        let report = fixture.report(|raw| {
            raw[0] = 5;
            raw[392] = 0x19;
            raw[393] = 1;
            raw[offset] = value;
        });
        assert!(
            fixture.verify(&fixture.with_report(report)).is_err(),
            "accepted dangerous v5 field {offset} = {value}"
        );
    }
    for version in [2, 3] {
        let report = fixture.report(|raw| {
            raw[0] = version;
            if version == 3 {
                raw[392] = 0x19;
                raw[393] = 1;
            }
            raw[504] = 1; // V5 fields cannot be smuggled into an older layout.
        });
        assert!(fixture.verify(&fixture.with_report(report)).is_err());
    }
    let empty_measurement = fixture.report(|raw| {
        raw[0] = 5;
        raw[392] = 0x19;
        raw[393] = 1;
        raw[144..192].fill(0);
    });
    assert!(
        fixture
            .verify(&fixture.with_report(empty_measurement))
            .is_err()
    );
}
#[test]
fn ambiguous_cbor_and_stale_documents_do_not_enroll_peers() {
    let fixture = Fixture::new();
    let report = fixture.report(|_| {});
    type DocumentEdit = Box<dyn Fn(&mut Vec<(Value, Value)>)>;
    let edits: Vec<DocumentEdit> = vec![
        Box::new(|pairs| pairs.push(pairs[0].clone())),
        Box::new(|pairs| pairs.push((Value::Text("unexpected".into()), integer(1)))),
        Box::new(|pairs| pairs[1].1 = integer((NOW - 61) * 1000)),
        Box::new(|pairs| pairs[1].1 = integer((NOW + 6) * 1000)),
        Box::new(|pairs| {
            if let Value::Map(pcrs) = &mut pairs[6].1 {
                pcrs.push(pcrs[0].clone());
            }
        }),
        Box::new(|pairs| {
            if let Value::Map(pcrs) = &mut pairs[6].1 {
                pcrs[0].0 = Value::Bool(true);
            }
        }),
    ];
    for edit in edits {
        let mut evidence = fixture.evidence();
        evidence.nitro = STANDARD.encode(fixture.document(&report, edit));
        assert!(fixture.verify(&evidence).is_err());
    }
    let mut evidence = fixture.evidence();
    let mut doc = decode(&evidence.nitro, MAX_DOCUMENT).unwrap();
    doc.push(0);
    evidence.nitro = STANDARD.encode(doc);
    assert!(fixture.verify(&evidence).is_err());
    let mut evidence = fixture.evidence();
    evidence.snp = STANDARD.encode([0; 1185]);
    assert!(fixture.verify(&evidence).is_err());
    assert!(
        verify_with_roots(
            &fixture.evidence(),
            &fixture.nonce,
            &fixture.profile,
            &fixture.claims.deployment,
            NOW + 601,
            &fixture.roots
        )
        .is_err()
    );
}

// Only device collection and fixture roots are replaced. The production frame
// exchange, quote verification, TLS handshake and record transport run unchanged.
struct TestIdentity {
    fixture: Fixture,
    identity: ChannelIdentity,
    lie_about_key: bool,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publisher_attests_the_service_before_sending_and_rejects_a_substituted_tls_key() {
    let fixture = Fixture::new();
    for lie_about_key in [false, true] {
        let server = TestIdentity {
            fixture: fixture.clone(),
            identity: ChannelIdentity::generate().unwrap(),
            lie_about_key,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let serving = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            if let Ok(mut channel) = channel::accept_publisher_using(stream, &server).await {
                let publication: Vec<u8> = channel.receive().await.unwrap();
                assert_eq!(publication, b"synthetic owner key publication");
                channel.send(&"committed").await.unwrap();
                true
            } else {
                false
            }
        });
        let connected = channel::connect_publisher_using(
            address,
            &fixture.profile,
            &fixture.claims.deployment,
            |proof, nonce, profile, deployment| {
                verify_with_roots(proof, nonce, profile, deployment, NOW, &fixture.roots)
            },
        )
        .await;
        if lie_about_key {
            assert!(connected.is_err());
        } else {
            let (peer, mut channel) = connected.unwrap();
            assert_eq!(peer.claims().deployment, fixture.claims.deployment);
            channel
                .send(&b"synthetic owner key publication".to_vec())
                .await
                .unwrap();
            assert_eq!(channel.receive::<String>().await.unwrap(), "committed");
        }
        assert_eq!(serving.await.unwrap(), !lie_about_key);
    }
}
#[async_trait::async_trait]
impl channel::ProtocolIdentity for TestIdentity {
    fn identity(&self) -> &ChannelIdentity {
        &self.identity
    }
    async fn collect(&self, nonce: [u8; 32]) -> Result<Evidence> {
        let mut fixture = self.fixture.clone();
        fixture.nonce = nonce;
        if !self.lie_about_key {
            fixture.tls = X509::from_der(&self.identity.certificate)?;
            fixture.claims.tls_sha256 = hex(Sha256::digest(&self.identity.certificate));
        }
        Ok(fixture.evidence())
    }
    fn verify(
        &self,
        proof: &Evidence,
        nonce: &[u8; 32],
        profile: &ReleaseProfile,
        deployment: &str,
    ) -> Result<AttestedIdentity> {
        verify_with_roots(proof, nonce, profile, deployment, NOW, &self.fixture.roots)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutually_attested_tls_carries_records_and_rejects_a_different_channel_key() {
    use std::sync::Arc;
    let fixture = Fixture::new();
    let client = TestIdentity {
        fixture: fixture.clone(),
        identity: ChannelIdentity::generate().unwrap(),
        lie_about_key: false,
    };
    for lie_about_key in [false, true] {
        let server = Arc::new(TestIdentity {
            fixture: fixture.clone(),
            identity: ChannelIdentity::generate().unwrap(),
            lie_about_key,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let serving = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let result = channel::accept_using(
                stream,
                server.as_ref(),
                std::slice::from_ref(&server.fixture.profile),
                &server.fixture.claims.deployment,
            )
            .await;
            if let Ok(mut channel) = result {
                let input: Vec<u8> = channel.receive().await.unwrap();
                assert_eq!(input, b"confidential replica snapshot");
                channel.send(&"acknowledged").await.unwrap();
                true
            } else {
                false
            }
        });
        let result = channel::connect_using(
            address,
            &client,
            std::slice::from_ref(&fixture.profile),
            &fixture.claims.deployment,
        )
        .await;
        if lie_about_key {
            assert!(
                result.is_err(),
                "an attested key must be the actual TLS channel key"
            );
        } else {
            let mut channel = result.unwrap();
            channel
                .send(&b"confidential replica snapshot".to_vec())
                .await
                .unwrap();
            assert_eq!(channel.receive::<String>().await.unwrap(), "acknowledged");
        }
        assert_eq!(serving.await.unwrap(), !lie_about_key);
    }
}
