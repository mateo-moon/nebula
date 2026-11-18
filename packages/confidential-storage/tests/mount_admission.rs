use super::*;

#[test]
fn pending_requests_never_block_another_recipient() {
    let now = Instant::now();
    let (first, mut first_client) = UnixStream::pair().unwrap();
    let (second, mut second_client) = UnixStream::pair().unwrap();
    let mut first = PendingMount::new(first, now).unwrap();
    let mut second = PendingMount::new(second, now).unwrap();
    first_client.write_all(b"C").unwrap();
    second_client.write_all(MAGIC).unwrap();
    assert!(!first.ready(now).unwrap());
    assert!(second.ready(now).unwrap());
    assert!(first.ready(now + Duration::from_secs(1)).is_err());
    drop(first);
    first_client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert_eq!(first_client.read(&mut [0; 1]).unwrap(), 0);
}

#[test]
fn partial_progress_never_renews_the_fixed_admission_deadline() {
    let now = Instant::now();
    let (server, mut client) = UnixStream::pair().unwrap();
    let mut pending = PendingMount::new(server, now).unwrap();
    for (part, elapsed) in [(b'C', 0), (b'M', 400), (b'0', 900)] {
        client.write_all(&[part]).unwrap();
        assert!(!pending.ready(now + Duration::from_millis(elapsed)).unwrap());
    }
    client.write_all(b"1").unwrap();
    assert!(pending.ready(now + Duration::from_millis(1001)).is_err());
}

#[test]
fn unknown_magic_and_early_eof_are_admission_refusals_before_any_export() {
    let now = Instant::now();
    for bytes in [b"BAD!".as_slice(), b"CM0", b""] {
        let (server, mut client) = UnixStream::pair().unwrap();
        let mut pending = PendingMount::new(server, now).unwrap();
        client.write_all(bytes).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(pending.ready(now).is_err());
        assert!(pending
            .grant("/nonexistent-mount-must-not-be-opened")
            .is_err());
        assert_eq!(client.read(&mut [0; 1]).unwrap(), 0);
    }
}

#[test]
fn a_ready_request_does_not_hide_a_mount_export_failure() {
    let now = Instant::now();
    let (server, mut client) = UnixStream::pair().unwrap();
    let mut pending = PendingMount::new(server, now).unwrap();
    client.write_all(MAGIC).unwrap();
    assert!(pending.ready(now).unwrap());
    assert!(pending
        .grant("/nonexistent-mount-must-not-be-opened")
        .is_err());
}
