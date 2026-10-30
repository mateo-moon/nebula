#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exit {
    UnlockDenied = 5,
    FormatDenied = 6,
}
impl Exit {
    pub fn phase(self) -> &'static str {
        match self {
            Self::UnlockDenied => "unlock-denied",
            Self::FormatDenied => "format-denied",
        }
    }
}
impl std::fmt::Display for Exit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (exit {})", self.phase(), *self as i32)
    }
}
impl std::error::Error for Exit {}

/// The process exit code: typed lifecycle/device failure, otherwise generic 1.
pub fn exit_code(error: &anyhow::Error) -> i32 {
    if let Some(stage) = error.downcast_ref::<crate::mount_handoff::LauncherStage>() {
        return *stage as i32;
    }
    error.downcast_ref::<Exit>().map_or_else(
        || {
            if error
                .downcast_ref::<crate::native::DevicePrerequisite>()
                .is_some()
            {
                crate::native::DevicePrerequisite::EXIT_CODE
            } else {
                1
            }
        },
        |exit| *exit as i32,
    )
}

pub(crate) fn stopping() -> bool {
    crate::mount_handoff::SIGNAL.load(std::sync::atomic::Ordering::SeqCst) != 0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    Allow,
    Deny,
}
