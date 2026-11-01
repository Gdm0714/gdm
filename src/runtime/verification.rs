//! Optional integration verification. Declarations are not remote observations.
//! Legacy work has no extension and retains its original normalization and hashes.
use super::{contract, fingerprint, protocol, state, store};
use crate::support::{
    Error, Result, ensure_flags, has_flag, now, print_json, read_flag, required_flag, sha256,
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path, process::Command};

const SCHEMA: &str = "gdm-verification-contract/v1";
const FEATURE: &str = "gdm-integration/v1";
const RECEIPT: &str = "gdm-completion-receipt/v1";
const MAX_ITEMS: usize = 256;
const MAX_FILE: u64 = 64 * 1024 * 1024;
fn s(v: &Value) -> &str {
    state::s(v)
}
fn error(code: &str) -> Error {
    Error::new(code, code.replace('_', " "))
}
fn object(v: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let o = v
        .as_object()
        .ok_or_else(|| error("verification_malformed"))?;
    if required.iter().any(|k| !o.contains_key(*k))
        || o.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err(error("verification_malformed"));
    }
    Ok(())
}
fn list(v: &Value) -> Result<&[Value]> {
    let a = v
        .as_array()
        .ok_or_else(|| error("verification_malformed"))?;
    if a.len() > MAX_ITEMS {
        return Err(error("verification_too_large"));
    }
    Ok(a)
}
fn id(v: &Value) -> Result<()> {
    contract::opaque_id(s(v), "verification id").map(|_| ())
}
fn text(v: &Value) -> Result<()> {
    contract::safe_text(s(v), "verification text", 1000).map(|_| ())
}
fn enum_value(v: &Value, values: &[&str]) -> Result<()> {
    if !values.contains(&s(v)) {
        return Err(error("verification_malformed"));
    }
    Ok(())
}
fn source_valid(v: &Value) -> bool {
    object(v, &["schemaVersion", "sha256", "fileCount"], &[]).is_ok()
        && v["schemaVersion"] == 1
        && state::valid_hash(s(&v["sha256"]))
        && v["fileCount"].as_u64().is_some()
}
fn file_ref(v: &Value, nullable: bool) -> Result<()> {
    if nullable && v.is_null() {
        return Ok(());
    }
    object(v, &["artifactRef", "sha256"], &[])?;
    let path = s(&v["artifactRef"]);
    // This is an explicit local file reference, unlike prose metadata where an
    // absolute path is itself rejected. Keep credential/control screening on
    // the path body; permit only the single leading POSIX root separator.
    contract::assert_no_sensitive(
        path.strip_prefix('/').unwrap_or(path),
        "verification artifact",
    )?;
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\\')
        || path
            .strip_prefix('/')
            .unwrap_or(path)
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || !state::valid_hash(s(&v["sha256"]))
    {
        return Err(error("verification_malformed"));
    }
    Ok(())
}
fn scope(v: &Value) -> Result<()> {
    enum_value(&v["inputOrigin"], &["captured", "synthetic", "unknown"])?;
    enum_value(
        &v["environment"],
        &["mock", "staging", "production", "unknown"],
    )?;
    enum_value(
        &v["targetKind"],
        &["workspace", "remote", "trace", "unknown"],
    )
}
pub fn active(w: &Value) -> bool {
    w.get("verificationFeature").is_some()
}
pub fn contract_value(w: &Value) -> &Value {
    &w["contract"]["integrationVerification"]
}
pub fn initialize(w: &mut Value) {
    w["verificationFeature"] = json!(FEATURE);
    w["contract"]["integrationVerification"] =
        json!({"schemaVersion":SCHEMA,"profile":"integration","pending":true});
}
fn pending(w: &Value) -> bool {
    contract_value(w)["pending"] == true
}

/// Validate authoring and stored transitions without consulting mutable files.
pub fn validate(w: &Value) -> Result<()> {
    let v = contract_value(w);
    if !active(w) {
        if !v.is_null() || w.get("verificationCompletion").is_some() {
            return Err(error("verification_feature_lost"));
        }
        return Ok(());
    }
    if w["verificationFeature"] != FEATURE {
        return Err(error("verification_unsupported"));
    }
    if v.is_null() {
        return Err(error("verification_feature_lost"));
    }
    if v["schemaVersion"] != SCHEMA {
        return Err(error("verification_unsupported"));
    }
    if pending(w) {
        object(v, &["schemaVersion", "profile", "pending"], &[])?;
        if v["profile"] != "integration"
            || w["done"] == true
            || w.get("verificationCompletion").is_some()
        {
            return Err(error("verification_malformed"));
        }
        return Ok(());
    }
    object(
        v,
        &[
            "schemaVersion",
            "profile",
            "review",
            "requirements",
            "checks",
            "unknowns",
        ],
        &[],
    )?;
    if v["profile"] != "integration" {
        return Err(error("verification_unsupported"));
    }
    object(&v["review"], &["note", "classifications"], &[])?;
    text(&v["review"]["note"])?;
    let specs = list(&v["checks"])?;
    let unknowns = list(&v["unknowns"])?;
    let mut spec_ids = BTreeSet::new();
    for c in specs {
        object(
            c,
            &[
                "checkId",
                "inputOrigin",
                "environment",
                "targetKind",
                "fixture",
                "target",
                "validator",
            ],
            &[],
        )?;
        id(&c["checkId"])?;
        state::check_index(w, s(&c["checkId"]))?;
        if !spec_ids.insert(s(&c["checkId"])) {
            return Err(error("verification_duplicate_id"));
        }
        scope(c)?;
        file_ref(&c["fixture"], true)?;
        file_ref(&c["target"], true)?;
        file_ref(&c["validator"], false)?;
    }
    object(
        &v["requirements"],
        &[
            "input",
            "positiveOutcome",
            "deniedAction",
            "stateContinuity",
        ],
        &[],
    )?;
    let mut required = BTreeSet::new();
    for k in [
        "input",
        "positiveOutcome",
        "deniedAction",
        "stateContinuity",
    ] {
        let r = &v["requirements"][k];
        object(r, &["checkIds"], &["notApplicableReason"])?;
        let ids = list(&r["checkIds"])?;
        let mut seen = BTreeSet::new();
        if ids.is_empty() {
            text(&r["notApplicableReason"])?;
        } else if r.get("notApplicableReason").is_some() {
            return Err(error("verification_malformed"));
        }
        for i in ids {
            if !seen.insert(s(i)) || !spec_ids.contains(s(i)) {
                return Err(error("verification_requirement_check"));
            }
            required.insert(s(i));
        }
    }
    if required.is_empty() {
        return Err(error("verification_requirements_empty"));
    }
    let mut unknown_ids = BTreeSet::new();
    for u in unknowns {
        object(
            u,
            &["id", "description", "checkId", "conditions", "status"],
            &["resolution", "waiver"],
        )?;
        id(&u["id"])?;
        text(&u["description"])?;
        if !unknown_ids.insert(s(&u["id"])) {
            return Err(error("verification_duplicate_id"));
        }
        if !spec_ids.contains(s(&u["checkId"])) {
            return Err(error("verification_unknown_check"));
        }
        object(
            &u["conditions"],
            &[
                "inputOrigin",
                "environment",
                "targetKind",
                "fixtureRequired",
                "targetRequired",
            ],
            &[],
        )?;
        scope(&u["conditions"])?;
        if !u["conditions"]["fixtureRequired"].is_boolean()
            || !u["conditions"]["targetRequired"].is_boolean()
        {
            return Err(error("verification_malformed"));
        }
        enum_value(&u["status"], &["open", "resolved", "waived"])?;
        match s(&u["status"]) {
            "open" if u.get("resolution").is_none() && u.get("waiver").is_none() => (),
            "resolved" if u.get("waiver").is_none() => {
                object(
                    &u["resolution"],
                    &["evidenceDigest", "contractDigest", "at"],
                    &[],
                )?;
                if !state::valid_hash(s(&u["resolution"]["evidenceDigest"]))
                    || u["resolution"]["contractDigest"] != contract_digest(w)
                    || !contract::canonical_timestamp(s(&u["resolution"]["at"]))
                {
                    return Err(error("verification_resolution_invalid"));
                }
            }
            "waived" if u.get("resolution").is_none() => {
                object(
                    &u["waiver"],
                    &[
                        "reason",
                        "policy",
                        "contractDigest",
                        "acceptUnknownScope",
                        "at",
                    ],
                    &[],
                )?;
                text(&u["waiver"]["reason"])?;
                text(&u["waiver"]["policy"])?;
                if u["waiver"]["contractDigest"] != contract_digest(w)
                    || !u["waiver"]["acceptUnknownScope"].is_boolean()
                    || !contract::canonical_timestamp(s(&u["waiver"]["at"]))
                {
                    return Err(error("verification_waiver_invalid"));
                }
            }
            _ => return Err(error("verification_transition_invalid")),
        }
    }
    let legacy = list(&w["contract"]["uncertainties"])?;
    let mut classified = BTreeSet::new();
    let mut classified_unknowns = BTreeSet::new();
    for c in list(&v["review"]["classifications"])? {
        object(c, &["uncertaintyIndex", "unknownIds"], &[])?;
        let i = c["uncertaintyIndex"]
            .as_u64()
            .ok_or_else(|| error("verification_classification"))?;
        if i >= legacy.len() as u64 || !classified.insert(i) {
            return Err(error("verification_classification"));
        }
        let ids = list(&c["unknownIds"])?;
        if ids.is_empty()
            || ids
                .iter()
                .any(|i| !unknown_ids.contains(s(i)) || !classified_unknowns.insert(s(i)))
        {
            return Err(error("verification_classification"));
        }
    }
    if classified.len() != legacy.len() {
        return Err(error("verification_classification"));
    }
    if let Some(r) = w.get("verificationCompletion") {
        validate_receipt(w, r)?;
    } else if w["done"] == true {
        return Err(error("verification_receipt_missing"));
    }
    Ok(())
}
pub fn digest(v: &Value) -> String {
    sha256(protocol::canonical_json(v))
}
pub fn contract_digest(w: &Value) -> String {
    let mut v = contract_value(w).clone();
    if let Some(a) = v["unknowns"].as_array_mut() {
        for u in a {
            for k in ["status", "resolution", "waiver"] {
                u.as_object_mut().unwrap().remove(k);
            }
        }
    }
    let checks: Vec<_> = state::checks(w).iter().map(|c| json!({"id":c["id"],"desc":c["desc"],"cmd":c["cmd"],"expect":c["expect"],"manual":c["manual"],"kind":state::kind(c),"expert":c["expert"]})).collect();
    digest(
        &json!({"verification":v,"checks":checks,"required":w["contract"]["required"],"forbidden":w["contract"]["forbidden"],"uncertainties":w["contract"]["uncertainties"]}),
    )
}
pub fn state_digest(w: &Value) -> String {
    let mut state = json!({"contractDigest":contract_digest(w),"checks":w["checks"],"unknowns":contract_value(w)["unknowns"]});
    if let Some(team) = w.get("team") {
        state["team"] = team.clone();
    }
    digest(&state)
}
pub fn invalidate(w: &mut Value) {
    if !active(w) {
        return;
    }
    if let Some(r) = w.as_object_mut().unwrap().remove("verificationCompletion") {
        if !w["verificationHistory"].is_array() {
            w["verificationHistory"] = json!([]);
        }
        let a = w["verificationHistory"].as_array_mut().unwrap();
        a.push(r);
        if a.len() > 64 {
            a.remove(0);
        }
    }
    w["done"] = json!(false);
    w.as_object_mut().unwrap().remove("doneAt");
}
pub fn plan_changed(w: &mut Value) {
    if !active(w) {
        return;
    }
    invalidate(w);
    w.as_object_mut().unwrap().remove("audit");
    if let Some(unknowns) = w["contract"]["integrationVerification"]
        .get_mut("unknowns")
        .and_then(Value::as_array_mut)
    {
        for u in unknowns {
            u["status"] = json!("open");
            u.as_object_mut().unwrap().remove("resolution");
            u.as_object_mut().unwrap().remove("waiver");
        }
    }
}
pub fn evidence_replaced(w: &mut Value, id: &str) {
    if !active(w) {
        return;
    }
    invalidate(w);
    if let Some(unknowns) = w["contract"]["integrationVerification"]
        .get_mut("unknowns")
        .and_then(Value::as_array_mut)
    {
        for u in unknowns {
            if u["checkId"] == id && u["status"] == "resolved" {
                u["status"] = json!("open");
                u.as_object_mut().unwrap().remove("resolution");
            }
        }
    }
}
pub fn required_ids(w: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    if let Some(r) = contract_value(w)["requirements"].as_object() {
        for v in r.values() {
            for id in v["checkIds"].as_array().into_iter().flatten() {
                ids.insert(s(id).to_owned());
            }
        }
    }
    ids
}
pub fn spec<'a>(w: &'a Value, id: &str) -> Option<&'a Value> {
    contract_value(w)["checks"]
        .as_array()?
        .iter()
        .find(|c| c["checkId"] == id)
}
fn observe_ref(cwd: &Path, r: &Value) -> Result<Value> {
    if r.is_null() {
        return Ok(Value::Null);
    }
    let path = cwd.join(s(&r["artifactRef"]));
    let bytes = store::read_regular(&path, MAX_FILE)?;
    let hash = sha256(bytes);
    if r["sha256"] != hash {
        return Err(error("verification_artifact_drift"));
    }
    Ok(json!({"artifactRef":r["artifactRef"],"sha256":hash}))
}
pub fn observe(cwd: &Path, w: &Value) -> Result<Value> {
    if !active(w) {
        return Ok(Value::Null);
    }
    if pending(w) {
        return Err(error("verification_contract_missing"));
    }
    let index = Command::new("/usr/bin/git")
        .args(["ls-files", "--stage"])
        .current_dir(cwd)
        .output()?;
    if !index.status.success() {
        return Err(error("verification_source_unavailable"));
    }
    if String::from_utf8_lossy(&index.stdout)
        .lines()
        .any(|l| l.starts_with("160000 "))
    {
        return Err(error("source_coverage_unsupported"));
    }
    let source = fingerprint::capture_source(cwd)?;
    let mut refs = vec![];
    for c in list(&contract_value(w)["checks"])? {
        refs.push(json!({"checkId":c["checkId"],"fixture":observe_ref(cwd,&c["fixture"])?,"target":observe_ref(cwd,&c["target"])?,"validator":observe_ref(cwd,&c["validator"])?}));
    }
    Ok(json!({"source":source,"refs":refs}))
}
pub fn assert_unchanged(before: &Value, after: &Value) -> Result<()> {
    if before != after {
        return Err(error("verification_execution_drift"));
    }
    Ok(())
}
pub fn bind(w: &Value, check: &str, before: &Value, after: &Value, manual: bool) -> Option<Value> {
    let c = spec(w, check)?;
    let refs = before["refs"]
        .as_array()?
        .iter()
        .find(|r| r["checkId"] == check)?;
    Some(
        json!({"schemaVersion":"gdm-evidence-binding/v1","contractDigest":contract_digest(w),"checkId":check,"scope":c,"sourceBefore":before["source"],"sourceAfter":after["source"],"artifacts":refs,"targetBinding":if !manual && c["targetKind"]=="workspace" && !c["target"].is_null(){"observed"}else{"unverified"},"mode":if manual{"manual"}else{"executed"}}),
    )
}
fn binding_valid(w: &Value, c: &Value) -> bool {
    let e = &c["evidence"];
    let b = &e["verificationBinding"];
    let Some(spec) = spec(w, s(&c["id"])) else {
        return false;
    };
    b["schemaVersion"] == "gdm-evidence-binding/v1"
        && b["contractDigest"] == contract_digest(w)
        && b["checkId"] == c["id"]
        && &b["scope"] == spec
        && b["sourceBefore"] == b["sourceAfter"]
        && source_valid(&b["sourceBefore"])
        && b["artifacts"]["fixture"] == spec["fixture"]
        && b["artifacts"]["target"] == spec["target"]
        && b["artifacts"]["validator"] == spec["validator"]
        && e["manual"] == (b["mode"] == "manual")
        && b["targetBinding"]
            == if c["manual"] != true
                && spec["targetKind"] == "workspace"
                && !spec["target"].is_null()
            {
                "observed"
            } else {
                "unverified"
            }
        && ["manual", "executed"].contains(&s(&b["mode"]))
}
fn conditions_hold(w: &Value, u: &Value) -> bool {
    let Ok(i) = state::check_index(w, s(&u["checkId"])) else {
        return false;
    };
    let c = &w["checks"][i];
    let Some(spec) = spec(w, s(&u["checkId"])) else {
        return false;
    };
    c["status"] == "proven"
        && binding_valid(w, c)
        && ["inputOrigin", "environment", "targetKind"]
            .iter()
            .all(|k| spec[k] == u["conditions"][k] && spec[k] != "unknown")
        && (u["conditions"]["fixtureRequired"] != true || !spec["fixture"].is_null())
        && (u["conditions"]["targetRequired"] != true
            || c["evidence"]["verificationBinding"]["targetBinding"] == "observed")
}
fn scope_unknown(w: &Value, c: &Value) -> bool {
    let Some(spec) = spec(w, s(&c["id"])) else {
        return true;
    };
    spec["inputOrigin"] == "unknown"
        || spec["environment"] == "unknown"
        || spec["fixture"].is_null()
        || spec["targetKind"] != "workspace"
        || c["evidence"]["verificationBinding"]["targetBinding"] != "observed"
}
fn accepted_unknown(w: &Value, id: &str) -> bool {
    contract_value(w)["unknowns"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|u| {
            u["checkId"] == id
                && u["status"] == "waived"
                && u["waiver"]["acceptUnknownScope"] == true
                && u["waiver"]["contractDigest"] == contract_digest(w)
        })
}
pub fn blockers(w: &Value) -> Vec<Value> {
    if !active(w) {
        return vec![];
    }
    if pending(w) {
        return vec![json!({"code":"verification_contract_missing"})];
    }
    let mut out = vec![];
    for u in contract_value(w)["unknowns"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let code = if u["status"] == "open" {
            Some("unresolved_open")
        } else if u["status"] == "resolved"
            && (!conditions_hold(w, u)
                || state::check_index(w, s(&u["checkId"])).is_ok_and(|i| {
                    u["resolution"]["evidenceDigest"] != digest(&w["checks"][i]["evidence"])
                }))
        {
            Some("resolution_stale")
        } else {
            None
        };
        if let Some(code) = code {
            out.push(json!({"code":code,"id":u["id"]}));
        }
    }
    for id in required_ids(w) {
        let Ok(i) = state::check_index(w, &id) else {
            continue;
        };
        let c = &w["checks"][i];
        if c["status"] != "proven" {
            out.push(json!({"code":"required_check_unproven","id":id}));
        } else if !binding_valid(w, c) {
            out.push(json!({"code":"evidence_binding_missing","id":id}));
        }
        if scope_unknown(w, c) && !accepted_unknown(w, &id) {
            out.push(json!({"code":"required_scope_unknown","id":id}));
        }
    }
    out
}
pub fn assert_evidence_current(cwd: &Path, w: &Value, observation: &Value) -> Result<()> {
    for spec in list(&contract_value(w)["checks"])? {
        let id = s(&spec["checkId"]);
        let c = &w["checks"][state::check_index(w, id)?];
        if !binding_valid(w, c)
            || c["evidence"]["verificationBinding"]["sourceAfter"] != observation["source"]
        {
            return Err(error("verification_evidence_stale"));
        }
    }
    if !super::evidence::stale(cwd, w).is_empty() {
        return Err(error("evidence_stale"));
    }
    Ok(())
}
pub fn audit_binding(cwd: &Path, w: &Value) -> Result<Value> {
    let observed = observe(cwd, w)?;
    assert_evidence_current(cwd, w, &observed)?;
    if !blockers(w).is_empty() {
        return Err(error("verification_blocked"));
    }
    Ok(
        json!({"schemaVersion":"gdm-audit-verification/v1","contractDigest":contract_digest(w),"stateDigest":state_digest(w),"observation":observed}),
    )
}
pub fn check_audit(cwd: &Path, w: &Value) -> Result<()> {
    if w["audit"]["verificationBinding"] != audit_binding(cwd, w)? {
        return Err(error("verification_audit_stale"));
    }
    Ok(())
}
pub fn completion(
    w: &Value,
    mode: &str,
    before: &Value,
    after: &Value,
    executions: Vec<Value>,
    at: &str,
) -> Value {
    json!({"schemaVersion":RECEIPT,"mode":mode,"at":at,"contractDigest":contract_digest(w),"stateDigest":state_digest(w),"checkIds":required_ids(w),"sourceBefore":before["source"],"sourceAfter":after["source"],"artifacts":after["refs"],"executions":executions,"auditBinding":if mode=="audit_bound"{w["audit"]["verificationBinding"].clone()}else{Value::Null}})
}
fn validate_receipt(w: &Value, r: &Value) -> Result<()> {
    object(
        r,
        &[
            "schemaVersion",
            "mode",
            "at",
            "contractDigest",
            "stateDigest",
            "checkIds",
            "sourceBefore",
            "sourceAfter",
            "artifacts",
            "executions",
            "auditBinding",
        ],
        &[],
    )?;
    if r["schemaVersion"] != RECEIPT {
        return Err(error("verification_unsupported"));
    }
    if !["validate", "audit_bound"].contains(&s(&r["mode"]))
        || !contract::canonical_timestamp(s(&r["at"]))
        || w["done"] != true
        || w["doneAt"] != r["at"]
        || r["contractDigest"] != contract_digest(w)
        || r["stateDigest"] != state_digest(w)
        || r["checkIds"] != json!(required_ids(w))
        || r["sourceBefore"] != r["sourceAfter"]
        || !source_valid(&r["sourceAfter"])
    {
        return Err(error("verification_receipt_invalid"));
    }
    let expected_artifacts: Vec<_> = contract_value(w)["checks"].as_array().unwrap().iter().map(|c| json!({"checkId":c["checkId"],"fixture":c["fixture"],"target":c["target"],"validator":c["validator"]})).collect();
    if r["artifacts"] != json!(expected_artifacts) {
        return Err(error("verification_receipt_invalid"));
    }
    let executions = list(&r["executions"])?;
    let mut ids = BTreeSet::new();
    for e in executions {
        object(e, &["checkId", "sha256", "exitCode", "binding"], &[])?;
        let i = state::check_index(w, s(&e["checkId"]))?;
        if !ids.insert(s(&e["checkId"]))
            || w["checks"][i]["manual"] == true
            || e["exitCode"] != 0
            || !state::valid_hash(s(&e["sha256"]))
            || e["binding"]
                != bind(
                    w,
                    s(&e["checkId"]),
                    &json!({"source":r["sourceBefore"],"refs":r["artifacts"]}),
                    &json!({"source":r["sourceAfter"]}),
                    false,
                )
                .unwrap_or(Value::Null)
        {
            return Err(error("verification_receipt_invalid"));
        }
    }
    if r["mode"] == "audit_bound" {
        if !executions.is_empty()
            || r["auditBinding"].is_null()
            || r["auditBinding"] != w["audit"]["verificationBinding"]
        {
            return Err(error("verification_receipt_invalid"));
        }
    } else {
        let expected: BTreeSet<_> = state::checks(w)
            .iter()
            .filter(|c| c["status"] == "proven" && c["manual"] != true)
            .map(|c| s(&c["id"]))
            .collect();
        if ids != expected || !r["auditBinding"].is_null() {
            return Err(error("verification_receipt_invalid"));
        }
    }
    Ok(())
}
pub fn summary(cwd: &Path, w: &Value) -> Option<Value> {
    if !active(w) {
        return None;
    }
    let mut blocked = blockers(w);
    let mut limitations = vec![];
    let mut open = 0;
    let mut waived = 0;
    let mut unknown = 0;
    for u in contract_value(w)["unknowns"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if u["status"] == "open" {
            open += 1;
        }
        if u["status"] == "waived" {
            waived += 1;
            limitations.push(json!({"code":"waived_unknown","id":u["id"]}));
        }
    }
    let required = required_ids(w);
    let mut proven = 0;
    for id in &required {
        if let Ok(i) = state::check_index(w, id) {
            let c = &w["checks"][i];
            if c["status"] == "proven" && binding_valid(w, c) {
                proven += 1;
            }
            if scope_unknown(w, c) {
                unknown += 1;
                limitations.push(json!({"code":"target_unverified","id":id}));
            }
            if c["manual"] == true {
                limitations.push(json!({"code":"manual_evidence","id":id}));
            }
            if let Some(scope) = spec(w, id) {
                for (field, prefix) in [
                    ("inputOrigin", "input"),
                    ("environment", "environment"),
                    ("targetKind", "target"),
                ] {
                    let value = s(&scope[field]);
                    if ["synthetic", "mock", "staging", "unknown", "remote", "trace"]
                        .contains(&value)
                    {
                        limitations.push(json!({"code":format!("{prefix}_{value}"),"id":id}));
                    }
                }
            }
        }
    }
    let current = observe(cwd, w);
    if let Err(e) = &current {
        blocked.push(json!({"code":if e.code=="source_coverage_unsupported"{"source_coverage_unsupported"}else{"scope_observation_unavailable"}}));
    } else if !pending(w)
        && proven > 0
        && assert_evidence_current(cwd, w, current.as_ref().unwrap()).is_err()
    {
        blocked.push(json!({"code":"evidence_stale"}));
    }
    let r = w.get("verificationCompletion");
    // Team reports/history live under .gdm and are intentionally outside the
    // source fingerprint. Re-read their independent bindings for a receipt.
    if r.is_some()
        && (!super::team::blockers(w).is_empty() || super::team::verify_artifacts(cwd, w).is_err())
    {
        blocked.push(json!({"code":"team_verification_stale"}));
    }
    let valid = r.is_some_and(|r| {
        validate_receipt(w, r).is_ok()
            && current
                .as_ref()
                .is_ok_and(|v| r["sourceAfter"] == v["source"] && r["artifacts"] == v["refs"])
    }) && (r.is_none_or(|r| r["mode"] != "audit_bound")
        || (check_audit(cwd, w).is_ok()
            && fingerprint::audit_problems(cwd, w).is_ok_and(|p| p.is_empty())))
        && blocked.is_empty()
        && proven == required.len()
        && !required.is_empty();
    if r.is_some() && !valid {
        blocked.push(json!({"code":"completion_stale"}));
    }
    Some(
        json!({"schemaVersion":"gdm-verification-summary/v1","profile":"integration","contractDigest":contract_digest(w),"stateDigest":state_digest(w),"completionDigest":r.map(digest),"completionValid":valid,"completionMode":r.map(|r|r["mode"].clone()),"counts":{"required":required.len(),"proven":proven,"open":open,"waived":waived,"unknown":unknown},"blockers":blocked,"limitations":limitations}),
    )
}
pub fn project(cwd: &Path, w: &mut Value) {
    if let Some(v) = summary(cwd, w) {
        w["verificationSummary"] = v;
    }
}

pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    let (action, args) = args.split_first().ok_or_else(|| error("usage"))?;
    ensure_flags(
        args,
        &["slug", "file", "id", "reason", "policy"],
        &["json", "accept-unknown-scope"],
    )?;
    let mut w = store::resolve(cwd, read_flag(args, "slug")?.as_deref(), true)?;
    if action == "show" {
        if has_flag(args, "json") {
            return print_json(
                &json!({"contract":contract_value(&w),"verificationSummary":summary(cwd,&w),"completion":w["verificationCompletion"]}),
            );
        }
        println!("{}", serde_json::to_string_pretty(contract_value(&w))?);
        return Ok(());
    }
    match action.as_str() {
        "import" => {
            let bytes = store::read_regular(&cwd.join(required_flag(args, "file")?), 1024 * 1024)?;
            let v: Value = serde_json::from_slice(&bytes)?;
            if v["schemaVersion"] != SCHEMA {
                return Err(error("verification_unsupported"));
            }
            if v.get("pending").is_some()
                || v["unknowns"].as_array().into_iter().flatten().any(|u| {
                    u["status"] != "open"
                        || u.get("resolution").is_some()
                        || u.get("waiver").is_some()
                })
            {
                return Err(error("verification_import_disposition"));
            }
            initialize(&mut w);
            invalidate(&mut w);
            w["contract"]["integrationVerification"] = v;
            for check in w["checks"].as_array_mut().unwrap() {
                check["status"] = json!("open");
            }
            // Contract changes invalidate audit and require fresh bound evidence.
            w.as_object_mut().unwrap().remove("audit");
            validate(&w)?;
            observe(cwd, &w)?;
        }
        "resolve" | "waive" => {
            if !active(&w) || pending(&w) {
                return Err(error("verification_contract_missing"));
            }
            let id = required_flag(args, "id")?;
            let index = contract_value(&w)["unknowns"]
                .as_array()
                .unwrap()
                .iter()
                .position(|u| u["id"] == id)
                .ok_or_else(|| error("verification_unknown_id"))?;
            let u = &contract_value(&w)["unknowns"][index];
            if u["status"] != "open" {
                return Err(error("verification_transition_invalid"));
            }
            let mut next = u.clone();
            if action == "resolve" {
                let observation = observe(cwd, &w)?;
                assert_evidence_current(cwd, &w, &observation)?;
                if !conditions_hold(&w, u) {
                    return Err(error("verification_conditions_unsatisfied"));
                }
                let i = state::check_index(&w, s(&u["checkId"]))?;
                next["status"] = json!("resolved");
                next["resolution"] = json!({"contractDigest":contract_digest(&w),"evidenceDigest":digest(&w["checks"][i]["evidence"]),"at":now()});
            } else {
                let reason = required_flag(args, "reason")?;
                let policy = required_flag(args, "policy")?;
                text(&json!(reason))?;
                text(&json!(policy))?;
                next["status"] = json!("waived");
                next["waiver"] = json!({"reason":reason,"policy":policy,"contractDigest":contract_digest(&w),"acceptUnknownScope":has_flag(args,"accept-unknown-scope"),"at":now()});
            }
            invalidate(&mut w);
            w.as_object_mut().unwrap().remove("audit");
            w["contract"]["integrationVerification"]["unknowns"][index] = next;
            validate(&w)?;
        }
        _ => return Err(error("usage")),
    }
    store::append_journal(
        cwd,
        s(&w["slug"]),
        &json!({"ts":now(),"event":"verification.update","action":action,"contractDigest":contract_digest(&w),"stateDigest":state_digest(&w)}),
    )?;
    store::save(cwd, &w)?;
    print_json(&summary(cwd, &w).unwrap())
}
