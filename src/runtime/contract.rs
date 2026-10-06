use super::state::{b, s};
use crate::support::{Error, Result, has_flag, now, read_flag, read_flags, sha256};
use serde_json::{Value, json};
fn re(p: &str, v: &str) -> bool {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, regex::Regex>>,
    > = std::sync::OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    cache
        .entry(p.to_owned())
        .or_insert_with(|| regex::Regex::new(p).unwrap())
        .is_match(v)
}
pub fn canonical_timestamp(v: &str) -> bool {
    re(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", v)
        && v.get(17..19) != Some("60")
        && chrono::DateTime::parse_from_rfc3339(v)
            .is_ok_and(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) == v)
}
pub fn assert_no_sensitive(v: &str, field: &str) -> Result<()> {
    let patterns = [
        r"[\x00-\x1f\x7f-\x9f]",
        r#"["'`{}<>]"#,
        r"(?i)^(?:user|assistant|system|human|사용자|어시스턴트|시스템|사람)\s*:",
        r"(?i)(?:=>|\(\);|function |class |const |let |var |import |export )",
        r"(?:diff --git|@@|--- |\+\+\+ )",
        r"(?i)(?:^|[\s(])(?:/|~(?:/|$)|[a-z]:[\\/]|\\\\)",
        r"(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:",
        r"[$=]",
        r"(?i)(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]+",
        r"(?i)(?:ghp_|github_pat_|AKIA|Bearer |BEGIN [A-Z ]*PRIVATE KEY)",
        r"[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
    ];
    if patterns.iter().any(|p| re(p, v)) {
        return Err(Error::new(
            "privacy_rejected",
            format!("privacyPolicyVersion=1 field={field} count=1"),
        ));
    }
    Ok(())
}
pub fn safe_text(v: &str, field: &str, max: usize) -> Result<String> {
    assert_no_sensitive(v, field)?;
    let v = v.trim();
    let detail = if v.is_empty() {
        Some("값이 비어 있습니다".to_owned())
    } else if v.encode_utf16().count() > max {
        Some(format!(
            "{max}자 제한 초과 ({}자)",
            v.encode_utf16().count()
        ))
    } else if let Some((index, ch)) = v
        .chars()
        .enumerate()
        .find(|(_, ch)| !re(r"^[\p{L}\p{N}\p{M} .,:;!?()\[\]_-]$", &ch.to_string()))
    {
        let hint = if field == "require" || field == "forbid" {
            " · 여러 조건은 --require/--forbid 플래그를 반복해 전달하세요"
        } else {
            ""
        };
        Some(format!(
            "허용되지 않는 문자 \"{ch}\" ({}번째) — 허용: 한글·영문·숫자·공백과 .,:;!?()[]_-{hint}",
            index + 1
        ))
    } else {
        None
    };
    if let Some(detail) = detail {
        return Err(Error::new(
            "privacy_rejected",
            format!("privacyPolicyVersion=1 field={field} count=1 — {detail}"),
        ));
    }
    Ok(v.into())
}
pub fn opaque_id(v: &str, field: &str) -> Result<String> {
    assert_no_sensitive(v, field)?;
    if !re(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$", v) {
        return Err(Error::new(
            "usage",
            format!("field={field} opaque identifier 형식이 잘못됐습니다"),
        ));
    }
    Ok(v.into())
}
pub fn path(v: &str, field: &str) -> Result<String> {
    let x = v.trim().replace('\\', "/");
    if x.is_empty()
        || x.contains('\0')
        || x.starts_with('/')
        || re(r"^[A-Za-z]:/", &x)
        || x.split('/').any(|p| p == "..")
    {
        return Err(Error::new(
            "path_rejected",
            format!("{field}는 저장소 상대 경로여야 합니다"),
        ));
    }
    let parts = x
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect::<Vec<_>>();
    let n = if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    };
    if n == ".gdm" || n.starts_with(".gdm/") {
        return Err(Error::new(
            "path_rejected",
            "gdm 내부 상태 경로(.gdm)를 쓸 수 없습니다",
        ));
    }
    assert_no_sensitive(v, field)?;
    Ok(n)
}
pub fn matches(p: &str, prefix: &str) -> bool {
    prefix == "." || p == prefix || p.starts_with(&format!("{prefix}/"))
}
pub fn default_contract() -> Value {
    json!({"required":[],"forbidden":[],"activeHabits":[],"commit":"forbidden","assumptions":[],"uncertainties":[],"allowedPaths":["."],"forbiddenPaths":[],"stopConditions":[],"risk":"low","verification":"deterministic","simplificationRequired":false,"scopeAmendments":[]})
}
fn strings(v: &Value) -> Result<Vec<String>> {
    v.as_array()
        .ok_or_else(|| Error::new("state_corrupt", "contract 목록 오류"))?
        .iter()
        .map(|x| {
            x.as_str()
                .map(str::to_owned)
                .ok_or_else(|| Error::new("state_corrupt", "contract 문자열 오류"))
        })
        .collect()
}
fn dedup(v: Vec<String>) -> Vec<String> {
    let mut out = vec![];
    for s in v {
        if !out.contains(&s) {
            out.push(s)
        }
    }
    out
}
pub fn normalize(value: Option<&Value>) -> Result<Value> {
    let Some(value) = value else {
        return Ok(default_contract());
    };
    if !value.is_object() {
        return Err(Error::new("state_corrupt", "contract 객체 오류"));
    }
    let mut v = value.clone();
    for k in ["required", "forbidden"] {
        strings(&v[k])?;
    }
    if !v["activeHabits"].is_array()
        || !["forbidden", "explicitly-approved"].contains(&s(&v["commit"]))
    {
        return Err(Error::new("state_corrupt", "contract 필수 필드 오류"));
    }
    let default = default_contract();
    for (k, val) in default.as_object().unwrap() {
        if v.get(k).is_none() {
            v[k] = val.clone();
        }
    }
    for k in ["assumptions", "uncertainties", "stopConditions"] {
        strings(&v[k])?;
    }
    for k in ["allowedPaths", "forbiddenPaths"] {
        let p = strings(&v[k])?
            .iter()
            .map(|x| path(x, k))
            .collect::<Result<Vec<_>>>()
            .map_err(|_| Error::new("state_corrupt", "contract 경로 오류"))?;
        v[k] = json!(dedup(p));
    }
    if !["low", "medium", "high"].contains(&s(&v["risk"]))
        || !["deterministic", "inspectable", "opaque"].contains(&s(&v["verification"]))
        || !v["simplificationRequired"].is_boolean()
    {
        return Err(Error::new("state_corrupt", "contract 정책 오류"));
    }
    for h in v["activeHabits"].as_array().unwrap() {
        if h.as_object().map(|o| o.len()) != Some(5)
            || !re(r"^h-[0-9a-f]{16}$", s(&h["habitId"]))
            || h["version"]
                .as_u64()
                .is_none_or(|n| !(1..=9_007_199_254_740_991).contains(&n))
            || !super::state::valid_hash(s(&h["ruleHash"]))
            || !canonical_timestamp(s(&h["activatedAt"]))
            || !safe_rule_ref(s(&h["ruleRef"]))
        {
            return Err(Error::new("state_corrupt", "activeHabit 오류"));
        }
    }
    let mut amendments = vec![];
    for a in v["scopeAmendments"]
        .as_array()
        .ok_or_else(|| Error::new("state_corrupt", "scopeAmendments 오류"))?
    {
        if s(&a["reason"]).trim().is_empty() || !canonical_timestamp(s(&a["at"])) {
            return Err(Error::new("state_corrupt", "scope amendment 오류"));
        }
        let mut amendment = json!({});
        for k in [
            "addedAllowed",
            "addedForbidden",
            "removedAllowed",
            "removedForbidden",
        ] {
            let input = match a.get(k) {
                Some(value) => strings(value)?,
                None => vec![],
            };
            let paths = input
                .iter()
                .map(|p| path(p, k))
                .collect::<Result<Vec<_>>>()
                .map_err(|_| Error::new("state_corrupt", "scope amendment 경로 오류"))?;
            amendment[k] = json!(dedup(paths));
        }
        amendment["reason"] = a["reason"].clone();
        amendment["at"] = a["at"].clone();
        amendments.push(amendment);
    }
    v["scopeAmendments"] = json!(amendments);
    if let Some(t) = v.get("latestCommitTransition")
        && (!t.is_object()
            || !["forbidden", "explicitly-approved"].contains(&s(&t["from"]))
            || !["forbidden", "explicitly-approved"].contains(&s(&t["to"]))
            || !t["eventId"].is_string()
            || !t["transitionRevision"].is_number()
            || !t["reason"].is_string()
            || !t["at"].is_string()
            || (!t["predecessorEventId"].is_null() && !t["predecessorEventId"].is_string()))
    {
        return Err(Error::new("state_corrupt", "commit transition 오류"));
    }
    if let Some(o) = v.get("outcome") {
        validate_outcome(o).map_err(|_| Error::new("state_corrupt", "outcome 오류"))?;
        let mut normalized = json!({});
        for key in [
            "bottleneck",
            "desiredOutcome",
            "baseline",
            "target",
            "unit",
            "interveneIf",
        ] {
            normalized[key] = json!(
                safe_text(s(&o[key]), key, 240)
                    .map_err(|_| Error::new("state_corrupt", "outcome 오류"))?
            );
        }
        v["outcome"] = normalized;
    }
    let known = [
        "required",
        "forbidden",
        "activeHabits",
        "commit",
        "assumptions",
        "uncertainties",
        "allowedPaths",
        "forbiddenPaths",
        "stopConditions",
        "risk",
        "verification",
        "simplificationRequired",
        "scopeAmendments",
        "outcome",
        "latestCommitTransition",
    ];
    v.as_object_mut()
        .unwrap()
        .retain(|key, _| known.contains(&key.as_str()));
    Ok(v)
}
pub fn safe_rule_ref(v: &str) -> bool {
    !v.is_empty()
        && v.encode_utf16().count() <= 240
        && v.trim() == v
        && !v.contains('\\')
        && assert_no_sensitive(v, "rule-ref").is_ok()
        && v.split('/').all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && ![".obsidian", "obsidian", "session", "sessions"]
                    .contains(&p.to_lowercase().as_str())
        })
}
fn validate_outcome(o: &Value) -> Result<()> {
    let keys = [
        "bottleneck",
        "desiredOutcome",
        "baseline",
        "target",
        "unit",
        "interveneIf",
    ];
    if o.as_object().map(|o| o.len()) != Some(6) {
        return Err(Error::new("usage", "outcome 여섯 값 필요"));
    }
    for k in keys {
        safe_text(s(&o[k]), k, 240)?;
    }
    Ok(())
}
pub fn constraints(args: &[String]) -> Result<(Vec<String>, Vec<String>)> {
    let req = dedup(
        read_flags(args, "require")?
            .iter()
            .map(|v| safe_text(v, "require", 240))
            .collect::<Result<_>>()?,
    );
    let forbid = dedup(
        read_flags(args, "forbid")?
            .iter()
            .map(|v| safe_text(v, "forbid", 240))
            .collect::<Result<_>>()?,
    );
    if req.iter().any(|x| forbid.contains(x)) {
        return Err(Error::new(
            "contract_conflict",
            "동일 제약은 필수와 금지에 함께 둘 수 없음",
        ));
    }
    Ok((req, forbid))
}
pub fn create(args: &[String]) -> Result<Value> {
    let (req, forbid) = constraints(args)?;
    if req.is_empty() && forbid.is_empty() {
        return Err(Error::new(
            "constraint_required",
            "--require 또는 --forbid가 필요합니다",
        ));
    }
    let mut v = default_contract();
    v["required"] = json!(req);
    v["forbidden"] = json!(forbid);
    for (flag, key) in [
        ("assume", "assumptions"),
        ("uncertain", "uncertainties"),
        ("stop-if", "stopConditions"),
    ] {
        v[key] = json!(dedup(
            read_flags(args, flag)?
                .iter()
                .map(|v| safe_text(v, flag, 240))
                .collect::<Result<_>>()?
        ));
    }
    for (flag, key) in [
        ("allow-path", "allowedPaths"),
        ("forbid-path", "forbiddenPaths"),
    ] {
        let p = read_flags(args, flag)?;
        if !p.is_empty() {
            v[key] = json!(dedup(
                p.iter().map(|v| path(v, flag)).collect::<Result<_>>()?
            ));
        }
    }
    if let Some(r) = read_flag(args, "risk")? {
        v["risk"] = json!(r)
    }
    if let Some(r) = read_flag(args, "verification")? {
        v["verification"] = json!(r)
    }
    v["simplificationRequired"] = json!(has_flag(args, "simplify"));
    let mut out = json!({});
    for (flag, key) in [
        ("bottleneck", "bottleneck"),
        ("desired-outcome", "desiredOutcome"),
        ("baseline", "baseline"),
        ("target", "target"),
        ("unit", "unit"),
        ("intervene-if", "interveneIf"),
    ] {
        if let Some(x) = read_flag(args, flag)? {
            out[key] = json!(safe_text(&x, key, 240)?);
        }
    }
    if !out.as_object().unwrap().is_empty() {
        validate_outcome(&out)?;
        v["outcome"] = out;
    }
    normalize(Some(&v)).map_err(|e| Error::new("usage", e.message))
}
pub fn assert_commit(work: &Value) -> Result<()> {
    if work["contract"]["commit"] == "forbidden" {
        Err(Error::new(
            "commit_forbidden",
            "명시적 승인 전에는 커밋할 수 없습니다",
        ))
    } else {
        Ok(())
    }
}
pub fn mutate(work: &mut Value, args: &[String]) -> Result<Option<Value>> {
    let (req, forbid) = constraints(args)?;
    let has_constraints = !req.is_empty() || !forbid.is_empty();
    let has_scope = [
        "allow-path",
        "forbid-path",
        "remove-allow-path",
        "remove-forbid-path",
    ]
    .iter()
    .any(|f| read_flags(args, f).is_ok_and(|v| !v.is_empty()));
    let check = has_flag(args, "check-commit");
    let commit = read_flag(args, "commit")?;
    let reason = read_flag(args, "reason")?;
    let modes = usize::from(has_constraints)
        + usize::from(has_scope)
        + usize::from(check)
        + usize::from(commit.is_some());
    if modes != 1 || ((check || has_constraints) && reason.is_some()) {
        return Err(Error::new("usage", "plan contract 동작 정확히 하나 필요"));
    }
    if check {
        assert_commit(work)?;
        return Ok(None);
    }
    let at = now();
    if has_constraints {
        let old_req = strings(&work["contract"]["required"])?;
        let old_forbid = strings(&work["contract"]["forbidden"])?;
        let next_req = dedup([old_req.clone(), req].concat());
        let next_forbid = dedup([old_forbid.clone(), forbid].concat());
        if next_req.iter().any(|v| next_forbid.contains(v)) {
            return Err(Error::new("contract_conflict", "필수와 금지 충돌"));
        }
        if next_req == old_req && next_forbid == old_forbid {
            return Ok(None);
        }
        if b(&work["done"]) || super::state::proven_count(work) > 0 {
            return Err(Error::new("contract_locked", "첫 통과 후 제약 추가 불가"));
        }
        let event = json!({"ts":at,"event":"contract.constraints","required":next_req[old_req.len()..],"forbidden":next_forbid[old_forbid.len()..]});
        work["contract"]["required"] = json!(next_req);
        work["contract"]["forbidden"] = json!(next_forbid);
        return Ok(Some(event));
    }
    let reason = safe_text(
        reason.as_deref().ok_or_else(|| {
            Error::new(
                if commit.is_some() {
                    "usage"
                } else {
                    "reason_required"
                },
                "--reason 필요",
            )
        })?,
        "reason",
        240,
    )?;
    if let Some(to) = commit {
        if !["forbidden", "explicitly-approved"].contains(&to.as_str()) {
            return Err(Error::new("usage", "commit 값 오류"));
        }
        let c = &work["contract"];
        if c["commit"] == to {
            if c["latestCommitTransition"]["to"] == to
                && c["latestCommitTransition"]["reason"] == reason
            {
                return Ok(None);
            }
            return Err(Error::new("commit_transition_conflict", "현재 상태와 충돌"));
        }
        let revision = c["latestCommitTransition"]["transitionRevision"]
            .as_u64()
            .unwrap_or(0)
            + 1;
        let predecessor = c["latestCommitTransition"]["eventId"].clone();
        let identity = format!(
            "{}\0{revision}\0{}\0{to}\0{reason}",
            s(&work["slug"]),
            s(&predecessor)
        );
        let transition = json!({"eventId":format!("commit-{}",&sha256(identity)[..16]),"transitionRevision":revision,"predecessorEventId":predecessor,"from":c["commit"],"to":to,"reason":reason,"at":at});
        work["contract"]["commit"] = json!(to);
        work["contract"]["latestCommitTransition"] = transition.clone();
        let mut e = json!({"event":"contract.commit","ts":at});
        e.as_object_mut()
            .unwrap()
            .extend(transition.as_object().unwrap().clone());
        return Ok(Some(e));
    }
    if b(&work["done"]) {
        return Err(Error::new("work_done", "완료 작업 범위 변경 불가"));
    }
    if work.get("audit").is_some() {
        return Err(Error::new("scope_locked", "검수 후 범위 변경 불가"));
    }
    let mut amendment = json!({"reason":reason,"at":at});
    let mut changed = false;
    for (key, add, remove, added, removed) in [
        (
            "allowedPaths",
            "allow-path",
            "remove-allow-path",
            "addedAllowed",
            "removedAllowed",
        ),
        (
            "forbiddenPaths",
            "forbid-path",
            "remove-forbid-path",
            "addedForbidden",
            "removedForbidden",
        ),
    ] {
        let plus = dedup(
            read_flags(args, add)?
                .iter()
                .map(|v| path(v, add))
                .collect::<Result<_>>()?,
        );
        let minus = dedup(
            read_flags(args, remove)?
                .iter()
                .map(|v| path(v, remove))
                .collect::<Result<_>>()?,
        );
        if plus.iter().any(|v| minus.contains(v)) {
            return Err(Error::new("contract_conflict", "동일 경로 추가 제거 충돌"));
        }
        let old = strings(&work["contract"][key])?;
        let actual_minus = old
            .iter()
            .filter(|v| minus.contains(v))
            .cloned()
            .collect::<Vec<_>>();
        let mut next = old
            .into_iter()
            .filter(|v| !minus.contains(v))
            .collect::<Vec<_>>();
        let actual_plus = plus
            .into_iter()
            .filter(|v| !next.contains(v))
            .collect::<Vec<_>>();
        changed |= !actual_minus.is_empty() || !actual_plus.is_empty();
        next.extend(actual_plus.clone());
        amendment[added] = json!(actual_plus);
        amendment[removed] = json!(actual_minus);
        work["contract"][key] = json!(next);
    }
    if !changed {
        return Err(Error::new("no_changes", "바뀐 범위 없음"));
    }
    work["contract"]["scopeAmendments"]
        .as_array_mut()
        .unwrap()
        .push(amendment.clone());
    let mut e = json!({"ts":at,"event":"contract.scope"});
    e.as_object_mut()
        .unwrap()
        .extend(amendment.as_object().unwrap().clone());
    Ok(Some(e))
}
