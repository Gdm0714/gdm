use super::{
    contract,
    state::{b, s},
    store,
};
use crate::support::{Error, Result, ensure_flags, now, read_flag, required_flag, sha256};
use serde_json::{Value, json};
use std::path::Path;
pub fn latest(journal: &[Value]) -> Result<Vec<Value>> {
    let mut out = serde_json::Map::new();
    for e in journal.iter().filter(|e| e["event"] == "attempt") {
        if e["schemaVersion"] != 1
            || !["fail", "retry"].contains(&s(&e["action"]))
            || !["command", "capability"].contains(&s(&e["sourceKind"]))
            || [
                "attemptId",
                "sourceId",
                "target",
                "errorCode",
                "fingerprint",
                "at",
                "hypothesis",
            ]
            .iter()
            .any(|k| !e[k].is_string())
            || !e["epoch"].is_number()
            || !e["failureCount"].is_number()
            || ![
                "awaiting-confirmation",
                "confirmation-permitted",
                "locked",
                "changed-permitted",
            ]
            .contains(&s(&e["decision"]))
        {
            return Err(Error::new("state_corrupt", "attempt journal 형식 오류"));
        }
        out.insert(s(&e["fingerprint"]).to_owned(), e.clone());
    }
    Ok(out.values().cloned().collect())
}
pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    let (sub, args) = args
        .split_first()
        .ok_or_else(|| Error::new("usage", "attempt 하위 명령 필요"))?;
    if !["fail", "retry"].contains(&sub.as_str()) {
        return Err(Error::new("usage", "attempt fail 또는 retry"));
    }
    ensure_flags(
        args,
        if sub == "fail" {
            &[
                "slug",
                "attempt-id",
                "command",
                "capability",
                "target",
                "error-code",
                "hypothesis",
            ]
        } else {
            &["slug", "attempt-id", "fingerprint", "changed", "evidence"]
        },
        &[],
    )?;
    let id = contract::opaque_id(&required_flag(args, "attempt-id")?, "attempt-id")?;
    if sub == "retry" {
        let changed = read_flag(args, "changed")?;
        let evidence = read_flag(args, "evidence")?;
        if changed.is_some() != evidence.is_some() {
            return Err(Error::new(
                "usage",
                "--changed와 --evidence는 함께 필요합니다",
            ));
        }
    }
    let w = store::resolve(cwd, read_flag(args, "slug")?.as_deref(), false)?;
    if b(&w["done"]) {
        return Err(Error::new("attempt_transition", "완료 작업 시도 추가 불가"));
    }
    let journal = store::read_journal(cwd, s(&w["slug"]))?;
    latest(&journal)?;
    let events = journal
        .iter()
        .filter(|e| e["event"] == "attempt")
        .collect::<Vec<_>>();
    let replay = events.iter().find(|e| e["attemptId"] == id);
    let at = now();
    let event;
    if sub == "fail" {
        let command = read_flag(args, "command")?;
        let capability = read_flag(args, "capability")?;
        if command.is_some() == capability.is_some() {
            return Err(Error::new("usage", "command 또는 capability 정확히 하나"));
        }
        let kind = if command.is_some() {
            "command"
        } else {
            "capability"
        };
        let source = contract::opaque_id(
            &command
                .or(capability)
                .unwrap()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            kind,
        )?;
        let target = contract::opaque_id(
            &required_flag(args, "target")?
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            "target",
        )?;
        let code = contract::opaque_id(&required_flag(args, "error-code")?, "error-code")?;
        let hypothesis =
            contract::safe_text(&required_flag(args, "hypothesis")?, "hypothesis", 240)?;
        let fp = format!(
            "fp-{}",
            &sha256(format!("{source}\0{target}\0{code}"))[..16]
        );
        if let Some(e) = replay {
            if e["action"] == "fail"
                && e["fingerprint"] == fp
                && e["sourceKind"] == kind
                && e["sourceId"] == source
                && e["target"] == target
                && e["errorCode"] == code
                && e["hypothesis"] == hypothesis
            {
                println!("{} · epoch {} · {}", fp, e["epoch"], s(&e["decision"]));
                return Ok(());
            }
            return Err(Error::new("attempt_id_conflict", "attempt-id 재사용 충돌"));
        }
        let last = events.iter().rev().find(|e| e["fingerprint"] == fp);
        if let Some(e) = last
            && (e["sourceKind"] != kind
                || e["sourceId"] != source
                || e["target"] != target
                || e["errorCode"] != code
                || !["confirmation-permitted", "changed-permitted"].contains(&s(&e["decision"])))
        {
            return Err(Error::new(
                "attempt_transition",
                "현재 상태에서 동일 실패 기록 불가",
            ));
        }
        let locked = last.is_some_and(|e| e["decision"] == "confirmation-permitted");
        event = json!({"schemaVersion":1,"event":"attempt","action":"fail","attemptId":id,"ts":at,"at":at,"sourceKind":kind,"sourceId":source,"target":target,"errorCode":code,"fingerprint":fp,"epoch":last.and_then(|e|e["epoch"].as_u64()).unwrap_or(0),"failureCount":if locked{2}else{1},"hypothesis":hypothesis,"decision":if locked{"locked"}else{"awaiting-confirmation"}});
    } else {
        let fp = required_flag(args, "fingerprint")?;
        contract::assert_no_sensitive(&fp, "fingerprint")?;
        if !regex::Regex::new(r"^fp-[0-9a-f]{16}$")
            .unwrap()
            .is_match(&fp)
        {
            return Err(Error::new("usage", "fingerprint 형식 오류"));
        }
        let changed = read_flag(args, "changed")?;
        let evidence = read_flag(args, "evidence")?;
        if changed.is_some() != evidence.is_some() {
            return Err(Error::new("usage", "changed와 evidence 함께 필요"));
        }
        if let Some(c) = &changed
            && !["dependency", "input", "code", "environment", "permission"].contains(&c.as_str())
        {
            return Err(Error::new("usage", "changed 종류 오류"));
        }
        let digest = evidence
            .as_ref()
            .map(|p| store::contained(cwd, p, "evidence", usize::MAX / 2).map(sha256))
            .transpose()?;
        if let Some(e) = replay {
            if e["action"] == "retry"
                && e["fingerprint"] == fp
                && e["changed"].as_str() == changed.as_deref()
                && e["evidence"].as_str() == evidence.as_deref()
                && e["evidenceSha256"].as_str() == digest.as_deref()
            {
                println!("{fp} · epoch {} · {}", e["epoch"], s(&e["decision"]));
                return Ok(());
            }
            return Err(Error::new("attempt_id_conflict", "attempt-id 충돌"));
        }
        let last = events
            .iter()
            .rev()
            .find(|e| e["fingerprint"] == fp)
            .ok_or_else(|| Error::new("attempt_not_found", "해당 실패 없음"))?;
        if changed.is_none() {
            if last["decision"] == "locked" {
                return Err(Error::new("unchanged_retry", "unchanged_retry"));
            }
            if last["decision"] != "awaiting-confirmation" {
                return Err(Error::new("attempt_transition", "확인 재시도 불가"));
            }
        } else {
            if last["decision"] != "locked" {
                return Err(Error::new(
                    "attempt_transition",
                    "변경 재시도는 잠금 뒤에만 가능",
                ));
            }
            if events.iter().any(|e| {
                e["fingerprint"] == fp && e["evidenceSha256"].as_str() == digest.as_deref()
            }) {
                return Err(Error::new("stale_evidence", "stale_evidence"));
            }
        }
        let mut next = json!({"schemaVersion":1,"event":"attempt","action":"retry","attemptId":id,"ts":at,"at":at,"sourceKind":last["sourceKind"],"sourceId":last["sourceId"],"target":last["target"],"errorCode":last["errorCode"],"fingerprint":fp,"epoch":last["epoch"].as_u64().unwrap_or(0)+u64::from(changed.is_some()),"failureCount":if changed.is_some(){json!(0)}else{last["failureCount"].clone()},"hypothesis":last["hypothesis"],"decision":if changed.is_some(){"changed-permitted"}else{"confirmation-permitted"}});
        if let Some(c) = changed {
            next["changed"] = json!(c);
            next["evidence"] = json!(evidence);
            next["evidenceSha256"] = json!(digest);
        }
        event = next;
    }
    store::append_journal(cwd, s(&w["slug"]), &event)?;
    println!(
        "{} · epoch {} · {}",
        s(&event["fingerprint"]),
        event["epoch"],
        s(&event["decision"])
    );
    Ok(())
}
