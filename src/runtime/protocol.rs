//! Provider-neutral dispatch protocol. Journal receipts never bypass work completion gates.
use super::{contract, fingerprint, state, store};
use crate::support::{Error, Result, now, read_flag, required_flag, sha256};
use base64::Engine;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const PROFILE: &str = "gdm-read-only-specialist/v1";
const ARTIFACT_MAX: usize = 1024 * 1024;
const LEGACY_MAX: usize = 16 * 1024 * 1024;
const OUTPUT_MAX: usize = 2 * 1024 * 1024;
const BUNDLE_MAX: usize = 4 * 1024 * 1024;
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn error(code: &str) -> Error {
    Error::new(code, format!("protocol {code}"))
}
fn is_hash(v: &Value) -> bool {
    v.as_str().is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn exact(v: &Value, required: &[&str], optional: &[&str]) -> bool {
    v.as_object().is_some_and(|o| {
        required.iter().all(|k| o.contains_key(*k))
            && o.keys()
                .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
    })
}
fn opaque(value: &str) -> Result<String> {
    contract::opaque_id(value, "protocol")
}
fn party(v: &Value) -> bool {
    exact(v, &["role"], &["provider"])
        && opaque(s(v, "role")).is_ok()
        && (v.get("provider").is_none() || opaque(s(v, "provider")).is_ok())
}
fn relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && !value.starts_with('/')
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && contract::assert_no_sensitive(part, "artifact-component").is_ok()
        })
        && contract::assert_no_sensitive(value, "artifact").is_ok()
}
fn artifact_shape(v: &Value) -> bool {
    exact(v, &["path", "sha256"], &[]) && relative_path(s(v, "path")) && is_hash(&v["sha256"])
}
fn positive(v: &Value) -> bool {
    v.as_u64()
        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
}
fn regex(value: &str, re: &'static str) -> bool {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<BTreeMap<&'static str, regex::Regex>>> =
        std::sync::OnceLock::new();
    let Ok(mut cache) = CACHE.get_or_init(Default::default).lock() else {
        return false;
    };
    cache
        .entry(re)
        .or_insert_with(|| regex::Regex::new(re).expect("static protocol validator"))
        .is_match(value)
}
fn field(value: &Value, field: &str, default: Value) -> Value {
    value.get(field).cloned().unwrap_or(default)
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(v) => {
            let mut keys: Vec<_> = v.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical_json(&v[*k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(v) => format!(
            "[{}]",
            v.iter().map(canonical_json).collect::<Vec<_>>().join(",")
        ),
        _ => serde_json::to_string(value).unwrap(),
    }
}
fn tagged(value: &Value, bytes: &mut Vec<u8>) {
    match value {
        Value::Null => bytes.push(0),
        Value::Bool(v) => bytes.push(if *v { 2 } else { 1 }),
        Value::Number(v) => {
            bytes.push(3);
            let v = v.to_string();
            bytes.extend_from_slice(&(v.len() as u64).to_be_bytes());
            bytes.extend_from_slice(v.as_bytes());
        }
        Value::String(v) => {
            bytes.push(4);
            bytes.extend_from_slice(&(v.len() as u64).to_be_bytes());
            bytes.extend_from_slice(v.as_bytes());
        }
        Value::Array(v) => {
            bytes.push(5);
            bytes.extend_from_slice(&(v.len() as u64).to_be_bytes());
            for v in v {
                tagged(v, bytes);
            }
        }
        Value::Object(v) => {
            bytes.push(6);
            bytes.extend_from_slice(&(v.len() as u64).to_be_bytes());
            let mut keys: Vec<_> = v.keys().collect();
            keys.sort();
            for k in keys {
                tagged(&Value::String(k.clone()), bytes);
                tagged(&v[k], bytes);
            }
        }
    }
}
/// Tagged canonical SHA-256 matches the TypeScript wire contract (not ordinary JSON hashing).
pub fn state_fingerprint(work: &Value) -> String {
    let c = &work["contract"];
    let mut contract = json!({"required":c["required"],"forbidden":c["forbidden"],"activeHabits":c["activeHabits"],"commit":c["commit"],"latestCommitTransition":c["latestCommitTransition"],"assumptions":field(c,"assumptions",json!([])),"uncertainties":field(c,"uncertainties",json!([])),"allowedPaths":field(c,"allowedPaths",json!(["."])),"forbiddenPaths":field(c,"forbiddenPaths",json!([])),"stopConditions":field(c,"stopConditions",json!([])),"risk":field(c,"risk",json!("low")),"verification":field(c,"verification",json!("deterministic")),"simplificationRequired":field(c,"simplificationRequired",json!(false)),"scopeAmendments":field(c,"scopeAmendments",json!([]))});
    if let Some(outcome) = c.get("outcome") {
        contract["outcome"] = outcome.clone();
    }
    let checks:Vec<_>=work["checks"].as_array().into_iter().flatten().map(|check|json!({"id":check["id"],"desc":check["desc"],"cmd":check["cmd"],"expect":check["expect"],"manual":check["manual"],"kind":kind(check),"expert":field(check,"expert",json!(false)),"status":check["status"],"redEvidence":check["redEvidence"],"evidence":check["evidence"]})).collect();
    let mut value = json!({"slug":work["slug"],"brief":work["brief"],"createdAt":work["createdAt"],"done":work["done"],"doneAt":work["doneAt"],"verificationPlanSourceFingerprint":work["verificationPlanSourceFingerprint"],"auditRequired":field(work,"auditRequired",json!(false)),"audit":audit_record(work),"baseline":work["baseline"],"checks":checks,"contract":contract});
    if let Some(team) = work.get("team") {
        value["team"] = team.clone();
    }
    if super::verification::active(work) {
        value["verificationFeature"] = work["verificationFeature"].clone();
        value["integrationVerification"] = work["contract"]["integrationVerification"].clone();
        value["verificationCompletion"] = work["verificationCompletion"].clone();
        value["verificationAudit"] = work["audit"]["verificationBinding"].clone();
    }
    let mut bytes = Vec::new();
    tagged(&json!("gdm-work-state-v1"), &mut bytes);
    tagged(&value, &mut bytes);
    sha256(bytes)
}
fn kind(check: &Value) -> Value {
    field(
        check,
        "kind",
        json!(if check["manual"] == true {
            "manual"
        } else {
            "behavior"
        }),
    )
}
fn audit_record(work: &Value) -> Value {
    let a = &work["audit"];
    if a.is_null() {
        return Value::Null;
    }
    let mut record = json!({"result":a["result"],"report":a["report"],"reportSha256":a["reportSha256"],"implementationModel":a["implementationModel"],"auditModel":a["auditModel"],"workspace":a["workspace"],"stateHash":a["stateHash"],"at":a["at"]});
    if let Some(binding) = a.get("verificationBinding") {
        record["verificationBinding"] = binding.clone();
    }
    record
}
fn evidence(e: &Value) -> Value {
    if e.is_null() {
        Value::Null
    } else {
        let mut value = json!({"observed":e["observed"],"sha256":e["sha256"],"exitCode":e["exitCode"],"manual":e["manual"],"reviewer":e["reviewer"],"notePresent":!s(e,"note").trim().is_empty(),"at":e["at"]});
        if let Some(binding) = e.get("verificationBinding") {
            value["verificationBinding"] = binding.clone();
        }
        value
    }
}
pub(super) fn no_credentials(value: &Value) -> Result<()> {
    match value {
        Value::String(v) => {
            if super::credentials::contains_credentials(v) {
                return Err(error("privacy_rejected"));
            }
        }
        Value::Array(v) => {
            for x in v {
                no_credentials(x)?;
            }
        }
        Value::Object(v) => {
            for x in v.values() {
                no_credentials(x)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn read_artifact(
    cwd: &Path,
    path: &str,
    max: usize,
    code: &str,
    automatic: bool,
) -> Result<(Value, Vec<u8>)> {
    let bytes = store::contained(cwd, path, "artifact", max).map_err(|e| {
        if e.code == "file_too_large" {
            error(code)
        } else {
            e
        }
    })?;
    if automatic {
        let text = std::str::from_utf8(&bytes).map_err(|_| error("artifact_encoding_invalid"))?;
        no_credentials(&json!(text))?;
    }
    Ok((json!({"path":path,"sha256":sha256(&bytes)}), bytes))
}
fn freshness(
    cwd: &Path,
    artifact: &Value,
    output: bool,
    automatic: bool,
) -> Result<Option<String>> {
    if artifact.is_null() {
        return Ok(None);
    }
    let changed = if output {
        "output_changed"
    } else {
        "artifact_changed"
    };
    let missing = if output {
        "output_missing"
    } else {
        "artifact_missing"
    };
    match read_artifact(
        cwd,
        s(artifact, "path"),
        if output {
            OUTPUT_MAX
        } else if automatic {
            ARTIFACT_MAX
        } else {
            LEGACY_MAX
        },
        if output {
            "output_too_large"
        } else {
            "artifact_too_large"
        },
        automatic,
    ) {
        Ok((current, _)) => Ok((current["sha256"] != artifact["sha256"]).then(|| changed.into())),
        Err(e) if e.code == "path_rejected" => Ok(Some(missing.into())),
        Err(e) if output && e.code == "output_too_large" => Ok(Some(changed.into())),
        Err(e) => Err(e),
    }
}
fn assert_artifact(cwd: &Path, handoff: &Value) -> Result<()> {
    if let Some(reason) = freshness(cwd, &handoff["artifact"], false, true)? {
        return Err(error(&reason));
    }
    Ok(())
}
fn current(work: &Value, source: &Value) -> Value {
    json!({"planFingerprint":state::verification_plan_fingerprint(work),"stateFingerprint":state_fingerprint(work),"sourceFingerprint":source["sha256"]})
}
fn assert_fresh(work: &Value, source: &Value, event: &Value) -> Result<()> {
    let actual = current(work, source);
    for (name, code) in [
        ("planFingerprint", "plan_fingerprint_mismatch"),
        ("stateFingerprint", "state_fingerprint_mismatch"),
        ("sourceFingerprint", "source_fingerprint_mismatch"),
    ] {
        if event[name] != actual[name] {
            return Err(error(code));
        }
    }
    Ok(())
}
fn assert_time(at: &str, previous: &str, code: &str) -> Result<()> {
    if !contract::canonical_timestamp(at) {
        return Err(error("usage"));
    }
    if at < previous {
        return Err(error(code));
    }
    Ok(())
}
fn handoff_id(slug: &str, id: &str) -> String {
    format!("h-{}", &sha256(format!("{slug}\0{id}"))[..16])
}
fn receipt_event_id(slug: &str, claim: &str, revision: u64, stage: &str) -> String {
    format!(
        "r-{}",
        &sha256(format!("{slug}\0{claim}\0{revision}\0{stage}"))[..16]
    )
}
fn receipt_id(slug: &str, claim: &str, revision: u64) -> String {
    format!(
        "receipt-{}",
        &sha256(format!("{slug}\0{claim}\0{revision}"))[..16]
    )
}
fn observed_valid(v: &Value) -> bool {
    exact(
        v,
        &[
            "providerTarget",
            "adapterVersion",
            "executable",
            "executableSha256",
            "executableVersion",
            "argvPolicyId",
            "outputArtifact",
            "exitCode",
            "status",
        ],
        &["modelRequested", "failureCode"],
    ) && ["providerTarget", "adapterVersion", "argvPolicyId"]
        .iter()
        .all(|k| opaque(s(v, k)).is_ok())
        && ["modelRequested", "failureCode"]
            .iter()
            .all(|k| v.get(*k).is_none() || opaque(s(v, k)).is_ok())
        && s(v, "executable").starts_with('/')
        && !s(v, "executable").contains('\0')
        && is_hash(&v["executableSha256"])
        && observation_text(s(v, "executableVersion")).is_ok_and(|x| x == s(v, "executableVersion"))
        && artifact_shape(&v["outputArtifact"])
        && v["exitCode"].as_u64().is_some_and(|n| n <= 255)
        && ["succeeded", "blocked", "failed"].contains(&s(v, "status"))
        && (v["status"] != "succeeded" || (v["exitCode"] == 0 && v.get("failureCode").is_none()))
}
fn observation_text(value: &str) -> Result<String> {
    let v = value.trim();
    if v.is_empty()
        || v.encode_utf16().count() > 240
        || value
            .chars()
            .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
    {
        return Err(error("usage"));
    }
    contract::assert_no_sensitive(v, "executable-version")?;
    Ok(v.into())
}
fn handoff_valid(v: &Value) -> bool {
    exact(
        v,
        &[
            "schemaVersion",
            "event",
            "eventId",
            "handoffId",
            "revision",
            "predecessorEventId",
            "ts",
            "slug",
            "from",
            "to",
            "intent",
            "planFingerprint",
            "stateFingerprint",
            "sourceFingerprint",
        ],
        &["artifact"],
    ) && v["schemaVersion"] == "gdm-handoff/v1"
        && v["event"] == "protocol_handoff"
        && regex(s(v, "eventId"), r"^h-[0-9a-f]{16}$")
        && opaque(s(v, "handoffId")).is_ok()
        && positive(&v["revision"])
        && (v["predecessorEventId"].is_null()
            || regex(s(v, "predecessorEventId"), r"^h-[0-9a-f]{16}$"))
        && contract::canonical_timestamp(s(v, "ts"))
        && regex(s(v, "slug"), r"^[a-z0-9][a-z0-9-]{1,50}$")
        && party(&v["from"])
        && party(&v["to"])
        && contract::safe_text(s(v, "intent"), "intent", 240).is_ok_and(|x| x == s(v, "intent"))
        && (v.get("artifact").is_none() || artifact_shape(&v["artifact"]))
        && ["planFingerprint", "stateFingerprint", "sourceFingerprint"]
            .iter()
            .all(|k| is_hash(&v[*k]))
}
fn receipt_valid(v: &Value) -> bool {
    exact(
        v,
        &[
            "schemaVersion",
            "event",
            "eventId",
            "receiptId",
            "revision",
            "predecessorEventId",
            "ts",
            "slug",
            "stage",
            "handoffEventId",
            "claimId",
            "bundleSha256",
            "receiver",
            "capabilityProfile",
            "planFingerprint",
            "stateFingerprint",
            "sourceFingerprint",
        ],
        &["modelRequested", "runnerObserved", "reason"],
    ) && v["schemaVersion"] == "gdm-protocol-receipt/v1"
        && v["event"] == "protocol_receipt"
        && regex(s(v, "eventId"), r"^r-[0-9a-f]{16}$")
        && opaque(s(v, "receiptId")).is_ok()
        && positive(&v["revision"])
        && (v["predecessorEventId"].is_null()
            || regex(s(v, "predecessorEventId"), r"^r-[0-9a-f]{16}$"))
        && contract::canonical_timestamp(s(v, "ts"))
        && regex(s(v, "slug"), r"^[a-z0-9][a-z0-9-]{1,50}$")
        && ["claimed", "exited", "adopted", "abandoned"].contains(&s(v, "stage"))
        && regex(s(v, "handoffEventId"), r"^h-[0-9a-f]{16}$")
        && opaque(s(v, "claimId")).is_ok()
        && party(&v["receiver"])
        && v["capabilityProfile"] == PROFILE
        && (v.get("modelRequested").is_none() || opaque(s(v, "modelRequested")).is_ok())
        && [
            "bundleSha256",
            "planFingerprint",
            "stateFingerprint",
            "sourceFingerprint",
        ]
        .iter()
        .all(|k| is_hash(&v[*k]))
        && (v.get("runnerObserved").is_none() || observed_valid(&v["runnerObserved"]))
        && (matches!(s(v, "stage"), "exited" | "adopted") == v.get("runnerObserved").is_some())
        && ((v["stage"] == "abandoned") == v.get("reason").is_some())
        && (v.get("reason").is_none()
            || contract::safe_text(s(v, "reason"), "reason", 240)
                .is_ok_and(|x| x == s(v, "reason")))
}

/// Validate discriminators, exact fields, deterministic identities, and complete causal chains.
pub fn validate_journal(journal: &[Value]) -> Result<()> {
    let mut handoffs: Vec<&Value> = Vec::new();
    let mut latest = BTreeMap::<String, &Value>::new();
    let mut ids = BTreeSet::new();
    for v in journal {
        let schema = s(v, "schemaVersion");
        let looks = schema.starts_with("gdm-handoff/")
            || schema.starts_with("gdm-protocol-")
            || [
                "handoffId",
                "handoffEventId",
                "claimId",
                "receiptId",
                "bundleSha256",
            ]
            .iter()
            .any(|k| v.get(*k).is_some())
            || ["protocol_handoff", "protocol_receipt"].contains(&s(v, "event"));
        if !looks {
            continue;
        }
        if handoff_valid(v) {
            let prior = handoffs.last().copied();
            if v["eventId"] != handoff_id(s(v, "slug"), s(v, "handoffId"))
                || v["revision"] != (handoffs.len() + 1) as u64
                || v["predecessorEventId"]
                    != prior.map(|p| p["eventId"].clone()).unwrap_or(Value::Null)
                || prior.is_some_and(|p| s(v, "ts") < s(p, "ts"))
                || !ids.insert(s(v, "eventId"))
            {
                return Err(error("state_corrupt"));
            }
            handoffs.push(v);
        } else if receipt_valid(v) {
            let prior = latest.get(s(v, "claimId")).copied();
            let revision = prior.map(|p| p["revision"].as_u64().unwrap()).unwrap_or(0) + 1;
            if v["eventId"]
                != receipt_event_id(s(v, "slug"), s(v, "claimId"), revision, s(v, "stage"))
                || v["revision"] != revision
                || v["predecessorEventId"]
                    != prior.map(|p| p["eventId"].clone()).unwrap_or(Value::Null)
                || !ids.insert(s(v, "eventId"))
            {
                return Err(error("state_corrupt"));
            }
            if let Some(p) = prior {
                if s(v, "ts") < s(p, "ts")
                    || [
                        "handoffEventId",
                        "receiver",
                        "capabilityProfile",
                        "modelRequested",
                        "bundleSha256",
                        "planFingerprint",
                        "stateFingerprint",
                        "sourceFingerprint",
                    ]
                    .iter()
                    .any(|k| v[*k] != p[*k])
                {
                    return Err(error("state_corrupt"));
                }
                if !match s(p, "stage") {
                    "claimed" => matches!(s(v, "stage"), "exited" | "abandoned"),
                    "exited" => v["stage"] == "adopted",
                    _ => false,
                } {
                    return Err(error("state_corrupt"));
                }
            } else if v["stage"] != "claimed" {
                return Err(error("state_corrupt"));
            }
            latest.insert(s(v, "claimId").into(), v);
        } else {
            return Err(error("state_corrupt"));
        }
    }
    Ok(())
}
fn validate_work_journal(work: &Value, journal: &[Value]) -> Result<()> {
    validate_journal(journal)?;
    let handoffs: Vec<_> = journal
        .iter()
        .filter(|v| v["event"] == "protocol_handoff")
        .collect();
    for v in &handoffs {
        if v["slug"] != work["slug"] || s(v, "ts") < s(work, "createdAt") {
            return Err(error("state_corrupt"));
        }
    }
    for v in journal.iter().filter(|v| v["event"] == "protocol_receipt") {
        let handoff = handoffs
            .iter()
            .find(|h| h["eventId"] == v["handoffEventId"])
            .ok_or_else(|| error("state_corrupt"))?;
        if v["slug"] != work["slug"]
            || s(v, "ts") < s(work, "createdAt")
            || s(v, "ts") < s(handoff, "ts")
            || v["receiver"]["role"] != handoff["to"]["role"]
            || (!handoff["to"]["provider"].is_null()
                && v["receiver"]["provider"] != handoff["to"]["provider"])
            || ["planFingerprint", "stateFingerprint", "sourceFingerprint"]
                .iter()
                .any(|k| v[*k] != handoff[*k])
        {
            return Err(error("state_corrupt"));
        }
    }
    Ok(())
}

fn check_completed(cwd: &Path, work: &Value) -> Result<()> {
    super::team::verify_snapshot_artifacts(cwd, work)?;
    if work["done"] != true {
        return Ok(());
    }
    super::team::verify_artifacts(cwd, work)?;
    for c in work["checks"].as_array().into_iter().flatten() {
        for k in ["evidence", "redEvidence"] {
            if let Some(e) = c.get(k) {
                let bytes = store::contained(cwd, s(e, "observed"), "evidence", usize::MAX)
                    .map_err(|_| error("state_corrupt"))?;
                if e["sha256"] != sha256(bytes) {
                    return Err(error("state_corrupt"));
                }
            }
        }
    }
    if let Some(a) = work.get("audit") {
        let bytes = store::contained(cwd, s(a, "report"), "audit report", usize::MAX)
            .map_err(|_| error("state_corrupt"))?;
        if a["reportSha256"] != sha256(bytes) {
            return Err(error("state_corrupt"));
        }
    }
    Ok(())
}
pub fn snapshot(cwd: &Path, work: &Value, source: &Value, journal: &[Value]) -> Result<Value> {
    if !exact(source, &["schemaVersion", "sha256", "fileCount"], &[])
        || source["schemaVersion"] != 1
        || !is_hash(&source["sha256"])
        || source["fileCount"].as_u64().is_none()
        || !contract::canonical_timestamp(s(work, "createdAt"))
        || work
            .get("doneAt")
            .is_some_and(|v| !v.as_str().is_some_and(contract::canonical_timestamp))
    {
        return Err(error("state_corrupt"));
    }
    validate_work_journal(work, journal)?;
    check_completed(cwd, work)?;
    let fp = current(work, source);
    let blockers = state::completion_blockers(work);
    let c = &work["contract"];
    let required = work["auditRequired"] == true || c["risk"] == "high";
    let audit = if !required {
        json!({"required":false,"state":"not-required","record":null})
    } else {
        json!({"required":true,"state":if work["audit"].is_null(){"missing"}else if work["audit"]["result"]!="pass"{"failed"}else if work["audit"]["stateHash"]!=state::checks_hash(work){"stale"}else{"passed-recorded"},"record":audit_record(work)})
    };
    let phase = if work["done"] == true {
        "completed"
    } else if work["checks"].as_array().is_none_or(|x| x.is_empty()) {
        "planning"
    } else if !blockers.is_empty() && blockers.iter().all(|b| s(b, "code").starts_with("audit_")) {
        "auditing"
    } else {
        "executing"
    };
    let mut contract = json!({"required":c["required"],"forbidden":c["forbidden"],"assumptions":field(c,"assumptions",json!([])),"uncertainties":field(c,"uncertainties",json!([])),"allowedPaths":field(c,"allowedPaths",json!(["."])),"forbiddenPaths":field(c,"forbiddenPaths",json!([])),"stopConditions":field(c,"stopConditions",json!([])),"risk":field(c,"risk",json!("low")),"verification":field(c,"verification",json!("deterministic")),"simplificationRequired":field(c,"simplificationRequired",json!(false)),"activeHabits":c["activeHabits"],"commit":{"state":c["commit"],"latestTransition":c["latestCommitTransition"]},"scopeAmendments":field(c,"scopeAmendments",json!([]))});
    if let Some(outcome) = c.get("outcome") {
        contract["outcome"] = outcome.clone();
    }
    let checks:Vec<_>=work["checks"].as_array().into_iter().flatten().map(|c|json!({"id":c["id"],"kind":kind(c),"description":c["desc"],"status":c["status"],"command":c["cmd"],"expect":c["expect"],"manual":c["manual"],"expert":field(c,"expert",json!(false)),"redEvidence":evidence(&c["redEvidence"]),"evidence":evidence(&c["evidence"])})).collect();
    let latest = if let Some(h) = journal
        .iter()
        .rev()
        .find(|v| v["event"] == "protocol_handoff")
    {
        let reasons = stale_reasons(cwd, h, &fp, false, false)?;
        json!({"eventId":h["eventId"],"handoffId":h["handoffId"],"revision":h["revision"],"predecessorEventId":h["predecessorEventId"],"ts":h["ts"],"from":h["from"],"to":h["to"],"intent":h["intent"],"artifact":h["artifact"],"planFingerprint":h["planFingerprint"],"stateFingerprint":h["stateFingerprint"],"sourceFingerprint":h["sourceFingerprint"],"stale":!reasons.is_empty(),"staleReasons":reasons})
    } else {
        Value::Null
    };
    let value = json!({"schemaVersion":"gdm-work-snapshot/v1","work":{"slug":work["slug"],"brief":work["brief"],"createdAt":work["createdAt"],"doneAt":work["doneAt"],"phase":phase,"planFingerprint":fp["planFingerprint"],"stateFingerprint":fp["stateFingerprint"],"planSourceFingerprint":work["verificationPlanSourceFingerprint"],"sourceFingerprint":source},"contract":contract,"checks":checks,"audit":audit,"completion":{"state":if work["done"]==true{"completed"}else if blockers.is_empty(){"ready-to-validate"}else{"blocked"},"blockers":blockers,"validationCommand":if work["done"]==true{Value::Null}else{json!(format!("gdm done --slug {}",s(work,"slug"))) }},"latestHandoff":latest});
    let mut value = value;
    if let Some(summary) = super::verification::summary(cwd, work) {
        value["verificationSummary"] = summary;
        value["contract"]["integrationVerification"] =
            work["contract"]["integrationVerification"].clone();
        value["completion"]["receipt"] = work["verificationCompletion"].clone();
    }
    if let Some(team) = work.get("team") {
        value["team"] = team.clone();
        value["coordination"] = super::team::summary(work);
    }
    no_credentials(&value)?;
    Ok(value)
}
fn stale_reasons(
    cwd: &Path,
    event: &Value,
    fp: &Value,
    output: bool,
    automatic: bool,
) -> Result<Vec<String>> {
    let mut reasons = Vec::new();
    for (k, reason) in [
        ("planFingerprint", "plan_changed"),
        ("stateFingerprint", "state_changed"),
        ("sourceFingerprint", "source_changed"),
    ] {
        if event[k] != fp[k] {
            reasons.push(reason.into());
        }
    }
    if let Some(reason) = freshness(
        cwd,
        if output {
            &event["runnerObserved"]["outputArtifact"]
        } else {
            &event["artifact"]
        },
        output,
        automatic,
    )? {
        reasons.push(reason);
    }
    Ok(reasons)
}

fn require_handoff<'a>(journal: &'a [Value], id: &str) -> Result<&'a Value> {
    opaque(id)?;
    journal
        .iter()
        .find(|v| v["event"] == "protocol_handoff" && v["eventId"] == id)
        .ok_or_else(|| error("handoff_not_found"))
}
fn latest_receipts(journal: &[Value]) -> Vec<&Value> {
    let mut result: Vec<&Value> = Vec::new();
    for event in journal.iter().filter(|v| v["event"] == "protocol_receipt") {
        if let Some(index) = result.iter().position(|v| v["claimId"] == event["claimId"]) {
            result[index] = event;
        } else {
            result.push(event);
        }
    }
    result
}
fn require_receipt<'a>(journal: &'a [Value], id: &str) -> Result<&'a Value> {
    opaque(id)?;
    latest_receipts(journal)
        .into_iter()
        .find(|v| v["claimId"] == id)
        .ok_or_else(|| error("claim_not_found"))
}

fn bundle(
    cwd: &Path,
    work: &Value,
    source: &Value,
    journal: &[Value],
    handoff: &Value,
    claim: &str,
    role: &str,
) -> Result<Value> {
    let artifact = if handoff.get("artifact").is_some() {
        let (mut descriptor, bytes) = read_artifact(
            cwd,
            s(&handoff["artifact"], "path"),
            ARTIFACT_MAX,
            "artifact_too_large",
            true,
        )
        .map_err(|e| {
            if e.code == "path_rejected" {
                error("artifact_missing")
            } else {
                e
            }
        })?;
        if descriptor["sha256"] != handoff["artifact"]["sha256"] {
            return Err(error("artifact_changed"));
        }
        descriptor["text"] = std::str::from_utf8(&bytes)
            .map_err(|_| error("artifact_encoding_invalid"))?
            .into();
        descriptor["bytesBase64"] = base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into();
        descriptor
    } else {
        Value::Null
    };
    let mut value = json!({"schemaVersion":"gdm-dispatch-bundle/v1","claimId":claim,"handoff":handoff,"snapshot":snapshot(cwd,work,source,journal)?,"receiver":{"role":role},"capabilityProfile":PROFILE,"artifact":artifact});
    let payload = canonical_json(&value);
    value["bundleSha256"] = sha256(payload).into();
    if canonical_json(&value).len() > BUNDLE_MAX {
        return Err(error("bundle_too_large"));
    }
    validate_bundle(&value)?;
    Ok(value)
}
pub fn validate_bundle(value: &Value) -> Result<()> {
    if !exact(
        value,
        &[
            "schemaVersion",
            "claimId",
            "handoff",
            "snapshot",
            "receiver",
            "capabilityProfile",
            "artifact",
            "bundleSha256",
        ],
        &[],
    ) || !is_hash(&value["bundleSha256"])
    {
        return Err(error("bundle_mismatch"));
    }
    let mut payload = value.clone();
    payload.as_object_mut().unwrap().remove("bundleSha256");
    if value["bundleSha256"] != sha256(canonical_json(&payload)) {
        return Err(error("bundle_mismatch"));
    }
    let a = &value["artifact"];
    if !a.is_null() {
        if !exact(a, &["path", "sha256", "text", "bytesBase64"], &[]) {
            return Err(error("bundle_mismatch"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s(a, "bytesBase64"))
            .map_err(|_| error("bundle_mismatch"))?;
        if base64::engine::general_purpose::STANDARD.encode(&bytes) != s(a, "bytesBase64")
            || a["sha256"] != sha256(&bytes)
            || std::str::from_utf8(&bytes).ok() != a["text"].as_str()
        {
            return Err(error("bundle_mismatch"));
        }
    }
    Ok(())
}
fn project_model_view(mut bundle: Value) -> Result<Value> {
    validate_bundle(&bundle)?;
    bundle["schemaVersion"] = "gdm-dispatch-model-view/v1".into();
    if let Some(a) = bundle["artifact"].as_object_mut() {
        a.remove("bytesBase64");
    }
    Ok(bundle)
}
fn next_receipt(prior: &Value, stage: &str, at: &str) -> Value {
    let revision = prior["revision"].as_u64().unwrap() + 1;
    let mut value = prior.clone();
    value["eventId"] =
        receipt_event_id(s(prior, "slug"), s(prior, "claimId"), revision, stage).into();
    value["receiptId"] = receipt_id(s(prior, "slug"), s(prior, "claimId"), revision).into();
    value["revision"] = revision.into();
    value["predecessorEventId"] = prior["eventId"].clone();
    value["ts"] = at.into();
    value["stage"] = stage.into();
    if stage != "exited" && stage != "adopted" {
        value.as_object_mut().unwrap().remove("runnerObserved");
    }
    if stage != "abandoned" {
        value.as_object_mut().unwrap().remove("reason");
    }
    value
}
fn append_event(cwd: &Path, work: &Value, journal: &[Value], event: &Value) -> Result<()> {
    let mut all = journal.to_vec();
    all.push(event.clone());
    validate_work_journal(work, &all)?;
    store::append_journal(cwd, s(work, "slug"), event)
}
fn grammar(args: &[String], valued: &[&str], booleans: &[&str]) -> Result<()> {
    let mut i = 0;
    let mut seen = BTreeSet::new();
    while i < args.len() {
        let token = args[i].strip_prefix("--").ok_or_else(|| error("usage"))?;
        let (key, value) = token
            .split_once('=')
            .map_or((token, None), |(k, v)| (k, Some(v)));
        if !seen.insert(key) {
            return Err(error("usage"));
        }
        if valued.contains(&key) {
            if value.is_none() {
                i += 1;
                if args.get(i).is_none_or(|v| v.starts_with("--")) {
                    return Err(error("usage"));
                }
            }
        } else if !booleans.contains(&key) || value.is_some() {
            return Err(error("usage"));
        }
        i += 1;
    }
    Ok(())
}
fn assert_expected_flags(args: &[String], fp: &Value, required: bool) -> Result<()> {
    for (flag, key, code) in [
        (
            "expected-plan-fingerprint",
            "planFingerprint",
            "plan_fingerprint_mismatch",
        ),
        (
            "expected-state-fingerprint",
            "stateFingerprint",
            "state_fingerprint_mismatch",
        ),
        (
            "expected-source-fingerprint",
            "sourceFingerprint",
            "source_fingerprint_mismatch",
        ),
    ] {
        let expected = read_flag(args, flag)?;
        if required && expected.is_none() {
            return Err(error("usage"));
        }
        if let Some(value) = expected {
            if !is_hash(&json!(value)) {
                return Err(error("usage"));
            }
            if fp[key] != value {
                return Err(error(code));
            }
        }
    }
    Ok(())
}

pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    let (command, args) = args.split_first().ok_or_else(|| error("usage"))?;
    let export = [
        "slug",
        "expected-plan-fingerprint",
        "expected-state-fingerprint",
        "expected-source-fingerprint",
    ];
    let offer = [
        "slug",
        "handoff-id",
        "from-role",
        "from-provider",
        "to-role",
        "to-provider",
        "intent",
        "artifact",
        "expected-plan-fingerprint",
        "expected-state-fingerprint",
        "expected-source-fingerprint",
    ];
    match command.as_str() {
        "export" => grammar(args, &export, &[])?,
        "handoff" | "offer" => grammar(args, &offer, &[])?,
        "claim" => grammar(
            args,
            &[
                "slug",
                "handoff-event-id",
                "claim-id",
                "receiver-role",
                "receiver-provider",
                "capability-profile",
                "model-requested",
            ],
            &["model-view"],
        )?,
        "finish" => grammar(
            args,
            &[
                "slug",
                "claim-id",
                "exit-code",
                "output-artifact",
                "provider-target",
                "adapter-version",
                "executable",
                "executable-sha256",
                "executable-version",
                "argv-policy-id",
                "model-requested",
                "failure-code",
            ],
            &[],
        )?,
        "adopt" => grammar(args, &["slug", "claim-id"], &[])?,
        "recover" => grammar(args, &["slug", "claim-id", "reason"], &[])?,
        "status" => grammar(args, &["slug"], &[])?,
        _ => return Err(error("usage")),
    }
    let slug = read_flag(args, "slug")?;
    if !matches!(command.as_str(), "export" | "status") && slug.is_none() {
        return Err(error("usage"));
    }
    let work = store::resolve(cwd, slug.as_deref(), true)?;
    let journal = store::read_journal(cwd, s(&work, "slug"))?;
    validate_work_journal(&work, &journal)?;
    // Recovery only releases an abandoned claim; changed or unreadable source must not trap it.
    let source = if command == "recover" {
        Value::Null
    } else {
        fingerprint::capture_source(cwd)?
    };
    let at = now();
    let value = match command.as_str() {
        "export" => {
            let value = snapshot(cwd, &work, &source, &journal)?;
            assert_expected_flags(args, &current(&work, &source), false)?;
            value
        }
        "handoff" | "offer" => {
            offer_handoff(cwd, &work, &source, &journal, args, &at, command == "offer")?
        }
        "claim" => claim(cwd, &work, &source, &journal, args, &at)?,
        "finish" => finish(cwd, &work, &source, &journal, args, &at)?,
        "adopt" => adopt(cwd, &work, &source, &journal, args, &at)?,
        "recover" => recover(cwd, &work, &journal, args, &at)?,
        "status" => status(cwd, &work, &source, &journal)?,
        _ => unreachable!(),
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn offer_handoff(
    cwd: &Path,
    work: &Value,
    source: &Value,
    journal: &[Value],
    args: &[String],
    at: &str,
    automatic: bool,
) -> Result<Value> {
    let id = opaque(&required_flag(args, "handoff-id")?)?;
    let mut from = json!({"role":opaque(&required_flag(args,"from-role")?)?});
    let mut to = json!({"role":opaque(&required_flag(args,"to-role")?)?});
    for (key, party) in [("from-provider", &mut from), ("to-provider", &mut to)] {
        if let Some(value) = read_flag(args, key)? {
            party["provider"] = opaque(&value)?.into();
        }
    }
    let intent = contract::safe_text(&required_flag(args, "intent")?, "intent", 240)?;
    let fp = current(work, source);
    assert_expected_flags(args, &fp, automatic)?;
    let artifact = if let Some(path) = read_flag(args, "artifact")? {
        Some(
            read_artifact(
                cwd,
                &path,
                if automatic { ARTIFACT_MAX } else { LEGACY_MAX },
                "artifact_too_large",
                automatic,
            )?
            .0,
        )
    } else {
        None
    };
    if let Some(replay) = journal
        .iter()
        .find(|v| v["event"] == "protocol_handoff" && v["handoffId"] == id)
    {
        if replay["from"] != from
            || replay["to"] != to
            || replay["intent"] != intent
            || replay.get("artifact") != artifact.as_ref()
            || ["planFingerprint", "stateFingerprint", "sourceFingerprint"]
                .iter()
                .any(|k| replay[*k] != fp[*k])
        {
            return Err(error("handoff_id_conflict"));
        }
        return Ok(replay.clone());
    }
    let latest = journal
        .iter()
        .rev()
        .find(|v| v["event"] == "protocol_handoff");
    assert_time(
        at,
        latest.map(|v| s(v, "ts")).unwrap_or(s(work, "createdAt")),
        "handoff_time_invalid",
    )?;
    let mut event = json!({"schemaVersion":"gdm-handoff/v1","event":"protocol_handoff","eventId":handoff_id(s(work,"slug"),&id),"handoffId":id,"revision":latest.map(|v|v["revision"].as_u64().unwrap()).unwrap_or(0)+1,"predecessorEventId":latest.map(|v|v["eventId"].clone()).unwrap_or(Value::Null),"ts":at,"slug":work["slug"],"from":from,"to":to,"intent":intent,"planFingerprint":fp["planFingerprint"],"stateFingerprint":fp["stateFingerprint"],"sourceFingerprint":fp["sourceFingerprint"]});
    if let Some(artifact) = artifact {
        event["artifact"] = artifact;
    }
    append_event(cwd, work, journal, &event)?;
    Ok(event)
}

fn claim(
    cwd: &Path,
    work: &Value,
    source: &Value,
    journal: &[Value],
    args: &[String],
    at: &str,
) -> Result<Value> {
    let handoff_id = opaque(&required_flag(args, "handoff-event-id")?)?;
    let id = opaque(&required_flag(args, "claim-id")?)?;
    let role = opaque(&required_flag(args, "receiver-role")?)?;
    let provider = read_flag(args, "receiver-provider")?
        .map(|v| opaque(&v))
        .transpose()?;
    let model = read_flag(args, "model-requested")?
        .map(|v| opaque(&v))
        .transpose()?;
    if required_flag(args, "capability-profile")? != PROFILE {
        return Err(error("capability_unsupported"));
    }
    let handoff = require_handoff(journal, &handoff_id)?;
    assert_time(at, s(handoff, "ts"), "receipt_time_invalid")?;
    assert_fresh(work, source, handoff)?;
    if handoff["to"]["role"] != role
        || handoff["to"]
            .get("provider")
            .is_some_and(|v| v.as_str() != provider.as_deref())
    {
        return Err(error("receiver_mismatch"));
    }
    let receipts = latest_receipts(journal);
    let existing = receipts.iter().find(|r| r["claimId"] == id).copied();
    if let Some(existing) = existing {
        if existing["handoffEventId"] != handoff_id
            || existing["receiver"]["role"] != role
            || existing["receiver"]["provider"].as_str() != provider.as_deref()
            || existing["modelRequested"].as_str() != model.as_deref()
        {
            return Err(error("claim_id_conflict"));
        }
        if existing["stage"] != "claimed" {
            return Err(error("receipt_transition"));
        }
    } else if receipts.iter().any(|r| {
        r["handoffEventId"] == handoff_id && r["claimId"] != id && r["stage"] != "abandoned"
    }) {
        return Err(error("claim_conflict"));
    }
    let bundle = bundle(cwd, work, source, journal, handoff, &id, &role)?;
    if let Some(existing) = existing {
        if existing["bundleSha256"] != bundle["bundleSha256"] {
            return Err(error("bundle_mismatch"));
        }
    } else {
        let mut receiver = json!({"role":role});
        if let Some(provider) = provider {
            receiver["provider"] = provider.into();
        }
        let mut event = json!({"schemaVersion":"gdm-protocol-receipt/v1","event":"protocol_receipt","eventId":receipt_event_id(s(work,"slug"),&id,1,"claimed"),"receiptId":receipt_id(s(work,"slug"),&id,1),"revision":1,"predecessorEventId":null,"ts":at,"slug":work["slug"],"stage":"claimed","handoffEventId":handoff_id,"claimId":id,"bundleSha256":bundle["bundleSha256"],"receiver":receiver,"capabilityProfile":PROFILE,"planFingerprint":handoff["planFingerprint"],"stateFingerprint":handoff["stateFingerprint"],"sourceFingerprint":handoff["sourceFingerprint"]});
        if let Some(model) = model {
            event["modelRequested"] = model.into();
        }
        append_event(cwd, work, journal, &event)?;
    }
    if args.iter().any(|a| a == "--model-view") {
        project_model_view(bundle)
    } else {
        Ok(bundle)
    }
}

fn ack_status(output: &str, prior: &Value) -> &'static str {
    let Some(line) = output.lines().map(str::trim).rfind(|s| !s.is_empty()) else {
        return "invalid";
    };
    let Some(raw) = line.strip_prefix("GDM_RECEIVER_ACK_V1=") else {
        return "invalid";
    };
    let Ok(ack) = serde_json::from_str::<Value>(raw) else {
        return "invalid";
    };
    if !exact(
        &ack,
        &[
            "bundleSha256",
            "claimId",
            "disposition",
            "handoffEventId",
            "schemaVersion",
        ],
        &[],
    ) || ack["schemaVersion"] != "gdm-receiver-ack/v1"
        || ["bundleSha256", "claimId", "handoffEventId"]
            .iter()
            .any(|k| ack[*k] != prior[*k])
    {
        return "invalid";
    }
    match s(&ack, "disposition") {
        "completed" => "succeeded",
        "blocked" => "blocked",
        _ => "invalid",
    }
}
fn rejected(event: &Value) -> Option<&'static str> {
    match s(&event["runnerObserved"], "failureCode") {
        "receiver_ack_invalid" => Some("receiver_ack_invalid"),
        "provider_executable_changed" => Some("provider_executable_changed"),
        _ => {
            if event["runnerObserved"]["status"] == "blocked" {
                Some("receiver_blocked")
            } else {
                None
            }
        }
    }
}
fn finish(
    cwd: &Path,
    work: &Value,
    source: &Value,
    journal: &[Value],
    args: &[String],
    at: &str,
) -> Result<Value> {
    let id = required_flag(args, "claim-id")?;
    let prior = require_receipt(journal, &id)?;
    assert_time(at, s(prior, "ts"), "receipt_time_invalid")?;
    let raw_exit = required_flag(args, "exit-code")?;
    if !regex(&raw_exit, r"^\d{1,3}$") {
        return Err(error("usage"));
    }
    let exit = raw_exit
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= 255)
        .ok_or_else(|| error("usage"))?;
    let (artifact, bytes) = read_artifact(
        cwd,
        &required_flag(args, "output-artifact")?,
        OUTPUT_MAX,
        "output_too_large",
        false,
    )?;
    let status = if exit == 0 {
        ack_status(&String::from_utf8_lossy(&bytes), prior)
    } else {
        "failed"
    };
    let invalid = status == "invalid";
    let executable = required_flag(args, "executable")?;
    if !executable.starts_with('/') || executable.contains('\0') {
        return Err(error("usage"));
    }
    let executable_hash = required_flag(args, "executable-sha256")?;
    if !is_hash(&json!(executable_hash)) {
        return Err(error("usage"));
    }
    let mut observed = json!({"providerTarget":opaque(&required_flag(args,"provider-target")?)?,"adapterVersion":opaque(&required_flag(args,"adapter-version")?)?,"executable":executable,"executableSha256":executable_hash,"executableVersion":observation_text(&required_flag(args,"executable-version")?)?,"argvPolicyId":opaque(&required_flag(args,"argv-policy-id")?)?,"outputArtifact":artifact,"exitCode":exit,"status":if invalid{"failed"}else{status}});
    if let Some(model) = read_flag(args, "model-requested")? {
        observed["modelRequested"] = opaque(&model)?.into();
    }
    if invalid {
        observed["failureCode"] = "receiver_ack_invalid".into();
    } else if let Some(code) = read_flag(args, "failure-code")? {
        observed["failureCode"] = opaque(&code)?.into();
    }
    if observed["status"] != "failed" && observed.get("failureCode").is_some()
        || observed["failureCode"] == "provider_executable_changed" && exit != 70
    {
        return Err(error("runner_observation_invalid"));
    }
    if !prior["receiver"]["provider"].is_null()
        && prior["receiver"]["provider"] != observed["providerTarget"]
        || prior["modelRequested"] != observed["modelRequested"]
    {
        return Err(error("receiver_mismatch"));
    }
    let event = if let Some(existing) = journal
        .iter()
        .find(|v| v["event"] == "protocol_receipt" && v["claimId"] == id && v["stage"] == "exited")
    {
        if canonical_json(&existing["runnerObserved"]) != canonical_json(&observed) {
            return Err(error("receipt_conflict"));
        }
        existing.clone()
    } else {
        if prior["stage"] != "claimed" {
            return Err(error("receipt_transition"));
        }
        assert_fresh(work, source, prior)?;
        assert_artifact(cwd, require_handoff(journal, s(prior, "handoffEventId"))?)?;
        let mut event = next_receipt(prior, "exited", at);
        event["runnerObserved"] = observed;
        append_event(cwd, work, journal, &event)?;
        event
    };
    if let Some(code) = rejected(&event) {
        return Err(error(code));
    }
    Ok(event)
}

fn adopt(
    cwd: &Path,
    work: &Value,
    source: &Value,
    journal: &[Value],
    args: &[String],
    at: &str,
) -> Result<Value> {
    let id = required_flag(args, "claim-id")?;
    let prior = require_receipt(journal, &id)?;
    assert_time(at, s(prior, "ts"), "receipt_time_invalid")?;
    if !matches!(s(prior, "stage"), "exited" | "adopted")
        || prior["runnerObserved"]["status"] != "succeeded"
    {
        return Err(error("receipt_transition"));
    }
    assert_fresh(work, source, prior)?;
    if let Some(reason) = freshness(cwd, &prior["runnerObserved"]["outputArtifact"], true, false)? {
        return Err(error(&reason));
    }
    assert_artifact(cwd, require_handoff(journal, s(prior, "handoffEventId"))?)?;
    if prior["stage"] == "adopted" {
        return Ok(prior.clone());
    }
    let event = next_receipt(prior, "adopted", at);
    append_event(cwd, work, journal, &event)?;
    Ok(event)
}
fn recover(
    cwd: &Path,
    work: &Value,
    journal: &[Value],
    args: &[String],
    at: &str,
) -> Result<Value> {
    let id = required_flag(args, "claim-id")?;
    let prior = require_receipt(journal, &id)?;
    assert_time(at, s(prior, "ts"), "receipt_time_invalid")?;
    let reason = contract::safe_text(&required_flag(args, "reason")?, "reason", 240)?;
    if let Some(existing) = journal.iter().find(|v| {
        v["event"] == "protocol_receipt" && v["claimId"] == id && v["stage"] == "abandoned"
    }) {
        if existing["reason"] != reason {
            return Err(error("receipt_conflict"));
        }
        return Ok(existing.clone());
    }
    if prior["stage"] != "claimed" {
        return Err(error("receipt_transition"));
    }
    let mut event = next_receipt(prior, "abandoned", at);
    event["reason"] = reason.into();
    append_event(cwd, work, journal, &event)?;
    Ok(event)
}
fn status(cwd: &Path, work: &Value, source: &Value, journal: &[Value]) -> Result<Value> {
    let fp = current(work, source);
    let mut values = Vec::new();
    for event in latest_receipts(journal) {
        let mut reasons = stale_reasons(cwd, event, &fp, true, false)?;
        let h = require_handoff(journal, s(event, "handoffEventId"))?;
        if let Some(reason) = freshness(cwd, &h["artifact"], false, true)? {
            let insert = reasons
                .iter()
                .position(|r| r.starts_with("output_"))
                .unwrap_or(reasons.len());
            reasons.insert(insert, reason);
        }
        values.push(json!({"claimId":event["claimId"],"stage":event["stage"],"handoffEventId":event["handoffEventId"],"bundleSha256":event["bundleSha256"],"receiver":event["receiver"],"capabilityProfile":PROFILE,"runnerObserved":event["runnerObserved"],"stale":!reasons.is_empty(),"staleReasons":reasons}));
    }
    Ok(json!({"schemaVersion":"gdm-protocol-status/v1","slug":work["slug"],"lifecycles":values}))
}

#[cfg(test)]
mod tests {
    use super::*;
    const AT: &str = "2026-09-21T00:00:01.000Z";
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).into()).collect()
    }
    fn fixture() -> (tempfile::TempDir, Value, Value) {
        let repo = tempfile::tempdir().unwrap();
        let work = json!({"slug":"test-work","brief":"native protocol parity","createdAt":"2026-09-21T00:00:00.000Z","done":false,"checks":[{"id":"c1","desc":"manual proof","cmd":null,"expect":"inspected","manual":true,"status":"open"}],"contract":contract::default_contract()});
        store::save(repo.path(), &work).unwrap();
        let source = json!({"schemaVersion":1,"sha256":"a".repeat(64),"fileCount":1});
        (repo, work, source)
    }
    fn offered(cwd: &Path, work: &Value, source: &Value) -> Value {
        offer_handoff(
            cwd,
            work,
            source,
            &[],
            &args(&[
                "--handoff-id",
                "handoff-one",
                "--from-role",
                "coordinator",
                "--to-role",
                "reviewer",
                "--to-provider",
                "claude",
                "--intent",
                "Review current work",
            ]),
            AT,
            false,
        )
        .unwrap()
    }
    fn claimed(cwd: &Path, work: &Value, source: &Value, handoff: &Value) -> Value {
        let journal = store::read_journal(cwd, "test-work").unwrap();
        claim(
            cwd,
            work,
            source,
            &journal,
            &args(&[
                "--handoff-event-id",
                s(handoff, "eventId"),
                "--claim-id",
                "claim-one",
                "--receiver-role",
                "reviewer",
                "--receiver-provider",
                "claude",
                "--capability-profile",
                PROFILE,
            ]),
            AT,
        )
        .unwrap()
    }
    fn finish_args() -> Vec<String> {
        args(&[
            "--claim-id",
            "claim-one",
            "--exit-code",
            "0",
            "--output-artifact",
            ".gdm/test-work/out/result.txt",
            "--provider-target",
            "claude",
            "--adapter-version",
            "adapter-v1",
            "--executable",
            "/usr/bin/true",
            "--executable-sha256",
            &"b".repeat(64),
            "--executable-version",
            "test version 1",
            "--argv-policy-id",
            "readonly-v1",
        ])
    }
    fn write_ack(cwd: &Path, bundle: &Value, disposition: &str) {
        let ack = json!({"schemaVersion":"gdm-receiver-ack/v1","claimId":bundle["claimId"],"bundleSha256":bundle["bundleSha256"],"handoffEventId":bundle["handoff"]["eventId"],"disposition":disposition});
        std::fs::write(
            cwd.join(".gdm/test-work/out/result.txt"),
            format!("Review result\nGDM_RECEIVER_ACK_V1={ack}\n"),
        )
        .unwrap();
    }
    #[test]
    fn state_fingerprint_matches_typescript_fixture() {
        let (_, work, _) = fixture();
        assert_eq!(
            state_fingerprint(&work),
            "e355bbe36530e474155511a9a449f277f47f7ab451c69987f8e9a2672ce528ec"
        );
        let mut w = work;
        w["delivery"] = json!({"head":"ignored"});
        assert_eq!(
            state_fingerprint(&w),
            "e355bbe36530e474155511a9a449f277f47f7ab451c69987f8e9a2672ce528ec"
        );
    }
    #[test]
    fn complete_receipt_is_adoptable_but_does_not_complete_work() {
        let (repo, work, source) = fixture();
        let h = offered(repo.path(), &work, &source);
        let bundle = claimed(repo.path(), &work, &source, &h);
        validate_bundle(&bundle).unwrap();
        write_ack(repo.path(), &bundle, "completed");
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        let exited = finish(repo.path(), &work, &source, &j, &finish_args(), AT).unwrap();
        assert_eq!(exited["runnerObserved"]["status"], "succeeded");
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        let adopted = adopt(
            repo.path(),
            &work,
            &source,
            &j,
            &args(&["--claim-id", "claim-one"]),
            AT,
        )
        .unwrap();
        assert_eq!(adopted["stage"], "adopted");
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        let replay = adopt(
            repo.path(),
            &work,
            &source,
            &j,
            &args(&["--claim-id", "claim-one"]),
            AT,
        )
        .unwrap();
        assert_eq!(adopted, replay);
        assert_eq!(j.len(), 4);
        assert_eq!(
            store::load(repo.path(), "test-work").unwrap()["done"],
            false
        );
    }
    #[test]
    fn missing_ack_is_recorded_as_failed_and_cannot_be_adopted() {
        let (repo, work, source) = fixture();
        let h = offered(repo.path(), &work, &source);
        claimed(repo.path(), &work, &source, &h);
        std::fs::write(
            repo.path().join(".gdm/test-work/out/result.txt"),
            "looks good",
        )
        .unwrap();
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        assert_eq!(
            finish(repo.path(), &work, &source, &j, &finish_args(), AT)
                .unwrap_err()
                .code,
            "receiver_ack_invalid"
        );
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        assert_eq!(j.last().unwrap()["stage"], "exited");
        assert_eq!(j.last().unwrap()["runnerObserved"]["status"], "failed");
        assert_eq!(
            adopt(
                repo.path(),
                &work,
                &source,
                &j,
                &args(&["--claim-id", "claim-one"]),
                AT
            )
            .unwrap_err()
            .code,
            "receipt_transition"
        );
    }
    #[test]
    fn output_changed_blocks_adoption() {
        let (repo, work, source) = fixture();
        let h = offered(repo.path(), &work, &source);
        let b = claimed(repo.path(), &work, &source, &h);
        write_ack(repo.path(), &b, "completed");
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        finish(repo.path(), &work, &source, &j, &finish_args(), AT).unwrap();
        std::fs::write(repo.path().join(".gdm/test-work/out/result.txt"), "changed").unwrap();
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        assert_eq!(
            adopt(
                repo.path(),
                &work,
                &source,
                &j,
                &args(&["--claim-id", "claim-one"]),
                AT
            )
            .unwrap_err()
            .code,
            "output_changed"
        );
    }
    #[test]
    fn recovery_allows_new_claim_but_competing_claim_is_rejected() {
        let (repo, work, source) = fixture();
        let h = offered(repo.path(), &work, &source);
        claimed(repo.path(), &work, &source, &h);
        let args = args(&[
            "--handoff-event-id",
            s(&h, "eventId"),
            "--claim-id",
            "claim-two",
            "--receiver-role",
            "reviewer",
            "--receiver-provider",
            "claude",
            "--capability-profile",
            PROFILE,
        ]);
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        assert_eq!(
            claim(repo.path(), &work, &source, &j, &args, AT)
                .unwrap_err()
                .code,
            "claim_conflict"
        );
        recover(
            repo.path(),
            &work,
            &j,
            &["--claim-id", "claim-one", "--reason", "Runner stopped"].map(String::from),
            AT,
        )
        .unwrap();
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        assert!(claim(repo.path(), &work, &source, &j, &args, AT).is_ok());
    }
    #[test]
    fn journal_tamper_and_changed_discriminator_are_rejected() {
        let (repo, work, source) = fixture();
        let h = offered(repo.path(), &work, &source);
        claimed(repo.path(), &work, &source, &h);
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        let mut corrupt = j.clone();
        corrupt[0]["revision"] = 2.into();
        assert!(validate_journal(&corrupt).is_err());
        let mut corrupt = j;
        corrupt[1]["event"] = "ordinary".into();
        assert!(validate_journal(&corrupt).is_err());
    }
    #[test]
    fn source_changes_block_claim_without_mutating_journal() {
        let (repo, work, source) = fixture();
        let h = offered(repo.path(), &work, &source);
        let changed = json!({"schemaVersion":1,"sha256":"c".repeat(64),"fileCount":1});
        let j = store::read_journal(repo.path(), "test-work").unwrap();
        let result = claim(
            repo.path(),
            &work,
            &changed,
            &j,
            &args(&[
                "--handoff-event-id",
                s(&h, "eventId"),
                "--claim-id",
                "claim-one",
                "--receiver-role",
                "reviewer",
                "--receiver-provider",
                "claude",
                "--capability-profile",
                PROFILE,
            ]),
            AT,
        );
        assert_eq!(result.unwrap_err().code, "source_fingerprint_mismatch");
        assert_eq!(
            store::read_journal(repo.path(), "test-work").unwrap().len(),
            1
        );
    }
    #[test]
    fn bundle_rejects_rehashed_corrupt_artifact_identity() {
        let (repo, work, source) = fixture();
        let path = ".gdm/test-work/out/review.txt";
        std::fs::write(repo.path().join(path), "review artifact").unwrap();
        let h = offer_handoff(
            repo.path(),
            &work,
            &source,
            &[],
            &args(&[
                "--handoff-id",
                "handoff-one",
                "--from-role",
                "coordinator",
                "--to-role",
                "reviewer",
                "--to-provider",
                "claude",
                "--intent",
                "Review current work",
                "--artifact",
                path,
            ]),
            AT,
            false,
        )
        .unwrap();
        let mut b = claimed(repo.path(), &work, &source, &h);
        b["artifact"]["text"] = "tampered".into();
        b.as_object_mut().unwrap().remove("bundleSha256");
        b["bundleSha256"] = sha256(canonical_json(&b)).into();
        assert_eq!(validate_bundle(&b).unwrap_err().code, "bundle_mismatch");
    }
}
