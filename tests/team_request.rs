use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    provider: PathBuf,
    config: PathBuf,
}
impl Fixture {
    fn new(uncertain: bool, checks: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        let provider = temp.path().join("provider");
        let config = temp.path().join("config");
        for path in [
            &root,
            &provider,
            &root.join("src"),
            &root.join("docs"),
            &root.join("tests"),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(root.join("src/transport.rs"), "PRIVATE_SOURCE_SENTINEL\n").unwrap();
        fs::write(root.join("src/service.rs"), "service source\n").unwrap();
        fs::write(
            root.join("docs/policy.md"),
            "Observed customer policy context\n",
        )
        .unwrap();
        fs::write(root.join("tests/scenario.rs"), "scenario test\n").unwrap();
        fs::write(provider.join("claude"),r#"#!/bin/sh
set -eu
fixture=$(dirname "$0")
if [ "${1:-}" = "--version" ]; then printf 'fake-claude/1.0\n'; exit 0; fi
printf x >> "$fixture/invocations"
printf '%s\n' "$@" > "$fixture/argv"
cat > "$fixture/input"
if test -f "$fixture/race"; then
  (cd "$GDM_TEST_CWD"; "$GDM_TEST_BINARY" --language en plan add --slug sample --desc 'Concurrent requirement' --cmd true --expect 'Expected outcome' >/dev/null)
fi
if test -f "$fixture/source-race"; then printf 'changed source\n' > "$GDM_TEST_CWD/src/service.rs"; fi
cat "$fixture/response"
"#).unwrap();
        fs::set_permissions(provider.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
        let fixture = Self {
            _temp: temp,
            root,
            provider,
            config,
        };
        let mut args = vec![
            "plan",
            "init",
            "--slug",
            "sample",
            "--brief",
            "Interpret customer intake rules, build transport before business behavior, then independently verify the outcomes",
            "--require",
            "Correct customer outcomes",
        ];
        if uncertain {
            args.extend(["--uncertain", "Customer policy needs source review"]);
        }
        fixture.ok(&args);
        if checks {
            for desc in [
                "Knowledge evidence accepted",
                "Implementation outcomes checked",
                "Independent scenarios verified",
            ] {
                fixture.ok(&[
                    "plan",
                    "add",
                    "--slug",
                    "sample",
                    "--desc",
                    desc,
                    "--cmd",
                    "true",
                    "--expect",
                    "Expected outcomes observed",
                ]);
            }
        }
        fixture.reply(response());
        fixture
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_gdm"))
            .args(["--language", "en"])
            .args(args)
            .current_dir(&self.root)
            .env("GDM_CONFIG_DIR", &self.config)
            .env("GDM_NO_COLOR", "1")
            .env("GDM_CLAUDE_EXECUTABLE", self.provider.join("claude"))
            .env("GDM_ROLE_MAX_SECONDS", "5")
            .env("GDM_TEST_CWD", &self.root)
            .env("GDM_TEST_BINARY", env!("CARGO_BIN_EXE_gdm"))
            .output()
            .unwrap()
    }
    fn ok(&self, args: &[&str]) -> Value {
        let out = self.run(args);
        assert!(
            out.status.success(),
            "{args:?}: {} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
    }
    fn auto(&self, extra: &[&str]) -> Output {
        self.run(
            &[
                &[
                    "team",
                    "auto",
                    "--slug",
                    "sample",
                    "--from-request",
                    "--provider",
                    "claude",
                    "--model",
                    "sonnet",
                    "--max-active",
                    "3",
                    "--executor",
                    "native",
                ][..],
                extra,
            ]
            .concat(),
        )
    }
    fn planned(&self, extra: &[&str]) -> Value {
        let out = self.auto(extra);
        assert!(
            out.status.success(),
            "{} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }
    fn rejected(&self, code: &str) {
        let before = self.state_bytes();
        let out = self.auto(&[]);
        assert!(
            !out.status.success(),
            "unexpected success: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(
            String::from_utf8_lossy(&out.stderr).contains(code),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            before,
            self.state_bytes(),
            "Invalid proposal changed canonical Work"
        );
        assert!(
            !self.has_request_archive(),
            "Invalid proposal published a planner artifact"
        );
    }
    fn reply(&self, value: Value) {
        fs::write(self.provider.join("response"),serde_json::to_vec(&json!({"type":"result","subtype":"success","is_error":false,"structured_output":value,"usage":{"input_tokens":12,"output_tokens":30}})).unwrap()).unwrap();
    }
    fn state_bytes(&self) -> Vec<u8> {
        fs::read(self.root.join(".gdm/sample/checks.json")).unwrap()
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&self.state_bytes()).unwrap()
    }
    fn has_request_archive(&self) -> bool {
        fs::read_dir(self.root.join(".gdm/sample/out")).is_ok_and(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("team-request-")
            })
        })
    }
    fn rejected_archives(&self) -> Vec<PathBuf> {
        fs::read_dir(self.root.join(".gdm/sample/out"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("team-rejected-")
            })
            .map(|entry| entry.path())
            .collect()
    }
}
fn assignment(paths: &[&str], checks: &[&str]) -> Value {
    json!({"paths":paths,"checks":checks,"deliverable":"Reviewable role result","acceptance":"Evidence confirms requested outcomes","routeId":"native-inherit","createPaths":[]})
}
fn response() -> Value {
    let mut transport = assignment(&["src/transport.rs"], &["c1", "c2"]);
    transport["id"] = json!("transport");
    transport["dependsOn"] = json!([]);
    transport["knowledgeIndependentReason"] = Value::Null;
    let mut service = assignment(&["src/service.rs"], &["c2"]);
    service["id"] = json!("business");
    service["dependsOn"] = json!(["transport"]);
    service["knowledgeIndependentReason"] = Value::Null;
    let mut knowledge = assignment(&["docs/policy.md"], &[]);
    knowledge["acceptanceMode"] = json!("artifact-review");
    json!({"plan":{"schemaVersion":"gdm-team-plan/v1","executor":"native","maxActive":3,"knowledge":knowledge,"modules":[transport,service],"verification":assignment(&["src","tests"],&["c3"]),"independentVerification":null},"rationale":"Customer policy needs source review. Transport precedes business behavior and a fresh role verifies the outcomes."})
}

#[test]
fn request_calls_real_provider_process_once_and_persists_grounded_dependencies_and_routes() {
    let f = Fixture::new(true, true);
    let out = f.planned(&["--context", "docs/policy.md"]);
    assert_eq!(out["automaticPlanning"], true);
    assert_eq!(out["automaticExecution"], false);
    assert_eq!(
        out["tasks"][2]["dependsOn"],
        json!(["knowledge", "implement-transport"])
    );
    assert_eq!(out["plannerReceipt"]["providerInvocations"], 1);
    assert_eq!(fs::read(f.provider.join("invocations")).unwrap(), b"x");
    let prompt = fs::read_to_string(f.provider.join("input")).unwrap();
    assert!(prompt.contains("Interpret customer intake rules"));
    assert!(prompt.contains("Observed customer policy context"));
    assert!(!prompt.contains("PRIVATE_SOURCE_SENTINEL"));
    let argv = fs::read_to_string(f.provider.join("argv")).unwrap();
    assert!(argv.contains("--json-schema\n"));
    assert!(argv.contains("additionalProperties"));
    let next = f.ok(&["team", "next", "--slug", "sample"]);
    assert_eq!(next["actions"][0]["route"]["id"], "native-inherit");
    assert_eq!(next["actions"][0]["route"]["model"], "inherit");
    assert!(
        next["actions"][0]["prompt"]
            .as_str()
            .unwrap()
            .contains("GDM_TEAM_TASK_V1_BEGIN")
    );
    assert_eq!(next["actions"][0]["acceptanceMode"], "artifact-review");
    assert_eq!(next["actions"][0]["checks"], json!([]));
    assert!(
        next["actions"][0]["prompt"]
            .as_str()
            .unwrap()
            .contains("Implementation outcomes checked")
    );
    let artifact = out["allocation"]["request"]["artifact"]["path"]
        .as_str()
        .unwrap();
    assert!(f.root.join(artifact).is_file());
    let before = f.state_bytes();
    let repeated = f.planned(&["--context", "docs/policy.md"]);
    assert_eq!(repeated["plannerReused"], true);
    assert_eq!(before, f.state_bytes());
    assert_eq!(fs::read(f.provider.join("invocations")).unwrap(), b"x");
}

#[test]
fn dry_run_invokes_planner_without_persisting_work_or_archive() {
    let f = Fixture::new(true, true);
    let before = f.state_bytes();
    let out = f.planned(&["--dry-run"]);
    assert_eq!(out["dryRun"], true);
    assert_eq!(before, f.state_bytes());
    assert!(!f.has_request_archive());
}

#[test]
fn semantic_proposals_reject_unknown_fields_checks_paths_routes_cycles_and_capacity() {
    for kind in [
        "field",
        "check",
        "path",
        "route",
        "cycle",
        "capacity",
        "executor",
        "missing-role",
    ] {
        let f = Fixture::new(true, true);
        let mut value = response();
        let code = match kind {
            "field" => {
                value["plan"]["invented"] = json!(true);
                "team_plan_invalid"
            }
            "check" => {
                value["plan"]["modules"][0]["checks"] = json!(["c404"]);
                "team_plan_invalid"
            }
            "path" => {
                value["plan"]["modules"][0]["paths"] = json!(["src/invented.rs"]);
                "team_path_ungrounded"
            }
            "route" => {
                value["plan"]["modules"][0]["routeId"] = json!("invented-model");
                "team_route_invalid"
            }
            "cycle" => {
                value["plan"]["modules"][0]["dependsOn"] = json!(["business"]);
                "team_plan_invalid"
            }
            "capacity" => {
                value["plan"]["maxActive"] = json!(4);
                "team_capability_conflict"
            }
            "executor" => {
                value["plan"]["executor"] = json!("unavailable");
                "team_capability_conflict"
            }
            "missing-role" => {
                value["plan"]["verification"] = Value::Null;
                "team_verification_required"
            }
            _ => unreachable!(),
        };
        f.reply(value);
        f.rejected(code);
        assert_eq!(fs::read(f.provider.join("invocations")).unwrap(), b"x");
    }
}

#[test]
fn malformed_provider_output_has_no_plan_fallback_or_retry() {
    let f = Fixture::new(true, true);
    fs::write(f.provider.join("response"), "not json").unwrap();
    f.rejected("request_planner_provider");
    assert_eq!(fs::read(f.provider.join("invocations")).unwrap(), b"x");
}

#[test]
fn paths_require_explicit_creation_under_observed_parent() {
    let f = Fixture::new(true, true);
    let mut value = response();
    value["plan"]["modules"][0]["paths"] = json!(["src/new.rs"]);
    value["plan"]["modules"][0]["createPaths"] = json!(["src/new.rs"]);
    f.reply(value);
    assert_eq!(f.planned(&[])["tasks"][1]["paths"], json!(["src/new.rs"]));
    let f = Fixture::new(true, true);
    let mut value = response();
    value["plan"]["modules"][0]["paths"] = json!(["absent/new.rs"]);
    value["plan"]["modules"][0]["createPaths"] = json!(["absent/new.rs"]);
    f.reply(value);
    f.rejected("team_path_ungrounded");
}

#[test]
fn work_mutation_during_model_call_does_not_deadlock_and_rejects_stale_proposal() {
    let f = Fixture::new(true, true);
    fs::write(f.provider.join("race"), "").unwrap();
    let out = f.auto(&[]);
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("team_request_stale"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(f.state()["checks"].as_array().unwrap().len(), 4);
    assert!(f.state().get("team").is_none());
}

#[test]
fn source_race_is_rejected_but_normal_implementation_edits_do_not_stale_dispatch() {
    let f = Fixture::new(true, true);
    fs::write(f.provider.join("source-race"), "").unwrap();
    f.rejected("team_request_stale");
    let f = Fixture::new(true, true);
    f.planned(&[]);
    fs::write(
        f.root.join("src/service.rs"),
        "Normal authorized implementation edit\n",
    )
    .unwrap();
    assert_eq!(
        f.ok(&["team", "next", "--slug", "sample"])["actions"][0]["action"],
        "dispatch"
    );
}

#[test]
fn provenance_metadata_and_archive_tampering_block_use() {
    let f = Fixture::new(true, true);
    f.planned(&[]);
    let mut work = f.state();
    work["team"]["allocation"]["request"]["receipt"]["modelRequested"] = json!("forged");
    fs::write(
        f.root.join(".gdm/sample/checks.json"),
        serde_json::to_vec(&work).unwrap(),
    )
    .unwrap();
    let out = f.run(&["team", "next", "--slug", "sample"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("state_corrupt"));
    let f = Fixture::new(true, true);
    let out = f.planned(&[]);
    fs::write(
        f.root.join(
            out["allocation"]["request"]["artifact"]["path"]
                .as_str()
                .unwrap(),
        ),
        "changed\n",
    )
    .unwrap();
    let next = f.ok(&["team", "next", "--slug", "sample"]);
    assert_eq!(next["actions"][0]["action"], "blocked");
    assert_eq!(
        next["actions"][0]["blockers"][0]["code"],
        "team_request_changed"
    );
    let claim = f.run(&[
        "team",
        "claim",
        "--slug",
        "sample",
        "--task",
        "knowledge",
        "--assignee",
        "worker",
        "--attempt",
        "a1",
    ]);
    assert!(!claim.status.success());
    assert!(String::from_utf8_lossy(&claim.stderr).contains("team_request_changed"));
}

#[test]
fn explicit_catalog_controls_model_route_without_caller_role_assignments() {
    let f = Fixture::new(true, true);
    fs::write(f.root.join("capabilities.json"),serde_json::to_vec(&json!({"schemaVersion":"gdm-team-capabilities/v1","routes":[{"id":"available-reader","provider":"claude","model":"sonnet","roles":["knowledge","verification"],"access":["read"]},{"id":"current-builder","provider":"native","model":"inherit","roles":["implementation"],"access":["write"]}]})).unwrap()).unwrap();
    let mut value = response();
    value["plan"]["knowledge"]["routeId"] = json!("available-reader");
    value["plan"]["verification"]["routeId"] = json!("available-reader");
    for module in value["plan"]["modules"].as_array_mut().unwrap() {
        module["routeId"] = json!("current-builder");
    }
    f.reply(value);
    f.planned(&["--capabilities-file", "capabilities.json"]);
    assert_eq!(
        f.ok(&["team", "next", "--slug", "sample"])["actions"][0]["route"]["model"],
        "sonnet"
    );
}

#[test]
fn request_requires_verification_checks_and_excludes_legacy_plan_input() {
    let f = Fixture::new(false, false);
    f.rejected("team_checks_required");
    assert!(!f.provider.join("invocations").exists());
    let f = Fixture::new(true, true);
    let out = f.auto(&["--file", "roles.json"]);
    assert!(!out.status.success());
    assert!(!f.provider.join("invocations").exists());
}

#[test]
fn request_single_module_stays_lightweight_and_legacy_import_still_works() {
    let f = Fixture::new(false, true);
    let mut value = response();
    value["plan"]["knowledge"] = Value::Null;
    value["plan"]["verification"] = Value::Null;
    value["plan"]["modules"].as_array_mut().unwrap().truncate(1);
    value["plan"]["modules"][0]["checks"] = json!(["c1", "c2", "c3"]);
    f.reply(value.clone());
    let out = f.planned(&[]);
    assert_eq!(out["mode"], "single");
    assert_eq!(out["tasks"], json!([]));
    let persisted = f.state();
    assert!(persisted["team"]["allocation"]["request"]["response"]["plan"]["knowledge"].is_null());
    assert!(
        persisted["team"]["allocation"]["spec"]
            .get("knowledge")
            .is_none()
    );
    assert!(persisted["team"]["allocation"]["request"]["response"]["plan"]["modules"][0]["knowledgeIndependentReason"].is_null());
    assert!(
        persisted["team"]["allocation"]["spec"]["modules"][0]
            .get("knowledgeIndependentReason")
            .is_none()
    );
    let legacy = Fixture::new(false, true);
    for key in ["knowledge", "verification", "independentVerification"] {
        value["plan"].as_object_mut().unwrap().remove(key);
    }
    value["plan"]["modules"][0]
        .as_object_mut()
        .unwrap()
        .remove("knowledgeIndependentReason");
    value["plan"]["modules"][0]
        .as_object_mut()
        .unwrap()
        .remove("routeId");
    fs::write(
        legacy.root.join("roles.json"),
        serde_json::to_vec(&value["plan"]).unwrap(),
    )
    .unwrap();
    assert_eq!(
        legacy.ok(&["team", "auto", "--slug", "sample", "--file", "roles.json"])["mode"],
        "single"
    );
}

#[test]
fn blank_planner_model_is_rejected_before_any_provider_probe() {
    let f = Fixture::new(true, true);
    for model in ["", "   "] {
        let out = f.run(&[
            "team",
            "auto",
            "--slug",
            "sample",
            "--from-request",
            "--provider",
            "claude",
            "--model",
            model,
            "--max-active",
            "3",
            "--executor",
            "native",
        ]);
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("nonblank --model"));
        assert!(!f.provider.join("invocations").exists());
        assert!(!f.has_request_archive());
    }
}

#[test]
fn structured_response_requires_explicit_nullable_properties() {
    for field in ["knowledge", "verification", "independentVerification"] {
        let f = Fixture::new(false, true);
        let mut value = response();
        value["plan"].as_object_mut().unwrap().remove(field);
        f.reply(value);
        f.rejected("team_plan_invalid");
    }
    let f = Fixture::new(false, true);
    let mut value = response();
    value["plan"]["modules"][0]
        .as_object_mut()
        .unwrap()
        .remove("knowledgeIndependentReason");
    f.reply(value);
    f.rejected("team_plan_invalid");
}

#[test]
fn archived_contract_bytes_remain_verifiable_without_current_prompt_regeneration() {
    use gdm::{runtime::protocol::canonical_json, support::sha256};
    let f = Fixture::new(true, true);
    f.planned(&[]);
    let mut work = f.state();
    let request = &mut work["team"]["allocation"]["request"];
    // Simulate a supported older v2 wire contract. Its exact schema string is
    // retained, including insignificant JSON whitespace, and its receipt is
    // checked against those archived bytes rather than the current generator.
    let prompt = format!(
        "Historical supported contract. {}",
        request["plannerContract"]["prompt"].as_str().unwrap()
    );
    let schema = format!(
        " \n{}\n",
        request["plannerContract"]["schema"].as_str().unwrap()
    );
    request["plannerContract"]["prompt"] = json!(prompt);
    request["plannerContract"]["schema"] = json!(schema);
    request["receipt"]["promptSha256"] = json!(sha256(&prompt));
    request["receipt"]["schemaSha256"] = json!(sha256(&schema));
    request.as_object_mut().unwrap().remove("artifact");
    let archive = canonical_json(request);
    let hash = sha256(&archive);
    let path = format!(".gdm/sample/out/team-request-{hash}.json");
    fs::write(f.root.join(&path), archive).unwrap();
    request["artifact"] = json!({"path":path,"sha256":hash});
    fs::write(
        f.root.join(".gdm/sample/checks.json"),
        canonical_json(&work),
    )
    .unwrap();
    assert_eq!(
        f.ok(&["team", "next", "--slug", "sample"])["actions"][0]["action"],
        "dispatch"
    );
}

#[test]
fn knowledge_artifact_review_can_finish_while_real_behavior_is_red() {
    let f = Fixture::new(true, true);
    fs::write(f.root.join("src/service.sh"), "printf 'accepted\\n'\n").unwrap();
    fs::write(
        f.root.join("tests/regression.sh"),
        "test \"$(sh src/service.sh unauthenticated)\" = denied\n",
    )
    .unwrap();
    f.ok(&[
        "plan",
        "edit",
        "--slug",
        "sample",
        "--check",
        "c2",
        "--cmd",
        "sh tests/regression.sh",
        "--reason",
        "Reject unauthenticated customer actions",
    ]);
    let red = f.run(&["pass", "c2", "--slug", "sample"]);
    assert!(!red.status.success());
    let mut value = response();
    value["plan"]["modules"].as_array_mut().unwrap().truncate(1);
    value["plan"]["modules"][0]["paths"] = json!(["src/service.sh", "tests/regression.sh"]);
    f.reply(value);
    f.planned(&[]);
    f.ok(&[
        "team",
        "claim",
        "--slug",
        "sample",
        "--task",
        "knowledge",
        "--assignee",
        "researcher",
        "--attempt",
        "k1",
    ]);
    f.ok(&[
        "team",
        "report",
        "--slug",
        "sample",
        "--task",
        "knowledge",
        "--attempt",
        "k1",
        "--outcome",
        "completed",
        "--summary",
        "Source policy separates unauthenticated actions",
        "--artifact",
        "docs/policy.md",
    ]);
    f.ok(&[
        "team",
        "review",
        "--slug",
        "sample",
        "--task",
        "knowledge",
        "--attempt",
        "k1",
        "--decision",
        "accept",
        "--reason",
        "Source policy and unresolved assumptions are reviewed",
    ]);
    assert_ne!(f.state()["checks"][1]["status"], "proven");
    let next = f.ok(&["team", "next", "--slug", "sample"]);
    assert_eq!(next["actions"][0]["action"], "dispatch");
    assert_eq!(next["actions"][0]["taskId"], "implement-transport");
    assert!(!f.run(&["done", "--slug", "sample"]).status.success());
    // The assigned implementation includes the regression test's write path.
    assert!(
        next["actions"][0]["paths"]
            .as_array()
            .unwrap()
            .contains(&json!("tests/regression.sh"))
    );
    f.ok(&[
        "team",
        "claim",
        "--slug",
        "sample",
        "--task",
        "implement-transport",
        "--assignee",
        "builder",
        "--attempt",
        "i1",
    ]);
    fs::write(f.root.join("src/service.sh"),"if test \"$1\" = unauthenticated; then printf 'denied\\n'; else printf 'accepted\\n'; fi\n").unwrap();
    f.ok(&["pass", "c2", "--slug", "sample"]);
    assert_eq!(f.state()["checks"][1]["status"], "proven");
    assert!(
        !f.run(&["done", "--slug", "sample"]).status.success(),
        "Final review and all remaining checks still gate completion"
    );
}

#[test]
fn artifact_review_cannot_bypass_implementation_verification_or_manual_acceptance() {
    for role in ["modules", "verification"] {
        let f = Fixture::new(true, true);
        let mut value = response();
        let assignment = if role == "modules" {
            &mut value["plan"][role][0]
        } else {
            &mut value["plan"][role]
        };
        assignment["acceptanceMode"] = json!("artifact-review");
        assignment["checks"] = json!([]);
        f.reply(value);
        f.rejected("team_plan_invalid");
    }
    let f = Fixture::new(true, true);
    let mut value = response();
    // A manually imported role spec cannot opt into semantic knowledge gating.
    for module in value["plan"]["modules"].as_array_mut().unwrap() {
        module
            .as_object_mut()
            .unwrap()
            .remove("knowledgeIndependentReason");
    }
    value["plan"]
        .as_object_mut()
        .unwrap()
        .remove("independentVerification");
    fs::write(
        f.root.join("roles.json"),
        serde_json::to_vec(&value["plan"]).unwrap(),
    )
    .unwrap();
    let before = f.state_bytes();
    let out = f.run(&["team", "auto", "--slug", "sample", "--file", "roles.json"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("team_plan_invalid"));
    assert_eq!(before, f.state_bytes());
}

#[test]
fn rejected_proposal_records_safe_response_and_precise_field_without_work_changes() {
    let f = Fixture::new(true, true);
    let mut value = response();
    let invalid = "Private description with / unsupported punctuation";
    value["plan"]["modules"][0]["deliverable"] = json!(invalid);
    f.reply(value.clone());
    let before = f.state_bytes();
    let output = f.auto(&[]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("modules[0].deliverable"), "{error}");
    assert!(error.contains("team-rejected-"));
    assert!(!error.contains(invalid));
    assert_eq!(before, f.state_bytes());
    assert!(!f.has_request_archive());
    let files = f.rejected_archives();
    assert_eq!(files.len(), 1);
    let archived: Value = serde_json::from_slice(&fs::read(&files[0]).unwrap()).unwrap();
    assert_eq!(archived["schemaVersion"], "gdm-team-rejected-proposal/v1");
    assert_eq!(archived["response"], value);
    assert_eq!(archived["receipt"]["providerInvocations"], 1);
    assert_eq!(
        archived["failure"]["message"],
        "Invalid planner field modules[0].deliverable"
    );
    assert!(archived["plannerContract"]["schema"].is_string());
}

#[test]
fn rejected_dry_run_and_credential_response_do_not_write_diagnostics() {
    let f = Fixture::new(true, true);
    let mut value = response();
    value["plan"]["modules"][0]["deliverable"] = json!("Invalid / description");
    f.reply(value);
    let before = f.state_bytes();
    assert!(!f.auto(&["--dry-run"]).status.success());
    assert_eq!(before, f.state_bytes());
    assert!(f.rejected_archives().is_empty());
    let f = Fixture::new(true, true);
    let mut value = response();
    value["rationale"] = json!("Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789");
    f.reply(value);
    let before = f.state_bytes();
    assert!(!f.auto(&[]).status.success());
    assert_eq!(before, f.state_bytes());
    assert!(f.rejected_archives().is_empty());
}

#[test]
fn adaptive_selection_survives_reload_and_claim_rejects_substitution_without_mutation() {
    let f = Fixture::new(true, true);
    let route = |id: &str, model: &str| json!({"id":id,"provider":"native","model":model,"roles":["knowledge","implementation","verification"],"access":["read","write"],"execution":"native","efforts":[null,"high"],"strengths":["Scoped implementation"],"limitations":[],"maxInvocations":8});
    fs::write(f.root.join("capabilities.json"), serde_json::to_vec(&json!({"schemaVersion":"gdm-team-capabilities/v2","routes":[route("light","available-light"),route("deep","available-deep")]})).unwrap()).unwrap();
    let mut reply = response();
    for key in ["knowledge", "verification"] {
        reply["plan"][key]["routeId"] = json!("light");
        reply["plan"][key]["effort"] = Value::Null;
        reply["plan"][key]["selectionReason"] = json!("Bounded read task with low execution cost");
    }
    for (i, module) in reply["plan"]["modules"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        module["routeId"] = json!(if i == 0 { "deep" } else { "light" });
        module["effort"] = json!("high");
        module["selectionReason"] = json!("Selected for module complexity and risk");
    }
    f.reply(reply);
    let planned = f.planned(&["--capabilities-file", "capabilities.json"]);
    assert_eq!(planned["tasks"][1]["routeId"], "deep");
    assert_eq!(planned["tasks"][2]["routeId"], "light");
    assert_eq!(planned["tasks"][1]["effort"], "high");
    f.ok(&["team", "next", "--slug", "sample"]);
    let before = f.state_bytes();
    let base = [
        "team",
        "claim",
        "--slug",
        "sample",
        "--task",
        "knowledge",
        "--assignee",
        "fresh-reader",
        "--attempt",
        "adaptive-k1",
    ];
    let missing = f.run(&base);
    assert!(!missing.status.success());
    assert_eq!(before, f.state_bytes());
    let wrong = [
        &base[..],
        &[
            "--execution-route",
            "light",
            "--execution-provider",
            "native",
            "--execution-model",
            "substitute",
            "--execution-effort",
            "inherit",
        ],
    ]
    .concat();
    assert!(!f.run(&wrong).status.success());
    assert_eq!(before, f.state_bytes());
    let valid = [
        &base[..],
        &[
            "--execution-route",
            "light",
            "--execution-provider",
            "native",
            "--execution-model",
            "available-light",
            "--execution-effort",
            "inherit",
        ],
    ]
    .concat();
    f.ok(&valid);
    let execution = f.state()["team"]["tasks"][0]["attempts"][0]["execution"].clone();
    assert_eq!(execution["source"], "host-declared");
    assert_eq!(execution["model"], "available-light");
    assert!(execution["effort"].is_null());
    f.ok(&["team", "next", "--slug", "sample"]);
}

#[test]
fn adaptive_reservations_count_failed_retried_claims_across_route_rename_replan() {
    let f = Fixture::new(true, true);
    let write_plan = |reader_id: &str| {
        let route = |id: &str, model: &str, cap: u64| json!({"id":id,"provider":"native","model":model,"roles":["knowledge","implementation","verification"],"access":["read","write"],"execution":"native","efforts":[null],"strengths":[],"limitations":[],"maxInvocations":cap});
        fs::write(f.root.join("capabilities.json"),serde_json::to_vec(&json!({"schemaVersion":"gdm-team-capabilities/v2","routes":[route(reader_id,"reader-model",2),route("builder","builder-model",8)]})).unwrap()).unwrap();
        let mut reply = response();
        for key in ["knowledge", "verification"] {
            reply["plan"][key]["routeId"] = json!(if key == "knowledge" {
                reader_id
            } else {
                "builder"
            });
            reply["plan"][key]["effort"] = Value::Null;
            reply["plan"][key]["selectionReason"] =
                json!("Bounded task within remaining invocation capacity");
        }
        for m in reply["plan"]["modules"].as_array_mut().unwrap() {
            m["routeId"] = json!("builder");
            m["effort"] = Value::Null;
            m["selectionReason"] = json!("Implementation capacity supports the scoped module");
        }
        f.reply(reply);
    };
    let claim = |route: &str, attempt: &str| {
        f.run(&[
            "team",
            "claim",
            "--slug",
            "sample",
            "--task",
            "knowledge",
            "--assignee",
            "reader-worker",
            "--attempt",
            attempt,
            "--execution-route",
            route,
            "--execution-provider",
            "native",
            "--execution-model",
            "reader-model",
            "--execution-effort",
            "inherit",
        ])
    };
    let reject = |attempt: &str| {
        f.ok(&[
            "team",
            "report",
            "--slug",
            "sample",
            "--task",
            "knowledge",
            "--attempt",
            attempt,
            "--outcome",
            "failed",
            "--summary",
            "Source analysis needs another attempt",
            "--artifact",
            "docs/policy.md",
        ]);
        f.ok(&[
            "team",
            "review",
            "--slug",
            "sample",
            "--task",
            "knowledge",
            "--attempt",
            attempt,
            "--decision",
            "reject",
            "--reason",
            "Retry source analysis with the missing evidence",
        ]);
    };
    write_plan("reader-old");
    f.planned(&["--capabilities-file", "capabilities.json"]);
    assert!(claim("reader-old", "reader-a1").status.success());
    reject("reader-a1");
    write_plan("reader-renamed");
    f.planned(&[
        "--capabilities-file",
        "capabilities.json",
        "--replan",
        "--reason",
        "Rename available route while preserving provider model reservation history",
    ]);
    let input = f.state()["team"]["allocation"]["request"]["input"].clone();
    assert_eq!(input["promptVersion"], 3);
    assert_eq!(input["invocationReservations"]["unknownAttribution"], false);
    let reader = input["invocationReservations"]["providerModels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["model"] == "reader-model")
        .unwrap();
    assert_eq!(reader["claimed"], 1);
    assert_eq!(reader["remaining"], 1);
    let prompt = fs::read_to_string(f.provider.join("input")).unwrap();
    assert!(prompt.contains("\"promptVersion\":3"));
    assert!(prompt.contains("invocationReservations"));
    assert!(claim("reader-renamed", "reader-a2").status.success());
    reject("reader-a2");
    f.ok(&[
        "team",
        "retry",
        "--slug",
        "sample",
        "--task",
        "knowledge",
        "--attempt",
        "reader-a2",
        "--reason",
        "Try another source analysis attempt",
    ]);
    let before = f.state_bytes();
    let exhausted = claim("reader-renamed", "reader-a3");
    assert!(!exhausted.status.success());
    assert!(String::from_utf8_lossy(&exhausted.stderr).contains("team_invocation_limit"));
    assert_eq!(before, f.state_bytes());
}
