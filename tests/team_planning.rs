use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
use tempfile::TempDir;

fn cli(cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_gdm"))
        .args(["--language", "en"])
        .args(args)
        .current_dir(cwd)
        .env("GDM_CONFIG_DIR", cwd.join("config"))
        .env("GDM_NO_COLOR", "1")
        .output()
        .unwrap()
}
fn ok(cwd: &Path, args: &[&str]) -> Value {
    let o = cli(cwd, args);
    assert!(
        o.status.success(),
        "{args:?}: {} {}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    serde_json::from_slice(&o.stdout).unwrap_or(Value::Null)
}
fn no(cwd: &Path, args: &[&str], code: &str) {
    let o = cli(cwd, args);
    assert!(!o.status.success(), "Unexpected success: {args:?}");
    assert!(
        String::from_utf8_lossy(&o.stderr).contains(code),
        "{args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
}
fn team(cwd: &Path, args: &[&str]) -> Value {
    ok(cwd, &[&["team"][..], args, &["--slug", "sample"]].concat())
}
fn denied(cwd: &Path, args: &[&str], code: &str) {
    no(
        cwd,
        &[&["team"][..], args, &["--slug", "sample"]].concat(),
        code,
    )
}
fn setup(uncertain: bool) -> TempDir {
    let t = tempfile::tempdir().unwrap();
    let mut args = vec![
        "plan",
        "init",
        "--slug",
        "sample",
        "--brief",
        "Deliver verified app behavior",
        "--require",
        "Correct outcomes",
    ];
    if uncertain {
        args.extend([
            "--uncertain",
            "External customer input format needs confirmation",
        ]);
    }
    ok(t.path(), &args);
    fs::write(t.path().join("result.txt"), "Verified role findings\n").unwrap();
    for (desc, cmd) in [
        ("Knowledge receipt exists", "test -s result.txt"),
        ("Implementation outcome checked", "test -s result.txt"),
        ("Independent product scenario checked", "test -s result.txt"),
    ] {
        ok(
            t.path(),
            &[
                "plan",
                "add",
                "--slug",
                "sample",
                "--desc",
                desc,
                "--cmd",
                cmd,
                "--expect",
                "Expected outcome observed",
                "--kind",
                "behavior",
            ],
        );
    }
    t
}
fn assignment(paths: &[&str], checks: &[&str]) -> Value {
    json!({"paths":paths,"checks":checks,"deliverable":"Reviewable scoped artifact","acceptance":"Evidence confirms required outcomes"})
}
fn spec(knowledge: bool) -> Value {
    let mut m = assignment(&["src/service.rs"], &["c2"]);
    m["id"] = json!("service");
    let mut s = json!({"schemaVersion":"gdm-team-plan/v1","executor":"native","maxActive":3,"modules":[m],"independentVerification":true,"verification":assignment(&["src/service.rs","tests"],&["c3"])});
    if knowledge {
        s["knowledge"] = assignment(&["docs/input.md"], &["c1"]);
    } else {
        s["modules"][0]["checks"] = json!(["c1", "c2"]);
    }
    s
}
fn write_spec(cwd: &Path, v: &Value) {
    fs::write(cwd.join("roles.json"), serde_json::to_vec(v).unwrap()).unwrap();
}
fn apply(cwd: &Path, v: &Value) -> Value {
    write_spec(cwd, v);
    team(cwd, &["auto", "--file", "roles.json"])
}
fn claim(cwd: &Path, id: &str, assignee: &str, attempt: &str) {
    team(
        cwd,
        &[
            "claim",
            "--task",
            id,
            "--assignee",
            assignee,
            "--attempt",
            attempt,
        ],
    );
}
fn accept(cwd: &Path, id: &str, attempt: &str, check: &str) {
    team(
        cwd,
        &[
            "report",
            "--task",
            id,
            "--attempt",
            attempt,
            "--outcome",
            "completed",
            "--summary",
            "Role completed with evidence",
            "--artifact",
            "result.txt",
        ],
    );
    let work = ok(cwd, &["plan", "list", "--slug", "sample", "--json"]);
    let proven = work["checks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == check && c["status"] == "proven");
    if proven {
        ok(cwd, &["recheck", "--check", check, "--slug", "sample"]);
    } else {
        ok(cwd, &["pass", check, "--slug", "sample"]);
    }
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
            "Evidence confirms expected product behavior",
        ],
    );
}
fn dispatches(cwd: &Path) -> Vec<String> {
    team(cwd, &["next"])["actions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["action"] == "dispatch")
        .map(|v| v["taskId"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn complex_work_allocates_knowledge_implementation_and_independent_verification() {
    let t = setup(true);
    let p = t.path();
    let mut s = spec(true);
    s["maxActive"] = json!(32);
    let out = apply(p, &s);
    assert_eq!(out["maxActive"], 32);
    assert_eq!(
        out["allocation"]["requiredRoles"],
        json!(["knowledge", "implementation", "verification"])
    );
    assert_eq!(out["automaticExecution"], false);
    assert_eq!(dispatches(p), vec!["knowledge"]);
    assert_eq!(out["tasks"][1]["dependsOn"], json!(["knowledge"]));
    assert_eq!(
        out["tasks"][2]["dependsOn"],
        json!(["knowledge", "implement-service"])
    );
    denied(
        p,
        &[
            "claim",
            "--task",
            "implement-service",
            "--assignee",
            "builder",
            "--attempt",
            "early",
        ],
        "team_dependency",
    );
    claim(p, "knowledge", "researcher", "k1");
    accept(p, "knowledge", "k1", "c1");
    claim(p, "implement-service", "builder", "i1");
    accept(p, "implement-service", "i1", "c2");
    denied(
        p,
        &[
            "claim",
            "--task",
            "verify",
            "--assignee",
            "builder",
            "--attempt",
            "bad",
        ],
        "team_verifier_conflict",
    );
    claim(p, "verify", "tester", "v1");
    accept(p, "verify", "v1", "c3");
    assert!(
        team(p, &["status"])["blockers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    ok(p, &["done", "--slug", "sample"]);
}
#[test]
fn dry_run_and_identical_replan_do_not_start_or_reset_workers() {
    let t = setup(true);
    let p = t.path();
    write_spec(p, &spec(true));
    let preview = team(p, &["auto", "--file", "roles.json", "--dry-run"]);
    assert_eq!(preview["dryRun"], true);
    assert!(team(p, &["status"]).is_null());
    apply(p, &spec(true));
    claim(p, "knowledge", "researcher", "k1");
    let before = fs::read(p.join(".gdm/sample/checks.json")).unwrap();
    assert_eq!(apply(p, &spec(true))["unchanged"], true);
    assert_eq!(before, fs::read(p.join(".gdm/sample/checks.json")).unwrap());
    let mut changed = spec(true);
    changed["maxActive"] = json!(2);
    write_spec(p, &changed);
    denied(p, &["auto", "--file", "roles.json"], "team_replan_conflict");
}
#[test]
fn low_risk_single_module_is_reasoned_lightweight_execution() {
    let t = setup(false);
    let p = t.path();
    let mut s = spec(false);
    s["maxActive"] = json!(32);
    s.as_object_mut().unwrap().remove("verification");
    s["independentVerification"] = json!(false);
    s["modules"][0]["checks"] = json!(["c1", "c2", "c3"]);
    let out = apply(p, &s);
    assert_eq!(out["mode"], "single");
    assert_eq!(out["maxActive"], 1);
    assert_eq!(out["tasks"], json!([]));
    assert_eq!(out["allocation"]["strategy"], "single");
    assert_eq!(team(p, &["next"])["actions"][0]["action"], "validate");
}
#[test]
fn missing_knowledge_test_role_and_unassigned_checks_are_rejected() {
    let t = setup(true);
    let p = t.path();
    write_spec(p, &spec(false));
    denied(
        p,
        &["auto", "--file", "roles.json"],
        "team_knowledge_required",
    );
    let mut s = spec(true);
    s.as_object_mut().unwrap().remove("verification");
    write_spec(p, &s);
    denied(
        p,
        &["auto", "--file", "roles.json"],
        "team_verification_required",
    );
    s = spec(true);
    s["verification"]["checks"] = json!(["c2"]);
    write_spec(p, &s);
    denied(
        p,
        &["auto", "--file", "roles.json"],
        "team_check_unassigned",
    );
}
#[test]
fn foundation_can_progress_with_knowledge_under_shared_capacity() {
    let t = setup(true);
    let p = t.path();
    let mut s = spec(true);
    s["modules"][0]["knowledgeIndependentReason"] =
        json!("Transport foundation does not depend on unresolved business input");
    s["maxActive"] = json!(2);
    apply(p, &s);
    assert_eq!(dispatches(p), vec!["knowledge", "implement-service"]);
    claim(p, "knowledge", "researcher", "k1");
    claim(p, "implement-service", "builder", "i1");
    assert_eq!(team(p, &["status"])["active"], 2);
    denied(
        p,
        &["configure", "--mode", "coordinated", "--max-active", "1"],
        "team_active_limit",
    );
}
#[test]
fn ownership_conflicts_serialize_even_independent_foundation() {
    let t = setup(true);
    let p = t.path();
    let mut s = spec(true);
    s["maxActive"] = json!(8);
    s["knowledge"]["paths"] = json!(["src"]);
    s["modules"][0]["knowledgeIndependentReason"] =
        json!("Foundation is logically separate but shares source path");
    apply(p, &s);
    assert_eq!(dispatches(p), vec!["knowledge"]);
    claim(p, "knowledge", "researcher", "k1");
    denied(
        p,
        &[
            "claim",
            "--task",
            "implement-service",
            "--assignee",
            "builder",
            "--attempt",
            "i1",
        ],
        "team_scope_conflict",
    );
}
#[test]
fn unavailable_executor_blocks_complex_work_without_pretending_to_dispatch() {
    let t = setup(true);
    let p = t.path();
    let mut s = spec(true);
    s["executor"] = json!("unavailable");
    apply(p, &s);
    assert_eq!(team(p, &["next"])["actions"][0]["action"], "blocked");
    denied(
        p,
        &[
            "claim",
            "--task",
            "knowledge",
            "--assignee",
            "researcher",
            "--attempt",
            "k1",
        ],
        "team_executor_unavailable",
    );
    no(
        p,
        &["done", "--slug", "sample"],
        "team_executor_unavailable",
    );
    s["executor"] = json!("native");
    apply(p, &s);
    assert_eq!(dispatches(p), vec!["knowledge"]);
}
#[test]
fn required_roles_cannot_be_withdrawn_or_replaced_to_skip_testing() {
    let t = setup(true);
    let p = t.path();
    apply(p, &spec(true));
    denied(
        p,
        &[
            "withdraw",
            "--task",
            "verify",
            "--reason",
            "Skip independent test to save available time",
        ],
        "team_allocation_locked",
    );
    denied(
        p,
        &[
            "add",
            "--task",
            "verify",
            "--role",
            "implementation",
            "--path",
            "src",
            "--access",
            "write",
            "--deliverable",
            "Alternate role",
            "--acceptance",
            "Results reviewed",
            "--check",
            "c3",
        ],
        "team_allocation_locked",
    );
    let state_path = p.join(".gdm/sample/checks.json");
    let mut w: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    w["team"]["tasks"].as_array_mut().unwrap().pop();
    fs::write(state_path, serde_json::to_vec(&w).unwrap()).unwrap();
    denied(p, &["status"], "state_corrupt");
}
#[test]
fn changed_requirement_inputs_block_dispatch_until_unstarted_replan() {
    let t = setup(true);
    let p = t.path();
    apply(p, &spec(true));
    ok(
        p,
        &[
            "plan",
            "add",
            "--slug",
            "sample",
            "--desc",
            "Additional acceptance scenario",
            "--cmd",
            "test -s result.txt",
            "--expect",
            "Expected behavior",
            "--kind",
            "behavior",
        ],
    );
    assert_eq!(team(p, &["next"])["actions"][0]["action"], "blocked");
    denied(
        p,
        &[
            "claim",
            "--task",
            "knowledge",
            "--assignee",
            "researcher",
            "--attempt",
            "k1",
        ],
        "team_allocation_stale",
    );
    let mut s = spec(true);
    s["verification"]["checks"] = json!(["c3", "c4"]);
    apply(p, &s);
    assert_eq!(dispatches(p), vec!["knowledge"]);
}
#[test]
fn knowledge_result_drift_prevents_downstream_claim() {
    let t = setup(true);
    let p = t.path();
    apply(p, &spec(true));
    claim(p, "knowledge", "researcher", "k1");
    accept(p, "knowledge", "k1", "c1");
    fs::write(p.join("result.txt"), "Changed policy after acceptance\n").unwrap();
    denied(
        p,
        &[
            "claim",
            "--task",
            "implement-service",
            "--assignee",
            "builder",
            "--attempt",
            "i1",
        ],
        "team_artifact_changed",
    );
    assert!(dispatches(p).is_empty());
}
#[test]
fn two_modules_without_uncertainty_still_get_independent_test_role() {
    let t = setup(false);
    let p = t.path();
    let mut s = spec(false);
    s["independentVerification"] = json!(false);
    let mut second = assignment(&["src/ui.rs"], &["c2"]);
    second["id"] = json!("ui");
    s["modules"].as_array_mut().unwrap().push(second);
    s["maxActive"] = json!(1);
    let out = apply(p, &s);
    assert_eq!(
        out["allocation"]["requiredRoles"],
        json!(["implementation", "verification"])
    );
    assert_eq!(dispatches(p), vec!["implement-service"]);
    claim(p, "implement-service", "builder", "i1");
    denied(
        p,
        &[
            "claim",
            "--task",
            "implement-ui",
            "--assignee",
            "other",
            "--attempt",
            "i2",
        ],
        "team_active_limit",
    );
}
#[test]
fn larger_auto_budget_dispatches_eight_modules_without_bypassing_verification() {
    let t = setup(false);
    let p = t.path();
    let mut s = spec(false);
    s["maxActive"] = json!(8);
    s["modules"] = json!(
        (0..9)
            .map(|i| {
                let mut module = assignment(&[&format!("src/module-{i}.rs")], &["c1", "c2"]);
                module["id"] = json!(format!("module-{i}"));
                module
            })
            .collect::<Vec<_>>()
    );
    let out = apply(p, &s);
    assert_eq!(out["maxActive"], 8);
    assert_eq!(out["taskCount"], 10);
    assert_eq!(
        dispatches(p),
        (0..8)
            .map(|i| format!("implement-module-{i}"))
            .collect::<Vec<_>>()
    );
    for i in 0..8 {
        claim(
            p,
            &format!("implement-module-{i}"),
            &format!("builder-{i}"),
            &format!("i-{i}"),
        );
    }
    assert_eq!(team(p, &["status"])["active"], 8);
    assert!(dispatches(p).is_empty());
    denied(
        p,
        &[
            "claim",
            "--task",
            "implement-module-8",
            "--assignee",
            "builder-8",
            "--attempt",
            "i-8",
        ],
        "team_active_limit",
    );
    denied(
        p,
        &[
            "claim",
            "--task",
            "verify",
            "--assignee",
            "tester",
            "--attempt",
            "v1",
        ],
        "team_dependency",
    );
    denied(
        p,
        &[
            "claim",
            "--task",
            "verify",
            "--assignee",
            "builder-0",
            "--attempt",
            "v2",
        ],
        "team_verifier_conflict",
    );
}

#[test]
fn bounded_spec_and_existing_scope_are_enforced() {
    let t = setup(true);
    let p = t.path();
    let mut s = spec(true);
    for cap in [0, 33] {
        s["maxActive"] = json!(cap);
        write_spec(p, &s);
        denied(p, &["auto", "--file", "roles.json"], "team_plan_invalid");
    }
    s = spec(true);
    s["knowledge"]["paths"] = json!(["../escape"]);
    write_spec(p, &s);
    denied(p, &["auto", "--file", "roles.json"], "team_plan_invalid");
    s = spec(true);
    s["modules"][0]["knowledgeIndependentReason"] = json!("fast");
    write_spec(p, &s);
    denied(p, &["auto", "--file", "roles.json"], "team_plan_invalid");
}

#[test]
fn late_knowledge_replan_preserves_history_and_requires_fresh_role_acceptance() {
    let t = setup(true);
    let p = t.path();
    apply(p, &spec(true));
    claim(p, "knowledge", "researcher", "k1");
    accept(p, "knowledge", "k1", "c1");
    claim(p, "implement-service", "builder", "i1");
    accept(p, "implement-service", "i1", "c2");
    ok(
        p,
        &[
            "plan",
            "add",
            "--slug",
            "sample",
            "--desc",
            "Late discovered identity contract",
            "--cmd",
            "test -s result.txt",
            "--expect",
            "Original identity accepted",
            "--kind",
            "behavior",
        ],
    );
    assert_eq!(team(p, &["next"])["actions"][0]["action"], "blocked");
    let mut s = spec(true);
    s["verification"]["checks"] = json!(["c3", "c4"]);
    write_spec(p, &s);
    denied(p, &["auto", "--file", "roles.json"], "team_replan_conflict");
    let before = fs::read(p.join(".gdm/sample/checks.json")).unwrap();
    let preview = team(
        p,
        &[
            "auto",
            "--file",
            "roles.json",
            "--replan",
            "--reason",
            "New interview evidence requires identity scenario",
            "--dry-run",
        ],
    );
    assert_eq!(preview["allocation"]["historyCount"], 1);
    assert_eq!(before, fs::read(p.join(".gdm/sample/checks.json")).unwrap());
    let out = team(
        p,
        &[
            "auto",
            "--file",
            "roles.json",
            "--replan",
            "--reason",
            "New interview evidence requires identity scenario",
        ],
    );
    assert_eq!(out["accepted"], 0);
    assert_eq!(out["allocation"]["historyCount"], 1);
    assert_eq!(dispatches(p), vec!["knowledge"]);
    denied(
        p,
        &[
            "claim",
            "--task",
            "knowledge",
            "--assignee",
            "researcher",
            "--attempt",
            "k1",
        ],
        "team_attempt_conflict",
    );
    claim(p, "knowledge", "researcher", "k2");
    accept(p, "knowledge", "k2", "c1");
    claim(p, "implement-service", "new-builder", "i2");
    accept(p, "implement-service", "i2", "c2");
    denied(
        p,
        &[
            "claim",
            "--task",
            "verify",
            "--assignee",
            "builder",
            "--attempt",
            "v2",
        ],
        "team_verifier_conflict",
    );
    claim(p, "verify", "tester", "v2");
    ok(p, &["pass", "c4", "--slug", "sample"]);
    accept(p, "verify", "v2", "c3");
    ok(p, &["done", "--slug", "sample"]);
}
#[test]
fn explicit_replan_cannot_discard_active_or_unreviewed_workers() {
    let t = setup(true);
    let p = t.path();
    apply(p, &spec(true));
    claim(p, "knowledge", "researcher", "k1");
    let mut s = spec(true);
    s["maxActive"] = json!(2);
    write_spec(p, &s);
    let args = [
        "auto",
        "--file",
        "roles.json",
        "--replan",
        "--reason",
        "Update bounded concurrency after host capability change",
    ];
    denied(p, &args, "team_replan_conflict");
    team(
        p,
        &[
            "report",
            "--task",
            "knowledge",
            "--attempt",
            "k1",
            "--outcome",
            "completed",
            "--summary",
            "Knowledge collection finished",
            "--artifact",
            "result.txt",
        ],
    );
    denied(p, &args, "team_replan_conflict");
    ok(p, &["pass", "c1", "--slug", "sample"]);
    team(
        p,
        &[
            "review",
            "--task",
            "knowledge",
            "--attempt",
            "k1",
            "--decision",
            "accept",
            "--reason",
            "Evidence confirms discovered source facts",
        ],
    );
    team(p, &args);
}
#[test]
fn replan_archives_are_checked_before_future_dispatch_and_claims() {
    let t = setup(true);
    let p = t.path();
    apply(p, &spec(true));
    claim(p, "knowledge", "researcher", "k1");
    accept(p, "knowledge", "k1", "c1");
    let mut s = spec(true);
    s["maxActive"] = json!(2);
    write_spec(p, &s);
    team(
        p,
        &[
            "auto",
            "--file",
            "roles.json",
            "--replan",
            "--reason",
            "Update host concurrency after knowledge acceptance",
        ],
    );
    let w: Value =
        serde_json::from_slice(&fs::read(p.join(".gdm/sample/checks.json")).unwrap()).unwrap();
    let archive = w["team"]["allocationHistory"][0]["artifact"]["path"]
        .as_str()
        .unwrap();
    let old: Value = serde_json::from_slice(&fs::read(p.join(archive)).unwrap()).unwrap();
    assert_eq!(old["team"]["tasks"][0]["status"], "accepted");
    fs::write(p.join(archive), "Changed historical evidence\n").unwrap();
    assert_eq!(team(p, &["next"])["actions"][0]["action"], "blocked");
    denied(
        p,
        &[
            "claim",
            "--task",
            "knowledge",
            "--assignee",
            "researcher",
            "--attempt",
            "k2",
        ],
        "team_history_changed",
    );
}

#[test]
fn medium_risk_and_explicit_verification_do_not_silently_fall_back_to_single() {
    let t = setup(false);
    let p = t.path();
    let mut s = spec(false);
    s["independentVerification"] = json!(false);
    assert_eq!(apply(p, &s)["mode"], "coordinated");
    let state_path = p.join(".gdm/sample/checks.json");
    let mut w: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    w["contract"]["risk"] = json!("medium");
    fs::write(state_path, serde_json::to_vec(&w).unwrap()).unwrap();
    s.as_object_mut().unwrap().remove("verification");
    s["modules"][0]["checks"] = json!(["c1", "c2", "c3"]);
    write_spec(p, &s);
    denied(
        p,
        &["auto", "--file", "roles.json"],
        "team_verification_required",
    );
}
