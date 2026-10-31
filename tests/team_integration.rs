use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn run(root: &Path, args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_gdm"))
        .args(["--language", "en"])
        .args(args)
        .current_dir(root)
        .env("CODEX_HOME", root.join("home"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
}
fn init(root: &Path, session: &str) {
    run(
        root,
        &[
            "plan",
            "init",
            "--slug",
            "work",
            "--brief",
            "team integration",
            "--require",
            "verified results",
        ],
    );
    run(
        root,
        &[
            "plan",
            "add",
            "--slug",
            "work",
            "--desc",
            "result exists",
            "--cmd",
            "test -s result.md",
            "--expect",
            "result exists",
        ],
    );
    run(
        root,
        &[
            "team",
            "configure",
            "--slug",
            "work",
            "--mode",
            "coordinated",
            "--session",
            session,
        ],
    );
}
fn hook(root: &Path, session: &str, continued: bool) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gdm"))
        .args(["agent", "hook"])
        .current_dir(root)
        .env("CODEX_HOME", root.join("home"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            serde_json::to_string(&json!({
                "hook_event_name":"Stop", "session_id":session, "stop_hook_active":continued
            }))
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn stop_reconciles_only_bound_work_and_limits_continuation() {
    let temp = tempfile::tempdir().unwrap();
    init(temp.path(), "root-one");
    let blocked = hook(temp.path(), "root-one", false);
    assert_eq!(blocked["decision"], "block");
    assert!(
        blocked["reason"]
            .as_str()
            .unwrap()
            .contains("gdm team next --slug work")
    );
    assert!(
        hook(temp.path(), "root-two", false)
            .get("decision")
            .is_none()
    );
    let continued = hook(temp.path(), "root-one", true);
    assert!(continued.get("decision").is_none());
    assert!(
        continued["systemMessage"]
            .as_str()
            .unwrap()
            .contains("continued once")
    );
}

#[test]
fn protocol_carries_tasks_and_changes_fingerprint_without_touching_legacy_state() {
    let temp = tempfile::tempdir().unwrap();
    assert!(
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(temp.path())
            .status()
            .unwrap()
            .success()
    );
    run(
        temp.path(),
        &[
            "plan",
            "init",
            "--slug",
            "work",
            "--brief",
            "snapshot",
            "--require",
            "verified",
        ],
    );
    let before = run(temp.path(), &["protocol", "export", "--slug", "work"]);
    assert!(before.get("team").is_none());
    run(
        temp.path(),
        &[
            "team",
            "configure",
            "--slug",
            "work",
            "--mode",
            "coordinated",
        ],
    );
    let after = run(temp.path(), &["protocol", "export", "--slug", "work"]);
    assert_eq!(after["team"]["mode"], "coordinated");
    assert_ne!(
        before["work"]["stateFingerprint"],
        after["work"]["stateFingerprint"]
    );
    assert_eq!(
        before["work"]["planFingerprint"],
        after["work"]["planFingerprint"]
    );
    assert_eq!(after["completion"]["state"], "blocked");
    let resume = run(temp.path(), &["resume", "--slug", "work", "--json"]);
    assert_eq!(resume["work"]["team"], after["team"]);
    assert!(
        fs::read_to_string(temp.path().join(".gdm/work/work.md"))
            .unwrap()
            .contains("gdm team next --slug work")
    );
}

#[test]
fn native_skill_bundles_remain_verifiable_for_all_providers() {
    let temp = tempfile::tempdir().unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut manifests = Vec::new();
    for target in ["codex", "claude", "gid"] {
        let output = temp.path().join(target);
        run(
            repo,
            &[
                "render-skills",
                "--target",
                target,
                "--source-root",
                repo.join("skills").to_str().unwrap(),
                "--agents-root",
                repo.join("agents").to_str().unwrap(),
                "--output",
                output.to_str().unwrap(),
            ],
        );
        manifests.push(output.join("gdm-target-manifest.json"));
    }
    run(
        repo,
        &[
            "verify-manifests",
            manifests[0].to_str().unwrap(),
            manifests[1].to_str().unwrap(),
            manifests[2].to_str().unwrap(),
        ],
    );
}
