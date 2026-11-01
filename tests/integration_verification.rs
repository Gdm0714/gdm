//! Real CLI acceptance tests. Every command uses an isolated temporary Git repository.
//! No browser, app host, UI automation, installed state mutation, or desktop interaction.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

struct Repo {
    dir: tempfile::TempDir,
}
impl Repo {
    fn new(profile: bool, audit: bool) -> Self {
        let r = Self {
            dir: tempfile::tempdir().unwrap(),
        };
        let o = Command::new("/usr/bin/git")
            .args(["init", "-q"])
            .current_dir(r.path())
            .output()
            .unwrap();
        assert!(o.status.success());
        fs::create_dir_all(r.path().join(".gdm/inputs")).unwrap();
        r.write(".gdm/inputs/request.json", "{\"customer\":\"normal\"}\n");
        r.write(
            ".gdm/inputs/target.json",
            "{\"service\":\"workspace-double\"}\n",
        );
        r.write("outcome.txt", "booking-created\n");
        r.write("denied.txt", "denied\n");
        r.write("validator.sh", "#!/bin/sh\nset -eu\ncase \"$1\" in\npositive) test \"$(cat outcome.txt)\" = booking-created; printf 'booking-created\\n';;\ndenied) test \"$(cat denied.txt)\" = denied; printf 'denied\\n';;\nesac\nif test -f .gdm/change-source; then printf changed >> outcome.txt; fi\nif test -f .gdm/change-fixture; then printf changed >> .gdm/inputs/request.json; fi\n");
        let mut args = vec![
            "plan",
            "init",
            "--slug",
            "sample",
            "--brief",
            "Accept normal customer request and deny forbidden action",
            "--require",
            "Both success and denial must be verified",
            "--uncertain",
            "Input envelope is not yet checked",
        ];
        if profile {
            args.extend(["--profile", "integration"]);
        }
        if audit {
            args.push("--audit");
        }
        r.ok(&args);
        r.ok(&[
            "plan",
            "add",
            "--slug",
            "sample",
            "--desc",
            "Normal customer operation",
            "--cmd",
            "sh validator.sh positive",
            "--expect",
            "booking-created",
        ]);
        r.ok(&[
            "plan",
            "add",
            "--slug",
            "sample",
            "--desc",
            "Forbidden operation",
            "--cmd",
            "sh validator.sh denied",
            "--expect",
            "denied",
        ]);
        r
    }
    fn path(&self) -> &Path {
        self.dir.path()
    }
    fn write(&self, path: &str, body: &str) {
        fs::write(self.path().join(path), body).unwrap();
    }
    fn raw(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_gdm"))
            .args(args)
            .current_dir(self.path())
            .env("GDM_LANG", "en")
            .env("GDM_COMMAND_TIMEOUT_MS", "5000")
            .output()
            .unwrap()
    }
    fn ok(&self, args: &[&str]) -> Output {
        let o = self.raw(args);
        assert!(
            o.status.success(),
            "{args:?}\n{}\n{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        );
        o
    }
    fn fail(&self, args: &[&str], code: &str) {
        let o = self.raw(args);
        assert!(!o.status.success(), "Unexpected success: {args:?}");
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        );
        assert!(text.contains(code), "Expected {code}: {text}");
    }
    fn json(&self, args: &[&str]) -> Value {
        serde_json::from_slice(&self.ok(args).stdout).unwrap()
    }
    fn state(&self) -> Value {
        self.json(&["plan", "list", "--slug", "sample", "--json"])
    }
    fn reference(&self, path: &str) -> Value {
        json!({"artifactRef":path,"sha256":hex::encode(Sha256::digest(fs::read(self.path().join(path)).unwrap()))})
    }
    fn contract(&self) -> Value {
        let spec = |id: &str| json!({"checkId":id,"inputOrigin":"synthetic","environment":"mock","targetKind":"workspace","fixture":self.reference(".gdm/inputs/request.json"),"target":self.reference(".gdm/inputs/target.json"),"validator":self.reference("validator.sh")});
        json!({"schemaVersion":"gdm-verification-contract/v1","profile":"integration","review":{"note":"Reviewed original normal and forbidden request requirements","classifications":[{"uncertaintyIndex":0,"unknownIds":["input-shape"]}]},"requirements":{"input":{"checkIds":["c1"]},"positiveOutcome":{"checkIds":["c1"]},"deniedAction":{"checkIds":["c2"]},"stateContinuity":{"checkIds":[],"notApplicableReason":"Single operation has no conversation state"}},"checks":[spec("c1"),spec("c2")],"unknowns":[{"id":"input-shape","description":"Check the available example input envelope","checkId":"c1","conditions":{"inputOrigin":"synthetic","environment":"mock","targetKind":"workspace","fixtureRequired":true,"targetRequired":true},"status":"open"}]})
    }
    fn import(&self, v: &Value) {
        self.write(
            ".gdm/contract.json",
            &serde_json::to_string_pretty(v).unwrap(),
        );
        self.ok(&[
            "plan",
            "verification",
            "import",
            "--slug",
            "sample",
            "--file",
            ".gdm/contract.json",
        ]);
    }
    fn imported(&self) {
        self.import(&self.contract());
    }
    fn passed(&self) {
        self.ok(&["pass", "c1", "--slug", "sample"]);
        self.ok(&["pass", "c2", "--slug", "sample"]);
    }
    fn resolved(&self) {
        self.ok(&[
            "plan",
            "verification",
            "resolve",
            "--slug",
            "sample",
            "--id",
            "input-shape",
        ]);
    }
    fn done(&self) {
        self.ok(&["done", "--slug", "sample"]);
    }
    fn team(&self, args: &[&str]) {
        self.ok(&[&["team"][..], args, &["--slug", "sample"]].concat());
    }
    fn accepted_attempt(&self, task: &str, attempt: &str, assignee: &str, check: &str) {
        self.team(&[
            "claim",
            "--task",
            task,
            "--attempt",
            attempt,
            "--assignee",
            assignee,
        ]);
        self.team(&[
            "report",
            "--task",
            task,
            "--attempt",
            attempt,
            "--outcome",
            "completed",
            "--summary",
            "Role completed with inspectable evidence",
            "--artifact",
            ".gdm/team-proof.txt",
        ]);
        let already_proven = self.state()["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == check && c["status"] == "proven");
        if already_proven {
            self.ok(&["recheck", "--slug", "sample", "--check", check]);
        } else {
            self.ok(&["pass", check, "--slug", "sample"]);
        }
        self.team(&[
            "review",
            "--task",
            task,
            "--attempt",
            attempt,
            "--decision",
            "accept",
            "--reason",
            "Evidence confirms the assigned result",
        ]);
    }
}

#[test]
fn positive_and_denied_outcomes_produce_distinct_validation_receipt_and_safe_projections() {
    let r = Repo::new(true, false);
    r.imported();
    r.passed();
    r.resolved();
    let before = r.state();
    let evidence = fs::read(r.path().join(".gdm/sample/out/c1.txt")).unwrap();
    r.done();
    let w = r.state();
    let summary = &w["verificationSummary"];
    assert_eq!(w["checks"], before["checks"]);
    assert_eq!(
        fs::read(r.path().join(".gdm/sample/out/c1.txt")).unwrap(),
        evidence
    );
    assert_eq!(summary["completionValid"], true);
    assert_eq!(summary["completionMode"], "validate");
    assert_eq!(summary["counts"]["required"], 2);
    assert_eq!(summary["counts"]["proven"], 2);
    assert_eq!(
        w["verificationCompletion"]["executions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        r.json(&["status", "--json", "--checks"])[0]["verificationSummary"],
        *summary
    );
    let snap = r.json(&["protocol", "export", "--slug", "sample"]);
    assert_eq!(snap["verificationSummary"], *summary);
    assert!(snap["checks"][0]["evidence"]["verificationBinding"].is_object());
    let serialized = serde_json::to_string(summary).unwrap();
    for secret in [
        "validator.sh",
        "customer",
        "reason",
        "policy",
        "artifactRef",
    ] {
        assert!(!serialized.contains(secret));
    }
}

#[test]
fn all_checks_passing_does_not_resolve_multiple_unknowns() {
    let r = Repo::new(true, false);
    let mut v = r.contract();
    let mut extra = v["unknowns"][0].clone();
    extra["id"] = json!("business-result");
    extra["checkId"] = json!("c2");
    v["unknowns"].as_array_mut().unwrap().push(extra);
    r.import(&v);
    r.passed();
    r.fail(&["done", "--slug", "sample"], "unresolved_open");
    r.resolved();
    r.fail(&["done", "--slug", "sample"], "unresolved_open");
    assert_eq!(r.state()["verificationSummary"]["counts"]["open"], 1);
}

#[test]
fn deny_every_request_double_fails_required_positive_outcome() {
    let r = Repo::new(true, false);
    r.write("outcome.txt", "denied\n");
    r.imported();
    r.ok(&["pass", "c2", "--slug", "sample"]);
    r.fail(&["pass", "c1", "--slug", "sample"], "cmd_failed");
    assert_eq!(r.state()["verificationSummary"]["counts"]["proven"], 1);
    r.fail(&["done", "--slug", "sample"], "unproven");
}

#[test]
fn incomplete_done_reports_unproven_check_before_binding_or_reexecution() {
    let r = Repo::new(true, false);
    r.imported();
    r.ok(&["pass", "c2", "--slug", "sample"]);
    r.write(".gdm/change-source", "1");
    let output = r.raw(&["done", "--slug", "sample"]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("unproven"), "{error}");
    assert!(error.contains("c1"), "{error}");
    assert!(!error.contains("verification_evidence_stale"), "{error}");
    assert_eq!(
        fs::read_to_string(r.path().join("outcome.txt")).unwrap(),
        "booking-created\n"
    );
    let work = r.state();
    assert_eq!(work["done"], false);
    assert_eq!(work["checks"][1]["status"], "proven");
    assert!(work.get("verificationCompletion").is_none());
}

#[test]
fn commit_permission_preserves_audited_completion_and_accepted_limitations() {
    let r = Repo::new(true, true);
    let mut contract = r.contract();
    contract["checks"][0]["targetKind"] = json!("trace");
    contract["unknowns"][0]["conditions"]["targetKind"] = json!("trace");
    r.import(&contract);
    r.passed();
    r.ok(&[
        "plan",
        "verification",
        "waive",
        "--slug",
        "sample",
        "--id",
        "input-shape",
        "--reason",
        "Accept historical trace only",
        "--policy",
        "Existing mock-only project authority",
        "--accept-unknown-scope",
    ]);
    r.write(".gdm/audit.md", "**판정: 통과**\nimplementationModel: first\nauditModel: second\nReviewed normal and denied outcomes with the accepted historical trace limitation.\n");
    r.ok(&[
        "audit",
        "verdict",
        "--slug",
        "sample",
        "--pass",
        "--report",
        ".gdm/audit.md",
        "--implementation-model",
        "first",
        "--audit-model",
        "second",
    ]);
    r.done();
    let before = r.state();
    assert_eq!(before["verificationSummary"]["completionValid"], true);
    assert_eq!(before["verificationSummary"]["counts"]["waived"], 1);
    r.ok(&[
        "plan",
        "contract",
        "--slug",
        "sample",
        "--commit",
        "explicitly-approved",
        "--reason",
        "Existing user authorization permits delivery",
    ]);
    r.ok(&["plan", "contract", "--slug", "sample", "--check-commit"]);
    let after = r.state();
    assert_eq!(after["contract"]["commit"], "explicitly-approved");
    for field in [
        "done",
        "doneAt",
        "verificationCompletion",
        "audit",
        "checks",
        "verificationSummary",
    ] {
        assert_eq!(after[field], before[field], "{field}");
    }
    assert_eq!(
        after["contract"]["integrationVerification"],
        before["contract"]["integrationVerification"]
    );
    assert!(after.get("verificationHistory").is_none());
    assert_eq!(
        r.json(&["protocol", "export", "--slug", "sample"])["verificationSummary"],
        before["verificationSummary"]
    );
}

#[test]
fn source_fixture_and_target_drift_invalidate_completed_scope() {
    for path in [
        "outcome.txt",
        ".gdm/inputs/request.json",
        ".gdm/inputs/target.json",
        "validator.sh",
    ] {
        let r = Repo::new(true, false);
        r.imported();
        r.passed();
        r.resolved();
        r.done();
        r.write(path, "changed\n");
        let summary = r.state()["verificationSummary"].clone();
        assert_eq!(summary["completionValid"], false, "{path}");
        assert!(summary["completionDigest"].is_string());
        assert!(
            summary["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["code"] == "completion_stale")
        );
    }
}

#[test]
fn validation_refuses_source_and_gdm_fixture_edits_during_execution() {
    for flag in [".gdm/change-source", ".gdm/change-fixture"] {
        let r = Repo::new(true, false);
        r.imported();
        r.passed();
        r.resolved();
        r.write(flag, "1");
        r.fail(&["done", "--slug", "sample"], "unproven");
        let w = r.state();
        assert_eq!(w["done"], false);
        assert!(w.get("verificationCompletion").is_none());
    }
}

#[test]
fn fake_trace_is_unverified_and_waiver_remains_visible() {
    let r = Repo::new(true, false);
    let mut v = r.contract();
    v["checks"][0]["targetKind"] = json!("trace");
    v["unknowns"][0]["conditions"]["targetKind"] = json!("trace");
    r.import(&v);
    r.passed();
    r.fail(
        &[
            "plan",
            "verification",
            "resolve",
            "--slug",
            "sample",
            "--id",
            "input-shape",
        ],
        "verification_conditions_unsatisfied",
    );
    r.fail(
        &[
            "plan",
            "verification",
            "waive",
            "--slug",
            "sample",
            "--id",
            "input-shape",
            "--reason",
            "Trace only",
        ],
        "policy",
    );
    r.ok(&[
        "plan",
        "verification",
        "waive",
        "--slug",
        "sample",
        "--id",
        "input-shape",
        "--reason",
        "Accept historical trace only",
        "--policy",
        "Existing mock-only project authority",
        "--accept-unknown-scope",
    ]);
    r.done();
    let w = r.state();
    assert_eq!(w["verificationSummary"]["completionValid"], true);
    assert_eq!(w["verificationSummary"]["counts"]["waived"], 1);
    assert_eq!(w["verificationSummary"]["counts"]["unknown"], 1);
    assert_eq!(
        w["checks"][0]["evidence"]["verificationBinding"]["targetBinding"],
        "unverified"
    );
    assert!(
        fs::read_to_string(r.path().join(".gdm/sample/work.md"))
            .unwrap()
            .contains("Accept historical trace only")
    );
}

#[test]
fn refresh_invalidates_receipt_and_reopens_resolution() {
    let r = Repo::new(true, false);
    r.imported();
    r.passed();
    r.resolved();
    r.done();
    let old = r.state()["verificationSummary"]["completionDigest"].clone();
    r.ok(&["recheck", "--slug", "sample"]);
    let w = r.state();
    assert_eq!(w["done"], false);
    assert!(w["verificationSummary"]["completionDigest"].is_null());
    assert_eq!(w["verificationHistory"].as_array().unwrap().len(), 1);
    assert_eq!(w["verificationSummary"]["counts"]["open"], 1);
    r.resolved();
    r.done();
    assert_ne!(r.state()["verificationSummary"]["completionDigest"], old);
}

#[test]
fn audit_bound_completion_has_no_claimed_reexecution() {
    let r = Repo::new(true, true);
    r.imported();
    r.passed();
    r.resolved();
    r.write(".gdm/audit.md","**판정: 통과**\nimplementationModel: first\nauditModel: second\nReviewed normal and denied outcomes, source and declared mock scope.\n");
    r.ok(&[
        "audit",
        "verdict",
        "--slug",
        "sample",
        "--pass",
        "--report",
        ".gdm/audit.md",
        "--implementation-model",
        "first",
        "--audit-model",
        "second",
    ]);
    r.write(".gdm/change-source", "1"); // Would mutate source if done actually reran it.
    r.done();
    let w = r.state();
    assert_eq!(w["verificationSummary"]["completionMode"], "audit_bound");
    assert_eq!(w["verificationSummary"]["completionValid"], true);
    assert!(
        w["verificationCompletion"]["executions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(r.path().join("outcome.txt")).unwrap(),
        "booking-created\n"
    );
    r.write(".gdm/audit.md", "changed");
    // Report integrity remains part of completion validity, even though excluded from source.
    assert_eq!(r.state()["verificationSummary"]["completionValid"], false);
}

#[test]
fn import_rejects_unsupported_malformed_missing_coverage_and_duplicate_ids() {
    let r = Repo::new(true, false);
    for kind in 0..8 {
        let mut v = r.contract();
        match kind {
            0 => v["schemaVersion"] = json!("gdm-verification-contract/v999"),
            1 => {
                v["requirements"]
                    .as_object_mut()
                    .unwrap()
                    .remove("deniedAction");
            }
            2 => v["review"]["classifications"] = json!([]),
            3 => {
                let c = v["checks"][0].clone();
                v["checks"].as_array_mut().unwrap().push(c);
            }
            4 => v["requirements"]["positiveOutcome"]["checkIds"] = json!(["c999"]),
            5 => v["unknowns"][0]["status"] = json!("resolved"),
            6 => {
                v["checks"][0]["fixture"]["artifactRef"] =
                    json!(format!("/tmp/{}-{}", "sk", "examplecredential"))
            }
            _ => v["checks"][0]["fixture"]["artifactRef"] = json!("../outside"),
        }
        r.write(".gdm/contract.json", &v.to_string());
        if kind == 6 {
            r.fail(
                &[
                    "plan",
                    "verification",
                    "import",
                    "--slug",
                    "sample",
                    "--file",
                    ".gdm/contract.json",
                ],
                "privacy_rejected",
            );
            continue;
        }
        assert!(
            !r.raw(&[
                "plan",
                "verification",
                "import",
                "--slug",
                "sample",
                "--file",
                ".gdm/contract.json"
            ])
            .status
            .success(),
            "case {kind}"
        );
    }
    assert_eq!(r.state()["verificationSummary"]["completionValid"], false);
}

#[test]
fn legacy_work_remains_unclassified_and_contract_updates_invalidate_integration_receipt() {
    let r = Repo::new(false, false);
    r.passed();
    r.done();
    assert!(r.state().get("verificationSummary").is_none());
    r.imported();
    r.passed();
    r.resolved();
    r.done();
    let prior = r.state()["verificationSummary"]["contractDigest"].clone();
    let mut v = r.contract();
    v["review"]["note"] = json!("Revised reviewed plan scope");
    r.import(&v);
    let w = r.state();
    assert_eq!(w["done"], false);
    assert_ne!(w["verificationSummary"]["contractDigest"], prior);
    assert_eq!(w["verificationSummary"]["completionValid"], false);
}

#[test]
fn old_writer_field_loss_is_detected_with_real_legacy_binary_when_available() {
    let r = Repo::new(true, false);
    r.imported();
    if let Some(binary) = std::env::var_os("GDM_LEGACY_BIN") {
        let o = Command::new(binary)
            .args([
                "plan",
                "contract",
                "--slug",
                "sample",
                "--require",
                "Additional old writer requirement",
            ])
            .current_dir(r.path())
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    } else {
        // Portable simulation of the documented legacy normalizer; root also runs real binary case.
        let path = r.path().join(".gdm/sample/checks.json");
        let mut w: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        w["contract"]
            .as_object_mut()
            .unwrap()
            .remove("integrationVerification");
        fs::write(path, w.to_string()).unwrap();
    }
    r.fail(
        &["plan", "list", "--slug", "sample", "--json"],
        "verification_feature_lost",
    );
}

#[test]
fn explicit_external_fixture_is_hashed_and_submodule_coverage_fails_closed() {
    let r = Repo::new(true, false);
    let external = tempfile::NamedTempFile::new().unwrap();
    fs::write(external.path(), b"external input\n").unwrap();
    let mut v = r.contract();
    let path = external.path().to_str().unwrap();
    v["checks"][0]["fixture"] =
        json!({"artifactRef":path,"sha256":hex::encode(Sha256::digest(fs::read(path).unwrap()))});
    r.import(&v);
    r.passed();
    r.resolved();
    r.done();
    let exported = r.json(&["protocol", "export", "--slug", "sample"]);
    assert_eq!(
        exported["contract"]["integrationVerification"]["checks"][0]["fixture"]["artifactRef"],
        path
    );
    assert_eq!(exported["verificationSummary"]["completionValid"], true);
    assert!(!exported["verificationSummary"].to_string().contains(path));
    fs::write(path, b"changed input\n").unwrap();
    assert_eq!(r.state()["verificationSummary"]["completionValid"], false);
    let r = Repo::new(true, false);
    r.imported();
    let out = Command::new("/usr/bin/git")
        .args([
            "update-index",
            "--add",
            "--cacheinfo",
            "160000,1111111111111111111111111111111111111111,module",
        ])
        .current_dir(r.path())
        .output()
        .unwrap();
    assert!(out.status.success());
    let w = r.state();
    assert!(
        w["verificationSummary"]["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["code"] == "source_coverage_unsupported")
    );
    r.fail(
        &["pass", "c1", "--slug", "sample"],
        "source_coverage_unsupported",
    );
}

#[test]
fn tampered_completion_mode_and_check_set_are_rejected() {
    for change in ["mode", "checkIds"] {
        let r = Repo::new(true, false);
        r.imported();
        r.passed();
        r.resolved();
        r.done();
        let path: PathBuf = r.path().join(".gdm/sample/checks.json");
        let mut w: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        w["verificationCompletion"][change] = if change == "mode" {
            json!("future-mode")
        } else {
            json!([])
        };
        fs::write(path, w.to_string()).unwrap();
        r.fail(
            &["plan", "list", "--slug", "sample", "--json"],
            "verification_receipt_invalid",
        );
    }
}

#[test]
fn manual_scope_is_disclosed_and_never_counted_as_reexecution() {
    let r = Repo::new(true, false);
    r.ok(&[
        "plan",
        "add",
        "--slug",
        "sample",
        "--desc",
        "Human continuity inspection",
        "--manual",
        "--expect",
        "Reviewed state transition",
    ]);
    let mut v = r.contract();
    let mut spec = v["checks"][0].clone();
    spec["checkId"] = json!("c3");
    v["checks"].as_array_mut().unwrap().push(spec);
    v["requirements"]["stateContinuity"] = json!({"checkIds":["c3"]});
    let mut u = v["unknowns"][0].clone();
    u["id"] = json!("manual-scope");
    u["checkId"] = json!("c3");
    v["unknowns"].as_array_mut().unwrap().push(u);
    r.import(&v);
    r.passed();
    r.write(
        ".gdm/manual.txt",
        "Human observed the example state transition.\n",
    );
    r.ok(&[
        "pass",
        "c3",
        "--slug",
        "sample",
        "--manual",
        "--observed",
        ".gdm/manual.txt",
    ]);
    r.resolved();
    r.fail(
        &[
            "plan",
            "verification",
            "resolve",
            "--slug",
            "sample",
            "--id",
            "manual-scope",
        ],
        "verification_conditions_unsatisfied",
    );
    r.ok(&[
        "plan",
        "verification",
        "waive",
        "--slug",
        "sample",
        "--id",
        "manual-scope",
        "--reason",
        "Accept human observation without automated target binding",
        "--policy",
        "Existing review policy",
        "--accept-unknown-scope",
    ]);
    r.done();
    let w = r.state();
    assert_eq!(w["verificationSummary"]["completionValid"], true);
    assert!(
        w["verificationSummary"]["limitations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["code"] == "manual_evidence" && l["id"] == "c3")
    );
    assert!(
        w["verificationCompletion"]["executions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["checkId"] != "c3")
    );
    assert_eq!(
        w["checks"][2]["evidence"]["verificationBinding"]["mode"],
        "manual"
    );
}

#[test]
fn completed_summary_rechecks_team_artifacts_excluded_from_source() {
    for archived in [false, true] {
        let r = Repo::new(true, false);
        r.imported();
        r.write(".gdm/team-proof.txt", "Reviewed implementation result\n");
        r.team(&["configure", "--mode", "coordinated"]);
        r.team(&[
            "add",
            "--task",
            "implementation",
            "--role",
            "implementation",
            "--path",
            "outcome.txt",
            "--access",
            "write",
            "--deliverable",
            "Verified normal outcome",
            "--acceptance",
            "Normal customer operation succeeds",
            "--check",
            "c1",
        ]);
        r.accepted_attempt("implementation", "a1", "builder", "c1");
        r.ok(&["pass", "c2", "--slug", "sample"]);
        r.resolved();
        r.done();
        let w = r.state();
        assert_eq!(w["verificationSummary"]["completionValid"], true);
        let source_before = r.json(&["workspace", "fingerprint", "--json"]);
        let key = if archived {
            "archivedArtifact"
        } else {
            "artifact"
        };
        let report_path = w["team"]["tasks"][0]["attempts"][0]["report"][key]["path"]
            .as_str()
            .unwrap();
        assert!(report_path.starts_with(".gdm/"));
        r.write(report_path, "Changed accepted team report\n");
        assert_eq!(
            r.json(&["workspace", "fingerprint", "--json"]),
            source_before
        );
        let summary = &r.state()["verificationSummary"];
        assert_eq!(summary["completionValid"], false);
        assert!(
            summary["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["code"] == "team_verification_stale")
        );
        assert_eq!(
            r.json(&["status", "--json", "--checks"])[0]["verificationSummary"],
            *summary
        );
        assert!(summary["completionDigest"].is_string());
    }
}

#[test]
fn legitimate_team_update_archives_completed_receipt_before_revalidation() {
    let r = Repo::new(true, false);
    r.imported();
    r.write(".gdm/team-proof.txt", "Reviewed implementation result\n");
    r.team(&["configure", "--mode", "coordinated"]);
    r.team(&[
        "add",
        "--task",
        "implementation",
        "--role",
        "implementation",
        "--path",
        "outcome.txt",
        "--access",
        "write",
        "--deliverable",
        "Verified normal outcome",
        "--acceptance",
        "Normal customer operation succeeds",
        "--check",
        "c1",
    ]);
    r.accepted_attempt("implementation", "a1", "builder", "c1");
    r.ok(&["pass", "c2", "--slug", "sample"]);
    r.resolved();
    r.done();
    let before = r.state();
    r.team(&[
        "configure",
        "--mode",
        "coordinated",
        "--max-active",
        "2",
        "--reason",
        "Update coordinator concurrency after completion",
    ]);
    let changed = r.state();
    assert_eq!(changed["done"], false);
    assert!(changed.get("verificationCompletion").is_none());
    assert_eq!(changed["verificationSummary"]["completionValid"], false);
    assert_eq!(changed["verificationHistory"].as_array().unwrap().len(), 1);
    assert_eq!(
        changed["verificationHistory"][0]["stateDigest"],
        before["verificationSummary"]["stateDigest"]
    );
    r.done();
    let validated = r.state();
    assert_eq!(validated["verificationSummary"]["completionValid"], true);
    assert_ne!(
        validated["verificationSummary"]["completionDigest"],
        before["verificationSummary"]["completionDigest"]
    );
}
