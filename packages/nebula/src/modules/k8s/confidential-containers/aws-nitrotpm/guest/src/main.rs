#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() == 1
        && ["--owner-channel", "--inspect-authority", "--canary-intent"].contains(&args[0].as_str())
    {
        if aws_trustee_bootstrap::owner_client::run(&args[0])
            .await
            .is_err()
        {
            eprintln!("attested owner publication failed");
            std::process::exit(1);
        }
    } else if args.as_slice() == ["--authority"] || args.as_slice() == ["--managed-runtime"] {
        let result = if args[0] == "--authority" {
            aws_trustee_bootstrap::boot::run_authority().await
        } else {
            aws_trustee_bootstrap::boot::run_runtime().await
        };
        if result.is_err() {
            eprintln!("protected appliance startup failed; no runtime is activated");
            std::process::exit(1);
        }
    } else if args.as_slice() == ["--verify-workload"] {
        if aws_trustee_bootstrap::workload::verify_stdin().is_err() {
            eprintln!("workload verification failed");
            std::process::exit(1);
        }
    } else if args.as_slice() == ["--verify-authority"] {
        if aws_trustee_bootstrap::authority::verify_stdin().is_err() {
            eprintln!("authority verification failed");
            std::process::exit(1);
        }
    } else if args.as_slice() == ["--transport"] {
        if aws_trustee_bootstrap::transport::provision().await.is_err() {
            eprintln!("CAA transport provisioning failed; guest services remain stopped");
            std::process::exit(1);
        }
    } else if !args.is_empty() {
        eprintln!("unsupported bootstrap arguments");
        std::process::exit(1);
    } else if aws_trustee_bootstrap::provision().await.is_err() {
        // Upstream errors can include response data: never log the error chain.
        let _ = std::fs::remove_file(aws_trustee_bootstrap::RESOURCE_FILE);
        eprintln!("attested resource provisioning failed; guest services remain stopped");
        std::process::exit(1);
    }
}
