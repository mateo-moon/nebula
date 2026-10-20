fn main() {
    #[cfg(target_os = "linux")]
    if let Err(error) = nebula_confidential_storage::run() {
        let code = nebula_confidential_storage::exit_code(&error);
        eprintln!("confidential storage exit {code}: {error:#}");
        std::process::exit(code);
    }
    #[cfg(not(target_os = "linux"))]
    panic!("Linux SNP runtime required");
}
