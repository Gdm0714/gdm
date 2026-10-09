//! Append-only, privacy-filtered habits. A proposal is evidence, never a rule until adopted.
mod ledger;
mod model;

use super::{contract, store};
use crate::support::{
    Error, Result, now, print_json, read_flag, read_flags, required_flag, sha256,
};
pub use model::{metrics, reduce};

pub fn overview(cwd: &Path) -> Result<Value> {
    let events = ledger::read(cwd)?;
    let state = reduce(&events)?;
    Ok(json!({
        "candidates": state.versions.values().filter(|v| v.adoption.is_none()).count(),
        "adopted": state.versions.values().filter(|v| v.adoption.is_some() && v.retirement.is_none()).count(),
        "next": if events.is_empty() { "gdm habit harvest" } else { "gdm habit status" }
    }))
}
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

fn flags(args: &[String], valued: &[&str], booleans: &[&str], repeat: &[&str]) -> Result<()> {
    let mut seen = BTreeSet::new();
    let mut i = 0;
    while i < args.len() {
        let token = args[i].strip_prefix("--").ok_or_else(|| {
            Error::new(
                "usage",
                crate::i18n::text(
                    "예상하지 않은 habit 위치 인자",
                    "Unexpected positional habit argument",
                ),
            )
        })?;
        let (name, inline) = token
            .split_once('=')
            .map_or((token, None), |(a, b)| (a, Some(b)));
        if !repeat.contains(&name) && !seen.insert(name) {
            return Err(Error::new(
                "usage",
                crate::i18n::text("단일 habit 플래그 중복", "Duplicate singleton habit flag"),
            ));
        }
        if valued.contains(&name) {
            if inline.is_none() {
                i += 1;
                if args.get(i).is_none_or(|v| v.starts_with("--")) {
                    return Err(Error::new(
                        "usage",
                        crate::i18n::text("habit 플래그 값 필요", "A habit flag value is required"),
                    ));
                }
            }
        } else if !booleans.contains(&name) || inline.is_some() {
            return Err(Error::new(
                "usage",
                crate::i18n::text("알 수 없는 habit 플래그", "Unknown habit flag"),
            ));
        }
        i += 1;
    }
    Ok(())
}

fn scan_arguments(args: &[String]) -> Result<()> {
    for value in args {
        if let Some(flag) = value.strip_prefix("--") {
            let (key, value) = flag
                .split_once('=')
                .map_or((flag, None), |(k, v)| (k, Some(v)));
            contract::assert_no_sensitive(key, "habit-flag")?;
            if let Some(value) = value {
                contract::assert_no_sensitive(value, "habit-argument")?;
            }
        } else {
            contract::assert_no_sensitive(value, "habit-argument")?;
        }
    }
    Ok(())
}

fn reference(value: &str) -> Result<(String, u64)> {
    contract::assert_no_sensitive(value, "habit-reference")?;
    let (id, version) = value.rsplit_once('@').ok_or_else(|| {
        Error::new(
            "usage",
            crate::i18n::text(
                "habit reference는 habit-id@version 형식입니다",
                "A habit reference uses habit-id@version",
            ),
        )
    })?;
    model::pattern(id, r"^h-[0-9a-f]{16}$")?;
    model::pattern(version, r"^[1-9][0-9]*$")?;
    let version = version
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| {
            Error::new(
                "usage",
                crate::i18n::text("version 형식 오류", "Invalid version format"),
            )
        })?;
    Ok((id.into(), version))
}

fn observation(raw: Value, at: &str) -> Result<Value> {
    model::scan(&raw, false)?;
    model::exact(
        &raw,
        &[
            "schemaVersion",
            "pattern",
            "taxonomy",
            "sourceToken",
            "sourceGroup",
            "sourceKind",
        ],
        &[],
    )
    .map_err(|_| {
        Error::new(
            "privacy_rejected",
            crate::i18n::text("observation 필드 거부", "Observation field rejected"),
        )
    })?;
    if raw["schemaVersion"] != 1 {
        return Err(Error::new(
            "usage",
            crate::i18n::text(
                "observation schemaVersion 오류",
                "Invalid observation schemaVersion",
            ),
        ));
    }
    let mut value = json!({"schemaVersion":1,"eventId":"","at":at,"kind":"observation"});
    for key in [
        "pattern",
        "taxonomy",
        "sourceToken",
        "sourceGroup",
        "sourceKind",
    ] {
        value[key] = raw[key].clone();
    }
    value["eventId"] = model::expected_id(&value).into();
    model::validate(&value)?;
    Ok(value)
}

fn append(cwd: &Path, event: Value) -> Result<()> {
    let count = ledger::append(cwd, std::slice::from_ref(&event))?;
    println!(
        "{}: {}{}",
        model::s(&event, "kind"),
        model::s(&event, "eventId"),
        if count == 0 {
            crate::i18n::text(" (변경 없음)", " (unchanged)")
        } else {
            ""
        }
    );
    Ok(())
}

pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    scan_arguments(args)?;
    let (command, rest) = args.split_first().ok_or_else(|| {
        Error::new(
            "usage",
            crate::i18n::text("habit 하위 명령 필요", "A habit subcommand is required"),
        )
    })?;
    let at = now();
    match command.as_str() {
        "observe" => {
            flags(
                rest,
                &[
                    "pattern",
                    "taxonomy",
                    "source-token",
                    "source-group",
                    "source-kind",
                ],
                &[],
                &[],
            )?;
            let raw = json!({"schemaVersion":1,"pattern":required_flag(rest,"pattern")?,"taxonomy":required_flag(rest,"taxonomy")?,"sourceToken":required_flag(rest,"source-token")?,"sourceGroup":required_flag(rest,"source-group")?,"sourceKind":required_flag(rest,"source-kind")?});
            append(cwd, observation(raw, &at)?)
        }
        "import" => {
            flags(rest, &["file"], &[], &[])?;
            let bytes = store::contained(
                cwd,
                &required_flag(rest, "file")?,
                "observation-file",
                16 * 1024 * 1024,
            )?;
            let text = std::str::from_utf8(&bytes).map_err(|_| {
                Error::new(
                    "privacy_rejected",
                    crate::i18n::text("observation 인코딩 오류", "Invalid observation encoding"),
                )
            })?;
            let lines: Vec<_> = text.split_terminator('\n').collect();
            if lines.is_empty() {
                return Err(Error::new(
                    "usage",
                    crate::i18n::text(
                        "observation file이 비어 있습니다",
                        "The observation file is empty",
                    ),
                ));
            }
            // Scan every raw token before decoding any record. Duplicate keys cannot hide private values.
            for line in &lines {
                if line.is_empty() || line.len() >= 2048 {
                    return Err(Error::new(
                        "privacy_rejected",
                        crate::i18n::text(
                            "observation import 크기 오류",
                            "Invalid observation import size",
                        ),
                    ));
                }
                model::scan_tokens(line)?;
            }
            let mut events = Vec::new();
            for line in lines {
                let raw = serde_json::from_str(line).map_err(|_| {
                    Error::new(
                        "privacy_rejected",
                        crate::i18n::text("observation JSON 오류", "Invalid observation JSON"),
                    )
                })?;
                events.push(observation(raw, &at)?);
            }
            crate::lprint!(
                "observation import: {}개 추가",
                "Observation import: {} added",
                ledger::append(cwd, &events)?
            );
            Ok(())
        }
        "propose" => {
            flags(
                rest,
                &["pattern", "statement", "source-event", "habit"],
                &[],
                &["source-event"],
            )?;
            let pattern = required_flag(rest, "pattern")?;
            model::pattern(&pattern, r"^[a-z0-9][a-z0-9.-]{2,63}$")?;
            let statement =
                contract::safe_text(&required_flag(rest, "statement")?, "statement", 160)?;
            let sources: BTreeSet<_> = read_flags(rest, "source-event")?.into_iter().collect();
            let events = ledger::read(cwd)?;
            let state = reduce(&events)?;
            let (id, version) = if let Some(id) = read_flag(rest, "habit")? {
                model::pattern(&id, r"^h-[0-9a-f]{16}$")?;
                let latest = state
                    .versions
                    .values()
                    .filter(|v| v.proposal["habitId"] == id)
                    .max_by_key(|v| v.proposal["version"].as_u64().unwrap_or(0))
                    .ok_or_else(|| {
                        Error::new(
                            "habit_transition",
                            crate::i18n::text(
                                "habit lineage가 없습니다",
                                "Habit lineage not found",
                            ),
                        )
                    })?;
                (
                    id,
                    latest.proposal["version"].as_u64().unwrap_or(0)
                        + u64::from(latest.retirement.is_some()),
                )
            } else {
                (
                    format!("h-{}", &sha256(format!("{pattern}\0{statement}"))[..16]),
                    1,
                )
            };
            let mut event = json!({"schemaVersion":1,"eventId":"","at":at,"kind":"proposal","habitId":id,"version":version,"pattern":pattern,"statement":statement,"sourceEventIds":sources});
            event["eventId"] = model::expected_id(&event).into();
            append(cwd, event)
        }
        "adopt" | "retire" | "evaluate" => {
            let (target, args) = rest.split_first().ok_or_else(|| {
                Error::new(
                    "usage",
                    crate::i18n::text("habit reference 필요", "A habit reference is required"),
                )
            })?;
            let (id, version) = reference(target)?;
            if command == "evaluate" {
                return evaluate(cwd, args, &id, version, &at);
            }
            let allowed = if command == "adopt" {
                vec!["rule-ref", "reason"]
            } else {
                vec!["reason"]
            };
            flags(args, &allowed, &[], &[])?;
            let reason = contract::safe_text(&required_flag(args, "reason")?, "reason", 240)?;
            let mut event = json!({"schemaVersion":1,"eventId":"","at":at,"kind":if command=="adopt"{"adoption"}else{"retirement"},"habitId":id,"version":version,"reason":reason});
            if command == "adopt" {
                let path = required_flag(args, "rule-ref")?;
                model::rule_path(&path)?;
                let bytes = store::contained(cwd, &path, "rule-ref", 16 * 1024 * 1024)?;
                event["ruleRef"] = path.into();
                event["ruleHash"] = sha256(bytes).into();
            }
            event["eventId"] = model::expected_id(&event).into();
            append(cwd, event)
        }
        "status" => {
            flags(rest, &[], &["json"], &[])?;
            let events = ledger::read(cwd)?;
            let state = reduce(&events)?;
            let mut versions:Vec<_>=state.versions.values().map(|v|{
                let lifecycle=match(v.adoption.is_some(),v.retirement.is_some()){(false,false)=>"proposed",(true,false)=>"adopted",(false,true)=>"rejected",(true,true)=>"retired"};
                let mut value=json!({"habitId":v.proposal["habitId"],"version":v.proposal["version"],"pattern":v.proposal["pattern"],"statement":v.proposal["statement"],"lifecycle":lifecycle,"metrics":metrics(&state,model::s(&v.proposal,"habitId"),v.proposal["version"].as_u64().unwrap_or(0))});
                if let Some(adoption)=&v.adoption {value["ruleRef"]=adoption["ruleRef"].clone();value["ruleHash"]=adoption["ruleHash"].clone();}value
            }).collect();
            versions.sort_by(|a, b| {
                model::s(a, "habitId")
                    .cmp(model::s(b, "habitId"))
                    .then(a["version"].as_u64().cmp(&b["version"].as_u64()))
            });
            if rest.iter().any(|a| a == "--json") {
                print_json(&json!({"schemaVersion":1,"versions":versions}))
            } else {
                for value in versions {
                    println!(
                        "{}@{} · {} · applied {}",
                        model::s(&value, "habitId"),
                        value["version"],
                        model::s(&value, "lifecycle"),
                        value["metrics"]["applied"]
                    );
                }
                Ok(())
            }
        }
        "harvest" => {
            flags(rest, &[], &["json"], &[])?;
            let value = harvest(cwd, &at)?;
            if rest.iter().any(|a| a == "--json") {
                print_json(&value)
            } else {
                crate::lprint!(
                    "habit 수확: {}개 추가 · {}개 재사용 · {}개 안전 제외",
                    "Habit harvest: {} added · {} reused · {} safely excluded",
                    value["appended"],
                    value["replayed"],
                    value["skippedUnsafe"]
                );
                Ok(())
            }
        }
        _ => Err(Error::new(
            "usage",
            crate::i18n::text("habit 명령이 잘못됐습니다", "Invalid habit command"),
        )),
    }
}

fn evaluate(cwd: &Path, args: &[String], id: &str, version: u64, at: &str) -> Result<()> {
    flags(args, &["work", "outcome", "correct", "reason"], &[], &[])?;
    let correct = read_flag(args, "correct")?;
    let reason = read_flag(args, "reason")?;
    if correct.is_some() != reason.is_some() {
        return Err(Error::new(
            "usage",
            crate::i18n::text(
                "correction에는 --correct와 --reason이 함께 필요합니다",
                "Corrections require both --correct and --reason",
            ),
        ));
    }
    let slug = required_flag(args, "work")?;
    model::pattern(&slug, r"^[a-z0-9][a-z0-9-]{1,50}$")?;
    let outcome = required_flag(args, "outcome")?;
    if !["ineligible", "skipped", "clean", "recurred"].contains(&outcome.as_str()) {
        return Err(Error::new(
            "usage",
            crate::i18n::text("outcome 값 오류", "Invalid outcome value"),
        ));
    }
    let work = store::load(cwd, &slug)?;
    let state = reduce(&ledger::read(cwd)?)?;
    let lifecycle = state
        .versions
        .get(&format!("{id}@{version}"))
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
    let adoption = lifecycle.adoption.as_ref().unwrap();
    if work["done"] != true {
        return Err(Error::new(
            "habit_transition",
            crate::i18n::text(
                "완료된 work만 평가할 수 있습니다",
                "Only completed work can be evaluated",
            ),
        ));
    }
    let active: Vec<_> = work["contract"]["activeHabits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["habitId"] == id)
        .collect();
    let exact = active.iter().find(|a| a["version"] == version);
    let is_applied = outcome == "clean" || outcome == "recurred";
    if active.is_empty() && is_applied
        || exact.is_some() && !is_applied
        || !active.is_empty() && exact.is_none()
    {
        return Err(Error::new(
            "evaluation_activation_mismatch",
            crate::i18n::text(
                "evaluation outcome과 work activation이 일치하지 않습니다",
                "Evaluation outcome does not match work activation",
            ),
        ));
    }
    if let Some(active) = exact {
        if active["ruleRef"] != adoption["ruleRef"] || active["ruleHash"] != adoption["ruleHash"] {
            return Err(Error::new(
                "evaluation_activation_mismatch",
                crate::i18n::text(
                    "work activation과 habit adoption이 일치하지 않습니다",
                    "Work activation does not match habit adoption",
                ),
            ));
        }
        let bytes = store::contained(
            cwd,
            model::s(active, "ruleRef"),
            "rule-ref",
            16 * 1024 * 1024,
        )?;
        if active["ruleHash"] != sha256(bytes) {
            return Err(Error::new(
                "habit_rule_changed",
                crate::i18n::text(
                    "활성화 뒤 rule 파일이 바뀌었습니다",
                    "The rule file changed after activation",
                ),
            ));
        }
    }
    if outcome != "ineligible"
        && work["doneAt"]
            .as_str()
            .is_some_and(|done| done < model::s(adoption, "at"))
    {
        return Err(Error::new(
            "habit_transition",
            crate::i18n::text(
                "채택 이전 완료 작업은 ineligible만 기록 가능합니다",
                "Work completed before adoption can only be recorded as ineligible",
            ),
        ));
    }
    let current = state.evaluations.get(&format!("{id}@{version}@{slug}"));
    let mut event = json!({"schemaVersion":1,"eventId":"","at":at,"kind":"evaluation","habitId":id,"version":version,"workSlug":slug,"outcome":outcome,"revision":0,"predecessorEventId":null});
    match current {
        None => {
            if correct.is_some() {
                return Err(Error::new(
                    "stale_correction",
                    crate::i18n::text(
                        "첫 평가는 correction을 받을 수 없습니다",
                        "The first evaluation cannot be a correction",
                    ),
                ));
            }
        }
        Some(current) => {
            if let (Some(correct), Some(reason)) = (correct, reason) {
                model::pattern(&correct, r"^ev-[0-9a-f]{16}$")?;
                let reason = contract::safe_text(&reason, "reason", 240)?;
                if current["predecessorEventId"] == correct
                    && current["outcome"] == outcome
                    && current["reason"] == reason
                {
                    return append(cwd, current.clone());
                }
                if current["eventId"] != correct {
                    return Err(Error::new(
                        "stale_correction",
                        crate::i18n::text(
                            "최신 evaluation만 수정할 수 있습니다",
                            "Only the latest evaluation can be corrected",
                        ),
                    ));
                }
                if current["outcome"] == outcome {
                    return Err(Error::new(
                        "usage",
                        crate::i18n::text(
                            "evaluation outcome이 바뀌지 않았습니다",
                            "The evaluation outcome did not change",
                        ),
                    ));
                }
                event["revision"] = (current["revision"].as_u64().unwrap_or(0) + 1).into();
                event["predecessorEventId"] = current["eventId"].clone();
                event["reason"] = reason.into();
            } else if current["revision"] == 0 && current["outcome"] == outcome {
                return append(cwd, current.clone());
            } else {
                return Err(Error::new(
                    "stale_correction",
                    crate::i18n::text(
                        "기존 평가는 --correct와 --reason으로 수정해야 합니다",
                        "Correct an existing evaluation with --correct and --reason",
                    ),
                ));
            }
        }
    }
    event["eventId"] = model::expected_id(&event).into();
    append(cwd, event)
}

pub fn activate(cwd: &Path, slug: &str, target: &str) -> Result<()> {
    let (id, version) = reference(target)?;
    let state = reduce(&ledger::read(cwd)?)?;
    let lifecycle = state
        .versions
        .get(&format!("{id}@{version}"))
        .filter(|v| v.adoption.is_some() && v.retirement.is_none())
        .ok_or_else(|| {
            Error::new(
                "habit_transition",
                crate::i18n::text(
                    "현재 adopted habit만 활성화할 수 있습니다",
                    "Only currently adopted habits can be activated",
                ),
            )
        })?;
    let adoption = lifecycle.adoption.as_ref().unwrap();
    let bytes = store::contained(
        cwd,
        model::s(adoption, "ruleRef"),
        "rule-ref",
        16 * 1024 * 1024,
    )?;
    if adoption["ruleHash"] != sha256(bytes) {
        return Err(Error::new(
            "habit_rule_changed",
            crate::i18n::text(
                "채택 뒤 rule 파일이 바뀌었습니다",
                "The rule file changed after adoption",
            ),
        ));
    }
    let mut work = store::load(cwd, slug)?;
    let active = work["contract"]["activeHabits"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(existing) = active
        .iter()
        .find(|a| a["habitId"] == id && a["version"] == version)
    {
        if existing["ruleRef"] == adoption["ruleRef"]
            && existing["ruleHash"] == adoption["ruleHash"]
        {
            crate::lprint!(
                "habit 활성화 변경 없음: {target}",
                "Habit activation unchanged: {target}"
            );
            return Ok(());
        }
        return Err(Error::new(
            "habit_activation_conflict",
            crate::i18n::text(
                "같은 habit version의 다른 활성화가 이미 있습니다",
                "A different activation of this habit version already exists",
            ),
        ));
    }
    if work["done"] == true
        || work["checks"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|c| c["status"] == "proven")
        || store::read_journal(cwd, slug)?
            .iter()
            .any(|e| e["event"] == "pass")
    {
        return Err(Error::new(
            "habit_activation_locked",
            crate::i18n::text(
                "첫 확인 항목 통과 뒤에는 habit을 활성화할 수 없습니다",
                "Habits cannot be activated after the first check passes",
            ),
        ));
    }
    let at = now();
    let entry = json!({"habitId":id,"version":version,"ruleRef":adoption["ruleRef"],"ruleHash":adoption["ruleHash"],"activatedAt":at});
    let mut active = active;
    active.push(entry.clone());
    work["contract"]["activeHabits"] = active.into();
    let mut event = entry;
    event["ts"] = at.into();
    event["event"] = "contract.habit-activated".into();
    store::append_journal(cwd, slug, &event)?;
    store::save(cwd, &work)?;
    crate::lprint!("habit 활성화: {target}", "Habit activated: {target}");
    Ok(())
}

fn harvest(cwd: &Path, at: &str) -> Result<Value> {
    let mut result = json!({"scanned":0,"mapped":0,"appended":0,"replayed":0,"skippedUnsafe":0,"skippedUnrecognized":0});
    let mut additions = Vec::new();
    let existing = reduce(&ledger::read(cwd)?)?;
    let root = store::root(cwd);
    if !root.exists() {
        return Ok(result);
    }
    let mut slugs = std::fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
    slugs.sort_by_key(|e| e.file_name());
    for directory in slugs {
        if !directory.file_type()?.is_dir() {
            continue;
        }
        let slug = directory.file_name().to_string_lossy().into_owned();
        if model::pattern(&slug, r"^[a-z0-9][a-z0-9-]{1,50}$").is_err() {
            continue;
        }
        let mut denied = BTreeMap::<String, usize>::new();
        for (index, event) in store::read_journal(cwd, &slug)?.iter().enumerate() {
            increment(&mut result, "scanned");
            if serde_json::to_vec(event)?.len() >= 2048 || model::scan(event, true).is_err() {
                increment(&mut result, "skippedUnsafe");
                continue;
            }
            let mapping = match model::s(event, "event") {
                "miss" if !model::s(event, "desc").trim().is_empty() => {
                    let kind = model::s(event, "type").trim().to_lowercase();
                    Some((
                        "miss",
                        if kind.is_empty() {
                            "verification.escape-after-done".into()
                        } else {
                            format!("verification.escape-after-done-{}", &sha256(kind)[..16])
                        },
                        "verification",
                    ))
                }
                "recheck" if event["ok"] == false => Some((
                    "recheck-failed",
                    "verification.failed-recheck".into(),
                    "verification",
                )),
                "plan.edit" if !model::s(event, "reason").trim().is_empty() => {
                    Some(("plan-edit", "intent.criteria-revised".into(), "intent"))
                }
                "denied" => {
                    let code = model::s(event, "code");
                    if contract::opaque_id(code, "harvest-code").is_ok() {
                        let count = denied.entry(code.into()).or_default();
                        *count += 1;
                        if *count >= 2 {
                            Some((
                                "denied-repeat",
                                "recovery.repeated-denial".into(),
                                "recovery",
                            ))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => None,
            };
            let Some((class, pattern, taxonomy)) = mapping else {
                increment(&mut result, "skippedUnrecognized");
                continue;
            };
            increment(&mut result, "mapped");
            let event = observation(
                json!({"schemaVersion":1,"pattern":pattern,"taxonomy":taxonomy,"sourceToken":format!("src-{}",&sha256(format!("gdm-harvest-source-v1\0{slug}\0{}\0{class}",index+1))[..16]),"sourceGroup":format!("grp-{}",&sha256(format!("gdm-harvest-group-v1\0{slug}"))[..16]),"sourceKind":"incident"}),
                at,
            )?;
            if existing.events.contains_key(model::s(&event, "eventId")) {
                increment(&mut result, "replayed");
            } else {
                additions.push(event);
            }
        }
    }
    result["appended"] = ledger::append(cwd, &additions)?.into();
    Ok(result)
}
fn increment(value: &mut Value, key: &str) {
    value[key] = (value[key].as_u64().unwrap_or(0) + 1).into();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn command(cwd: &Path, values: &[&str]) -> Result<()> {
        run(cwd, &values.iter().map(|v| (*v).into()).collect::<Vec<_>>())
    }
    fn adopted(cwd: &Path) -> String {
        std::fs::create_dir(cwd.join("rules")).unwrap();
        std::fs::write(
            cwd.join("rules/retry.md"),
            "Check evidence before repeating",
        )
        .unwrap();
        for (token, group) in [("src-one", "grp-one"), ("src-two", "grp-two")] {
            command(
                cwd,
                &[
                    "observe",
                    "--pattern",
                    "recovery.repeated-denial",
                    "--taxonomy",
                    "recovery",
                    "--source-token",
                    token,
                    "--source-group",
                    group,
                    "--source-kind",
                    "incident",
                ],
            )
            .unwrap();
        }
        let events = ledger::read(cwd).unwrap();
        command(
            cwd,
            &[
                "propose",
                "--pattern",
                "recovery.repeated-denial",
                "--statement",
                "재시도 전에 근거를 확인한다",
                "--source-event",
                model::s(&events[0], "eventId"),
                "--source-event",
                model::s(&events[1], "eventId"),
            ],
        )
        .unwrap();
        let events = ledger::read(cwd).unwrap();
        let reference = format!("{}@1", model::s(events.last().unwrap(), "habitId"));
        command(
            cwd,
            &[
                "adopt",
                &reference,
                "--rule-ref",
                "rules/retry.md",
                "--reason",
                "사용자 명시 승인",
            ],
        )
        .unwrap();
        reference
    }
    #[test]
    fn full_lifecycle_activation_correction_and_metrics() {
        let repo = tempfile::tempdir().unwrap();
        let target = adopted(repo.path());
        let at = now();
        let mut work = json!({"slug":"habit-work","brief":"habit lifecycle proof","createdAt":at,"done":false,"checks":[],"contract":contract::default_contract()});
        store::save(repo.path(), &work).unwrap();
        activate(repo.path(), "habit-work", &target).unwrap();
        work = store::load(repo.path(), "habit-work").unwrap();
        let bytes = b"verified";
        std::fs::write(repo.path().join(".gdm/habit-work/out/c1.txt"), bytes).unwrap();
        let at = now();
        work["checks"] = json!([{"id":"c1","desc":"checked","cmd":"true","expect":"exit 0","manual":false,"status":"proven","evidence":{"observed":".gdm/habit-work/out/c1.txt","sha256":sha256(bytes),"exitCode":0,"manual":false,"at":at}}]);
        work["done"] = true.into();
        work["doneAt"] = at.into();
        store::save(repo.path(), &work).unwrap();
        command(
            repo.path(),
            &[
                "evaluate",
                &target,
                "--work",
                "habit-work",
                "--outcome",
                "clean",
            ],
        )
        .unwrap();
        let events = ledger::read(repo.path()).unwrap();
        let first = model::s(events.last().unwrap(), "eventId").to_owned();
        command(
            repo.path(),
            &[
                "evaluate",
                &target,
                "--work",
                "habit-work",
                "--outcome",
                "recurred",
                "--correct",
                &first,
                "--reason",
                "재발 확인",
            ],
        )
        .unwrap();
        // Replaying an identical correction does not add another observation.
        command(
            repo.path(),
            &[
                "evaluate",
                &target,
                "--work",
                "habit-work",
                "--outcome",
                "recurred",
                "--correct",
                &first,
                "--reason",
                "재발 확인",
            ],
        )
        .unwrap();
        let events = ledger::read(repo.path()).unwrap();
        assert_eq!(events.len(), 6);
        let state = reduce(&events).unwrap();
        let (id, version) = reference(&target).unwrap();
        let counts = metrics(&state, &id, version);
        assert_eq!(counts["applied"], 1);
        assert_eq!(counts["recurred"], 1);
        assert_eq!(counts["verdict"], "insufficient");
        command(
            repo.path(),
            &["retire", &target, "--reason", "규칙 개선 필요"],
        )
        .unwrap();
        assert_eq!(
            command(
                repo.path(),
                &[
                    "evaluate",
                    &target,
                    "--work",
                    "habit-work",
                    "--outcome",
                    "clean"
                ]
            )
            .unwrap_err()
            .code,
            "habit_transition"
        );
    }
    #[test]
    fn activation_rejects_changed_rule_without_mutating_work() {
        let repo = tempfile::tempdir().unwrap();
        let target = adopted(repo.path());
        let work = json!({"slug":"habit-work","brief":"rule identity","createdAt":now(),"done":false,"checks":[],"contract":contract::default_contract()});
        store::save(repo.path(), &work).unwrap();
        let before = std::fs::read(repo.path().join(".gdm/habit-work/checks.json")).unwrap();
        std::fs::write(repo.path().join("rules/retry.md"), "changed rule").unwrap();
        assert_eq!(
            activate(repo.path(), "habit-work", &target)
                .unwrap_err()
                .code,
            "habit_rule_changed"
        );
        assert_eq!(
            std::fs::read(repo.path().join(".gdm/habit-work/checks.json")).unwrap(),
            before
        );
    }
}
