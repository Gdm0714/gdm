use crate::runtime::contract;
use crate::support::{Error, Result, sha256};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn pattern(value: &str, re: &'static str) -> Result<()> {
    contract::assert_no_sensitive(value, "habit-field")?;
    static CACHE: std::sync::OnceLock<std::sync::Mutex<BTreeMap<&'static str, regex::Regex>>> =
        std::sync::OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| Error::new("internal", "validator cache"))?;
    if cache
        .entry(re)
        .or_insert_with(|| regex::Regex::new(re).expect("static habit validator"))
        .is_match(value)
    {
        Ok(())
    } else {
        Err(Error::new(
            "usage",
            crate::i18n::text("habit 필드 형식 오류", "Invalid habit field format"),
        ))
    }
}
pub fn exact(value: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or_else(|| {
        Error::new(
            "habit_event_invalid",
            crate::i18n::text("객체 필요", "An object is required"),
        )
    })?;
    if required.iter().all(|k| object.contains_key(*k))
        && object
            .keys()
            .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
    {
        Ok(())
    } else {
        Err(Error::new(
            "habit_event_invalid",
            crate::i18n::text("필드 집합 오류", "Invalid field set"),
        ))
    }
}
pub fn scan(value: &Value, harvest: bool) -> Result<()> {
    fn visit(value: &Value, harvest: bool, exempt: bool) -> Result<()> {
        match value {
            Value::String(v) if !exempt => contract::assert_no_sensitive(v, "habit")?,
            Value::Array(v) => {
                for x in v {
                    visit(x, harvest, exempt)?;
                }
            }
            Value::Object(v) => {
                for (k, x) in v {
                    // Diagnostic values are exempt, but even their nested keys remain checked.
                    contract::assert_no_sensitive(k, "habit-key")?;
                    visit(
                        x,
                        harvest,
                        exempt || harvest && (k == "patch" || k == "message"),
                    )?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(value, harvest, false)
}
pub fn scan_tokens(raw: &str) -> Result<()> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        let mut escape = false;
        while i < bytes.len() {
            let b = bytes[i];
            if b == b'"' && !escape {
                break;
            }
            escape = b == b'\\' && !escape;
            i += 1;
        }
        if i >= bytes.len() {
            return Err(Error::new(
                "privacy_rejected",
                crate::i18n::text("habit JSON 토큰 오류", "Invalid habit JSON token"),
            ));
        }
        let text: String = serde_json::from_str(&raw[start..=i]).map_err(|_| {
            Error::new(
                "privacy_rejected",
                crate::i18n::text("habit JSON 토큰 오류", "Invalid habit JSON token"),
            )
        })?;
        contract::assert_no_sensitive(&text, "habit-json")?;
        i += 1;
    }
    Ok(())
}
pub fn rule_path(path: &str) -> Result<()> {
    contract::assert_no_sensitive(path, "rule-ref")?;
    if path.is_empty()
        || path.len() > 240
        || path.trim() != path
        || path.contains('\\')
        || path.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || [".obsidian", "obsidian", "session", "sessions"]
                    .contains(&p.to_lowercase().as_str())
        })
    {
        return Err(Error::new(
            "privacy_rejected",
            crate::i18n::text("rule-ref 거부", "rule-ref rejected"),
        ));
    }
    Ok(())
}
fn id(kind: &str, parts: &[String]) -> String {
    format!(
        "ev-{}",
        &sha256(format!("{kind}\0{}", parts.join("\0")))[..16]
    )
}
pub fn expected_id(event: &Value) -> String {
    let kind = s(event, "kind");
    let fields: &[&str] = match kind {
        "observation" => &["sourceGroup", "sourceToken", "pattern"],
        "evaluation" => &[
            "habitId",
            "version",
            "workSlug",
            "revision",
            "predecessorEventId",
        ],
        _ => &["habitId", "version"],
    };
    id(
        kind,
        &fields
            .iter()
            .map(|k| match &event[*k] {
                Value::String(x) => x.clone(),
                Value::Number(x) => x.to_string(),
                _ => String::new(),
            })
            .collect::<Vec<_>>(),
    )
}
fn semantic(event: &Value) -> Value {
    let mut event = event.clone();
    event.as_object_mut().unwrap().remove("at");
    event
}
fn positive(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
}
pub fn validate(event: &Value) -> Result<()> {
    scan(event, false)?;
    let common = ["schemaVersion", "eventId", "at", "kind"];
    let specific: &[&str] = match s(event, "kind") {
        "observation" => &[
            "pattern",
            "taxonomy",
            "sourceToken",
            "sourceGroup",
            "sourceKind",
        ],
        "proposal" => &[
            "habitId",
            "version",
            "pattern",
            "statement",
            "sourceEventIds",
        ],
        "adoption" => &["habitId", "version", "ruleRef", "ruleHash", "reason"],
        "retirement" => &["habitId", "version", "reason"],
        "evaluation" => &[
            "habitId",
            "version",
            "workSlug",
            "outcome",
            "revision",
            "predecessorEventId",
        ],
        _ => {
            return Err(Error::new(
                "habit_event_invalid",
                crate::i18n::text("kind 오류", "Invalid kind"),
            ));
        }
    };
    let mut keys = common.to_vec();
    keys.extend(specific);
    exact(
        event,
        &keys,
        if s(event, "kind") == "evaluation" {
            &["reason"]
        } else {
            &[]
        },
    )?;
    if event["schemaVersion"] != 1 || !contract::canonical_timestamp(s(event, "at")) {
        return Err(Error::new(
            "event_conflict",
            crate::i18n::text(
                "habit schema 또는 timestamp 오류",
                "Invalid habit schema or timestamp",
            ),
        ));
    }
    pattern(s(event, "eventId"), r"^ev-[0-9a-f]{16}$")?;
    let kind = s(event, "kind");
    if kind != "observation" {
        pattern(s(event, "habitId"), r"^h-[0-9a-f]{16}$")?;
        if !positive(&event["version"]) {
            return Err(Error::new(
                "usage",
                crate::i18n::text("version 오류", "Invalid version"),
            ));
        }
    }
    match kind {
        "observation" => {
            pattern(s(event, "pattern"), r"^[a-z0-9][a-z0-9.-]{2,63}$")?;
            if ![
                "intent",
                "delivery",
                "retry",
                "review",
                "verification",
                "tooling",
                "recovery",
            ]
            .contains(&s(event, "taxonomy"))
                || !["incident", "principle"].contains(&s(event, "sourceKind"))
            {
                return Err(Error::new(
                    "usage",
                    crate::i18n::text(
                        "observation 분류 오류",
                        "Invalid observation classification",
                    ),
                ));
            }
            contract::opaque_id(s(event, "sourceToken"), "source-token")?;
            contract::opaque_id(s(event, "sourceGroup"), "source-group")?;
        }
        "proposal" => {
            pattern(s(event, "pattern"), r"^[a-z0-9][a-z0-9.-]{2,63}$")?;
            contract::safe_text(s(event, "statement"), "statement", 160)?;
            let values = event["sourceEventIds"].as_array().ok_or_else(|| {
                Error::new(
                    "habit_event_invalid",
                    crate::i18n::text(
                        "source events 배열 필요",
                        "A source events array is required",
                    ),
                )
            })?;
            let mut prior = None;
            for value in values {
                let value = value.as_str().ok_or_else(|| {
                    Error::new(
                        "habit_event_invalid",
                        crate::i18n::text("source event ID 필요", "A source event ID is required"),
                    )
                })?;
                pattern(value, r"^ev-[0-9a-f]{16}$")?;
                if prior.is_some_and(|p| p >= value) {
                    return Err(Error::new(
                        "event_conflict",
                        crate::i18n::text(
                            "proposal source events는 중복 없이 정렬되어야 합니다",
                            "Proposal source events must be sorted and unique",
                        ),
                    ));
                }
                prior = Some(value);
            }
        }
        "adoption" => {
            rule_path(s(event, "ruleRef"))?;
            pattern(s(event, "ruleHash"), r"^[0-9a-f]{64}$")?;
            contract::safe_text(s(event, "reason"), "reason", 240)?;
        }
        "retirement" => {
            contract::safe_text(s(event, "reason"), "reason", 240)?;
        }
        "evaluation" => {
            pattern(s(event, "workSlug"), r"^[a-z0-9][a-z0-9-]{1,50}$")?;
            if !["ineligible", "skipped", "clean", "recurred"].contains(&s(event, "outcome"))
                || event["revision"]
                    .as_u64()
                    .is_none_or(|n| n > 9_007_199_254_740_991)
            {
                return Err(Error::new(
                    "usage",
                    crate::i18n::text("evaluation 필드 오류", "Invalid evaluation field"),
                ));
            }
            if !event["predecessorEventId"].is_null() {
                pattern(s(event, "predecessorEventId"), r"^ev-[0-9a-f]{16}$")?;
            }
            if event.get("reason").is_some() {
                contract::safe_text(s(event, "reason"), "reason", 240)?;
            }
        }
        _ => unreachable!(),
    }
    if serde_json::to_vec(event)?.len() + 1 >= 2048 {
        return Err(Error::new(
            "privacy_rejected",
            crate::i18n::text("habit event 크기 초과", "Habit event size limit exceeded"),
        ));
    }
    if event["eventId"] != expected_id(event) {
        return Err(Error::new(
            "event_conflict",
            crate::i18n::text(
                "habit event identity가 일치하지 않습니다",
                "Habit event identity mismatch",
            ),
        ));
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct Version {
    pub proposal: Value,
    pub adoption: Option<Value>,
    pub retirement: Option<Value>,
}
#[derive(Default, Debug)]
pub struct State {
    pub events: BTreeMap<String, Value>,
    pub versions: BTreeMap<String, Version>,
    pub evaluations: BTreeMap<String, Value>,
}
pub fn reduce(events: &[Value]) -> Result<State> {
    let mut state = State::default();
    for event in events {
        validate(event)?;
        let event_id = s(event, "eventId");
        if let Some(prior) = state.events.get(event_id) {
            if semantic(prior) == semantic(event) {
                continue;
            }
            return Err(Error::new(
                "event_conflict",
                crate::i18n::text(
                    "habit event identity가 충돌합니다",
                    "Habit event identity conflict",
                ),
            ));
        }
        let habit = s(event, "habitId");
        let version = event["version"].as_u64().unwrap_or(0);
        let key = format!("{habit}@{version}");
        match s(event, "kind") {
            "observation" => {}
            "proposal" => {
                let mut groups = BTreeSet::new();
                let mut incident = false;
                for source in event["sourceEventIds"].as_array().unwrap() {
                    let source = state
                        .events
                        .get(source.as_str().unwrap())
                        .filter(|e| e["kind"] == "observation")
                        .ok_or_else(|| {
                            Error::new(
                                "habit_transition",
                                crate::i18n::text(
                                    "proposal source observation이 없습니다",
                                    "Proposal source observation is missing",
                                ),
                            )
                        })?;
                    if source["pattern"] != event["pattern"] {
                        return Err(Error::new(
                            "habit_transition",
                            crate::i18n::text(
                                "proposal source pattern이 일치하지 않습니다",
                                "Proposal source pattern mismatch",
                            ),
                        ));
                    }
                    groups.insert(s(source, "sourceGroup"));
                    incident |= source["sourceKind"] == "incident";
                }
                if groups.len() < 2 || !incident {
                    return Err(Error::new(
                        "habit_transition",
                        crate::i18n::text(
                            "proposal에는 다른 source group 두 개와 incident 근거가 필요합니다",
                            "A proposal requires two different source groups and incident evidence",
                        ),
                    ));
                }
                let latest = state
                    .versions
                    .values()
                    .filter(|v| v.proposal["habitId"] == habit)
                    .max_by_key(|v| v.proposal["version"].as_u64());
                if let Some(latest) = latest {
                    if latest.retirement.is_none()
                        || version != latest.proposal["version"].as_u64().unwrap() + 1
                        || latest.proposal["pattern"] != event["pattern"]
                    {
                        return Err(Error::new(
                            "habit_transition",
                            crate::i18n::text(
                                "retired version 다음에만 같은 pattern 새 version을 만들 수 있습니다",
                                "A new version for the same pattern requires the previous version to be retired",
                            ),
                        ));
                    }
                } else {
                    let expected = format!(
                        "h-{}",
                        &sha256(format!(
                            "{}\0{}",
                            s(event, "pattern"),
                            s(event, "statement")
                        ))[..16]
                    );
                    if version != 1
                        || habit != expected
                        || state
                            .versions
                            .values()
                            .any(|v| v.proposal["pattern"] == event["pattern"])
                    {
                        return Err(Error::new(
                            "habit_transition",
                            crate::i18n::text(
                                "첫 habit identity 또는 parallel proposal 오류",
                                "Invalid initial habit identity or parallel proposal",
                            ),
                        ));
                    }
                }
                state.versions.insert(
                    key,
                    Version {
                        proposal: event.clone(),
                        adoption: None,
                        retirement: None,
                    },
                );
            }
            "adoption" => {
                let version = state
                    .versions
                    .get_mut(&key)
                    .filter(|v| v.adoption.is_none() && v.retirement.is_none())
                    .ok_or_else(|| {
                        Error::new(
                            "habit_transition",
                            crate::i18n::text(
                                "proposed habit만 채택할 수 있습니다",
                                "Only proposed habits can be adopted",
                            ),
                        )
                    })?;
                version.adoption = Some(event.clone());
            }
            "retirement" => {
                let version = state
                    .versions
                    .get_mut(&key)
                    .filter(|v| v.retirement.is_none())
                    .ok_or_else(|| {
                        Error::new(
                            "habit_transition",
                            crate::i18n::text(
                                "아직 은퇴하지 않은 habit만 은퇴할 수 있습니다",
                                "Only non-retired habits can be retired",
                            ),
                        )
                    })?;
                version.retirement = Some(event.clone());
            }
            "evaluation" => {
                state
                    .versions
                    .get(&key)
                    .filter(|v| v.adoption.is_some() && v.retirement.is_none())
                    .ok_or_else(|| {
                        Error::new(
                            "habit_transition",
                            crate::i18n::text(
                                "현재 adopted habit만 평가할 수 있습니다",
                                "Only currently adopted habits can be evaluated",
                            ),
                        )
                    })?;
                let key = format!("{key}@{}", s(event, "workSlug"));
                if let Some(prior) = state.evaluations.get(&key) {
                    if event["revision"].as_u64() != prior["revision"].as_u64().map(|n| n + 1)
                        || event["predecessorEventId"] != prior["eventId"]
                        || event.get("reason").is_none()
                    {
                        return Err(Error::new(
                            "stale_correction",
                            crate::i18n::text(
                                "evaluation correction chain 오류",
                                "Invalid evaluation correction chain",
                            ),
                        ));
                    }
                } else if event["revision"] != 0
                    || !event["predecessorEventId"].is_null()
                    || event.get("reason").is_some()
                {
                    return Err(Error::new(
                        "habit_transition",
                        crate::i18n::text(
                            "첫 평가는 revision 0이어야 합니다",
                            "The first evaluation must have revision 0",
                        ),
                    ));
                }
                state.evaluations.insert(key, event.clone());
            }
            _ => unreachable!(),
        }
        state.events.insert(event_id.into(), event.clone());
    }
    Ok(state)
}
pub fn metrics(state: &State, habit: &str, version: u64) -> Value {
    let (mut eligible, mut applied, mut recurred) = (0, 0, 0);
    for event in state
        .evaluations
        .values()
        .filter(|e| e["habitId"] == habit && e["version"] == version)
    {
        match s(event, "outcome") {
            "skipped" => eligible += 1,
            "clean" => {
                eligible += 1;
                applied += 1;
            }
            "recurred" => {
                eligible += 1;
                applied += 1;
                recurred += 1;
            }
            _ => {}
        }
    }
    json!({"eligible":eligible,"applied":applied,"recurred":recurred,"applicationRate":if eligible==0{None}else{Some(f64::from(applied)/f64::from(eligible))},"recurrenceRate":if applied==0{None}else{Some(f64::from(recurred)/f64::from(applied))},"verdict":if applied<3{"insufficient"}else{"observed"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observation(group: &str) -> Value {
        let mut e = json!({"schemaVersion":1,"eventId":"","at":"2026-09-21T00:00:00.000Z","kind":"observation","pattern":"verification.failed-recheck","taxonomy":"verification","sourceToken":"src-test","sourceGroup":group,"sourceKind":"incident"});
        e["eventId"] = expected_id(&e).into();
        e
    }
    #[test]
    fn replay_is_idempotent_and_conflict_is_rejected() {
        let e = observation("grp-a");
        assert_eq!(reduce(&[e.clone(), e.clone()]).unwrap().events.len(), 1);
        let mut conflict = e.clone();
        conflict["taxonomy"] = "intent".into();
        assert_eq!(reduce(&[e, conflict]).unwrap_err().code, "event_conflict");
    }
    #[test]
    fn proposal_requires_independent_evidence() {
        let e = observation("grp-a");
        let mut p = json!({"schemaVersion":1,"eventId":"","at":"2026-09-21T00:00:00.000Z","kind":"proposal","habitId":format!("h-{}",&sha256("verification.failed-recheck\0재검증한다")[..16]),"version":1,"pattern":"verification.failed-recheck","statement":"재검증한다","sourceEventIds":[e["eventId"]]});
        p["eventId"] = expected_id(&p).into();
        assert_eq!(reduce(&[e, p]).unwrap_err().code, "habit_transition");
    }
    #[test]
    fn duplicate_json_key_cannot_hide_private_value() {
        assert_eq!(
            scan_tokens(r#"{"sourceToken":"ghp_secret","sourceToken":"safe"}"#)
                .unwrap_err()
                .code,
            "privacy_rejected"
        );
    }
    #[test]
    fn harvest_exemption_does_not_exempt_unknown_fields() {
        assert!(scan(&json!({"patch":"diff --git\nx=y"}), true).is_ok());
        assert!(scan(&json!({"desc":"ghp_secret"}), true).is_err());
        assert!(scan(&json!({"message":{"ghp_secret":"ordinary"}}), true).is_err());
    }
}
