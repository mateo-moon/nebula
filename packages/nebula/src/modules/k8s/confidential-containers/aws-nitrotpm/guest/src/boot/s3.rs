//! Download public desired state with the instance's narrowly scoped S3 role.
//! IAM credentials authorize transport only, never a workload or a key release.
use crate::{transport::metadata, workload::hex};
use anyhow::{Result, ensure};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Credentials {
    access_key_id: String,
    secret_access_key: String,
    token: String,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        self.access_key_id.zeroize();
        self.secret_access_key.zeroize();
        self.token.zeroize();
    }
}
fn mac(key: &[u8], text: &str) -> Zeroizing<Vec<u8>> {
    let mut hmac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts arbitrary key lengths");
    hmac.update(text.as_bytes());
    Zeroizing::new(hmac.finalize().into_bytes().to_vec())
}
fn authorization(
    credentials: &Credentials,
    region: &str,
    host: &str,
    path: &str,
    timestamp: &str,
) -> Result<String> {
    ensure!(
        timestamp.len() == 16
            && timestamp.bytes().enumerate().all(|(i, b)| if i == 8 {
                b == b'T'
            } else if i == 15 {
                b == b'Z'
            } else {
                b.is_ascii_digit()
            }),
        "invalid AWS timestamp"
    );
    let empty = hex(Sha256::digest([]));
    let headers = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
    let request = Zeroizing::new(format!(
        "GET\n{path}\n\nhost:{host}\nx-amz-content-sha256:{empty}\nx-amz-date:{timestamp}\nx-amz-security-token:{}\n\n{headers}\n{empty}",
        credentials.token
    ));
    let date = &timestamp[..8];
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string = format!(
        "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        hex(Sha256::digest(request.as_bytes()))
    );
    let initial = Zeroizing::new(format!("AWS4{}", credentials.secret_access_key));
    let date_key = mac(initial.as_bytes(), date);
    let region_key = mac(&date_key, region);
    let service_key = mac(&region_key, "s3");
    let key = mac(&service_key, "aws4_request");
    Ok(format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={headers}, Signature={}",
        credentials.access_key_id,
        hex(mac(&key, &string))
    ))
}
fn timestamp() -> Result<String> {
    let seconds: libc::time_t = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .try_into()?;
    let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
    // gmtime_r writes only this stack-owned tm and has no shared timezone state.
    ensure!(
        !unsafe { libc::gmtime_r(&seconds, tm.as_mut_ptr()) }.is_null(),
        "clock conversion failed"
    );
    let tm = unsafe { tm.assume_init() };
    Ok(format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    ))
}
pub(super) async fn configuration(key: &str) -> Result<Vec<u8>> {
    ensure!(
        key.len() <= 512
            && key.split('/').all(|segment| !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))),
        "invalid public configuration path"
    );
    let bucket = metadata("meta-data/tags/instance/nebula-coco-bucket", 63).await?;
    let bucket = std::str::from_utf8(&bucket)?;
    ensure!(
        (3..=63).contains(&bucket.len())
            && bucket
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !bucket.starts_with('-')
            && !bucket.ends_with('-'),
        "invalid configuration bucket"
    );
    let region = metadata("meta-data/placement/region", 32).await?;
    let region = std::str::from_utf8(&region)?;
    ensure!(
        ["eu-west-1", "us-east-2"].contains(&region),
        "unsupported SNP region"
    );
    let role = metadata("meta-data/iam/security-credentials/", 64).await?;
    let role = std::str::from_utf8(&role)?;
    let credentials: Credentials = serde_json::from_slice(
        &metadata(&format!("meta-data/iam/security-credentials/{role}"), 16384).await?,
    )?;
    ensure!(
        !credentials.access_key_id.is_empty()
            && credentials.access_key_id.len() <= 128
            && !credentials.secret_access_key.is_empty()
            && credentials.secret_access_key.len() <= 128
            && !credentials.token.is_empty()
            && credentials.token.len() <= 8192
            && [
                &credentials.access_key_id,
                &credentials.secret_access_key,
                &credentials.token
            ]
            .iter()
            .all(|s| s.bytes().all(|b| (0x21..=0x7e).contains(&b))),
        "invalid IAM transport credentials"
    );
    let host = format!("{bucket}.s3.{region}.amazonaws.com");
    let path = format!("/{key}");
    let timestamp = timestamp()?;
    let authorization = Zeroizing::new(authorization(
        &credentials,
        region,
        &host,
        &path,
        &timestamp,
    )?);
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?;
    let mut response = http
        .get(format!("https://{host}{path}"))
        .header("x-amz-date", timestamp)
        .header("x-amz-content-sha256", hex(Sha256::digest([])))
        .header("x-amz-security-token", &credentials.token)
        .header("authorization", authorization.as_str())
        .send()
        .await?;
    ensure!(
        response.status().is_success(),
        "configuration not available"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 512 * 1024,
            "public configuration too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_matches_the_aws_sdk_for_a_session_authenticated_s3_get() {
        // Synthetic credentials, independently evaluated with botocore's
        // S3SigV4Auth. No AWS account or network is involved in this vector.
        let credentials = Credentials {
            access_key_id: "EXAMPLEACCESS".into(),
            secret_access_key: "example-synthetic-secret".into(),
            token: "example-session".into(),
        };
        let signed = authorization(
            &credentials,
            "eu-west-1",
            "example.invalid",
            "/boot/example/authority.json",
            "20261007T120000Z",
        )
        .unwrap();
        assert!(signed.ends_with(
            "Signature=69a9a7e3de776542746a21ae8406b3699a351fc046a8c1256f06dbaae31451fa"
        ));
        assert!(
            authorization(
                &credentials,
                "eu-west-1",
                "example.invalid",
                "/",
                "bad timestamp"
            )
            .is_err()
        );
    }
}
