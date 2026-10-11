//! Kata connects to the CDH managed by systemd. Merely ordering Type=simple
//! services does not guarantee the Unix listener exists when Kata probes it.
use anyhow::{Result, ensure};
use std::{io::ErrorKind, os::unix::fs::FileTypeExt, path::Path, time::Duration};
use tokio::{net::UnixStream, time};

use crate::startup::{Stage, at};

async fn wait_for_socket(path: &Path, deadline: Duration) -> Result<()> {
    time::timeout(deadline, async {
        loop {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) => {
                    ensure!(metadata.file_type().is_socket(), "Unix listener required");
                    match UnixStream::connect(path).await {
                        Ok(_) => return Ok(()),
                        Err(error)
                            if matches!(
                                error.kind(),
                                ErrorKind::NotFound | ErrorKind::ConnectionRefused
                            ) => {}
                        Err(error) => return Err(error.into()),
                    }
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await?
}

/// Fixed endpoint and bounded startup wait; no caller-selected service or
/// diagnostic response can enter the attested runtime configuration.
pub async fn wait_for_cdh() -> Result<()> {
    at(
        Stage::CdhReadiness,
        wait_for_socket(
            Path::new("/run/confidential-containers/cdh.sock"),
            Duration::from_secs(60),
        )
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    #[tokio::test]
    async fn waits_for_a_real_delayed_listener() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cdh.sock");
        let start = async {
            time::sleep(Duration::from_millis(50)).await;
            let listener = UnixListener::bind(&path).unwrap();
            listener.accept().await.unwrap();
        };
        let (result, ()) = tokio::join!(wait_for_socket(&path, Duration::from_secs(2)), start);
        result.unwrap();
    }

    #[tokio::test]
    async fn accepts_a_listening_socket() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cdh.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        wait_for_socket(&path, Duration::from_secs(1))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn absent_and_stale_sockets_time_out() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cdh.sock");
        assert!(
            wait_for_socket(&path, Duration::from_millis(30))
                .await
                .is_err()
        );
        drop(UnixListener::bind(&path).unwrap());
        assert!(
            wait_for_socket(&path, Duration::from_millis(30))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn ordinary_files_and_symlinks_are_refused() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cdh.sock");
        std::fs::write(&path, b"not a listener").unwrap();
        assert!(
            wait_for_socket(&path, Duration::from_secs(1))
                .await
                .is_err()
        );
        std::fs::remove_file(&path).unwrap();
        let target = directory.path().join("other.sock");
        let _listener = UnixListener::bind(&target).unwrap();
        std::os::unix::fs::symlink(target, &path).unwrap();
        assert!(
            wait_for_socket(&path, Duration::from_secs(1))
                .await
                .is_err()
        );
    }
}
