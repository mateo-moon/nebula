#[tokio::main]
async fn main() {
    if aws_trustee_bootstrap::provision().await.is_err() {
        // Upstream errors can include response data: never log the error chain.
        let _ = std::fs::remove_file(aws_trustee_bootstrap::RESOURCE_FILE);
        eprintln!("attested resource provisioning failed; guest services remain stopped");
        std::process::exit(1);
    }
}
