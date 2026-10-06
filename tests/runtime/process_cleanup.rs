//! Real subprocess tests for cancellation, timeout, and inherited pipe cleanup.
use gdm::runtime::{contract, store};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn fixture(command: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    store::save(dir.path(),&json!({"slug":"process-proof","brief":"subprocess cleanup","createdAt":"2026-09-20T00:00:00.000Z","done":false,"checks":[{"id":"c1","desc":"process cleanup","cmd":command,"expect":"exit zero","manual":false,"kind":"behavior","expert":false,"status":"open"}],"contract":contract::default_contract()})).unwrap();
    dir
}
fn wait_for_pid(path: &Path) -> i32 {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        // Redirection creates the file before echo writes its contents.
        if let Ok(text) = fs::read_to_string(path)
            && let Ok(pid) = text.trim().parse::<i32>()
            && pid > 0
        {
            return pid;
        }
        assert!(Instant::now() < end, "PID file not written");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn running(pid: i32) -> bool {
    let o = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .unwrap();
    o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().starts_with('Z')
}
fn assert_stopped(pid: i32) {
    let end = Instant::now() + Duration::from_secs(3);
    while running(pid) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!running(pid), "owned child {pid} still running");
}
#[test]
fn cancellation_reaps_owned_group_and_leaves_unrelated_process() {
    let dir = fixture("sleep 60 & echo $! > child.pid; wait");
    let mut unrelated = Command::new("sleep").arg("60").spawn().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_gdm"))
        .args(["pass", "c1", "--slug", "process-proof"])
        .current_dir(dir.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = wait_for_pid(&dir.path().join("child.pid"));
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        if Instant::now() > end {
            let _ = child.kill();
            panic!("cancellation did not finish")
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_stopped(pid);
    assert!(unrelated.try_wait().unwrap().is_none());
    let _ = unrelated.kill();
    let _ = unrelated.wait();
    let work: Value = serde_json::from_slice(
        &fs::read(dir.path().join(".gdm/process-proof/checks.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(work["checks"][0]["status"], "open");
    assert!(
        store::read_journal(dir.path(), "process-proof")
            .unwrap()
            .iter()
            .any(|e| e["code"] == "interrupted")
    );
}
#[test]
fn timeout_kills_descendants() {
    let dir = fixture("sleep 60 & echo $! > child.pid; wait");
    let started = Instant::now();
    let result = Command::new(env!("CARGO_BIN_EXE_gdm"))
        .args(["pass", "c1", "--slug", "process-proof"])
        .env("GDM_COMMAND_TIMEOUT_MS", "150")
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(String::from_utf8_lossy(&result.stderr).contains("ETIMEDOUT"));
    let pid = fs::read_to_string(dir.path().join("child.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_stopped(pid);
}
#[test]
fn parent_success_closes_background_inherited_pipes() {
    let dir = fixture("sleep 60 & echo $! > child.pid; printf finished");
    let started = Instant::now();
    let result = Command::new(env!("CARGO_BIN_EXE_gdm"))
        .args(["pass", "c1", "--slug", "process-proof"])
        .env("GDM_COMMAND_TIMEOUT_MS", "1000")
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    let pid = fs::read_to_string(dir.path().join("child.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_stopped(pid);
}
