//! Synthetic fixture only. No fixture hooks are compiled into the guest executable.
use anyhow::Result;
use aws_trustee_bootstrap::{Config, fetch_resources};
use kbs_protocol::TeeKeyPair;
use kms::{Getter, plugins::kbs::KbcClient};
use std::{env, fs};

#[tokio::test]
#[ignore = "requires explicitly started stock KBS and synthetic fixture"]
async fn stock_kbs_client_and_offline_kbc_interoperate() -> Result<()> {
    let path = std::path::PathBuf::from(env::var("NEBULA_INTEROP_FIXTURE")?);
    let config: Config = serde_json::from_slice(&fs::read(path.join("bootstrap.json"))?)?;
    let ca = fs::read_to_string(path.join("tls-root.crt"))?;
    let token = fs::read_to_string(path.join("passport.jwt"))?;
    let key = TeeKeyPair::from_pem(&fs::read_to_string(path.join("recipient-test.key"))?)?;
    let resources = fetch_resources(&config, &ca, token.clone(), key.clone()).await?;
    assert_eq!(resources.0.len(), 1);
    // Fixture keys only; production write_resources() refuses this disk-backed path.
    let resource_file = path.join("offline-fixture.json");
    fs::write(&resource_file, serde_json::to_vec(&resources.0)?)?;
    unsafe {
        env::set_var("AA_KBC_PARAMS", "offline_fs_kbc::null");
        env::set_var("OFFLINE_FS_KBC_EXTRA_FILE_PATH", &resource_file);
    }
    let kbc = KbcClient::new().await?;
    let secret = kbc
        .get_secret("kbs:///default/image_key/workload-0", &Default::default())
        .await?;
    assert_eq!(secret, b"TEST ONLY fixture image key");
    let other_key =
        kbs_protocol::TeeKeyPair::new_with_algorithm(kbs_protocol::TeeKeyAlgorithm::RsaOaep256)?;
    assert!(
        fetch_resources(&config, &ca, token.clone(), other_key)
            .await
            .is_err(),
        "substituted private key must not decrypt"
    );
    let wrong = Config {
        resources: vec!["default/image_key/other".into()],
        ..config
    };
    assert!(
        fetch_resources(&wrong, &ca, token.clone(), key.clone())
            .await
            .is_err(),
        "other workload key must be denied"
    );
    let unavailable = Config {
        kbs_url: "https://127.0.0.1:1/".into(),
        ..wrong
    };
    assert!(
        fetch_resources(&unavailable, &ca, token, key)
            .await
            .is_err(),
        "no fallback when KBS is unavailable"
    );
    fs::remove_file(resource_file)?;
    Ok(())
}
