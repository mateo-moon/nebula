use anyhow::{bail, ensure, Result};

pub fn run() -> Result<()> {
    ensure!(cfg!(target_arch = "x86_64"), "x86_64 SNP required");
    crate::native::protect_process()?;
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("install") if args.len() == 1 => crate::generic_storage::install(),
        Some("serve") if args.len() == 2 => crate::generic_storage::serve(&args[1]),
        Some("resource-broker") if args.len() == 2 => {
            crate::generic_storage::serve_resources(&args[1])
        }
        Some("launch") if args.len() >= 4 && args[2] == "--" => {
            let config = crate::generic_config::Launcher::parse(&args[1])?;
            crate::mount_handoff::launch_generic(&config, &args[3..])
        }
        _ => bail!("expected install, serve CONFIG, or launch CONFIG -- PROGRAM [ARGS]"),
    }
}
