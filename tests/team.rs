use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::Path,
    process::{Command, Output},
    sync::Barrier,
    thread,
};
use tempfile::TempDir;

fn command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gdm"));
    command
        .args(["--language", "en"])
        .args(args)
        .current_dir(cwd)
        .env("GDM_NO_COLOR", "1")
        .env("GDM_CONFIG_DIR", cwd.join("config"))
        .env_remove("GDM_TEST_JOURNAL_FAILPOINT");
    command
}

fn cli(cwd: &Path, args: &[&str]) -> Output {
    command(cwd, args).output().unwrap()
}

fn success(cwd: &Path, args: &[&str]) -> String {
    let output = cli(cwd, args);
    assert!(
        output.status.success(),
        "{args:?}: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn denied(cwd: &Path, args: &[&str]) -> String {
    let output = cli(cwd, args);
    assert!(
        !output.status.success(),
        "Unexpected success for {args:?}: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    String::from_utf8(output.stderr).unwrap()
}

fn team(cwd: &Path, args: &[&str]) -> String {
    success(cwd, &[&["team"][..], args, &["--slug", "sample"]].concat())
}

fn team_denied(cwd: &Path, args: &[&str]) -> String {
    denied(cwd, &[&["team"][..], args, &["--slug", "sample"]].concat())
}

fn team_json(cwd: &Path, command: &str) -> Value {
    serde_json::from_str(&team(cwd, &[command, "--json"])).unwrap()
}

fn has_action(cwd: &Path, action: &str, task: &str) -> bool {
    team_json(cwd, "next")["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["action"] == action && item["taskId"] == task)
}

fn setup() -> TempDir {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path();
    fs::write(cwd.join("expected.txt"), "ready\n").unwrap();
    fs::write(cwd.join("actual.txt"), "ready\n").unwrap();
    fs::create_dir(cwd.join("artifacts")).unwrap();
    fs::write(
        cwd.join("artifacts/result.txt"),
        "Completed implementation\n",
    )
    .unwrap();
    success(
        cwd,
        &[
            "plan",
            "init",
            "--slug",
            "sample",
            "--brief",
            "Coordinated workflow",
            "--require",
            "Accept verified results before completion",
        ],
    );
    success(
        cwd,
        &[
            "plan",
            "add",
            "--slug",
            "sample",
            "--desc",
            "Result matches expected output",
            "--cmd",
            "cmp expected.txt actual.txt",
            "--expect",
            "Files match",
            "--kind",
            "behavior",
        ],
    );
    temp
}

fn configure(cwd: &Path, max_active: &str) {
    team(
        cwd,
        &[
            "configure",
            "--mode",
            "coordinated",
            "--max-active",
            max_active,
        ],
    );
}

fn add(cwd: &Path, id: &str, path: &str, access: &str, dependency: Option<&str>) {
    let mut args = vec![
        "add",
        "--task",
        id,
        "--role",
        "implementation",
        "--path",
        path,
        "--access",
        access,
        "--deliverable",
        "Verified implementation",
        "--acceptance",
        "Expected output matches",
        "--check",
        "c1",
    ];
    if let Some(dependency) = dependency {
        args.extend(["--depends-on", dependency]);
    }
    team(cwd, &args);
}

fn claim(cwd: &Path, id: &str, attempt: &str) {
    team(
        cwd,
        &[
            "claim",
            "--task",
            id,
            "--assignee",
            &format!("worker-{id}"),
            "--attempt",
            attempt,
        ],
    );
}

fn report_args<'a>(
    id: &'a str,
    attempt: &'a str,
    outcome: &'a str,
    summary: &'a str,
) -> Vec<&'a str> {
    vec![
        "report",
        "--task",
        id,
        "--attempt",
        attempt,
        "--outcome",
        outcome,
        "--summary",
        summary,
        "--artifact",
        "artifacts/result.txt",
        "--tokens",
        "123",
        "--elapsed-ms",
        "45",
    ]
}

fn report(cwd: &Path, id: &str, attempt: &str, outcome: &str) {
    team(
        cwd,
        &report_args(id, attempt, outcome, "Result is ready for review"),
    );
}

fn accept(cwd: &Path, id: &str, attempt: &str) {
    team(
        cwd,
        &[
            "review",
            "--task",
            id,
            "--attempt",
            attempt,
            "--decision",
            "accept",
            "--reason",
            "Evidence confirms expected output",
        ],
    );
}

fn pass(cwd: &Path) {
    success(cwd, &["pass", "c1", "--slug", "sample"]);
}

fn recheck(cwd: &Path) {
    success(cwd, &["recheck", "--check", "c1", "--slug", "sample"]);
}

fn done_denied(cwd: &Path) {
    denied(cwd, &["done", "--slug", "sample"]);
    let state: Value =
        serde_json::from_slice(&fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()).unwrap();
    assert_eq!(
        state["done"], false,
        "Denied completion must leave work open"
    );
}

#[test]
fn legacy_work_without_a_team_still_completes() {
    let temp = setup();
    pass(temp.path());
    success(temp.path(), &["done", "--slug", "sample"]);
}

#[test]
fn coordinated_completion_requires_tasks_and_coordinator_acceptance() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    pass(cwd);
    done_denied(cwd); // An empty coordinated plan cannot silently complete.
    add(cwd, "implementation", "src", "write", None);
    done_denied(cwd); // Pending.
    claim(cwd, "implementation", "attempt-1");
    done_denied(cwd); // Running.
    report(cwd, "implementation", "attempt-1", "completed");
    done_denied(cwd); // A worker report alone is not acceptance.
    recheck(cwd);
    accept(cwd, "implementation", "attempt-1");
    success(cwd, &["done", "--slug", "sample"]);
}

#[test]
fn acceptance_requires_passing_linked_check_and_rejected_result_can_retry() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    report(cwd, "implementation", "attempt-1", "completed");
    let review = [
        "review",
        "--task",
        "implementation",
        "--attempt",
        "attempt-1",
        "--decision",
        "accept",
        "--reason",
        "Review requested",
    ];
    team_denied(cwd, &review);
    fs::write(cwd.join("actual.txt"), "incorrect\n").unwrap();
    denied(cwd, &["pass", "c1", "--slug", "sample"]);
    team_denied(cwd, &review);
    fs::write(cwd.join("actual.txt"), "ready\n").unwrap();
    pass(cwd);
    team(
        cwd,
        &[
            "review",
            "--task",
            "implementation",
            "--attempt",
            "attempt-1",
            "--decision",
            "reject",
            "--reason",
            "Additional work is needed",
        ],
    );
    done_denied(cwd);
    team(
        cwd,
        &[
            "retry",
            "--task",
            "implementation",
            "--attempt",
            "attempt-1",
            "--reason",
            "Address review findings",
        ],
    );
    claim(cwd, "implementation", "attempt-2");
    report(cwd, "implementation", "attempt-2", "completed");
    recheck(cwd);
    accept(cwd, "implementation", "attempt-2");
    success(cwd, &["done", "--slug", "sample"]);
}

#[test]
fn noncompleted_outcomes_never_satisfy_completion_or_acceptance() {
    for outcome in ["failed", "cancelled", "inconclusive"] {
        let temp = setup();
        let cwd = temp.path();
        configure(cwd, "3");
        add(cwd, "implementation", "src", "write", None);
        claim(cwd, "implementation", "attempt-1");
        report(cwd, "implementation", "attempt-1", outcome);
        pass(cwd);
        team_denied(
            cwd,
            &[
                "review",
                "--task",
                "implementation",
                "--attempt",
                "attempt-1",
                "--decision",
                "accept",
                "--reason",
                "Check alone is insufficient",
            ],
        );
        done_denied(cwd);
    }
}

#[test]
fn dependent_task_is_claimable_only_after_predecessor_acceptance() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "foundation", "src", "write", None);
    add(cwd, "consumer", "tests", "write", Some("foundation"));
    assert!(has_action(cwd, "dispatch", "foundation"));
    assert!(!has_action(cwd, "dispatch", "consumer"));
    let dependent_claim = [
        "claim",
        "--task",
        "consumer",
        "--assignee",
        "worker-consumer",
        "--attempt",
        "consumer-1",
    ];
    team_denied(cwd, &dependent_claim);
    claim(cwd, "foundation", "foundation-1");
    team_denied(cwd, &dependent_claim);
    report(cwd, "foundation", "foundation-1", "completed");
    pass(cwd);
    assert!(has_action(cwd, "review", "foundation"));
    assert!(!has_action(cwd, "dispatch", "consumer"));
    team_denied(cwd, &dependent_claim);
    accept(cwd, "foundation", "foundation-1");
    assert!(has_action(cwd, "dispatch", "consumer"));
    team(cwd, &dependent_claim);
    let status = team_json(cwd, "status");
    assert_eq!(status["taskCount"], 2);
    assert_eq!(status["active"], 1);
    assert_eq!(status["accepted"], 1);
}

#[test]
fn concurrency_limit_releases_capacity_when_an_attempt_reports() {
    let temp = setup();
    let cwd = temp.path();
    team_denied(
        cwd,
        &["configure", "--mode", "coordinated", "--max-active", "5"],
    );
    team_denied(
        cwd,
        &["configure", "--mode", "coordinated", "--max-active", "0"],
    );
    configure(cwd, "1");
    add(cwd, "first", "src", "write", None);
    add(cwd, "second", "tests", "write", None);
    claim(cwd, "first", "first-1");
    let second_claim = [
        "claim",
        "--task",
        "second",
        "--assignee",
        "worker-second",
        "--attempt",
        "second-1",
    ];
    team_denied(cwd, &second_claim);
    report(cwd, "first", "first-1", "failed");
    team(cwd, &second_claim);
}

#[test]
fn overlapping_writes_conflict_but_sibling_paths_and_readers_can_run() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "4");
    add(cwd, "writer", "src", "write", None);
    add(cwd, "reader", "src/component.rs", "read", None);
    add(cwd, "sibling", "src-other", "write", None);
    claim(cwd, "writer", "writer-1");
    let reader_claim = [
        "claim",
        "--task",
        "reader",
        "--assignee",
        "worker-reader",
        "--attempt",
        "reader-1",
    ];
    team_denied(cwd, &reader_claim);
    claim(cwd, "sibling", "sibling-1");
    report(cwd, "writer", "writer-1", "failed");
    team(cwd, &reader_claim);
    add(cwd, "other-reader", "src", "read", None);
    claim(cwd, "other-reader", "other-reader-1");
    add(cwd, "child-writer", "src/component.rs", "write", None);
    team_denied(
        cwd,
        &[
            "claim",
            "--task",
            "child-writer",
            "--assignee",
            "worker-child",
            "--attempt",
            "child-1",
        ],
    );
}

#[test]
fn report_replays_are_idempotent_and_retry_invalidates_old_attempts() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    report(cwd, "implementation", "attempt-1", "failed");
    let before = fs::read(cwd.join(".gdm/sample/checks.json")).unwrap();
    report(cwd, "implementation", "attempt-1", "failed");
    assert_eq!(
        before,
        fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()
    );
    team_denied(
        cwd,
        &report_args("implementation", "attempt-1", "failed", "Different result"),
    );
    team_denied(
        cwd,
        &report_args(
            "implementation",
            "attempt-1",
            "completed",
            "Result is ready for review",
        ),
    );
    team(
        cwd,
        &[
            "retry",
            "--task",
            "implementation",
            "--attempt",
            "attempt-1",
            "--reason",
            "Try a corrected implementation",
        ],
    );
    team_denied(
        cwd,
        &report_args(
            "implementation",
            "attempt-1",
            "failed",
            "Result is ready for review",
        ),
    );
    team_denied(
        cwd,
        &[
            "claim",
            "--task",
            "implementation",
            "--assignee",
            "worker-implementation",
            "--attempt",
            "attempt-1",
        ],
    );
    claim(cwd, "implementation", "attempt-2");
    team_denied(
        cwd,
        &report_args(
            "implementation",
            "attempt-1",
            "completed",
            "Late worker response",
        ),
    );
    report(cwd, "implementation", "attempt-2", "completed");
    pass(cwd);
    accept(cwd, "implementation", "attempt-2");
    success(cwd, &["done", "--slug", "sample"]);
}

#[test]
fn late_review_and_retry_cannot_modify_a_newer_attempt() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    report(cwd, "implementation", "attempt-1", "failed");
    team(
        cwd,
        &[
            "retry",
            "--task",
            "implementation",
            "--attempt",
            "attempt-1",
            "--reason",
            "Correct the first implementation",
        ],
    );
    claim(cwd, "implementation", "attempt-2");
    report(cwd, "implementation", "attempt-2", "completed");
    pass(cwd);
    let before = fs::read(cwd.join(".gdm/sample/checks.json")).unwrap();
    for decision in ["accept", "reject"] {
        let error = team_denied(
            cwd,
            &[
                "review",
                "--task",
                "implementation",
                "--attempt",
                "attempt-1",
                "--decision",
                decision,
                "--reason",
                "Late review of the old result",
            ],
        );
        assert!(error.contains("team_attempt_conflict"), "{error}");
        assert_eq!(
            before,
            fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()
        );
    }
    team(
        cwd,
        &[
            "review",
            "--task",
            "implementation",
            "--attempt",
            "attempt-2",
            "--decision",
            "reject",
            "--reason",
            "Additional verification is required",
        ],
    );
    let before = fs::read(cwd.join(".gdm/sample/checks.json")).unwrap();
    let error = team_denied(
        cwd,
        &[
            "retry",
            "--task",
            "implementation",
            "--attempt",
            "attempt-1",
            "--reason",
            "Late retry of the old result",
        ],
    );
    assert!(error.contains("team_attempt_conflict"), "{error}");
    assert_eq!(
        before,
        fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()
    );
    team(
        cwd,
        &[
            "retry",
            "--task",
            "implementation",
            "--attempt",
            "attempt-2",
            "--reason",
            "Address the current review findings",
        ],
    );
    claim(cwd, "implementation", "attempt-3");
    report(cwd, "implementation", "attempt-3", "completed");
    recheck(cwd);
    accept(cwd, "implementation", "attempt-3");
    success(cwd, &["done", "--slug", "sample"]);
}

#[test]
fn rejected_task_remains_rejected_after_crash_while_appending_journal() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    report(cwd, "implementation", "attempt-1", "completed");
    pass(cwd);
    accept(cwd, "implementation", "attempt-1");
    let crashed = command(
        cwd,
        &[
            "team",
            "review",
            "--slug",
            "sample",
            "--task",
            "implementation",
            "--attempt",
            "attempt-1",
            "--decision",
            "reject",
            "--reason",
            "New evidence requires corrections",
        ],
    )
    .env("GDM_TEST_JOURNAL_FAILPOINT", "after-anchor-rename")
    .output()
    .unwrap();
    assert_eq!(
        crashed.status.code(),
        Some(86),
        "{}",
        String::from_utf8_lossy(&crashed.stderr)
    );
    let recovered = team_json(cwd, "status");
    assert_eq!(recovered["tasks"][0]["status"], "rejected");
    assert_eq!(recovered["accepted"], 0);
    done_denied(cwd);
}

#[test]
fn required_pending_task_survives_crash_while_appending_journal() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    report(cwd, "implementation", "attempt-1", "completed");
    pass(cwd);
    accept(cwd, "implementation", "attempt-1");
    let crashed = command(
        cwd,
        &[
            "team",
            "add",
            "--slug",
            "sample",
            "--task",
            "verification",
            "--role",
            "verification",
            "--path",
            "tests",
            "--access",
            "write",
            "--deliverable",
            "Independent verification",
            "--acceptance",
            "Expected output remains correct",
            "--check",
            "c1",
        ],
    )
    .env("GDM_TEST_JOURNAL_FAILPOINT", "after-anchor-rename")
    .output()
    .unwrap();
    assert_eq!(
        crashed.status.code(),
        Some(86),
        "{}",
        String::from_utf8_lossy(&crashed.stderr)
    );
    let recovered = team_json(cwd, "status");
    assert_eq!(recovered["taskCount"], 2);
    let pending = recovered["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == "verification")
        .unwrap();
    assert_eq!(pending["status"], "pending");
    assert_eq!(recovered["accepted"], 1);
    done_denied(cwd);
}

#[test]
fn simultaneous_overlapping_claims_allow_exactly_one_worker() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "parent", "src", "write", None);
    add(cwd, "child", "src/component.rs", "write", None);
    let barrier = Barrier::new(3);
    let outputs = thread::scope(|scope| {
        let parent = scope.spawn(|| {
            barrier.wait();
            cli(
                cwd,
                &[
                    "team",
                    "claim",
                    "--slug",
                    "sample",
                    "--task",
                    "parent",
                    "--assignee",
                    "worker-parent",
                    "--attempt",
                    "parent-1",
                ],
            )
        });
        let child = scope.spawn(|| {
            barrier.wait();
            cli(
                cwd,
                &[
                    "team",
                    "claim",
                    "--slug",
                    "sample",
                    "--task",
                    "child",
                    "--assignee",
                    "worker-child",
                    "--attempt",
                    "child-1",
                ],
            )
        });
        barrier.wait();
        [parent.join().unwrap(), child.join().unwrap()]
    });
    assert_eq!(
        outputs
            .iter()
            .filter(|output| output.status.success())
            .count(),
        1
    );
    let denied = outputs
        .iter()
        .find(|output| !output.status.success())
        .unwrap();
    assert!(
        String::from_utf8_lossy(&denied.stderr).contains("team_scope_conflict"),
        "{}",
        String::from_utf8_lossy(&denied.stderr)
    );
    let status = team_json(cwd, "status");
    assert_eq!(status["active"], 1);
    assert_eq!(
        status["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|task| task["status"] == "active")
            .count(),
        1
    );
}

fn tamper_artifact(cwd: &Path, change: &str) {
    let artifact = cwd.join("artifacts/result.txt");
    match change {
        "deleted" => fs::remove_file(artifact).unwrap(),
        "modified" => fs::write(artifact, "Unreviewed replacement\n").unwrap(),
        "symlink" => {
            fs::rename(&artifact, cwd.join("artifacts/target.txt")).unwrap();
            symlink("target.txt", artifact).unwrap();
        }
        _ => unreachable!(),
    }
}

#[test]
fn artifact_deletion_modification_and_symlinks_block_review() {
    for change in ["deleted", "modified", "symlink"] {
        let temp = setup();
        let cwd = temp.path();
        configure(cwd, "3");
        add(cwd, "implementation", "src", "write", None);
        claim(cwd, "implementation", "attempt-1");
        report(cwd, "implementation", "attempt-1", "completed");
        pass(cwd);
        tamper_artifact(cwd, change);
        team_denied(
            cwd,
            &[
                "review",
                "--task",
                "implementation",
                "--attempt",
                "attempt-1",
                "--decision",
                "accept",
                "--reason",
                "Artifact must remain intact",
            ],
        );
        done_denied(cwd);
    }
}

#[test]
fn accepted_artifacts_are_revalidated_before_completion_and_export() {
    for change in ["deleted", "modified", "symlink"] {
        let temp = setup();
        let cwd = temp.path();
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(cwd)
                .status()
                .unwrap()
                .success()
        );
        configure(cwd, "3");
        add(cwd, "implementation", "src", "write", None);
        claim(cwd, "implementation", "attempt-1");
        report(cwd, "implementation", "attempt-1", "completed");
        pass(cwd);
        accept(cwd, "implementation", "attempt-1");
        success(cwd, &["protocol", "export", "--slug", "sample"]);
        tamper_artifact(cwd, change);
        done_denied(cwd);
        denied(cwd, &["protocol", "export", "--slug", "sample"]);
    }
}

#[test]
fn check_definition_changes_require_new_acceptance_but_rechecks_preserve_it() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    report(cwd, "implementation", "attempt-1", "completed");
    pass(cwd);
    accept(cwd, "implementation", "attempt-1");
    recheck(cwd);
    assert_eq!(team_json(cwd, "status")["accepted"], 1);

    success(
        cwd,
        &[
            "plan",
            "edit",
            "--slug",
            "sample",
            "--check",
            "c1",
            "--cmd",
            "cmp expected.txt actual.txt && test -s actual.txt",
            "--expect",
            "Matching nonempty files",
            "--reason",
            "Require a nonempty result in addition to matching output",
        ],
    );
    pass(cwd);
    assert_eq!(team_json(cwd, "status")["accepted"], 0);
    assert!(has_action(cwd, "review", "implementation"));
    assert!(denied(cwd, &["done", "--slug", "sample"]).contains("team_acceptance_stale"));
    accept(cwd, "implementation", "attempt-1");
    recheck(cwd);
    assert_eq!(team_json(cwd, "status")["accepted"], 1);
    success(cwd, &["done", "--slug", "sample"]);
}

#[test]
fn forged_completion_with_unfinished_tasks_is_rejected_when_loading() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    pass(cwd);
    let path = cwd.join(".gdm/sample/checks.json");
    let mut work: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    work["done"] = json!(true);
    work["doneAt"] = work["createdAt"].clone();
    fs::write(path, serde_json::to_vec_pretty(&work).unwrap()).unwrap();
    team_denied(cwd, &["status", "--json"]);
    denied(cwd, &["protocol", "export", "--slug", "sample"]);
}

#[test]
fn single_mode_requires_reason_and_cannot_hide_unfinished_coordinated_work() {
    let temp = setup();
    let cwd = temp.path();
    team_denied(cwd, &["configure", "--mode", "single"]);
    team_denied(cwd, &["configure", "--mode", "single", "--reason", "   "]);
    team(
        cwd,
        &[
            "configure",
            "--mode",
            "single",
            "--reason",
            "One tightly coupled task",
        ],
    );
    pass(cwd);
    success(cwd, &["done", "--slug", "sample"]);

    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    team_denied(
        cwd,
        &[
            "configure",
            "--mode",
            "single",
            "--reason",
            "Skip pending work",
        ],
    );
    claim(cwd, "implementation", "attempt-1");
    team_denied(
        cwd,
        &[
            "configure",
            "--mode",
            "single",
            "--reason",
            "Skip running work",
        ],
    );
    report(cwd, "implementation", "attempt-1", "failed");
    team_denied(
        cwd,
        &[
            "configure",
            "--mode",
            "single",
            "--reason",
            "Skip failed work",
        ],
    );
    pass(cwd);
    done_denied(cwd);
}

#[test]
fn invalid_paths_dependencies_checks_and_attempt_transitions_are_rejected() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    for path in ["../outside", "/absolute", "src/../outside", ".gdm/sample"] {
        team_denied(
            cwd,
            &[
                "add",
                "--task",
                "invalid",
                "--role",
                "implementation",
                "--path",
                path,
                "--access",
                "write",
                "--deliverable",
                "Result",
                "--acceptance",
                "Verified",
                "--check",
                "c1",
            ],
        );
    }
    for (id, dependency) in [("unknown", "missing"), ("self", "self")] {
        team_denied(
            cwd,
            &[
                "add",
                "--task",
                id,
                "--role",
                "implementation",
                "--path",
                "src",
                "--access",
                "write",
                "--deliverable",
                "Result",
                "--acceptance",
                "Verified",
                "--check",
                "c1",
                "--depends-on",
                dependency,
            ],
        );
    }
    team_denied(
        cwd,
        &[
            "add",
            "--task",
            "invalid-check",
            "--role",
            "implementation",
            "--path",
            "src",
            "--access",
            "write",
            "--deliverable",
            "Result",
            "--acceptance",
            "Verified",
            "--check",
            "c999",
        ],
    );
    add(cwd, "implementation", "src", "write", None);
    team_denied(
        cwd,
        &report_args(
            "implementation",
            "attempt-1",
            "completed",
            "Cannot report before claim",
        ),
    );
    team_denied(
        cwd,
        &[
            "review",
            "--task",
            "implementation",
            "--attempt",
            "attempt-1",
            "--decision",
            "accept",
            "--reason",
            "Cannot accept pending work",
        ],
    );
    claim(cwd, "implementation", "attempt-1");
    team_denied(
        cwd,
        &[
            "claim",
            "--task",
            "implementation",
            "--assignee",
            "another-worker",
            "--attempt",
            "attempt-2",
        ],
    );
    team_denied(
        cwd,
        &[
            "retry",
            "--task",
            "implementation",
            "--attempt",
            "attempt-1",
            "--reason",
            "Cannot replace an active worker",
        ],
    );
    team_denied(
        cwd,
        &report_args(
            "implementation",
            "unknown-attempt",
            "completed",
            "Unknown attempt",
        ),
    );
}

#[test]
fn invalid_report_metrics_leave_no_archive_and_corrected_result_can_report() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    let before = fs::read(cwd.join(".gdm/sample/checks.json")).unwrap();
    let mut options = report_args(
        "implementation",
        "attempt-1",
        "completed",
        "Ready for review",
    );
    options[12] = "invalid";
    assert!(team_denied(cwd, &options).contains("usage"));
    assert_eq!(
        before,
        fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()
    );
    assert!(
        !fs::read_dir(cwd.join(".gdm/sample/out")).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("team-"))
    );
    fs::write(cwd.join("artifacts/result.txt"), "Corrected result\n").unwrap();
    report(cwd, "implementation", "attempt-1", "completed");
    pass(cwd);
    accept(cwd, "implementation", "attempt-1");
}

#[test]
fn interrupted_archive_can_recover_but_committed_archive_cannot_be_rewritten() {
    use sha2::{Digest, Sha256};
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    let out = cwd.join(".gdm/sample/out");
    fs::create_dir_all(&out).unwrap();
    let identity = format!("{:x}", Sha256::digest(b"implementation\0attempt-1"));
    let archive = out.join(format!("team-{identity}.txt"));
    fs::write(&archive, "Uncommitted result before crash\n").unwrap();
    report(cwd, "implementation", "attempt-1", "completed");
    let committed = fs::read(&archive).unwrap();
    assert_eq!(
        committed,
        fs::read(cwd.join("artifacts/result.txt")).unwrap()
    );
    fs::write(
        cwd.join("artifacts/result.txt"),
        "Changed after commitment\n",
    )
    .unwrap();
    assert!(
        team_denied(
            cwd,
            &report_args(
                "implementation",
                "attempt-1",
                "completed",
                "Result is ready for review"
            )
        )
        .contains("team_report_conflict")
    );
    assert_eq!(committed, fs::read(&archive).unwrap());
}

#[test]
fn team_metadata_uses_export_privacy_validation_before_persistence() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    let before = fs::read(cwd.join(".gdm/sample/checks.json")).unwrap();
    let synthetic = ["gho_", "abcdefgh"].concat();
    assert!(
        team_denied(
            cwd,
            &report_args("implementation", "attempt-1", "completed", &synthetic)
        )
        .contains("privacy_rejected")
    );
    assert_eq!(
        before,
        fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()
    );
    assert!(
        !fs::read_dir(cwd.join(".gdm/sample/out")).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("team-"))
    );
    assert!(
        team_denied(
            cwd,
            &[
                "add",
                "--task",
                "second",
                "--role",
                "implementation",
                "--path",
                "other",
                "--access",
                "write",
                "--deliverable",
                &synthetic,
                "--acceptance",
                "Verified outcome",
                "--check",
                "c1"
            ]
        )
        .contains("privacy_rejected")
    );
    assert_eq!(
        before,
        fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()
    );
    report(cwd, "implementation", "attempt-1", "completed");
}

#[test]
fn incomplete_stale_work_can_be_exported_without_weakening_completion() {
    let temp = setup();
    let cwd = temp.path();
    assert!(
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(cwd)
            .status()
            .unwrap()
            .success()
    );
    configure(cwd, "3");
    add(cwd, "implementation", "src", "write", None);
    claim(cwd, "implementation", "attempt-1");
    report(cwd, "implementation", "attempt-1", "completed");
    pass(cwd);
    accept(cwd, "implementation", "attempt-1");
    success(
        cwd,
        &[
            "plan",
            "edit",
            "--slug",
            "sample",
            "--check",
            "c1",
            "--cmd",
            "cmp expected.txt actual.txt && test -s actual.txt",
            "--expect",
            "Matching nonempty files",
            "--reason",
            "Add nonempty verification",
        ],
    );
    let exported: Value =
        serde_json::from_str(&success(cwd, &["protocol", "export", "--slug", "sample"])).unwrap();
    assert_eq!(exported["completion"]["state"], "blocked");
    assert!(
        exported["completion"]["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["code"] == "team_acceptance_stale")
    );
    done_denied(cwd);
    pass(cwd);
    accept(cwd, "implementation", "attempt-1");
    let state: Value =
        serde_json::from_slice(&fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()).unwrap();
    let evidence = state["checks"][0]["evidence"]["observed"].as_str().unwrap();
    fs::write(cwd.join(evidence), "Changed evidence\n").unwrap();
    assert!(denied(cwd, &["protocol", "export", "--slug", "sample"]).contains("stale_evidence"));
}

#[test]
fn withdrawal_requires_current_cancelled_attempt_and_no_remaining_dependents() {
    let temp = setup();
    let cwd = temp.path();
    configure(cwd, "3");
    add(cwd, "upstream", "src", "write", None);
    add(cwd, "dependent", "docs", "write", Some("upstream"));
    let reason = "Requirement removed by the coordinator";
    assert!(
        team_denied(cwd, &["withdraw", "--task", "upstream", "--reason", reason])
            .contains("team_dependency")
    );
    team(
        cwd,
        &["withdraw", "--task", "dependent", "--reason", reason],
    );
    claim(cwd, "upstream", "upstream-a1");
    assert!(
        team_denied(
            cwd,
            &[
                "withdraw",
                "--task",
                "upstream",
                "--attempt",
                "upstream-a1",
                "--reason",
                reason
            ]
        )
        .contains("team_transition")
    );
    report(cwd, "upstream", "upstream-a1", "cancelled");
    assert!(
        team_denied(cwd, &["withdraw", "--task", "upstream", "--reason", reason])
            .contains("team_attempt_conflict")
    );
    assert!(
        team_denied(
            cwd,
            &[
                "withdraw",
                "--task",
                "upstream",
                "--attempt",
                "stale",
                "--reason",
                reason
            ]
        )
        .contains("team_attempt_conflict")
    );
    team(
        cwd,
        &[
            "withdraw",
            "--task",
            "upstream",
            "--attempt",
            "upstream-a1",
            "--reason",
            reason,
        ],
    );
    let state = team_json(cwd, "status");
    assert_eq!(state["withdrawn"], 2);
    assert_eq!(
        state["tasks"][0]["attempts"][0]["report"]["outcome"],
        "cancelled"
    );
    assert!(state["blockers"].as_array().unwrap().is_empty());
    team_denied(
        cwd,
        &[
            "review",
            "--task",
            "upstream",
            "--attempt",
            "upstream-a1",
            "--decision",
            "reject",
            "--reason",
            "Try to reactivate old work",
        ],
    );
    team_denied(
        cwd,
        &[
            "claim",
            "--task",
            "dependent",
            "--attempt",
            "new",
            "--assignee",
            "worker",
        ],
    );
    team_denied(
        cwd,
        &[
            "add",
            "--task",
            "third",
            "--role",
            "implementation",
            "--path",
            "third",
            "--access",
            "write",
            "--deliverable",
            "New task",
            "--acceptance",
            "Verified result",
            "--check",
            "c1",
            "--depends-on",
            "upstream",
        ],
    );
    pass(cwd);
    success(cwd, &["done", "--slug", "sample"]);
}

#[test]
fn identical_configuration_preserves_completed_work() {
    let temp = setup();
    let cwd = temp.path();
    team(
        cwd,
        &[
            "configure",
            "--mode",
            "single",
            "--reason",
            "One small sequential change",
        ],
    );
    pass(cwd);
    success(cwd, &["done", "--slug", "sample"]);
    let before = fs::read(cwd.join(".gdm/sample/checks.json")).unwrap();
    team(
        cwd,
        &[
            "configure",
            "--mode",
            "single",
            "--reason",
            "One small sequential change",
        ],
    );
    assert_eq!(
        before,
        fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()
    );
}

#[test]
fn changed_upstream_attempt_is_exportable_for_review_but_cannot_complete() {
    let temp = setup();
    let cwd = temp.path();
    assert!(
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(cwd)
            .status()
            .unwrap()
            .success()
    );
    configure(cwd, "3");
    add(cwd, "upstream", "src", "write", None);
    add(cwd, "downstream", "docs", "write", Some("upstream"));
    claim(cwd, "upstream", "a1");
    report(cwd, "upstream", "a1", "completed");
    pass(cwd);
    accept(cwd, "upstream", "a1");
    claim(cwd, "downstream", "b1");
    report(cwd, "downstream", "b1", "completed");
    accept(cwd, "downstream", "b1");
    team(
        cwd,
        &[
            "review",
            "--task",
            "upstream",
            "--attempt",
            "a1",
            "--decision",
            "reject",
            "--reason",
            "Review replacement implementation",
        ],
    );
    team(
        cwd,
        &[
            "retry",
            "--task",
            "upstream",
            "--attempt",
            "a1",
            "--reason",
            "Replace upstream implementation",
        ],
    );
    claim(cwd, "upstream", "a2");
    report(cwd, "upstream", "a2", "completed");
    accept(cwd, "upstream", "a2");
    let exported: Value =
        serde_json::from_str(&success(cwd, &["protocol", "export", "--slug", "sample"])).unwrap();
    assert_eq!(exported["completion"]["state"], "blocked");
    assert!(
        exported["completion"]["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["taskId"] == "downstream" && b["code"] == "team_acceptance_stale")
    );
    done_denied(cwd);
}
