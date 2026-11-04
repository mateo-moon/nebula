fn main() {
    #[cfg(target_os = "linux")]
    if let Err(error) = nebula_confidential_storage::run() {
        let code = nebula_confidential_storage::exit_code(&error);
        // Only a fixed failure class crosses the guest boundary. The parent
        // agent deliberately discards native stderr because it may contain
        // sensitive context, but a failed first start needs a safe diagnosis:
        // native policy forbids silently replacing the helper afterward.
        if std::env::args().nth(1).as_deref() == Some("agent") {
            let detail = format!("{error:#}");
            let class = if code == 8 {
                "device-prerequisite"
            } else if detail.contains("guest swap must be disabled") {
                "swap-enabled"
            } else if detail.contains("guest memory volume required") {
                "memory-volume"
            } else if detail.contains("invalid storage credentials") {
                "native-credentials"
            } else if detail.contains("cannot assign resource socket") {
                "resource-socket"
            } else {
                "other"
            };
            use std::io::Write;
            if let Ok(mut report) = std::fs::OpenOptions::new()
                .append(true)
                .open("/dev/termination-log")
            {
                let _ = writeln!(report, "nebula-storage-agent:{class}");
            }
        }
        eprintln!("confidential storage exit {code}: {error:#}");
        std::process::exit(code);
    }
    #[cfg(not(target_os = "linux"))]
    panic!("Linux SNP runtime required");
}
