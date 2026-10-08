//! Public operational diagnostics contain fixed codes only. Error chains may
//! contain cloud responses or protected data and must never reach the console.
use anyhow::{Error, Result};
use std::{
    fmt,
    io::Write,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Stage {
    AuthorityIntent,
    AuthorityConfiguration,
    AuthorityMembership,
    StateDisk,
    TrustRoot,
    AuthorityState,
    TransportFilesystem,
    TransportMetadata,
    TransportConfiguration,
    TransportPersist,
    TpmEnvironment,
    TpmInventory,
    BootMeasurements,
    BootPcr4,
    BootPcr12,
    TpmProvisioning,
    TpmRecovery,
    EvidenceEnvironment,
    EvidenceBinding,
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    SnpDevice,
    SnpReport,
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    SnpFirmware,
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    SnpRateLimited,
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    SnpCertificateBuffer,
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    SnpEndorsement,
    NitroEvidence,
    NitroEndorsement,
    NitroEkHandles,
    NitroEkDevice,
    NitroEkPrimaryAuth,
    NitroEkPersistAuth,
    NitroEkAuth,
    NitroEkLockout,
    NitroEkObjectMemory,
    NitroEkSessionMemory,
    NitroEkMemory,
    NitroEkHandle,
    NitroEkPrimary,
    NitroEkPersist,
    NitroEkTss,
    NitroEkWrapper,
    NitroEkPublicKey,
    NitroEkEncoding,
    NitroEkParameters,
    NitroBuffer,
    NitroRequest,
    NitroTss,
    NitroResponse,
    NitroTimeout,
}

impl Stage {
    fn message(self) -> &'static str {
        match self {
            Self::AuthorityIntent => "NEBULA_STARTUP_FAILURE:authority-intent\n",
            Self::AuthorityConfiguration => "NEBULA_STARTUP_FAILURE:authority-configuration\n",
            Self::AuthorityMembership => "NEBULA_STARTUP_FAILURE:authority-membership\n",
            Self::StateDisk => "NEBULA_STARTUP_FAILURE:state-disk\n",
            Self::TrustRoot => "NEBULA_STARTUP_FAILURE:trust-root\n",
            Self::AuthorityState => "NEBULA_STARTUP_FAILURE:authority-state\n",
            Self::TransportFilesystem => "NEBULA_STARTUP_FAILURE:transport-filesystem\n",
            Self::TransportMetadata => "NEBULA_STARTUP_FAILURE:transport-metadata\n",
            Self::TransportConfiguration => "NEBULA_STARTUP_FAILURE:transport-configuration\n",
            Self::TransportPersist => "NEBULA_STARTUP_FAILURE:transport-persist\n",
            Self::TpmEnvironment => "NEBULA_STARTUP_FAILURE:tpm-environment\n",
            Self::TpmInventory => "NEBULA_STARTUP_FAILURE:tpm-inventory\n",
            Self::BootMeasurements => "NEBULA_STARTUP_FAILURE:boot-measurements\n",
            Self::BootPcr4 => "NEBULA_STARTUP_FAILURE:boot-pcr4\n",
            Self::BootPcr12 => "NEBULA_STARTUP_FAILURE:boot-pcr12\n",
            Self::TpmProvisioning => "NEBULA_STARTUP_FAILURE:tpm-provisioning\n",
            Self::TpmRecovery => "NEBULA_STARTUP_FAILURE:tpm-recovery\n",
            Self::EvidenceEnvironment => "NEBULA_STARTUP_FAILURE:evidence-environment\n",
            Self::EvidenceBinding => "NEBULA_STARTUP_FAILURE:evidence-binding\n",
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            Self::SnpDevice => "NEBULA_STARTUP_FAILURE:snp-device\n",
            Self::SnpReport => "NEBULA_STARTUP_FAILURE:snp-report\n",
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            Self::SnpFirmware => "NEBULA_STARTUP_FAILURE:snp-firmware\n",
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            Self::SnpRateLimited => "NEBULA_STARTUP_FAILURE:snp-rate-limited\n",
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            Self::SnpCertificateBuffer => "NEBULA_STARTUP_FAILURE:snp-certificate-buffer\n",
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            Self::SnpEndorsement => "NEBULA_STARTUP_FAILURE:snp-endorsement\n",
            Self::NitroEvidence => "NEBULA_STARTUP_FAILURE:nitro-evidence\n",
            Self::NitroEndorsement => "NEBULA_STARTUP_FAILURE:nitro-endorsement\n",
            Self::NitroEkHandles => "NEBULA_STARTUP_FAILURE:nitro-ek-handle-capacity\n",
            Self::NitroEkDevice => "NEBULA_STARTUP_FAILURE:nitro-ek-device\n",
            Self::NitroEkPrimaryAuth => "NEBULA_STARTUP_FAILURE:nitro-ek-primary-auth\n",
            Self::NitroEkPersistAuth => "NEBULA_STARTUP_FAILURE:nitro-ek-persist-auth\n",
            Self::NitroEkAuth => "NEBULA_STARTUP_FAILURE:nitro-ek-auth\n",
            Self::NitroEkLockout => "NEBULA_STARTUP_FAILURE:nitro-ek-lockout\n",
            Self::NitroEkObjectMemory => "NEBULA_STARTUP_FAILURE:nitro-ek-object-memory\n",
            Self::NitroEkSessionMemory => "NEBULA_STARTUP_FAILURE:nitro-ek-session-memory\n",
            Self::NitroEkMemory => "NEBULA_STARTUP_FAILURE:nitro-ek-memory\n",
            Self::NitroEkHandle => "NEBULA_STARTUP_FAILURE:nitro-ek-handle\n",
            Self::NitroEkPrimary => "NEBULA_STARTUP_FAILURE:nitro-ek-primary\n",
            Self::NitroEkPersist => "NEBULA_STARTUP_FAILURE:nitro-ek-persist\n",
            Self::NitroEkTss => "NEBULA_STARTUP_FAILURE:nitro-ek-tss\n",
            Self::NitroEkWrapper => "NEBULA_STARTUP_FAILURE:nitro-ek-wrapper\n",
            Self::NitroEkPublicKey => "NEBULA_STARTUP_FAILURE:nitro-ek-public-key\n",
            Self::NitroEkEncoding => "NEBULA_STARTUP_FAILURE:nitro-ek-encoding\n",
            Self::NitroEkParameters => "NEBULA_STARTUP_FAILURE:nitro-ek-parameters\n",
            Self::NitroBuffer => "NEBULA_STARTUP_FAILURE:nitro-buffer\n",
            Self::NitroRequest => "NEBULA_STARTUP_FAILURE:nitro-request\n",
            Self::NitroTss => "NEBULA_STARTUP_FAILURE:nitro-tss\n",
            Self::NitroResponse => "NEBULA_STARTUP_FAILURE:nitro-response\n",
            Self::NitroTimeout => "NEBULA_STARTUP_FAILURE:nitro-timeout\n",
        }
    }
}

impl fmt::Display for Stage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message().trim_end())
    }
}
impl std::error::Error for Stage {}

/// Preserve the most specific classification without inspecting error text.
pub(crate) fn at<T, E: Into<Error>>(stage: Stage, result: std::result::Result<T, E>) -> Result<T> {
    result.map_err(|error| {
        let error = error.into();
        if error.downcast_ref::<Stage>().is_some() {
            error
        } else {
            error.context(stage)
        }
    })
}

fn message(error: &Error) -> &'static str {
    error
        .downcast_ref::<Stage>()
        .map(|stage| stage.message())
        .unwrap_or("NEBULA_STARTUP_FAILURE:unclassified\n")
}

/// Keep service stdout/stderr suppressed. Only this bounded, static message is
/// written explicitly to the public console; never Display/Debug the error.
pub fn report(error: &Error) {
    if let Ok(mut console) = std::fs::OpenOptions::new().write(true).open("/dev/console") {
        let _ = console.write_all(message(error).as_bytes());
    }
}

#[derive(Default)]
struct EvidenceDiagnostics(Option<Instant>);

impl EvidenceDiagnostics {
    fn take(&mut self, now: Instant, error: &Error) -> Option<&'static str> {
        if self
            .0
            .is_some_and(|last| now.saturating_duration_since(last) < Duration::from_secs(60))
        {
            return None;
        }
        self.0 = Some(now);
        Some(message(error))
    }
}

/// Remote requests cannot make the collector print error bodies or flood the
/// console. Only a fixed classification is emitted, at most once per minute.
pub(crate) fn report_evidence(error: &Error) {
    static LAST: Mutex<EvidenceDiagnostics> = Mutex::new(EvidenceDiagnostics(None));
    let Ok(mut last) = LAST.try_lock() else {
        return;
    };
    let Some(message) = last.take(Instant::now(), error) else {
        return;
    };
    drop(last);
    if let Ok(mut console) = std::fs::OpenOptions::new().write(true).open("/dev/console") {
        let _ = console.write_all(message.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_diagnostics_preserve_inner_stage_and_never_format_error_data() {
        let secret = "synthetic-credential-response-NEBULA_STARTUP_FAILURE:forged";
        let error = anyhow::anyhow!(secret).context(secret);
        assert_eq!(message(&error), "NEBULA_STARTUP_FAILURE:unclassified\n");
        let inner = at::<(), _>(Stage::BootMeasurements, Err(error));
        let outer = at(Stage::AuthorityState, inner)
            .unwrap_err()
            .context(secret);
        assert_eq!(
            message(&outer),
            "NEBULA_STARTUP_FAILURE:boot-measurements\n"
        );
        assert!(!message(&outer).contains(secret));
    }

    #[test]
    fn evidence_diagnostics_are_rate_limited_and_never_format_error_data() {
        let now = Instant::now();
        let mut diagnostics = EvidenceDiagnostics::default();
        let error = anyhow::anyhow!("private upstream error NEBULA_STARTUP_FAILURE:forged")
            .context(Stage::NitroBuffer);
        assert_eq!(
            diagnostics.take(now, &error),
            Some("NEBULA_STARTUP_FAILURE:nitro-buffer\n")
        );
        assert_eq!(diagnostics.take(now, &error), None);
        assert_eq!(
            diagnostics.take(now + Duration::from_secs(59), &error),
            None
        );
        let other = anyhow::anyhow!("untrusted payload").context(Stage::SnpReport);
        assert_eq!(
            diagnostics.take(now + Duration::from_secs(60), &other),
            Some("NEBULA_STARTUP_FAILURE:snp-report\n")
        );
    }

    #[test]
    fn transport_diagnostics_never_reveal_metadata_or_tls_material() {
        for (stage, expected) in [
            (Stage::TransportFilesystem, "transport-filesystem"),
            (Stage::TransportMetadata, "transport-metadata"),
            (Stage::TransportConfiguration, "transport-configuration"),
            (Stage::TransportPersist, "transport-persist"),
        ] {
            let error = at::<(), _>(
                stage,
                Err(anyhow::anyhow!("private metadata and TLS key bytes")),
            )
            .unwrap_err();
            assert_eq!(
                message(&error),
                format!("NEBULA_STARTUP_FAILURE:{expected}\n")
            );
        }
    }
}
