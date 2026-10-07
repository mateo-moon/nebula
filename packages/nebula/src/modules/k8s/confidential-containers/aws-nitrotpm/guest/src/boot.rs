//! Automatic immutable-appliance entry points. Cloud metadata and S3 contain
//! public intent only. Authorization is repeated inside the attested service.
use crate::{
    activation,
    authority::{self, OwnerRequest, OwnerResponse},
    evidence::{self, Claims, ReleaseProfile, Role},
    transport,
    workload::{self, Envelope, Expectation},
};
use anyhow::{Context, Result, ensure};
use openssl::x509::X509;
use serde::{Deserialize, Serialize};
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    process::Stdio,
    sync::Arc,
    time::Duration,
};
mod s3;

pub const REPLICA_PORT: u16 = 9443;
pub const OWNER_PORT: u16 = 9444;
const ASVK: &str = "/usr/share/nebula/amd-milan-asvk.pem";
const STATE: &str = "/var/lib/nebula";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Common {
    pub version: u8,
    pub deployment: String,
    pub genesis: Envelope,
    pub authority_profile: ReleaseProfile,
    pub runtime_profiles: Vec<ReleaseProfile>,
    pub peers: Vec<Ipv4Addr>,
}
impl Common {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && self.authority_profile.role == Role::Authority
                && self.peers.len() == 3
                && self
                    .peers
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == 3
                && self.peers.iter().all(|p| p.is_private())
                && !self.runtime_profiles.is_empty()
                && self.runtime_profiles.len() <= 16,
            "invalid managed deployment"
        );
        self.authority_profile.validate()?;
        let genesis = authority::verify_genesis(
            &self.genesis,
            &self.deployment,
            &self.authority_profile.release,
        )?;
        for profile in &self.runtime_profiles {
            profile.validate()?;
            ensure!(
                profile.role == Role::Runtime
                    && genesis.runtime_releases.contains(&profile.release),
                "unapproved runtime release"
            );
        }
        Ok(())
    }
    fn replicas(&self) -> Vec<SocketAddr> {
        self.peers
            .iter()
            .map(|ip| (*ip, REPLICA_PORT).into())
            .collect()
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuthorityIntent {
    deployment: String,
    state_volume: String,
    version: u8,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeIntent {
    pub common: Common,
    pub descriptor: Envelope,
    pub grant: Envelope,
}
fn asvk() -> Result<Vec<u8>> {
    crate::require_readonly_file(Path::new(ASVK))?;
    let bytes = std::fs::read(ASVK)?;
    ensure!(bytes.len() <= 4096, "ASVK too large");
    Ok(X509::from_pem(&bytes)?.to_der()?)
}
async fn command(tool: &str, args: &[&str]) -> Result<std::process::Output> {
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new(tool)
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    ensure!(result.stdout.len() <= 4096, "unexpected storage response");
    Ok(result)
}

fn state_mount_ready(output: &[u8], device: &Path, directory: &Path) -> Result<bool> {
    let output = std::str::from_utf8(output)?;
    let fields: Vec<_> = output.split_whitespace().collect();
    ensure!(fields.len() == 2, "unexpected state mount response");
    if fields[0] == "ext4" {
        ensure!(
            std::fs::canonicalize(fields[1])? == std::fs::canonicalize(device)?,
            "unexpected mounted state disk"
        );
        return Ok(true);
    }
    // ProtectSystem/StateDirectory bind-mount the empty directory from /var's
    // tmpfs into this service's namespace. It is a mount point already, but is
    // not the attached state volume. Mount over only that empty volatile
    // placeholder; never accept another disk or hide existing journal files.
    ensure!(fields[0] == "tmpfs", "unexpected state filesystem");
    ensure!(
        std::fs::read_dir(directory)?.next().is_none(),
        "state placeholder is not empty"
    );
    Ok(false)
}

async fn mount_state(volume: &str) -> Result<()> {
    ensure!(
        volume.strip_prefix("vol-").is_some_and(|id| id.len() == 17
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
        "invalid module state volume"
    );
    let device = format!(
        "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_{}",
        volume.replace('-', "")
    );
    use std::os::unix::fs::FileTypeExt;
    ensure!(
        std::fs::metadata(&device)?.file_type().is_block_device(),
        "state disk unavailable"
    );
    let mounted = command(
        "/usr/bin/findmnt",
        &["-n", "-o", "FSTYPE,SOURCE", "--mountpoint", STATE],
    )
    .await?;
    if mounted.status.success() {
        if state_mount_ready(&mounted.stdout, Path::new(&device), Path::new(STATE))? {
            return Ok(());
        }
    } else {
        ensure!(
            mounted.status.code() == Some(1) && std::fs::read_dir(STATE)?.next().is_none(),
            "state mount inspection failed"
        );
    }
    let result = command(
        "/usr/sbin/blkid",
        &["-p", "-o", "value", "-s", "TYPE", &device],
    )
    .await?;
    if result.status.code() == Some(2) {
        // Only an unformatted attached data volume is initialized. A readable
        // foreign filesystem is never reformatted as a recovery shortcut.
        ensure!(
            command("/usr/sbin/mkfs.ext4", &["-q", "-m", "0", &device])
                .await?
                .status
                .success(),
            "state format failed"
        );
    } else {
        ensure!(
            result.status.success() && result.stdout == b"ext4\n",
            "unexpected state filesystem"
        );
    }
    ensure!(
        command(
            "/usr/bin/mount",
            &["-t", "ext4", "-o", "rw,nosuid,nodev,noexec", &device, STATE]
        )
        .await?
        .status
        .success(),
        "state mount failed"
    );
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(STATE, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub async fn run_authority() -> Result<()> {
    let intent: AuthorityIntent =
        serde_json::from_slice(&transport::metadata("user-data", 16384).await?)?;
    ensure!(
        intent.version == 1 && workload::digest(&intent.deployment),
        "invalid authority boot intent"
    );
    let bytes = s3::configuration(&format!("boot/{}/authority.json", intent.deployment)).await?;
    let common: Common = serde_json::from_slice(&bytes)?;
    common.validate()?;
    ensure!(
        common.deployment == intent.deployment,
        "deployment mismatch"
    );
    let local = transport::metadata("meta-data/local-ipv4", 32).await?;
    let local: Ipv4Addr = std::str::from_utf8(&local)?.parse()?;
    ensure!(
        common.peers.contains(&local),
        "authority is outside the discovery cohort"
    );
    mount_state(&intent.state_volume).await?;
    use std::os::unix::fs::DirBuilderExt;
    let directory = Path::new(STATE).join("authority");
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => std::fs::File::open(STATE)?.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.into()),
    }
    let replicas = authority::ProtectedReplicas::open(authority::ReplicaConfig {
        directory,
        genesis: common.genesis,
        deployment: common.deployment,
        profile: common.authority_profile,
        runtime_profiles: common.runtime_profiles,
        address: (local, REPLICA_PORT).into(),
        publisher_address: (local, OWNER_PORT).into(),
        asvk: asvk()?,
    })
    .await?;
    let peers: Vec<_> = common
        .peers
        .iter()
        .map(|ip| (*ip, REPLICA_PORT).into())
        .collect();
    let maintenance = async {
        loop {
            // A different peer may be leader after an election. Rotate discovery
            // order on every attempt so a live follower cannot starve enrollment.
            for offset in 0..3 {
                let mut ordered = peers.clone();
                ordered.rotate_left(offset);
                let _ =
                    tokio::time::timeout(Duration::from_secs(90), replicas.enroll(&ordered)).await;
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    tokio::select! { result = replicas.serve() => result, result = maintenance => result }
}

/// Before activation this connection returns public approval only. After one
/// confirmed PCR extension, a new mutual-evidence channel may request keys.
pub async fn run_runtime() -> Result<()> {
    crate::require_memory_directory(Path::new(crate::SECRETS))?;
    let (namespace, pod) = transport::pod_identity()?;
    let deployment =
        transport::metadata("meta-data/tags/instance/nebula-coco-deployment", 64).await?;
    let deployment = std::str::from_utf8(&deployment)?;
    ensure!(workload::digest(deployment), "invalid runtime deployment");
    // The controller and peer-pod creation reconcile independently. Wait for
    // public intent before extending PCR 15; a retry after activation must never
    // reset or replace the already measured workload policy.
    let key = format!("boot/{deployment}/pods/{namespace}/{pod}.json");
    let mut configuration = None;
    for _ in 0..60 {
        if let Ok(bytes) = s3::configuration(&key).await {
            configuration = Some(bytes);
            break;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    let intent: RuntimeIntent =
        serde_json::from_slice(&configuration.context("public runtime intent unavailable")?)?;
    intent.common.validate()?;
    ensure!(
        intent.common.deployment == deployment,
        "runtime deployment mismatch"
    );
    // Decode only to select a pin. Its canonical bytes/signatures are checked
    // against the live, attested approval below, before policy installation.
    let grant: authority::Grant = serde_json::from_slice(&workload::decode(
        &intent.grant.payload,
        authority::MAX_GRANT_BYTES,
    )?)?;
    grant.encode()?;
    ensure!(
        grant.enabled && grant.deployment == deployment,
        "invalid runtime grant"
    );
    let profile = intent
        .common
        .runtime_profiles
        .iter()
        .find(|p| p.release == grant.runtime_release)
        .context("runtime profile unavailable")?;
    let mut approved = None;
    for _ in 0..30 {
        for peer in &intent.common.peers {
            if let Ok(approval) = fetch_approval((*peer, OWNER_PORT).into(), &intent, &grant).await
            {
                approved = Some(approval);
                break;
            }
        }
        if approved.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    let approval = approved.context("authority approval unavailable")?;
    let expected = Expectation {
        deployment: deployment.into(),
        workload: grant.workload.clone(),
        generation: grant.generation,
        runtime_release: grant.runtime_release.clone(),
        authority_release: intent.common.authority_profile.release.clone(),
    };
    let active = activation::activate(&intent.descriptor, &approval.owners, &expected).await?;
    let channel =
        Arc::new(tokio::task::spawn_blocking(evidence::ChannelIdentity::generate).await??);
    let collector = evidence::Collector::new(
        channel,
        Claims {
            authority_identity: grant.authority_identity.clone(),
            deployment: deployment.into(),
            policy: active.verified().descriptor_sha384.clone(),
            release: profile.release.clone(),
            replica_public_key: String::new(),
            role: Role::Runtime,
            tls_sha256: String::new(),
            version: 1,
        },
        asvk()?,
    )?;
    for _ in 0..30 {
        for address in intent.common.replicas() {
            if let Ok(keys) = authority::fetch_runtime_keys(
                address,
                &collector,
                &intent.common.authority_profile,
                deployment,
                &grant.authority_identity,
                grant.workload.clone(),
                grant.generation,
            )
            .await
            {
                ensure!(keys.len() == grant.resources.len() && keys.iter().all(|(path, key)| grant.resources.get(path) == Some(&key.commitment())),
                    "resource commitment mismatch");
                let resources = crate::SecretResources(
                    keys.iter()
                        .map(|(path, key)| (path.clone(), key.encoded()))
                        .collect(),
                );
                crate::write_resources(Path::new(crate::RESOURCE_FILE), &resources.0)?;
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    anyhow::bail!("current authority quorum did not release workload keys")
}
async fn fetch_approval(
    address: SocketAddr,
    intent: &RuntimeIntent,
    grant: &authority::Grant,
) -> Result<authority::Approval> {
    let (peer, mut channel) = evidence::connect_publisher(
        address,
        &intent.common.authority_profile,
        &intent.common.deployment,
    )
    .await?;
    ensure!(
        peer.claims().authority_identity == grant.authority_identity,
        "authority lineage mismatch"
    );
    channel
        .send(&OwnerRequest::Approval {
            workload: grant.workload.clone(),
        })
        .await?;
    let OwnerResponse::Approval { status, approval } =
        tokio::time::timeout(Duration::from_secs(15), channel.receive()).await??
    else {
        anyhow::bail!("invalid authority approval");
    };
    ensure!(
        status.authority_identity == grant.authority_identity
            && status.deployment == grant.deployment
            && approval.grant == *grant,
        "stale or substituted workload grant"
    );
    let (payload, _) = workload::verify_envelope(
        &intent.grant,
        &approval.owners,
        authority::GRANT_TYPE,
        authority::MAX_GRANT_BYTES,
        16,
    )?;
    ensure!(payload == grant.encode()?, "noncanonical grant");
    approval.verify_descriptor(&intent.descriptor, &intent.common.authority_profile.release)?;
    Ok(approval)
}

#[cfg(test)]
mod tests {
    use super::state_mount_ready;

    #[test]
    fn empty_systemd_tmpfs_binding_is_a_placeholder_not_the_state_disk() {
        let directory = tempfile::tempdir().unwrap();
        let disk = directory.path().join("device");
        let state = directory.path().join("state");
        std::fs::write(&disk, []).unwrap();
        std::fs::create_dir(&state).unwrap();
        assert!(!state_mount_ready(b"tmpfs tmpfs[/lib/nebula]\n", &disk, &state).unwrap());
        let mounted = format!("ext4 {}\n", disk.display());
        assert!(state_mount_ready(mounted.as_bytes(), &disk, &state).unwrap());
        std::fs::write(state.join("unexpected-journal"), b"must not be hidden").unwrap();
        assert!(state_mount_ready(b"tmpfs tmpfs[/lib/nebula]\n", &disk, &state).is_err());
    }

    #[test]
    fn foreign_disk_or_bind_mount_is_not_a_recovery_shortcut() {
        let directory = tempfile::tempdir().unwrap();
        let disk = directory.path().join("device");
        let foreign = directory.path().join("other-device");
        std::fs::write(&disk, []).unwrap();
        std::fs::write(&foreign, []).unwrap();
        for source in [
            format!("ext4 {}", foreign.display()),
            format!("ext4 {}[/subdir]", disk.display()),
            "xfs /dev/foreign".into(),
            "tmpfs".into(),
        ] {
            assert!(state_mount_ready(source.as_bytes(), &disk, directory.path()).is_err());
        }
    }
}
