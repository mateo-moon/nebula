//! Public operational diagnostics contain fixed codes only. Error chains may
//! contain cloud responses or protected data and must never reach the console.
use anyhow::{Error, Result};
use std::{fmt, io::Write};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Stage {
    AuthorityIntent,
    AuthorityConfiguration,
    AuthorityMembership,
    StateDisk,
    TrustRoot,
    AuthorityState,
    TpmEnvironment,
    TpmInventory,
    BootMeasurements,
    BootPcr4,
    BootPcr12,
    TpmProvisioning,
    TpmRecovery,
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
            Self::TpmEnvironment => "NEBULA_STARTUP_FAILURE:tpm-environment\n",
            Self::TpmInventory => "NEBULA_STARTUP_FAILURE:tpm-inventory\n",
            Self::BootMeasurements => "NEBULA_STARTUP_FAILURE:boot-measurements\n",
            Self::BootPcr4 => "NEBULA_STARTUP_FAILURE:boot-pcr4\n",
            Self::BootPcr12 => "NEBULA_STARTUP_FAILURE:boot-pcr12\n",
            Self::TpmProvisioning => "NEBULA_STARTUP_FAILURE:tpm-provisioning\n",
            Self::TpmRecovery => "NEBULA_STARTUP_FAILURE:tpm-recovery\n",
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
}
