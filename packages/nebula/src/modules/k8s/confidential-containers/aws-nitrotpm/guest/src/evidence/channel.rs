//! Fresh mutual evidence exchange followed by TLS 1.3 on the same connection.
//! The unencrypted prefix contains only challenges and public evidence. Nothing
//! confidential is serialized until both measured channel keys are verified.
use super::*;
use openssl::{
    asn1::{Asn1Integer, Asn1Time},
    hash::MessageDigest,
    pkey::Private,
    rsa::Rsa,
    ssl::{
        Ssl, SslAcceptor, SslConnector, SslMethod, SslOptions, SslSessionCacheMode, SslVerifyMode,
        SslVersion,
    },
    x509::{
        X509NameBuilder,
        extension::{BasicConstraints, ExtendedKeyUsage, KeyUsage, SubjectAlternativeName},
    },
};
use rsa::rand_core::{OsRng, RngCore};
use std::{
    net::SocketAddr,
    pin::Pin,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};
use tokio_openssl::SslStream;
use zeroize::Zeroizing;

const MAX_PROOF: usize = 64 * 1024;
const MAX_MESSAGE: usize = 2 * 1024 * 1024;
const NAME: &str = "nebula-coco.invalid";
const PREFIX: &[u8; 17] = b"NEBULA-COCO-TLS1\0";
const PUBLISHER_PREFIX: &[u8; 17] = b"NEBULA-COCO-PUB1\0";

pub struct ChannelIdentity {
    pub(super) key: PKey<Private>,
    pub(super) certificate: Vec<u8>,
}
impl ChannelIdentity {
    pub fn generate() -> Result<Self> {
        let key = PKey::from_rsa(Rsa::generate(3072)?)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let mut name = X509NameBuilder::new()?;
        name.append_entry_by_text("CN", NAME)?;
        let name = name.build();
        let mut builder = X509::builder()?;
        builder.set_version(2)?;
        let mut serial = [0; 16];
        OsRng.try_fill_bytes(&mut serial)?;
        serial[0] &= 0x7f;
        let serial = BigNum::from_slice(&serial)?;
        let serial = Asn1Integer::from_bn(&serial)?;
        builder.set_serial_number(&serial)?;
        builder.set_subject_name(&name)?;
        builder.set_issuer_name(&name)?;
        builder.set_pubkey(&key)?;
        let before = Asn1Time::from_unix(now.saturating_sub(60).try_into()?)?;
        builder.set_not_before(&before)?;
        let after = Asn1Time::from_unix(
            now.checked_add(365 * 86400)
                .context("clock overflow")?
                .try_into()?,
        )?;
        builder.set_not_after(&after)?;
        builder.append_extension(BasicConstraints::new().critical().ca().build()?)?;
        builder.append_extension(
            KeyUsage::new()
                .critical()
                .digital_signature()
                .key_cert_sign()
                .build()?,
        )?;
        builder.append_extension(
            ExtendedKeyUsage::new()
                .server_auth()
                .client_auth()
                .build()?,
        )?;
        builder.append_extension(
            SubjectAlternativeName::new()
                .dns(NAME)
                .build(&builder.x509v3_context(None, None))?,
        )?;
        builder.sign(&key, MessageDigest::sha256())?;
        Ok(Self {
            key,
            certificate: builder.build().to_der()?,
        })
    }
}

pub struct SecureChannel {
    stream: SslStream<TcpStream>,
    peer: AttestedIdentity,
}
impl SecureChannel {
    pub fn peer(&self) -> &AttestedIdentity {
        &self.peer
    }
    pub async fn send<T: Serialize>(&mut self, value: &T) -> Result<()> {
        let bytes = Zeroizing::new(serde_json::to_vec(value)?);
        frame_write(&mut self.stream, &bytes, MAX_MESSAGE).await
    }
    pub async fn receive<T: for<'de> Deserialize<'de>>(&mut self) -> Result<T> {
        let bytes = frame_read(&mut self.stream, MAX_MESSAGE).await?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}

/// The server proves its measured channel key; the client is deliberately not
/// a trusted replica. The application accepts only owner-signed publications
/// and public queries on this channel, never key reads or consensus messages.
pub struct PublisherChannel {
    stream: SslStream<TcpStream>,
}
impl PublisherChannel {
    pub async fn send<T: Serialize>(&mut self, value: &T) -> Result<()> {
        let bytes = Zeroizing::new(serde_json::to_vec(value)?);
        frame_write(&mut self.stream, &bytes, MAX_MESSAGE).await
    }
    pub async fn receive<T: for<'de> Deserialize<'de>>(&mut self) -> Result<T> {
        let bytes = frame_read(&mut self.stream, MAX_MESSAGE).await?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}

pub async fn connect_publisher(
    address: SocketAddr,
    profile: &ReleaseProfile,
    deployment: &str,
) -> Result<(AttestedIdentity, PublisherChannel)> {
    connect_publisher_using(
        address,
        profile,
        deployment,
        |proof, challenge, profile, deployment| {
            verify(proof, challenge, profile, deployment, now()?)
        },
    )
    .await
}
pub(super) async fn connect_publisher_using(
    address: SocketAddr,
    profile: &ReleaseProfile,
    deployment: &str,
    verify_peer: impl Fn(&Evidence, &[u8; 32], &ReleaseProfile, &str) -> Result<AttestedIdentity>,
) -> Result<(AttestedIdentity, PublisherChannel)> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut stream = TcpStream::connect(address).await?;
        stream.set_nodelay(true)?;
        let challenge = nonce()?;
        stream.write_all(PUBLISHER_PREFIX).await?;
        stream.write_all(&challenge).await?;
        let proof: Evidence = serde_json::from_slice(&frame_read(&mut stream, MAX_PROOF).await?)?;
        let peer = verify_peer(&proof, &challenge, profile, deployment)?;
        let mut context = SslConnector::builder(SslMethod::tls_client())?;
        context.set_min_proto_version(Some(SslVersion::TLS1_3))?;
        context.set_max_proto_version(Some(SslVersion::TLS1_3))?;
        context.set_options(SslOptions::NO_TICKET | SslOptions::NO_COMPRESSION);
        context.set_session_cache_mode(SslSessionCacheMode::OFF);
        context.set_verify(SslVerifyMode::PEER);
        context
            .cert_store_mut()
            .add_cert(X509::from_der(peer.certificate())?)?;
        let ssl = context.build().configure()?.into_ssl(NAME)?;
        let mut stream = SslStream::new(ssl, stream)?;
        Pin::new(&mut stream).connect().await?;
        ensure!(
            stream
                .ssl()
                .peer_certificate()
                .context("missing service certificate")?
                .to_der()?
                == peer.certificate(),
            "service changed its attested key"
        );
        Ok((peer, PublisherChannel { stream }))
    })
    .await?
}

pub async fn accept_publisher(stream: TcpStream, local: &Collector) -> Result<PublisherChannel> {
    accept_publisher_using(stream, local).await
}
pub(super) async fn accept_publisher_using(
    mut stream: TcpStream,
    local: &impl ProtocolIdentity,
) -> Result<PublisherChannel> {
    tokio::time::timeout(Duration::from_secs(30), async {
        stream.set_nodelay(true)?;
        let mut prefix = [0; 17];
        stream.read_exact(&mut prefix).await?;
        ensure!(&prefix == PUBLISHER_PREFIX, "invalid publisher protocol");
        let mut challenge = [0; 32];
        stream.read_exact(&mut challenge).await?;
        let evidence = local.collect(challenge).await?;
        frame_write(&mut stream, &serde_json::to_vec(&evidence)?, MAX_PROOF).await?;
        let mut context = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls_server())?;
        context.set_min_proto_version(Some(SslVersion::TLS1_3))?;
        context.set_max_proto_version(Some(SslVersion::TLS1_3))?;
        context.set_options(SslOptions::NO_TICKET | SslOptions::NO_COMPRESSION);
        context.set_session_cache_mode(SslSessionCacheMode::OFF);
        // No client identity is inferred here. Signed application messages are
        // the only authorization; this listener has no resource-read variant.
        context.set_verify(SslVerifyMode::NONE);
        let certificate = X509::from_der(&local.identity().certificate)?;
        context.set_certificate(&certificate)?;
        context.set_private_key(&local.identity().key)?;
        context.check_private_key()?;
        let ssl = Ssl::new(context.build().context())?;
        let mut stream = SslStream::new(ssl, stream)?;
        Pin::new(&mut stream).accept().await?;
        Ok(PublisherChannel { stream })
    })
    .await?
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    nonce: [u8; 32],
    evidence: Evidence,
}
fn nonce() -> Result<[u8; 32]> {
    let mut nonce = [0; 32];
    OsRng.try_fill_bytes(&mut nonce)?;
    Ok(nonce)
}
fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
#[async_trait::async_trait]
pub(super) trait ProtocolIdentity: Send + Sync {
    fn identity(&self) -> &ChannelIdentity;
    async fn collect(&self, nonce: [u8; 32]) -> Result<Evidence>;
    fn verify(
        &self,
        proof: &Evidence,
        nonce: &[u8; 32],
        profile: &ReleaseProfile,
        deployment: &str,
    ) -> Result<AttestedIdentity>;
}
#[async_trait::async_trait]
impl ProtocolIdentity for Collector {
    fn identity(&self) -> &ChannelIdentity {
        &self.identity
    }
    async fn collect(&self, nonce: [u8; 32]) -> Result<Evidence> {
        Collector::collect(self, nonce).await
    }
    fn verify(
        &self,
        proof: &Evidence,
        nonce: &[u8; 32],
        profile: &ReleaseProfile,
        deployment: &str,
    ) -> Result<AttestedIdentity> {
        verify(proof, nonce, profile, deployment, now()?)
    }
}
fn authenticate(
    local: &impl ProtocolIdentity,
    evidence: &Evidence,
    challenge: &[u8; 32],
    profiles: &[ReleaseProfile],
    deployment: &str,
) -> Result<AttestedIdentity> {
    ensure!(
        !profiles.is_empty() && profiles.len() <= 16,
        "bounded release set required"
    );
    for profile in profiles {
        if let Ok(peer) = local.verify(evidence, challenge, profile, deployment) {
            return Ok(peer);
        }
    }
    anyhow::bail!("peer attestation rejected")
}

/// A caller must match the returned precise replica key to committed membership
/// before permitting Raft RPCs or snapshot transfers. Attestation alone proves
/// eligible code, not permission to join an existing authority lineage.
pub async fn connect(
    address: SocketAddr,
    local: &Collector,
    profiles: &[ReleaseProfile],
    deployment: &str,
) -> Result<SecureChannel> {
    connect_using(address, local, profiles, deployment).await
}
pub(super) async fn connect_using(
    address: SocketAddr,
    local: &impl ProtocolIdentity,
    profiles: &[ReleaseProfile],
    deployment: &str,
) -> Result<SecureChannel> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut stream = TcpStream::connect(address).await?;
        stream.set_nodelay(true)?;
        let challenge = nonce()?;
        stream.write_all(PREFIX).await?;
        stream.write_all(&challenge).await?;
        let hello: Hello = serde_json::from_slice(&frame_read(&mut stream, MAX_PROOF).await?)?;
        let peer = authenticate(local, &hello.evidence, &challenge, profiles, deployment)?;
        let proof = local.collect(hello.nonce).await?;
        frame_write(&mut stream, &serde_json::to_vec(&proof)?, MAX_PROOF).await?;
        let mut context = SslConnector::builder(SslMethod::tls_client())?;
        context.set_min_proto_version(Some(SslVersion::TLS1_3))?;
        context.set_max_proto_version(Some(SslVersion::TLS1_3))?;
        context.set_options(SslOptions::NO_TICKET | SslOptions::NO_COMPRESSION);
        context.set_session_cache_mode(SslSessionCacheMode::OFF);
        context.set_verify(SslVerifyMode::PEER);
        context
            .cert_store_mut()
            .add_cert(X509::from_der(peer.certificate())?)?;
        let certificate = X509::from_der(&local.identity().certificate)?;
        context.set_certificate(&certificate)?;
        context.set_private_key(&local.identity().key)?;
        context.check_private_key()?;
        let ssl = context.build().configure()?.into_ssl(NAME)?;
        let mut stream = SslStream::new(ssl, stream)?;
        Pin::new(&mut stream).connect().await?;
        ensure!(
            stream
                .ssl()
                .peer_certificate()
                .context("peer certificate missing")?
                .to_der()?
                == peer.certificate(),
            "TLS peer key changed"
        );
        Ok(SecureChannel { stream, peer })
    })
    .await?
}

pub async fn accept(
    stream: TcpStream,
    local: &Collector,
    profiles: &[ReleaseProfile],
    deployment: &str,
) -> Result<SecureChannel> {
    accept_using(stream, local, profiles, deployment).await
}
pub(super) async fn accept_using(
    mut stream: TcpStream,
    local: &impl ProtocolIdentity,
    profiles: &[ReleaseProfile],
    deployment: &str,
) -> Result<SecureChannel> {
    tokio::time::timeout(Duration::from_secs(30), async {
        stream.set_nodelay(true)?;
        let mut prefix = [0; 17];
        stream.read_exact(&mut prefix).await?;
        ensure!(&prefix == PREFIX, "invalid channel protocol");
        let mut challenge = [0; 32];
        stream.read_exact(&mut challenge).await?;
        let our_nonce = nonce()?;
        let hello = Hello {
            nonce: our_nonce,
            evidence: local.collect(challenge).await?,
        };
        frame_write(&mut stream, &serde_json::to_vec(&hello)?, MAX_PROOF).await?;
        let proof: Evidence = serde_json::from_slice(&frame_read(&mut stream, MAX_PROOF).await?)?;
        let peer = authenticate(local, &proof, &our_nonce, profiles, deployment)?;
        let mut context = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls_server())?;
        context.set_min_proto_version(Some(SslVersion::TLS1_3))?;
        context.set_max_proto_version(Some(SslVersion::TLS1_3))?;
        context.set_options(SslOptions::NO_TICKET | SslOptions::NO_COMPRESSION);
        context.set_session_cache_mode(SslSessionCacheMode::OFF);
        context.set_verify(SslVerifyMode::PEER | SslVerifyMode::FAIL_IF_NO_PEER_CERT);
        context
            .cert_store_mut()
            .add_cert(X509::from_der(peer.certificate())?)?;
        let certificate = X509::from_der(&local.identity().certificate)?;
        context.set_certificate(&certificate)?;
        context.set_private_key(&local.identity().key)?;
        context.check_private_key()?;
        let ssl = Ssl::new(context.build().context())?;
        let mut stream = SslStream::new(ssl, stream)?;
        Pin::new(&mut stream).accept().await?;
        ensure!(
            stream
                .ssl()
                .peer_certificate()
                .context("peer certificate missing")?
                .to_der()?
                == peer.certificate(),
            "TLS peer key changed"
        );
        Ok(SecureChannel { stream, peer })
    })
    .await?
}

async fn frame_read(
    stream: &mut (impl AsyncRead + Unpin),
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    let length = stream.read_u32().await? as usize;
    ensure!(
        length > 0 && length <= limit,
        "channel message size invalid"
    );
    let mut bytes = Zeroizing::new(vec![0; length]);
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}
async fn frame_write(
    stream: &mut (impl AsyncWrite + Unpin),
    bytes: &[u8],
    limit: usize,
) -> Result<()> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= limit,
        "channel message size invalid"
    );
    stream.write_u32(bytes.len().try_into()?).await?;
    stream.write_all(bytes).await?;
    stream.flush().await?;
    Ok(())
}
