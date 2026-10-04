use super::{
    contract, fingerprint,
    state::{b, s},
    store,
};
use crate::support::{Error, Result, ensure_flags, now, read_flag, required_flag};
use serde_json::{Value, json};
use std::path::Path;
fn gate(m: &str) -> Error {
    Error::new("delivery_gate", m)
}
fn sha(v: &str) -> Result<String> {
    if !(7..=64).contains(&v.len()) || !v.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::new("delivery_invalid", "Git SHA 필요"));
    }
    Ok(v.to_lowercase())
}
fn id(v: &str) -> Result<String> {
    if !regex::Regex::new(r"^[A-Za-z0-9#._-]{1,128}$")
        .unwrap()
        .is_match(v)
    {
        return Err(Error::new("delivery_invalid", "identifier 형식 오류"));
    }
    Ok(v.into())
}
fn prepared(w: &Value) -> Result<Value> {
    if !b(&w["done"]) {
        return Err(gate("검증 완료 전 delivery 시작 불가"));
    }
    contract::assert_commit(w)?;
    w.get("delivery")
        .cloned()
        .ok_or_else(|| gate("delivery prepare 필요"))
}
fn merge_gate(d: &Value, head: &str) -> Result<()> {
    if d["head"] != head || d["pr"]["head"] != head {
        return Err(gate("현재 HEAD의 PR 기록 필요"));
    }
    if d["ci"]["head"] == head && d["ci"]["status"] == "failed" {
        return Err(gate("현재 HEAD의 CI 실패 기록이 있습니다"));
    }
    if d["mergeApproval"]["head"] != head {
        return Err(gate("현재 HEAD 명시적 머지 승인 없음"));
    }
    Ok(())
}
pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    let (sub, args) = args
        .split_first()
        .ok_or_else(|| Error::new("usage", "delivery 하위 명령 필요"))?;
    let flags: &[&str] = match sub.as_str() {
        "prepare" => &["slug", "issue", "branch", "head"],
        "pr" => &["slug", "number", "head"],
        "ci" => &["slug", "status", "head", "run"],
        "approve-merge" => &["slug", "head", "reason"],
        "check-merge" => &["slug", "head"],
        "merged" => &["slug", "head", "merge-sha"],
        _ => return Err(Error::new("usage", "delivery 하위 명령 오류")),
    };
    ensure_flags(args, flags, &[])?;
    let mut w = store::resolve(cwd, read_flag(args, "slug")?.as_deref(), true)?;
    let head = sha(&required_flag(args, "head")?)?;
    let at = now();
    if sub != "merged" {
        let (current_head, current_branch) = fingerprint::current_position(cwd)?
            .ok_or_else(|| gate("커밋이 있는 Git 브랜치 필요"))?;
        if current_head != head {
            return Err(gate("현재 Git HEAD 불일치"));
        }
        let branch = if sub == "prepare" {
            Some(required_flag(args, "branch")?)
        } else {
            w["delivery"]["branch"].as_str().map(str::to_owned)
        };
        if branch.is_some_and(|b| current_branch != b) {
            return Err(gate("현재 Git 브랜치 불일치"));
        }
    }
    let (mut d, event_key, event_body) = if sub == "prepare" {
        if !b(&w["done"]) {
            return Err(gate("검증 완료 전 delivery 시작 불가"));
        }
        contract::assert_commit(&w)?;
        let branch = required_flag(args, "branch")?;
        if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
            .unwrap()
            .is_match(&branch)
            || branch.contains("..")
            || branch.ends_with('/')
            || branch.contains("//")
        {
            return Err(Error::new("delivery_invalid", "branch 형식 오류"));
        }
        let d = json!({"issue":id(&required_flag(args,"issue")?)?,"branch":branch,"head":head,"preparedAt":at});
        (d.clone(), "delivery.prepare", d)
    } else {
        let mut d = prepared(&w)?;
        if d["head"] != head {
            return Err(gate("준비된 HEAD와 불일치"));
        }
        match sub.as_str() {
            "pr" => {
                let p = json!({"number":id(&required_flag(args,"number")?)?,"head":head,"at":at});
                d["pr"] = p.clone();
                for key in ["ci", "mergeApproval", "merged"] {
                    d.as_object_mut().unwrap().remove(key);
                }
                (d, "delivery.pr", p)
            }
            "ci" => {
                if d["pr"]["head"] != head {
                    return Err(gate("현재 HEAD PR 필요"));
                }
                let status = required_flag(args, "status")?;
                if !["passed", "failed"].contains(&status.as_str()) {
                    return Err(Error::new("usage", "CI status 오류"));
                }
                let ci = json!({"status":status,"head":head,"run":id(&required_flag(args,"run")?)?,"at":at});
                d["ci"] = ci.clone();
                for key in ["mergeApproval", "merged"] {
                    d.as_object_mut().unwrap().remove(key);
                }
                (d, "delivery.ci", ci)
            }
            "approve-merge" => {
                if d["pr"]["head"] != head {
                    return Err(gate("현재 HEAD PR 필요"));
                }
                let approval = json!({"head":head,"reason":contract::safe_text(&required_flag(args,"reason")?,"reason",240)?,"at":at});
                d["mergeApproval"] = approval.clone();
                d.as_object_mut().unwrap().remove("merged");
                (d, "delivery.merge-approved", approval)
            }
            "check-merge" => {
                merge_gate(&d, &head)?;
                println!("머지 가능: PR {} · HEAD {head}", s(&d["pr"]["number"]));
                return Ok(());
            }
            "merged" => {
                merge_gate(&d, &head)?;
                let merged = json!({"sha":sha(&required_flag(args,"merge-sha")?)?,"at":at});
                d["merged"] = merged.clone();
                (d, "delivery.merged", merged)
            }
            _ => unreachable!(),
        }
    };
    let mut event = json!({"ts":at,"event":event_key});
    event
        .as_object_mut()
        .unwrap()
        .extend(event_body.as_object().unwrap().clone());
    w["delivery"] = std::mem::take(&mut d);
    store::append_journal(cwd, s(&w["slug"]), &event)?;
    store::save(cwd, &w)?;
    println!("{event_key}: {head}");
    Ok(())
}
