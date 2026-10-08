use super::*;
use crate::startup::{Stage, at};
use std::{path::Path, sync::Arc};

/// The channel key belongs to this process. The caller fixes claims from
/// authenticated boot/committed state; the remote request supplies only a nonce.
#[derive(Clone)]
pub struct Collector {
    pub(super) identity: Arc<ChannelIdentity>,
    pub(super) claims: Claims,
    asvk: Vec<u8>,
    nitro: Option<Arc<dyn NitroSource>>,
}
impl Collector {
    pub fn new(identity: Arc<ChannelIdentity>, claims: Claims, asvk: Vec<u8>) -> Result<Self> {
        ensure!(
            claims.role == Role::Runtime,
            "authority requires its protected TPM writer"
        );
        Self::configured(identity, claims, asvk, None)
    }

    pub(crate) fn authority(
        identity: Arc<ChannelIdentity>,
        claims: Claims,
        asvk: Vec<u8>,
        nitro: Arc<dyn NitroSource>,
    ) -> Result<Self> {
        ensure!(
            claims.role == Role::Authority,
            "authority collector required"
        );
        Self::configured(identity, claims, asvk, Some(nitro))
    }

    fn configured(
        identity: Arc<ChannelIdentity>,
        mut claims: Claims,
        asvk: Vec<u8>,
        nitro: Option<Arc<dyn NitroSource>>,
    ) -> Result<Self> {
        claims.tls_sha256 = hex(Sha256::digest(&identity.certificate));
        claims.validate()?;
        ensure!(asvk.len() <= MAX_CERTIFICATE, "invalid ASVK size");
        X509::from_der(&asvk)?;
        Ok(Self {
            identity,
            claims,
            asvk,
            nitro,
        })
    }
    pub fn claims(&self) -> &Claims {
        &self.claims
    }

    /// Only public evidence is returned. Private channel keys, TPM owner auth
    /// and authority state are never accepted as arguments or written to files.
    pub async fn collect(&self, nonce: [u8; 32]) -> Result<Evidence> {
        let result = self.collect_inner(nonce).await;
        if let Err(error) = &result {
            crate::startup::report_evidence(error);
        }
        result
    }

    async fn collect_inner(&self, nonce: [u8; 32]) -> Result<Evidence> {
        let path = Path::new("/run/nebula/evidence");
        at(
            Stage::EvidenceEnvironment,
            crate::require_memory_directory(path),
        )?;
        let public = at(
            Stage::EvidenceBinding,
            self.identity.key.public_key_to_der(),
        )?;
        let request = at(
            Stage::EvidenceBinding,
            report_data(&nonce, &self.claims, &public),
        )?;
        let (report, vlek) = at(Stage::SnpReport, local_snp(request).await)?;
        let binding = at(
            Stage::EvidenceBinding,
            serde_json::to_vec(&Binding {
                claims: self.claims.clone(),
                snp_sha256: hex(Sha256::digest(&report)),
            }),
        )?;
        let request = at(
            Stage::EvidenceBinding,
            NitroRequest::new(nonce, public, binding),
        )?;
        let output = at(
            Stage::NitroEvidence,
            if let Some(source) = &self.nitro {
                source.document(request).await
            } else {
                at(
                    Stage::NitroEvidence,
                    tokio::task::spawn_blocking(move || request.document(None)).await,
                )?
            },
        )?;
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
        let (report, certificates) = at(Stage::SnpDevice, Firmware::open())?
            .get_ext_report(Some(1), Some(request), Some(0))
            .map_err(|error| {
                use sev::error::{UserApiError, VmmError};
                let stage = match &error {
                    UserApiError::VmmError(VmmError::RateLimitRetryRequest) => {
                        Stage::SnpRateLimited
                    }
                    UserApiError::VmmError(VmmError::InvalidCertificatePageLength)
                    | UserApiError::ApiError(_) => Stage::SnpCertificateBuffer,
                    UserApiError::FirmwareError(_) => Stage::SnpFirmware,
                    _ => Stage::SnpReport,
                };
                anyhow::Error::from(error).context(stage)
            })?;
        ensure!(report.len() == 1184, "invalid local SNP report");
        let certificates = certificates.context(Stage::SnpEndorsement)?;
        ensure!(certificates.len() <= 8, Stage::SnpEndorsement);
        let vlek: Vec<_> = certificates
            .into_iter()
            .filter(|cert| cert.cert_type == CertType::VLEK)
            .collect();
        ensure!(
            vlek.len() == 1 && vlek[0].data.len() <= MAX_CERTIFICATE,
            Stage::SnpEndorsement
        );
        let cert = at(
            Stage::SnpEndorsement,
            X509::from_der(&vlek[0].data).or_else(|_| X509::from_pem(&vlek[0].data)),
        )?;
        Ok((report, at(Stage::SnpEndorsement, cert.to_der())?))
    })
    .await?
}
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
async fn local_snp(_: [u8; 64]) -> Result<(Vec<u8>, Vec<u8>)> {
    anyhow::bail!("SNP collector requires an x86_64 Linux confidential guest")
}
