use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use kbs_protocol::{
    KbsClientBuilder, KbsClientCapabilities, TeeKeyAlgorithm, TeeKeyPair, Token,
    token_provider::TokenProvider,
};
use rsa::{BigUint, RsaPublicKey, pkcs8::EncodePublicKey};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::Duration,
};
use zeroize::{Zeroize, Zeroizing};

pub mod activation;
pub mod authority;
pub mod boot;
pub mod evidence;
pub mod owner_client;
pub mod protected_state;
pub mod startup;
pub mod tpm_state;
pub mod transport;
pub mod workload;

pub const CONFIG: &str = "/usr/share/nebula/bootstrap.json";
pub const CA: &str = "/usr/share/nebula/tls-ca.crt";
pub const SECRETS: &str = "/run/nebula/secrets";
pub const RESOURCE_FILE: &str = "/run/nebula/secrets/resources.json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub workload: String,
    pub verifier_url: String,
    pub kbs_url: String,
    pub resources: Vec<String>,
}

fn label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && value.as_bytes()[0] != b'-'
        && !value.ends_with('-')
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(label(&self.workload), "invalid workload");
        for endpoint in [&self.verifier_url, &self.kbs_url] {
            let url = url::Url::parse(endpoint)?;
            ensure!(
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.path() == "/",
                "fixed HTTPS origin required"
            );
        }
        ensure!(
            !self.resources.is_empty() && self.resources.len() <= 20,
            "exact resources required"
        );
        let mut unique = std::collections::BTreeSet::new();
        for resource in &self.resources {
            let fields: Vec<_> = resource.split('/').collect();
            ensure!(
                fields.len() == 3
                    && label(fields[0])
                    && fields[1] == "image_key"
                    && label(fields[2])
                    && unique.insert(resource),
                "invalid or duplicate image resource"
            );
        }
        Ok(())
    }
}

struct FixedPassport {
    token: String,
    key: TeeKeyPair,
}

#[async_trait]
impl TokenProvider for FixedPassport {
    async fn get_token(&self) -> kbs_protocol::Result<(Token, TeeKeyPair)> {
        let token = Token::new(self.token.clone())
            .map_err(|_| kbs_protocol::Error::GetTokenFailed("invalid passport".into()))?;
        token
            .check_valid()
            .map_err(|_| kbs_protocol::Error::GetTokenFailed("expired passport".into()))?;
        Ok((token, self.key.clone()))
    }
}

pub fn recipient_der(key: &TeeKeyPair) -> Result<Vec<u8>> {
    let public = serde_json::to_value(key.export_pubkey()?)?;
    let n = URL_SAFE_NO_PAD.decode(public["n"].as_str().context("RSA modulus missing")?)?;
    let e = URL_SAFE_NO_PAD.decode(public["e"].as_str().context("RSA exponent missing")?)?;
    let public = RsaPublicKey::new(BigUint::from_bytes_be(&n), BigUint::from_bytes_be(&e))?;
    Ok(public.to_public_key_der()?.as_bytes().to_vec())
}

pub struct SecretResources(pub BTreeMap<String, String>);
impl Drop for SecretResources {
    fn drop(&mut self) {
        for value in self.0.values_mut() {
            value.zeroize();
        }
    }
}

/// Stock KBS passport client handles bearer auth, recipient-bound JWE and decryption.
pub async fn fetch_resources(
    config: &Config,
    ca: &str,
    token: String,
    key: TeeKeyPair,
) -> Result<SecretResources> {
    config.validate()?;
    let provider: Box<dyn TokenProvider> = Box::new(FixedPassport { token, key });
    let mut client = KbsClientBuilder::with_token_provider(provider, &config.kbs_url)
        .add_kbs_cert(ca)
        .build()?;
    let mut resources = SecretResources(BTreeMap::new());
    for path in &config.resources {
        let uri = format!("kbs:///{path}")
            .as_str()
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid resource URI"))?;
        let bytes = Zeroizing::new(client.get_resource(uri).await?);
        ensure!(
            !bytes.is_empty() && bytes.len() <= 65536,
            "invalid resource size"
        );
        resources
            .0
            .insert(path.clone(), STANDARD.encode(bytes.as_slice()));
    }
    Ok(resources)
}

#[cfg(target_os = "linux")]
fn mount_flags(path: &Path) -> Result<libc::c_ulong> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let cpath = CString::new(path.as_os_str().as_bytes())?;
    let mut info = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    ensure!(
        unsafe { libc::statvfs(cpath.as_ptr(), info.as_mut_ptr()) } == 0,
        "cannot inspect mount flags"
    );
    Ok(unsafe { info.assume_init() }.f_flag)
}

#[cfg(target_os = "linux")]
pub fn require_readonly_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0,
        "root-owned regular configuration file required"
    );
    ensure!(
        mount_flags(path)? & libc::ST_RDONLY != 0,
        "configuration must be on a read-only mount"
    );
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn require_readonly_file(_path: &Path) -> Result<()> {
    anyhow::bail!("Linux read-only root required")
}

#[cfg(target_os = "linux")]
pub fn require_memory_directory(path: &Path) -> Result<()> {
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::MetadataExt},
    };
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && metadata.uid() == 0 && metadata.mode() & 0o777 == 0o700,
        "root-owned private directory required"
    );
    let cpath = CString::new(path.as_os_str().as_bytes())?;
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // statfs writes info only on success; cpath lives through the call.
    ensure!(
        unsafe { libc::statfs(cpath.as_ptr(), info.as_mut_ptr()) } == 0,
        "cannot inspect secret filesystem"
    );
    let info = unsafe { info.assume_init() };
    ensure!(
        info.f_type == libc::TMPFS_MAGIC,
        "secret filesystem must be tmpfs"
    );
    let flags = libc::ST_NODEV | libc::ST_NOSUID | libc::ST_NOEXEC;
    ensure!(
        mount_flags(path)? & flags == flags,
        "restricted tmpfs mount required"
    );
    let swaps = fs::read_to_string("/proc/swaps")?;
    ensure!(swaps.lines().count() == 1, "swap forbidden");
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn require_memory_directory(_path: &Path) -> Result<()> {
    anyhow::bail!("Linux tmpfs required")
}

pub fn write_resources(path: &Path, resources: &BTreeMap<String, String>) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    require_memory_directory(path)?;
    ensure!(!resources.is_empty(), "empty resource file forbidden");
    let pending = path.join(".resources.pending");
    let result = (|| {
        let encoded = Zeroizing::new(serde_json::to_vec(resources)?);
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&pending)?;
        output.write_all(&encoded)?;
        output.sync_all()?;
        fs::rename(&pending, path.join("resources.json"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&pending);
    }
    result
}

async fn bounded_json<T: for<'a> Deserialize<'a>>(mut response: reqwest::Response) -> Result<T> {
    ensure!(response.status().is_success(), "verifier rejected request");
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 16384,
            "oversize verifier response"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Challenge {
    challenge_id: String,
    nonce: String,
    expires_at: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Passport {
    token: String,
}
#[derive(Serialize)]
struct ChallengeRequest<'a> {
    workload: &'a str,
    public_key: String,
}

pub async fn provision() -> Result<()> {
    let path = Path::new(SECRETS);
    require_memory_directory(path)?;
    // Never reuse resources from a failed/restarted provisioning attempt.
    if Path::new(RESOURCE_FILE).exists() {
        fs::remove_file(RESOURCE_FILE)?;
    }
    for file in [CONFIG, CA, "/usr/share/nebula/policy.rego"] {
        require_readonly_file(Path::new(file))?;
    }
    let config: Config = serde_json::from_slice(&fs::read(CONFIG)?)?;
    config.validate()?;
    let ca = fs::read_to_string(CA)?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .tls_certs_only([reqwest::Certificate::from_pem(ca.as_bytes())?])
        .build()?;
    let key = TeeKeyPair::new_with_algorithm(TeeKeyAlgorithm::RsaOaep256)?;
    let der = recipient_der(&key)?;
    let challenge: Challenge = bounded_json(
        http.post(format!(
            "{}/v1/challenge",
            config.verifier_url.trim_end_matches('/')
        ))
        .json(&ChallengeRequest {
            workload: &config.workload,
            public_key: STANDARD.encode(&der),
        })
        .send()
        .await?,
    )
    .await?;
    let nonce = STANDARD.decode(&challenge.nonce)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    ensure!(
        nonce.len() == 32
            && challenge.challenge_id.len() <= 64
            && challenge.expires_at > now
            && challenge.expires_at <= now + 65,
        "invalid challenge"
    );
    // Only public key and nonce cross the CLI boundary; no private PEM or token in argv/env/files.
    let transport = tempfile::tempdir_in(path)?;
    fs::write(transport.path().join("recipient.der"), der)?;
    fs::write(transport.path().join("nonce"), nonce)?;
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new("/usr/bin/nitro-tpm-attest")
            .arg("--public-key")
            .arg(transport.path().join("recipient.der"))
            .arg("--nonce")
            .arg(transport.path().join("nonce"))
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    ensure!(
        output.status.success() && !output.stdout.is_empty() && output.stdout.len() <= 32768,
        "NitroTPM evidence unavailable"
    );
    let passport: Passport = bounded_json(http.post(format!("{}/v1/passport", config.verifier_url.trim_end_matches('/')))
        .json(&serde_json::json!({"challenge_id": challenge.challenge_id, "document": STANDARD.encode(output.stdout)}))
        .send().await?).await?;
    let resources = fetch_resources(&config, &ca, passport.token, key).await?;
    write_resources(path, &resources.0)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_plaintext_endpoints_and_wrong_resources() {
        let mut config = Config {
            workload: "workload-0".into(),
            verifier_url: "https://verifier.example/".into(),
            kbs_url: "https://kbs.example/".into(),
            resources: vec!["default/image_key/workload-0".into()],
        };
        config.validate().unwrap();
        config.kbs_url = "http://kbs.example/".into();
        assert!(config.validate().is_err());
        config.kbs_url = "https://kbs.example/".into();
        config.resources = vec!["default/image_key/../../other".into()];
        assert!(config.validate().is_err());
    }
    #[test]
    fn refuses_disk_backed_secret_file() {
        let directory = tempfile::tempdir().unwrap();
        let resources = BTreeMap::from([("default/image_key/workload-0".into(), "a2V5".into())]);
        assert!(write_resources(directory.path(), &resources).is_err());
        assert!(!directory.path().join("resources.json").exists());
    }
    #[test]
    fn rejects_mutable_configuration() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(require_readonly_file(file.path()).is_err());
    }
    #[test]
    fn stock_key_export_is_der_rsa() {
        let key = TeeKeyPair::new_with_algorithm(TeeKeyAlgorithm::RsaOaep256).unwrap();
        let der = recipient_der(&key).unwrap();
        use rsa::pkcs8::DecodePublicKey;
        assert!(RsaPublicKey::from_public_key_der(&der).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated root-owned /run/nebula/secrets tmpfs"]
    fn provisions_atomically_on_linux_tmpfs_and_rejects_symlinks() {
        use std::os::unix::fs::{MetadataExt, symlink};
        let path = Path::new(SECRETS);
        let resources = BTreeMap::from([("default/image_key/workload-0".into(), "a2V5".into())]);
        write_resources(path, &resources).unwrap();
        assert_eq!(fs::metadata(RESOURCE_FILE).unwrap().mode() & 0o777, 0o600);
        assert_eq!(
            serde_json::from_slice::<BTreeMap<String, String>>(&fs::read(RESOURCE_FILE).unwrap())
                .unwrap(),
            resources
        );
        fs::remove_file(RESOURCE_FILE).unwrap();
        symlink("/tmp/nebula-not-written", path.join(".resources.pending")).unwrap();
        assert!(write_resources(path, &resources).is_err());
        assert!(!Path::new("/tmp/nebula-not-written").exists());
        assert!(!Path::new(RESOURCE_FILE).exists());
    }
}
