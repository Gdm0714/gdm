use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::Path,
    process::{Command, Output},
};
use tempfile::TempDir;

fn cli(cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_gdm"))
        .args(["--language", "en"])
        .args(args)
        .current_dir(cwd)
        .env("GDM_NO_COLOR", "1")
        .output()
        .unwrap()
}
fn success(cwd: &Path, args: &[&str]) -> String {
    let output = cli(cwd, args);
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn json_result(cwd: &Path, args: &[&str]) -> Value {
    serde_json::from_str(&success(cwd, args)).unwrap()
}
fn setup() -> TempDir {
    let temp = tempfile::tempdir().unwrap();
    success(
        temp.path(),
        &[
            "plan",
            "init",
            "--slug",
            "sample",
            "--brief",
            "Regression workflow",
            "--require",
            "Preserve behavior",
        ],
    );
    success(
        temp.path(),
        &[
            "feedback",
            "--slug",
            "sample",
            "--value",
            "bad",
            "--reason",
            "Build diagnostics lost",
        ],
    );
    fs::create_dir(temp.path().join("fixtures")).unwrap();
    fs::write(temp.path().join("fixtures/input.txt"), "expected\n").unwrap();
    temp
}
fn candidates(cwd: &Path) -> Value {
    json_result(
        cwd,
        &["regression", "candidates", "--slug", "sample", "--json"],
    )
}
fn capture(cwd: &Path, name: &str, cmd: &str, timeout: &str) -> Value {
    let candidate = candidates(cwd)["candidates"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    json_result(
        cwd,
        &[
            "regression",
            "capture",
            "--slug",
            "sample",
            "--candidate",
            &candidate,
            "--case",
            name,
            "--fixture",
            "fixtures/input.txt",
            "--cmd",
            cmd,
            "--expect",
            "Expected result is preserved",
            "--timeout-ms",
            timeout,
        ],
    )
}
fn journal(cwd: &Path) -> Vec<Value> {
    fs::read_to_string(cwd.join(".gdm/sample/journal.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn candidates_include_feedback_and_misses_and_remain_stable_after_append() {
    let temp = setup();
    let cwd = temp.path();
    let first = candidates(cwd)["candidates"][0].clone();
    success(cwd, &["feedback", "--slug", "sample", "--value", "good"]);
    success(
        cwd,
        &["miss", "--slug", "sample", "--desc", "Missing tail error"],
    );
    let after = candidates(cwd);
    assert_eq!(after["candidates"][0], first);
    assert_eq!(after["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(after["candidates"][1]["kind"], "miss");
    let retro = json_result(cwd, &["retro", "--all", "--json"]);
    assert_eq!(retro["regressionCandidates"], after["candidates"]);
}

#[test]
fn capture_does_not_execute_and_frozen_input_can_compare_current_implementation() {
    let temp = setup();
    let cwd = temp.path();
    fs::write(cwd.join("actual.txt"), "wrong\n").unwrap();
    let command = "touch marker; cmp fixtures/input.txt \"$GDM_REGRESSION_PROJECT/actual.txt\"";
    let captured = capture(cwd, "diagnostics", command, "1000");
    assert_eq!(captured["commandExecuted"], false);
    assert!(!cwd.join("marker").exists());
    let before = fs::read(cwd.join(".gdm/sample/checks.json")).unwrap();
    let failed = cli(
        cwd,
        &[
            "regression",
            "replay",
            "--slug",
            "sample",
            "--case",
            "diagnostics",
        ],
    );
    assert!(!failed.status.success());
    let failure: Value = serde_json::from_slice(&failed.stdout).unwrap();
    assert_eq!(failure["passed"], false);
    assert!(failure["exitCode"].as_i64().unwrap() != 0);
    // Source fixture changes do not silently change the captured test input.
    fs::write(cwd.join("fixtures/input.txt"), "changed since capture\n").unwrap();
    fs::write(cwd.join("actual.txt"), "expected\n").unwrap();
    let passed = json_result(
        cwd,
        &[
            "regression",
            "replay",
            "--slug",
            "sample",
            "--case",
            "diagnostics",
            "--expected-case-sha256",
            captured["sha256"].as_str().unwrap(),
        ],
    );
    assert_eq!(passed["passed"], true);
    assert_ne!(failure["runId"], passed["runId"]);
    assert_eq!(failure["caseSha256"], passed["caseSha256"]);
    assert!(!cwd.join("marker").exists(), "Replay must use scratch cwd");
    assert_eq!(
        before,
        fs::read(cwd.join(".gdm/sample/checks.json")).unwrap()
    );
    let events = journal(cwd);
    assert_eq!(
        events
            .iter()
            .filter(|e| e["event"] == "regression.replay")
            .count(),
        2
    );
    assert_eq!(
        gdm::support::sha256(fs::read(cwd.join(passed["observed"].as_str().unwrap())).unwrap()),
        passed["outputSha256"]
    );
}

#[test]
fn captured_command_and_fixture_tampering_are_rejected_without_execution() {
    let temp = setup();
    let cwd = temp.path();
    capture(cwd, "frozen", "exit 0", "1000");
    let path = cwd.join(".gdm/sample/regressions/frozen.json");
    let bytes = fs::read(&path).unwrap();
    let mut case: Value = serde_json::from_slice(&bytes).unwrap();
    case["command"] = json!("touch \"$GDM_REGRESSION_PROJECT/unsafe-marker\"");
    fs::write(&path, serde_json::to_vec_pretty(&case).unwrap()).unwrap();
    let result = cli(
        cwd,
        &[
            "regression",
            "replay",
            "--slug",
            "sample",
            "--case",
            "frozen",
        ],
    );
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("artifact_changed"));
    assert!(!cwd.join("unsafe-marker").exists());
    case = serde_json::from_slice(&bytes).unwrap();
    case["fixtures"][0]["text"] = json!("tampered");
    fs::write(&path, serde_json::to_vec_pretty(&case).unwrap()).unwrap();
    assert!(
        !cli(
            cwd,
            &["regression", "show", "--slug", "sample", "--case", "frozen"]
        )
        .status
        .success()
    );
}

#[test]
fn invalid_candidate_duplicate_case_and_expected_digest_cannot_execute() {
    let temp = setup();
    let cwd = temp.path();
    let unknown = cli(
        cwd,
        &[
            "regression",
            "capture",
            "--slug",
            "sample",
            "--candidate",
            "reg-unknown",
            "--case",
            "unknown",
            "--fixture",
            "fixtures/input.txt",
            "--cmd",
            "exit 0",
            "--expect",
            "Pass",
        ],
    );
    assert!(!unknown.status.success());
    capture(
        cwd,
        "one",
        "touch \"$GDM_REGRESSION_PROJECT/marker\"",
        "1000",
    );
    let candidate = candidates(cwd)["candidates"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let duplicate = cli(
        cwd,
        &[
            "regression",
            "capture",
            "--slug",
            "sample",
            "--candidate",
            &candidate,
            "--case",
            "one",
            "--fixture",
            "fixtures/input.txt",
            "--cmd",
            "exit 0",
            "--expect",
            "Pass",
        ],
    );
    assert!(!duplicate.status.success());
    assert!(
        !cli(
            cwd,
            &[
                "regression",
                "replay",
                "--slug",
                "sample",
                "--case",
                "one",
                "--expected-case-sha256",
                "wrong"
            ]
        )
        .status
        .success()
    );
    assert!(!cwd.join("marker").exists());
}

#[test]
fn traversal_symlinks_and_credential_shaped_fixture_are_rejected() {
    let temp = setup();
    let cwd = temp.path();
    let candidate = candidates(cwd)["candidates"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    symlink(cwd.join("fixtures/input.txt"), cwd.join("linked.txt")).unwrap();
    symlink(cwd.join("fixtures"), cwd.join("linked-dir")).unwrap();
    fs::write(cwd.join("secret.txt"), "Bearer a-private-value").unwrap();
    for fixture in [
        "../input.txt",
        "linked.txt",
        "linked-dir/input.txt",
        ".gdm/sample/checks.json",
        "secret.txt",
    ] {
        let result = cli(
            cwd,
            &[
                "regression",
                "capture",
                "--slug",
                "sample",
                "--candidate",
                &candidate,
                "--case",
                "rejected",
                "--fixture",
                fixture,
                "--cmd",
                "exit 0",
                "--expect",
                "Pass",
            ],
        );
        assert!(!result.status.success(), "accepted {fixture}");
    }
    assert!(!cwd.join(".gdm/sample/regressions/rejected.json").exists());
}

#[test]
fn limits_and_timeout_produce_actionable_results() {
    let temp = setup();
    let cwd = temp.path();
    let candidate = candidates(cwd)["candidates"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fs::write(cwd.join("large.txt"), "x".repeat(128 * 1024 + 1)).unwrap();
    let oversized = cli(
        cwd,
        &[
            "regression",
            "capture",
            "--slug",
            "sample",
            "--candidate",
            &candidate,
            "--case",
            "large",
            "--fixture",
            "large.txt",
            "--cmd",
            "exit 0",
            "--expect",
            "Pass",
        ],
    );
    assert!(!oversized.status.success());
    capture(cwd, "timeout", "sleep 5", "100");
    let timed = cli(
        cwd,
        &[
            "regression",
            "replay",
            "--slug",
            "sample",
            "--case",
            "timeout",
        ],
    );
    assert!(!timed.status.success());
    let result: Value = serde_json::from_slice(&timed.stdout).unwrap();
    assert_eq!(result["passed"], false);
    assert!(result["error"].as_str().unwrap().contains("ETIMEDOUT"));
    assert!(cwd.join(result["observed"].as_str().unwrap()).is_file());
}

#[test]
fn state_directory_symlink_is_never_followed() {
    let temp = setup();
    let cwd = temp.path();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), cwd.join(".gdm/sample/regressions")).unwrap();
    let candidate = candidates(cwd)["candidates"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        !cli(
            cwd,
            &[
                "regression",
                "capture",
                "--slug",
                "sample",
                "--candidate",
                &candidate,
                "--case",
                "one",
                "--fixture",
                "fixtures/input.txt",
                "--cmd",
                "exit 0",
                "--expect",
                "Pass"
            ]
        )
        .status
        .success()
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[test]
fn replay_logs_are_bounded_but_retain_final_diagnostics() {
    let temp = setup();
    let cwd = temp.path();
    capture(
        cwd,
        "large-log",
        "head -c 1200000 /dev/zero | tr '\\0' x; printf '\\ntail diagnostic\\n'",
        "5000",
    );
    let result = json_result(
        cwd,
        &[
            "regression",
            "replay",
            "--slug",
            "sample",
            "--case",
            "large-log",
        ],
    );
    assert_eq!(result["passed"], true);
    assert_eq!(result["outputTruncated"], true);
    let output = fs::read_to_string(cwd.join(result["observed"].as_str().unwrap())).unwrap();
    assert!(output.len() < 1024 * 1024 + 100);
    assert!(output.ends_with("tail diagnostic\n"));
    assert!(output.contains("[Regression output truncated]"));
}
