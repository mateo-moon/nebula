//! Actual private PID1 fixture: same original lease, real privilege drop,
//! capability-free children and a TERM-resistant orphan. No guest/device use.
use super::*;
use std::os::unix::fs::PermissionsExt;

#[test]
#[ignore = "explicit disposable PID1 Linux container with setup capabilities only"]
fn isolated_pid1_supervisor_restart_reaps_descendants_and_retains_original_lease() {
    assert_eq!(
        std::env::var("COCO_SUPERVISOR_TEST").as_deref(),
        Ok("isolated-pid1")
    );
    private_pid_init().unwrap();
    assert_eq!(unsafe { libc::geteuid() }, 0);
    let root = std::path::PathBuf::from("/tmp/supervisor-owned");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
    signals().unwrap();
    startup_credentials(11000, 11000, &[10001]).unwrap();
    let status = fs::read_to_string("/proc/thread-self/status").unwrap();
    assert!(status
        .lines()
        .any(|line| line == "CapEff:\t0000000000200000"));
    let (lease, mut owner) = UnixStream::pair().unwrap();
    lease.set_nonblocking(true).unwrap();
    let observer = std::thread::spawn(move || {
        owner
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut byte = [0];
        owner.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"B");
        owner.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"X");
        owner.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"B");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !std::path::Path::new("/tmp/supervisor-owned/second-ready").exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        }
        owner.write_all(b"S").unwrap();
        owner.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"D");
    });
    let script = r#"set -eu
      test "$(awk '/^CapEff:/{print $2}' /proc/self/status)" = 0000000000000000
      test "$(awk '/^CapBnd:/{print $2}' /proc/self/status)" = 0000000000000000
      test "$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status)" = 1
      test ! -r /proc/1/mem
      test ! -r /proc/1/environ
      if ls /proc/1/fd >/dev/null 2>&1; then exit 22; fi
      if test ! -f /tmp/supervisor-owned/orphan; then
        (trap '' TERM; while :; do sleep 1; done) &
        echo $! > /tmp/supervisor-owned/orphan
        sleep 0.1
        exit 7
      fi
      old=$(cat /tmp/supervisor-owned/orphan)
      if kill -0 "$old" 2>/dev/null; then exit 21; fi
      touch /tmp/supervisor-owned/second-ready
      while :; do sleep 1; done
    "#;
    let args = vec!["/bin/sh".into(), "-c".into(), script.into()];
    supervise_leases(
        "fixture",
        11000,
        Duration::from_secs(1),
        &args,
        vec![MountLease {
            stream: lease,
            target: CString::new("/unattached").unwrap(),
            attached: false,
        }],
    )
    .unwrap();
    observer.join().unwrap();
    assert!(root.join("second-ready").exists());
    assert!(!fs::read_dir("/proc")
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| n > 1)));
}

#[test]
#[ignore = "explicit disposable PID1 Linux container with setup capabilities only"]
fn isolated_pid1_supervisor_lease_loss_stops_without_restart() {
    assert_eq!(
        std::env::var("COCO_SUPERVISOR_TEST").as_deref(),
        Ok("isolated-pid1")
    );
    private_pid_init().unwrap();
    signals().unwrap();
    startup_credentials(11000, 11000, &[10001]).unwrap();
    let (lease, mut owner) = UnixStream::pair().unwrap();
    lease.set_nonblocking(true).unwrap();
    let observer = thread::spawn(move || {
        let mut byte = [0];
        owner.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"B");
        drop(owner);
    });
    let args = vec![
        "/bin/sh".into(),
        "-c".into(),
        "while :; do sleep 1; done".into(),
    ];
    assert!(supervise_leases(
        "fixture",
        11000,
        Duration::from_millis(100),
        &args,
        vec![MountLease {
            stream: lease,
            target: CString::new("/unattached").unwrap(),
            attached: false
        }]
    )
    .is_err());
    observer.join().unwrap();
    stop_namespace_clients().unwrap();
}
