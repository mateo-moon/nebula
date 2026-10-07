use super::*;
use std::{path::Path, sync::Arc, time::Duration};
use tokio::io::AsyncReadExt;

/// The channel key belongs to this process. The caller fixes claims from
/// authenticated boot/committed state; the remote request supplies only a nonce.
#[derive(Clone)]
pub struct Collector {
    pub(super) identity: Arc<ChannelIdentity>,
    pub(super) claims: Claims,
    asvk: Vec<u8>,
}
impl Collector {
    pub fn new(identity: Arc<ChannelIdentity>, mut claims: Claims, asvk: Vec<u8>) -> Result<Self> {
        claims.tls_sha256 = hex(Sha256::digest(&identity.certificate));
        claims.validate()?;
        ensure!(asvk.len() <= MAX_CERTIFICATE, "invalid ASVK size");
        X509::from_der(&asvk)?;
        Ok(Self {
            identity,
            claims,
            asvk,
        })
    }
    pub fn claims(&self) -> &Claims {
        &self.claims
    }

    /// Only public evidence is returned. Private channel keys, TPM owner auth
    /// and authority state are never accepted as arguments or written to files.
    pub async fn collect(&self, nonce: [u8; 32]) -> Result<Evidence> {
        let path = Path::new("/run/nebula/evidence");
        crate::require_memory_directory(path)?;
        let public = self.identity.key.public_key_to_der()?;
        let request = report_data(&nonce, &self.claims, &public)?;
        let (report, vlek) = local_snp(request).await?;
        let binding = serde_json::to_vec(&Binding {
            claims: self.claims.clone(),
            snp_sha256: hex(Sha256::digest(&report)),
        })?;
        ensure!(binding.len() <= 1024, "identity binding too large");
        let directory = tempfile::tempdir_in(path)?;
        std::fs::write(directory.path().join("nonce"), nonce)?;
        std::fs::write(directory.path().join("public.der"), public)?;
        std::fs::write(directory.path().join("binding.json"), binding)?;
        let mut process = tokio::process::Command::new("/usr/bin/nitro-tpm-attest")
            .arg("--nonce")
            .arg(directory.path().join("nonce"))
            .arg("--public-key")
            .arg(directory.path().join("public.der"))
            .arg("--user-data")
            .arg(directory.path().join("binding.json"))
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let output = tokio::time::timeout(Duration::from_secs(10), async {
            let mut output = Vec::new();
            process
                .stdout
                .take()
                .context("attester output missing")?
                .take((MAX_DOCUMENT + 1) as u64)
                .read_to_end(&mut output)
                .await?;
            ensure!(
                !output.is_empty() && output.len() <= MAX_DOCUMENT,
                "attester output invalid"
            );
            ensure!(
                process.wait().await?.success(),
                "NitroTPM evidence unavailable"
            );
            Ok::<_, anyhow::Error>(output)
        })
        .await??;
        Ok(Evidence {
            nitro: STANDARD.encode(output),
            snp: STANDARD.encode(report),
            vlek: STANDARD.encode(vlek),
            asvk: STANDARD.encode(&self.asvk),
            tls_certificate: STANDARD.encode(&self.identity.certificate),
        })
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
async fn local_snp(request: [u8; 64]) -> Result<(Vec<u8>, Vec<u8>)> {
    tokio::task::spawn_blocking(move || {
        use sev::firmware::{guest::Firmware, host::CertType};
        let (report, certificates) = Firmware::open()?
            .get_ext_report(Some(1), Some(request), Some(0))
            .map_err(|_| anyhow::anyhow!("local SNP evidence unavailable"))?;
        ensure!(report.len() == 1184, "invalid local SNP report");
        let certificates = certificates.context("SNP endorsement missing")?;
        ensure!(certificates.len() <= 8, "too many SNP certificates");
        let vlek: Vec<_> = certificates
            .into_iter()
            .filter(|cert| cert.cert_type == CertType::VLEK)
            .collect();
        ensure!(
            vlek.len() == 1 && vlek[0].data.len() <= MAX_CERTIFICATE,
            "unique VLEK required"
        );
        let cert = X509::from_der(&vlek[0].data).or_else(|_| X509::from_pem(&vlek[0].data))?;
        Ok((report, cert.to_der()?))
    })
    .await?
}
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
async fn local_snp(_: [u8; 64]) -> Result<(Vec<u8>, Vec<u8>)> {
    anyhow::bail!("SNP collector requires an x86_64 Linux confidential guest")
}
