//! Stdio adapter for Nebula's trusted owner-side publisher. Only public status
//! is printed; private image keys arrive after the SDK verifies this handshake.
use crate::{
    authority::{OwnerRequest, OwnerResponse},
    evidence::{self, ReleaseProfile, Role},
};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::{
    io::{BufRead, Read, Write},
    net::SocketAddr,
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Connect {
    address: SocketAddr,
    profile: ReleaseProfile,
    deployment: String,
    expected_identity: Option<String>,
}
fn read_line(reader: &mut impl BufRead, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
    let mut bytes = Zeroizing::new(Vec::new());
    reader
        .take((limit + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= limit && bytes.last() == Some(&b'\n'),
        "invalid owner message"
    );
    Ok(bytes)
}
fn print(value: &OwnerResponse) -> Result<()> {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
pub async fn run(mode: &str) -> Result<()> {
    let input = std::io::stdin();
    let mut input = input.lock();
    let config: Connect = serde_json::from_slice(&read_line(&mut input, 16384)?)?;
    config.profile.validate()?;
    ensure!(
        config.profile.role == Role::Authority,
        "authority release required"
    );
    let (peer, mut channel) =
        evidence::connect_publisher(config.address, &config.profile, &config.deployment).await?;
    let request = match mode {
        "--inspect-authority" => OwnerRequest::Health,
        "--canary-intent" => OwnerRequest::Canary,
        "--owner-channel" => OwnerRequest::Status,
        _ => anyhow::bail!("unknown owner client mode"),
    };
    channel.send(&request).await?;
    let status: OwnerResponse =
        tokio::time::timeout(Duration::from_secs(30), channel.receive()).await??;
    let public = match &status {
        OwnerResponse::Status(public)
        | OwnerResponse::Health { status: public, .. }
        | OwnerResponse::Canary { status: public, .. } => public,
        _ => anyhow::bail!("invalid service response"),
    };
    ensure!(
        public.authority_identity == peer.claims().authority_identity
            && public.deployment == config.deployment
            && config
                .expected_identity
                .as_ref()
                .is_none_or(|id| *id == public.authority_identity),
        "authority identity changed"
    );
    let identity = public.authority_identity.clone();
    print(&status)?;
    if mode != "--owner-channel" {
        return Ok(());
    }
    // The status connection served one request. Re-attest the same lineage
    // before consuming a publication; the owner signs only the verified pin.
    let (peer, mut channel) =
        evidence::connect_publisher(config.address, &config.profile, &config.deployment).await?;
    ensure!(
        peer.claims().authority_identity == identity,
        "authority changed before publication"
    );
    let request: OwnerRequest = serde_json::from_slice(&read_line(&mut input, 1024 * 1024)?)?;
    ensure!(
        matches!(request, OwnerRequest::Publish(_) | OwnerRequest::Rotate(_)),
        "signed publication required"
    );
    channel.send(&request).await?;
    let response: OwnerResponse =
        tokio::time::timeout(Duration::from_secs(30), channel.receive()).await??;
    let OwnerResponse::Status(ref status) = response else {
        anyhow::bail!("invalid publication response");
    };
    ensure!(
        status.authority_identity == identity,
        "publication lineage changed"
    );
    print(&response).context("cannot acknowledge public publication status")
}
