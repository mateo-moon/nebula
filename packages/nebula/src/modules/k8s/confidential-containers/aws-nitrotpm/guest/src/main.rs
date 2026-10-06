#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--transport"] {
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
