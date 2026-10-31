use super::{
    state::{b, s},
    store,
};
use crate::support::{Result, ensure_flags, has_flag, print_json, read_flag};
use serde_json::{Value, json};
use std::path::Path;
fn increment(map: &mut Value, key: &str) {
    map[key] = json!(map[key].as_u64().unwrap_or(0) + 1)
}
pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(args, &["slug"], &["json", "all"])?;
    let all = has_flag(args, "all");
    let works = if all {
        store::list(cwd)?
    } else {
        vec![store::resolve(
            cwd,
            read_flag(args, "slug")?.as_deref(),
            true,
        )?]
    };
    let mut denied = json!({});
    let mut friction = json!({});
    let mut edits = vec![];
    let mut misses = vec![];
    let mut rechecks = vec![];
    let mut feedback = json!({"good":0,"bad":0,"total":0});
    let mut eval = vec![];
    let mut events = 0;
    for w in &works {
        for e in store::read_journal(cwd, s(&w["slug"]))? {
            events += 1;
            match s(&e["event"]) {
                "denied" => {
                    increment(&mut denied, e["code"].as_str().unwrap_or("unknown"));
                    if let Some(c) = e["check"].as_str() {
                        increment(&mut friction, c)
                    }
                }
                "plan.edit" => {
                    edits.push(json!({"check":e["check"],"reason":e["reason"],"patch":e["patch"]}))
                }
                "miss" => {
                    let mut m = json!({"work":w["slug"]});
                    for k in ["type", "check", "desc"] {
                        if let Some(v) = e.get(k) {
                            m[k] = v.clone()
                        }
                    }
                    misses.push(m)
                }
                "feedback" if ["good", "bad"].contains(&s(&e["value"])) => {
                    increment(&mut feedback, s(&e["value"]));
                    increment(&mut feedback, "total");
                    if e["value"] == "bad" && !s(&e["reason"]).is_empty() {
                        eval.push(json!({"work":w["slug"],"reason":e["reason"],"source":e["source"].as_str().unwrap_or("unknown")}));
                    }
                }
                "recheck" => rechecks.push(json!({"check":e["check"],"ok":e["ok"]})),
                _ => {}
            }
        }
    }
    let mut result = if all {
        let mut types = json!({});
        for m in &misses {
            increment(
                &mut types,
                m["type"]
                    .as_str()
                    .unwrap_or(crate::i18n::text("미분류", "Unclassified")),
            );
        }
        let mut entries = types.as_object().unwrap().iter().collect::<Vec<_>>();
        entries.sort_by_key(|(_, v)| std::cmp::Reverse(v.as_u64().unwrap()));
        let mut suggestions=entries.iter().map(|(t,c)|crate::lfmt!("검수 체크리스트에 \"{t}\" 유형 반영 검토 — 게이트 통과 후 {c}건 발견 (gdm-agents/auditor.md)", "Consider the \"{t}\" category in the audit checklist — {c} defects found after the gate passed (gdm-agents/auditor.md)")).collect::<Vec<_>>();
        if edits.len() >= 3 {
            suggestions.push(crate::lfmt!("check 기준 수정 {}건 — plan 단계에서 기준을 더 구체화하면 재작업이 줄어듭니다", "Check criteria changed {} times — more specific criteria during planning can reduce rework",
                edits.len()
            ));
        }
        let fails = rechecks.iter().filter(|e| e["ok"] == false).count();
        if fails > 0 {
            suggestions.push(crate::lfmt!("recheck가 회귀 {fails}건을 잡음 — 후속 변경의 영향 항목만 중간 재검증하고 done 직전 중복 실행은 생략", "Recheck caught {fails} regressions — recheck only affected checks during changes; skip duplicate checks immediately before done"));
        }
        let habits = super::habit::overview(cwd)?;
        json!({"works":works.len(),"done":works.iter().filter(|w|b(&w["done"])).count(),"events":events,"denied":denied,"misses":misses,"feedback":feedback,"evalCandidates":eval,"editCount":edits.len(),"recheckFails":fails,"suggestions":suggestions,"habitCandidates":habits["candidates"],"habitAdopted":habits["adopted"],"habitNext":habits["next"]})
    } else {
        json!({"slug":works[0]["slug"],"done":works[0]["done"],"events":events,"denied":denied,"frictionByCheck":friction,"edits":edits,"rechecks":rechecks})
    };
    let mut regression_candidates = Vec::new();
    for work in &works {
        regression_candidates.extend(super::regression::candidates(cwd, s(&work["slug"]))?);
    }
    result["regressionCandidates"] = json!(regression_candidates);
    if has_flag(args, "json") {
        print_json(&result)
    } else {
        crate::lprint!(
            "회고 — 이벤트 {events}건\n{}",
            "Retrospective — {events} events\n{}",
            serde_json::to_string_pretty(&result)?
        );
        Ok(())
    }
}
