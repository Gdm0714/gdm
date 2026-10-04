//! Crash/commit boundaries exercise the Rust executable, never the old interpreter.
use gdm::runtime::{contract, store};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

const SLUG: &str = "storage-proof";

#[test]
fn refreshing_completed_audited_work_reopens_without_corrupting_state() {
    for command in ["true", "false"] {
        let repo = fixture();
        let mut work = store::load(repo.path(), SLUG).unwrap();
        work["checks"] = json!([{
            "id":"c1", "desc":"fixture command", "cmd":command,
            "expect":"exit zero", "manual":false, "kind":"behavior", "expert":false,
            "status":"proven", "evidence":{
                "observed":format!(".gdm/{SLUG}/out/c1.txt"), "sha256":"a".repeat(64),
                "exitCode":0, "manual":false, "at":"2026-09-20T00:00:01.000Z"
            }
        }]);
        work["auditRequired"] = json!(true);
        work["audit"] = json!({
            "result":"pass", "report":"fixture-report.txt",
            "stateHash":gdm::runtime::state::checks_hash(&work),
            "at":"2026-09-20T00:00:02.000Z"
        });
        work["done"] = json!(true);
        work["doneAt"] = json!("2026-09-20T00:00:03.000Z");
        store::save(repo.path(), &work).unwrap();
        let result = run(repo.path(), &["recheck", "--slug", SLUG], None);
        assert_eq!(
            result.status.success(),
            command == "true",
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let refreshed = store::load(repo.path(), SLUG).unwrap();
        assert_eq!(refreshed["done"], false);
        assert!(refreshed.get("doneAt").is_none());
        assert_eq!(
            refreshed["checks"][0]["status"],
            if command == "true" { "proven" } else { "open" }
        );
        assert!(!gdm::runtime::state::completion_blockers(&refreshed).is_empty());
    }
}

#[test]
fn parseable_lock_without_a_live_valid_pid_is_reclaimed_immediately() {
    let repo = tempfile::tempdir().unwrap();
    let path = repo.path().join(".gdm.lock");
    for owner in [
        json!({}),
        json!({"pid": "unknown"}),
        json!({"pid": -1}),
        json!({"pid": 1.5}),
        json!({"pid": 4_294_967_296_u64 + std::process::id() as u64}),
    ] {
        fs::write(&path, owner.to_string()).unwrap();
        let started = Instant::now();
        let lock = store::lock(repo.path()).unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        let current: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(current["pid"], std::process::id());
        drop(lock);
        assert!(!path.exists());
    }
}

fn fixture() -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    let git = Command::new("git")
        .args(["init", "-q"])
        .current_dir(repo.path())
        .output()
        .unwrap();
    assert!(
        git.status.success(),
        "{}",
        String::from_utf8_lossy(&git.stderr)
    );
    store::save(
        repo.path(),
        &json!({
            "slug":SLUG, "brief":"native journal recovery", "createdAt":"2026-09-20T00:00:00.000Z",
            "done":false, "checks":[], "contract":contract::default_contract()
        }),
    )
    .unwrap();
    let legacy = json!({"ts":"2026-09-20T00:00:01.000Z","event":"initial","sequence":1});
    fs::write(
        repo.path().join(format!(".gdm/{SLUG}/journal.jsonl")),
        format!("{legacy}\n"),
    )
    .unwrap();
    repo
}
fn run(cwd: &Path, args: &[&str], failpoint: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gdm"));
    command
        .args(args)
        .current_dir(cwd)
        .env_remove("GDM_TEST_JOURNAL_FAILPOINT")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(value) = failpoint {
        command.env("GDM_TEST_JOURNAL_FAILPOINT", value);
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let result = child.wait_with_output().unwrap();
            panic!(
                "native gdm timed out: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn handoff(cwd: &Path, id: &str, failpoint: Option<&str>) -> Output {
    run(
        cwd,
        &[
            "protocol",
            "handoff",
            "--slug",
            SLUG,
            "--handoff-id",
            id,
            "--from-role",
            "coordinator",
            "--to-role",
            "reviewer",
            "--intent",
            "Review current work",
        ],
        failpoint,
    )
}
fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn anchor(cwd: &Path) -> Value {
    store::read_json(&cwd.join(format!(".gdm/{SLUG}/journal.anchor"))).unwrap()
}
fn journal_path(cwd: &Path) -> std::path::PathBuf {
    cwd.join(format!(".gdm/{SLUG}/journal.jsonl"))
}

#[test]
fn crash_after_data_fsync_exposes_old_prefix_and_retry_truncates_orphan() {
    let repo = fixture();
    let original = fs::read(journal_path(repo.path())).unwrap();
    let crashed = handoff(repo.path(), "retry-one", Some("after-data-fsync"));
    assert_eq!(crashed.status.code(), Some(86));
    let committed = anchor(repo.path());
    assert_eq!(store::read_journal(repo.path(), SLUG).unwrap().len(), 1);
    assert_eq!(
        committed["byteLength"].as_u64().unwrap(),
        original.len() as u64
    );
    assert!(fs::metadata(journal_path(repo.path())).unwrap().len() > original.len() as u64);
    assert!(
        !repo
            .path()
            .join(format!(".gdm/{SLUG}/journal.format"))
            .exists()
    );
    assert_success(&handoff(repo.path(), "retry-one", None));
    let events = store::read_journal(repo.path(), SLUG).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1]["handoffId"], "retry-one");
    let bytes = fs::read(journal_path(repo.path())).unwrap();
    assert!(bytes.starts_with(&original));
    assert_eq!(
        anchor(repo.path())["byteLength"].as_u64().unwrap(),
        bytes.len() as u64
    );
    assert_eq!(
        fs::read_to_string(repo.path().join(format!(".gdm/{SLUG}/journal.format"))).unwrap(),
        "gdm-journal-anchor/v1\n"
    );
}

#[test]
fn crash_after_anchor_rename_commits_once_and_next_writer_converges() {
    let repo = fixture();
    let crashed = handoff(repo.path(), "committed-one", Some("after-anchor-rename"));
    assert_eq!(crashed.status.code(), Some(86));
    assert_eq!(store::read_journal(repo.path(), SLUG).unwrap().len(), 2);
    assert!(
        !repo
            .path()
            .join(format!(".gdm/{SLUG}/journal.format"))
            .exists()
    );
    // Replaying the committed handoff must not write a duplicate receipt.
    assert_success(&handoff(repo.path(), "committed-one", None));
    assert_eq!(store::read_journal(repo.path(), SLUG).unwrap().len(), 2);
    assert_success(&handoff(repo.path(), "next-writer", None));
    assert_eq!(store::read_journal(repo.path(), SLUG).unwrap().len(), 3);
    assert_eq!(anchor(repo.path())["lineCount"], 3);
    assert_eq!(
        anchor(repo.path())["byteLength"].as_u64().unwrap(),
        fs::metadata(journal_path(repo.path())).unwrap().len()
    );
    assert!(
        repo.path()
            .join(format!(".gdm/{SLUG}/journal.format"))
            .exists()
    );
}

#[test]
fn anchored_prefix_tampering_fails_closed_for_reader_and_writer() {
    for mutation in [
        "truncate",
        "flip",
        "reorder",
        "line-count",
        "remove-anchor",
        "remove-journal",
        "corrupt-marker",
    ] {
        let repo = fixture();
        assert_success(&handoff(repo.path(), "first-offer", None));
        let path = journal_path(repo.path());
        let mut bytes = fs::read(&path).unwrap();
        match mutation {
            "truncate" => {
                bytes.pop();
                fs::write(&path, bytes).unwrap();
            }
            "flip" => {
                bytes[3] ^= 1;
                fs::write(&path, bytes).unwrap();
            }
            "reorder" => {
                let text = String::from_utf8(bytes).unwrap();
                fs::write(
                    &path,
                    text.lines()
                        .rev()
                        .map(|line| format!("{line}\n"))
                        .collect::<String>(),
                )
                .unwrap();
            }
            "line-count" => {
                let mut value = anchor(repo.path());
                value["lineCount"] = 99.into();
                store::write_json_atomic(
                    &repo.path().join(format!(".gdm/{SLUG}/journal.anchor")),
                    &value,
                )
                .unwrap();
            }
            "remove-anchor" => {
                fs::remove_file(repo.path().join(format!(".gdm/{SLUG}/journal.anchor"))).unwrap()
            }
            "remove-journal" => fs::remove_file(&path).unwrap(),
            "corrupt-marker" => fs::write(
                repo.path().join(format!(".gdm/{SLUG}/journal.format")),
                "legacy\n",
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let before = fs::read(&path).ok();
        assert_eq!(
            store::read_journal(repo.path(), SLUG).unwrap_err().code,
            "state_corrupt",
            "{mutation}"
        );
        let rejected = handoff(repo.path(), "never-append", None);
        assert_eq!(
            rejected.status.code(),
            Some(2),
            "{mutation}: {}",
            String::from_utf8_lossy(&rejected.stderr)
        );
        assert_eq!(
            fs::read(&path).ok(),
            before,
            "{mutation} mutated rejected journal"
        );
    }
}

#[test]
fn uncommitted_suffix_is_ignored_and_removed_by_next_native_write() {
    use std::io::Write;
    let repo = fixture();
    assert_success(&handoff(repo.path(), "first-offer", None));
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(journal_path(repo.path()))
        .unwrap();
    file.write_all(b"{\"event\":\"orphan\",\"partial\":")
        .unwrap();
    file.sync_all().unwrap();
    assert_eq!(store::read_journal(repo.path(), SLUG).unwrap().len(), 2);
    assert_success(&handoff(repo.path(), "next-offer", None));
    assert_eq!(store::read_journal(repo.path(), SLUG).unwrap().len(), 3);
    assert!(
        !fs::read_to_string(journal_path(repo.path()))
            .unwrap()
            .contains("orphan")
    );
}

#[test]
fn journal_symlink_does_not_modify_outside_target() {
    let repo = fixture();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), "outside stays unchanged\n").unwrap();
    fs::remove_file(journal_path(repo.path())).unwrap();
    std::os::unix::fs::symlink(outside.path(), journal_path(repo.path())).unwrap();
    let rejected = handoff(repo.path(), "outside-offer", None);
    assert_eq!(rejected.status.code(), Some(2));
    assert_eq!(
        fs::read_to_string(outside.path()).unwrap(),
        "outside stays unchanged\n"
    );
}

#[test]
fn oversized_anchor_is_rejected_even_when_json_and_hash_are_valid() {
    let repo = fixture();
    assert_success(&handoff(repo.path(), "first-offer", None));
    let path = repo.path().join(format!(".gdm/{SLUG}/journal.anchor"));
    let valid = fs::read_to_string(&path).unwrap();
    fs::write(&path, format!("{}{valid}", " ".repeat(4097))).unwrap();
    assert_eq!(
        store::read_journal(repo.path(), SLUG).unwrap_err().code,
        "state_corrupt"
    );
    let before = fs::read(journal_path(repo.path())).unwrap();
    assert_eq!(
        handoff(repo.path(), "never-append", None).status.code(),
        Some(2)
    );
    assert_eq!(fs::read(journal_path(repo.path())).unwrap(), before);
}

#[test]
fn large_uncommitted_sparse_suffix_does_not_hide_valid_committed_prefix() {
    let repo = fixture();
    assert!(handoff(repo.path(), "bounded-tail", None).status.success());
    let path = repo.path().join(format!(".gdm/{SLUG}/journal.jsonl"));
    let committed = fs::read(&path).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(70 * 1024 * 1024)
        .unwrap();
    assert_eq!(store::read_journal(repo.path(), SLUG).unwrap().len(), 2);
    assert!(
        handoff(repo.path(), "bounded-tail-next", None)
            .status
            .success()
    );
    let repaired = fs::read(&path).unwrap();
    assert!(repaired.len() < committed.len() + 4096);
    assert!(repaired.starts_with(&committed));
}

#[test]
fn manual_fifo_evidence_is_rejected_without_waiting_for_a_writer() {
    let repo = fixture();
    assert!(
        run(
            repo.path(),
            &[
                "plan",
                "add",
                "--slug",
                SLUG,
                "--desc",
                "file evidence",
                "--expect",
                "regular proof",
                "--manual"
            ],
            None
        )
        .status
        .success()
    );
    nix::unistd::mkfifo(
        &repo.path().join("evidence.pipe"),
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let before = Instant::now();
    let output = run(
        repo.path(),
        &[
            "pass",
            "c1",
            "--slug",
            SLUG,
            "--manual",
            "--observed",
            "evidence.pipe",
        ],
        None,
    );
    assert_eq!(output.status.code(), Some(5));
    assert!(before.elapsed() < Duration::from_secs(2));
    assert_eq!(
        store::load(repo.path(), SLUG).unwrap()["checks"][0]["status"],
        "open"
    );
}
