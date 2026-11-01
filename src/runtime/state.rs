use super::contract;
use crate::support::{Error, Result, sha256};
use serde_json::{Value, json};
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn b(v: &Value) -> bool {
    v.as_bool().unwrap_or(false)
}
pub fn checks(v: &Value) -> &[Value] {
    v["checks"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn kind(c: &Value) -> &str {
    c["kind"].as_str().unwrap_or(if b(&c["manual"]) {
        "manual"
    } else {
        "behavior"
    })
}
pub fn proven_count(w: &Value) -> usize {
    checks(w).iter().filter(|c| c["status"] == "proven").count()
}
pub fn valid_hash(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn validate_slug(v: &str) -> Result<()> {
    if !(2..=51).contains(&v.len())
        || !v.as_bytes()[0].is_ascii_alphanumeric()
        || !v
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(Error::new(
            "bad_slug",
            crate::i18n::text(
                "슬러그는 소문자 영문/숫자/하이픈 2~51자여야 합니다",
                "Slug must contain 2–51 lowercase ASCII letters, digits or hyphens",
            ),
        ));
    }
    Ok(())
}
pub fn checks_hash(w: &Value) -> String {
    sha256(serde_json::to_vec(&w["checks"]).unwrap())
}
fn count(bytes: &mut Vec<u8>, n: usize) {
    bytes.extend((n as u64).to_be_bytes());
}
fn string(bytes: &mut Vec<u8>, s: &str) {
    count(bytes, s.len());
    bytes.extend(s.as_bytes())
}
fn strings(bytes: &mut Vec<u8>, values: &Value) {
    let a = values.as_array().map(Vec::as_slice).unwrap_or(&[]);
    count(bytes, a.len());
    for v in a {
        string(bytes, s(v))
    }
}
pub fn verification_plan_fingerprint(w: &Value) -> String {
    let mut bytes = vec![];
    let fallback = contract::default_contract();
    let c = w.get("contract").unwrap_or(&fallback);
    string(&mut bytes, "gidem-verification-plan-v1");
    string(&mut bytes, s(&w["brief"]));
    bytes.push(u8::from(b(&w["auditRequired"])));
    for k in ["required", "forbidden"] {
        strings(&mut bytes, &c[k])
    }
    string(&mut bytes, c["commit"].as_str().unwrap_or("forbidden"));
    for k in [
        "assumptions",
        "uncertainties",
        "allowedPaths",
        "forbiddenPaths",
        "stopConditions",
    ] {
        strings(&mut bytes, c.get(k).unwrap_or(&fallback[k]))
    }
    string(&mut bytes, c["risk"].as_str().unwrap_or("low"));
    string(
        &mut bytes,
        c["verification"].as_str().unwrap_or("deterministic"),
    );
    bytes.push(u8::from(b(&c["simplificationRequired"])));
    if let Some(o) = c.get("outcome") {
        string(&mut bytes, "gidem-outcome-intent-v1");
        for k in [
            "bottleneck",
            "desiredOutcome",
            "baseline",
            "target",
            "unit",
            "interveneIf",
        ] {
            string(&mut bytes, s(&o[k]))
        }
    }
    count(&mut bytes, checks(w).len());
    for c in checks(w) {
        string(&mut bytes, s(&c["id"]));
        string(&mut bytes, s(&c["desc"]));
        if let Some(cmd) = c["cmd"].as_str() {
            bytes.push(1);
            string(&mut bytes, cmd)
        } else {
            bytes.push(0)
        }
        string(&mut bytes, s(&c["expect"]));
        bytes.push(u8::from(b(&c["manual"])));
        string(&mut bytes, kind(c));
        bytes.push(u8::from(b(&c["expert"])));
    }
    if super::verification::active(w) {
        string(&mut bytes, "gdm-integration/v1");
        string(&mut bytes, &super::verification::contract_digest(w));
    }
    sha256(bytes)
}
pub fn assert_plan(w: &Value, expected: Option<&str>) -> Result<()> {
    if let Some(fp) = expected {
        if !valid_hash(fp) {
            return Err(Error::new(
                "usage",
                crate::i18n::text(
                    "--expected-plan-fingerprint는 소문자 64자리 SHA-256이어야 합니다",
                    "--expected-plan-fingerprint must be a 64-character lowercase SHA-256",
                ),
            ));
        }
        if verification_plan_fingerprint(w) != fp {
            return Err(Error::new(
                "plan_fingerprint_mismatch",
                crate::i18n::text(
                    "승인된 검증 계획이 바뀌었습니다",
                    "The approved verification plan changed",
                ),
            ));
        }
    }
    Ok(())
}
pub fn check_index(w: &Value, id: &str) -> Result<usize> {
    checks(w).iter().position(|c| c["id"] == id).ok_or_else(|| {
        Error::new(
            "check_not_found",
            crate::lfmt!("항목 {id} 없음", "Check {id} not found"),
        )
    })
}
pub fn assert_open(w: &Value) -> Result<()> {
    if b(&w["done"]) {
        return Err(Error::new(
            "work_done",
            crate::i18n::text("이미 완료된 작업입니다", "This work is already completed"),
        ));
    }
    Ok(())
}
pub fn passable(w: &Value, id: &str) -> Result<usize> {
    assert_open(w)?;
    let i = check_index(w, id)?;
    if w["checks"][i]["status"] == "proven" {
        return Err(Error::new(
            "already_proven",
            crate::lfmt!("{id} 이미 통과", "{id} already passed"),
        ));
    }
    Ok(i)
}
pub fn add_check(w: &mut Value, input: &Value) -> Result<Value> {
    assert_open(w)?;
    let desc = s(&input["desc"]).trim();
    if desc.is_empty() {
        return Err(Error::new(
            "empty_desc",
            crate::i18n::text(
                "항목 설명이 비어 있습니다",
                "The check description is empty",
            ),
        ));
    }
    let manual = b(&input["manual"]);
    let expert = b(&input["expert"]);
    let kind = input["kind"]
        .as_str()
        .unwrap_or(if manual { "manual" } else { "behavior" });
    if !["regression", "behavior", "edge", "static", "manual"].contains(&kind)
        || manual != (kind == "manual")
        || expert && !manual
    {
        return Err(Error::new(
            "usage",
            crate::i18n::text(
                "kind/manual/expert 조합 오류",
                "Invalid kind/manual/expert combination",
            ),
        ));
    }
    let cmd = s(&input["cmd"]).trim();
    if !manual && cmd.is_empty() {
        return Err(Error::new(
            "cmd_required",
            crate::i18n::text("자동 항목에는 --cmd 필요", "Automatic checks require --cmd"),
        ));
    }
    let expect = s(&input["expect"]).trim();
    if expect.is_empty() {
        return Err(Error::new(
            "expect_required",
            crate::i18n::text("--expect 필요", "--expect is required"),
        ));
    }
    let n = checks(w)
        .iter()
        .map(|c| {
            s(&c["id"])
                .strip_prefix('c')
                .unwrap_or("")
                .parse::<u64>()
                .unwrap_or(0)
        })
        .max()
        .unwrap_or(0)
        + 1;
    let c = json!({"id":format!("c{n}"),"desc":desc,"cmd":if cmd.is_empty(){Value::Null}else{json!(cmd)},"expect":expect,"manual":manual,"kind":kind,"expert":expert,"status":"open"});
    w["checks"].as_array_mut().unwrap().push(c.clone());
    super::verification::plan_changed(w);
    Ok(c)
}
pub fn edit(w: &mut Value, id: &str, patch: &Value, reason: &str) -> Result<bool> {
    assert_open(w)?;
    if reason.trim().is_empty() {
        return Err(Error::new(
            "reason_required",
            crate::i18n::text(
                "항목 수정에는 사유 필수",
                "A reason is required to edit a check",
            ),
        ));
    }
    let i = check_index(w, id)?;
    let mut next = w["checks"][i].clone();
    let mut changed = false;
    for k in ["desc", "cmd", "expect", "kind"] {
        if let Some(v) = patch.get(k) {
            let text = s(v).trim();
            let value = if k == "cmd" && text.is_empty() {
                Value::Null
            } else {
                json!(text)
            };
            let old = if k == "kind" {
                json!(kind(&next))
            } else {
                next[k].clone()
            };
            if old != value {
                next[k] = value;
                changed = true;
            }
        }
    }
    if !changed {
        return Err(Error::new(
            "no_changes",
            crate::i18n::text("바뀐 내용 없음", "No changes"),
        ));
    }
    if s(&next["desc"]).is_empty() {
        return Err(Error::new(
            "empty_desc",
            crate::i18n::text("설명 비울 수 없음", "The description cannot be empty"),
        ));
    }
    if !b(&next["manual"]) && next["cmd"].is_null() {
        return Err(Error::new(
            "cmd_required",
            crate::i18n::text("cmd 비울 수 없음", "cmd cannot be empty"),
        ));
    }
    if s(&next["expect"]).is_empty() {
        return Err(Error::new(
            "expect_required",
            crate::i18n::text("expect 비울 수 없음", "expect cannot be empty"),
        ));
    }
    if !["regression", "behavior", "edge", "static", "manual"].contains(&kind(&next))
        || b(&next["manual"]) != (kind(&next) == "manual")
    {
        return Err(Error::new(
            "usage",
            crate::i18n::text("kind 불일치", "Kind mismatch"),
        ));
    }
    let reverted = next["status"] == "proven";
    next["status"] = json!("open");
    next.as_object_mut().unwrap().remove("evidence");
    next.as_object_mut().unwrap().remove("redEvidence");
    w["checks"][i] = next;
    super::verification::plan_changed(w);
    Ok(reverted)
}
pub fn completion_blockers(w: &Value) -> Vec<Value> {
    if b(&w["done"]) {
        return vec![];
    }
    let mut out = vec![];
    let mut push = |code: &str, message: String| out.push(json!({"code":code,"message":message}));
    let c = checks(w);
    if c.is_empty() {
        push(
            "no_checks",
            crate::i18n::text(
                "확인 항목이 하나도 없습니다. gdm plan add로 항목부터 세우세요",
                "No checks exist. Add a check with gdm plan add first",
            )
            .into(),
        )
    }
    let open = c
        .iter()
        .filter(|c| c["status"] != "proven")
        .collect::<Vec<_>>();
    if !open.is_empty() {
        push(
            "unproven",
            crate::lfmt!(
                "미통과 항목 {}개: {}",
                "{} checks have not passed: {}",
                open.len(),
                open.iter()
                    .map(|c| format!("{}({})", s(&c["id"]), s(&c["desc"])))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
    }
    if b(&w["contract"]["simplificationRequired"])
        && !c
            .iter()
            .any(|c| c["status"] == "proven" && kind(c) == "static")
    {
        push("simplification_required",crate::i18n::text("간소화 확인이 필요합니다. --kind static 항목을 추가하고 불필요한 복잡성이 없음을 증명하세요", "Simplification verification is required. Add a --kind static check proving unnecessary complexity is absent").into())
    }
    if w["contract"]["risk"] == "high"
        && w["contract"]["verification"] == "opaque"
        && !c.iter().any(|c| {
            c["status"] == "proven"
                && b(&c["manual"])
                && b(&c["expert"])
                && !s(&c["evidence"]["reviewer"]).trim().is_empty()
                && !s(&c["evidence"]["note"]).trim().is_empty()
        })
    {
        push("expert_review_required",crate::i18n::text("high+opaque 작업은 전문가 확인이 필요합니다. --manual --expert 항목과 reviewer·판단 근거를 제출하세요", "High-risk opaque work requires expert review. Provide a --manual --expert check with reviewer and reasoning").into())
    }
    if b(&w["auditRequired"]) || w["contract"]["risk"] == "high" {
        if w.get("audit").is_none() {
            push(
                "audit_required",
                crate::i18n::text("검수가 필요한 작업입니다. gdm audit brief → 검수자 → gdm audit verdict", "An audit is required. Run gdm audit brief, obtain an independent audit, then gdm audit verdict").into(),
            )
        } else if w["audit"]["result"] != "pass" {
            push(
                "audit_failed",
                crate::i18n::text(
                    "검수가 반려됐습니다. 반려 사유를 해결하고 재검수하세요",
                    "The audit was rejected. Resolve the findings and obtain another audit",
                )
                .into(),
            )
        } else if s(&w["audit"]["stateHash"]) != checks_hash(w) {
            push(
                "audit_stale",
                crate::i18n::text(
                    "검수 이후 항목 상태가 바뀌었습니다. 재검수가 필요합니다",
                    "Check state changed after the audit. A new audit is required",
                )
                .into(),
            )
        }
    }
    out.extend(super::team::blockers(w));
    out.extend(super::verification::blockers(w).into_iter().map(|mut v| {
        v["message"] = json!(format!(
            "Integration verification: {} {}",
            s(&v["code"]),
            s(&v["id"])
        ));
        v
    }));
    out
}
pub fn evidence_valid(e: &Value) -> bool {
    e.is_object()
        && !s(&e["observed"]).is_empty()
        && valid_hash(s(&e["sha256"]))
        && e["manual"].is_boolean()
        && contract::canonical_timestamp(s(&e["at"]))
        && e.get("exitCode").is_none_or(|v| {
            v.as_i64()
                .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
        })
        && ["note", "reviewer"]
            .iter()
            .all(|k| e.get(k).is_none_or(Value::is_string))
}
fn fingerprint_valid(v: &Value) -> bool {
    if v["kind"] != "git"
        || !regex::Regex::new(r"^(?:[0-9a-f]{40}|[0-9a-f]{64}|unborn)$")
            .unwrap()
            .is_match(s(&v["head"]))
        || !valid_hash(s(&v["sha256"]))
    {
        return false;
    }
    if let Some(files) = v.get("files") {
        let Some(files) = files.as_array() else {
            return false;
        };
        let mut seen = std::collections::HashSet::new();
        for f in files {
            let p = s(&f["path"]);
            if p.is_empty()
                || p.starts_with('/')
                || p.split('/').any(|s| s.is_empty() || s == "." || s == "..")
                || p == ".gdm"
                || p.starts_with(".gdm/")
                || !valid_hash(s(&f["sha256"]))
                || !seen.insert(p)
            {
                return false;
            }
        }
    }
    true
}
pub fn validate_work(mut w: Value) -> Result<Value> {
    let bad = |why: &str| {
        Error::new(
            "state_corrupt",
            crate::lfmt!(
                "상태 파일이 손상됐습니다: {why}",
                "State file is corrupt: {why}"
            ),
        )
    };
    if !w.is_object()
        || !w["slug"].is_string()
        || !w["brief"].is_string()
        || !w["done"].is_boolean()
        || !w["checks"].is_array()
    {
        return Err(bad(crate::i18n::text(
            "work 필수 필드",
            "Required work fields",
        )));
    }
    validate_slug(s(&w["slug"])).map_err(|_| bad("slug"))?;
    if !contract::canonical_timestamp(s(&w["createdAt"]))
        || w.get("auditRequired").is_some_and(|v| !v.is_boolean())
        || w.get("doneAt")
            .is_some_and(|v| !contract::canonical_timestamp(s(v)))
        || b(&w["done"]) != w.get("doneAt").is_some()
        || w.get("doneAt").is_some_and(|v| s(v) < s(&w["createdAt"]))
    {
        return Err(bad(crate::i18n::text(
            "work 시간 및 완료 상태",
            "Work timestamps and completion state",
        )));
    }
    if w.get("verificationPlanSourceFingerprint")
        .is_some_and(|v| !valid_hash(s(v)))
    {
        return Err(bad("source fingerprint"));
    }
    for c in checks(&w) {
        if !c.is_object()
            || !c["id"].is_string()
            || !c["desc"].is_string()
            || c.get("cmd").is_none_or(|v| !v.is_null() && !v.is_string())
            || !c["expect"].is_string()
            || !c["manual"].is_boolean()
            || !["open", "proven"].contains(&s(&c["status"]))
        {
            return Err(bad("check"));
        }
        if c.get("evidence").is_some_and(|e| !evidence_valid(e))
            || c["status"] == "proven" && !evidence_valid(&c["evidence"])
            || c.get("evidence")
                .is_some_and(|e| e["manual"] != c["manual"])
        {
            return Err(bad("check evidence"));
        }
        if c.get("kind").is_some_and(|v| !v.is_string())
            || !["regression", "behavior", "edge", "static", "manual"].contains(&kind(c))
            || b(&c["manual"]) != (kind(c) == "manual")
            || c.get("expert").is_some_and(|v| !v.is_boolean())
            || b(&c["expert"]) && !b(&c["manual"])
        {
            return Err(bad("check kind"));
        }
        if let Some(r) = c.get("redEvidence")
            && (!evidence_valid(r)
                || kind(c) != "regression"
                || b(&r["manual"])
                || r["exitCode"].as_i64().is_none_or(|n| n == 0)
                || c.get("evidence").is_some_and(|e| s(&r["at"]) > s(&e["at"])))
        {
            return Err(bad("red evidence"));
        }
    }
    if let Some(d) = w.get("delivery") {
        if !d.is_object()
            || ["issue", "branch", "head", "preparedAt"]
                .iter()
                .any(|k| !d[k].is_string())
        {
            return Err(bad("delivery"));
        }
        for (key, fields) in [
            ("pr", &["number", "head"][..]),
            ("ci", &["head", "run"][..]),
            ("mergeApproval", &["head", "reason"][..]),
            ("merged", &["sha"][..]),
        ] {
            if let Some(item) = d.get(key)
                && fields.iter().any(|k| !item[k].is_string())
            {
                return Err(bad("delivery child"));
            }
        }
        if let Some(ci) = d.get("ci")
            && !["passed", "failed"].contains(&s(&ci["status"]))
        {
            return Err(bad("delivery ci"));
        }
    }
    if let Some(a) = w.get("audit")
        && (!a.is_object()
            || !["pass", "fail"].contains(&s(&a["result"]))
            || s(&a["report"]).is_empty()
            || !valid_hash(s(&a["stateHash"]))
            || !contract::canonical_timestamp(s(&a["at"]))
            || a.get("reportSha256").is_some_and(|v| !valid_hash(s(v)))
            || ["implementationModel", "auditModel"]
                .iter()
                .any(|k| a.get(k).is_some_and(|v| !v.is_string()))
            || a.get("workspace")
                .is_some_and(|v| !v.is_null() && !fingerprint_valid(v)))
    {
        return Err(bad("audit"));
    }
    if w.get("baseline")
        .is_some_and(|v| !v.is_null() && !fingerprint_valid(v))
    {
        return Err(bad("baseline"));
    }
    w["contract"] = contract::normalize(w.get("contract"))?;
    super::team::validate(&w)?;
    super::verification::validate(&w)?;
    if b(&w["done"]) {
        let mut candidate = w.clone();
        candidate["done"] = json!(false);
        let blockers = completion_blockers(&candidate);
        if !blockers.is_empty() {
            return Err(bad(crate::i18n::text(
                "완료 상태와 선행 조건 불일치",
                "Completion state does not match prerequisites",
            )));
        }
    }
    Ok(w)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_forged_completion() {
        let w = json!({"slug":"test","brief":"ok","createdAt":"2026-01-01T00:00:00.000Z","done":true,"doneAt":"2026-01-01T00:00:01.000Z","checks":[],"contract":contract::default_contract()});
        assert!(validate_work(w).is_err())
    }
    #[test]
    fn fingerprint_ignores_runtime() {
        let mut w = json!({"brief":"x","checks":[],"contract":contract::default_contract()});
        add_check(&mut w, &json!({"desc":"x","cmd":"true","expect":"ok"})).unwrap();
        let fp = verification_plan_fingerprint(&w);
        w["checks"][0]["status"] = json!("proven");
        assert_eq!(fp, verification_plan_fingerprint(&w));
    }
}
