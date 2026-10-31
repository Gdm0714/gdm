use super::{
    contract, evidence, fingerprint,
    state::{self, b, s},
    store,
};
use crate::support::{
    Error, Result, ensure_flags, has_flag, now, print_json, read_flag, read_flags, required_flag,
    sha256,
};
use serde_json::{Value, json};
use std::{fs, path::Path};
fn resolve(cwd: &Path, args: &[String], read: bool) -> Result<Value> {
    store::resolve(cwd, read_flag(args, "slug")?.as_deref(), read)
}
fn denied(cwd: &Path, w: &Value, cmd: &str, e: &Error, extra: Value) -> Result<()> {
    let mut event =
        json!({"ts":now(),"event":"denied","action":cmd,"code":e.code,"message":e.message});
    event
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    store::append_journal(cwd, s(&w["slug"]), &event)
}
fn resolve_cmd(cwd: &Path, cmd: Option<String>) -> Result<Option<String>> {
    if let Some(c) = cmd {
        if let Some(name) = c.strip_prefix('@') {
            let presets = presets(cwd)?;
            return presets[name]
                .as_str()
                .map(|s| Some(s.into()))
                .ok_or_else(|| {
                    Error::new(
                        "preset_not_found",
                        crate::lfmt!("프리셋 @{name} 없음", "Preset @{name} not found"),
                    )
                });
        }
        return Ok(Some(c));
    }
    Ok(None)
}
fn print_work(w: &Value) {
    println!(
        "{} · {} ({}/{})",
        s(&w["slug"]),
        if b(&w["done"]) {
            crate::i18n::text("완료", "Completed")
        } else {
            crate::i18n::text("진행 중", "In progress")
        },
        state::proven_count(w),
        state::checks(w).len()
    );
    for c in state::checks(w) {
        let detail = if c["status"] == "proven" {
            crate::lfmt!("증거: {}", "Evidence: {}", s(&c["evidence"]["observed"]))
        } else {
            let how = if b(&c["manual"]) {
                crate::lfmt!(
                    "(수동 확인{})",
                    "(manual check{})",
                    if b(&c["expert"]) { " · expert" } else { "" }
                )
            } else {
                s(&c["cmd"]).to_owned()
            };
            crate::lfmt!(
                "재현: {how} → 기대: {}",
                "Reproduce: {how} → Expect: {}",
                s(&c["expect"])
            )
        };
        println!(
            "  {} {} {} — {detail}",
            if c["status"] == "proven" {
                "✅"
            } else {
                "⬜"
            },
            s(&c["id"]),
            s(&c["desc"])
        );
    }
}

pub fn plan(cwd: &Path, args: &[String]) -> Result<()> {
    let (sub, args) = args.split_first().ok_or_else(|| {
        Error::new(
            "usage",
            crate::i18n::text("plan 하위 명령 필요", "A plan subcommand is required"),
        )
    })?;
    match sub.as_str() {
        "init" => {
            ensure_flags(
                args,
                &[
                    "slug",
                    "brief",
                    "brief-file",
                    "require",
                    "forbid",
                    "assume",
                    "uncertain",
                    "allow-path",
                    "forbid-path",
                    "stop-if",
                    "risk",
                    "verification",
                    "bottleneck",
                    "desired-outcome",
                    "baseline",
                    "target",
                    "unit",
                    "intervene-if",
                ],
                &["audit", "simplify"],
            )?;
            let slug = required_flag(args, "slug")?;
            state::validate_slug(&slug)?;
            let contract = contract::create(args)?;
            let brief = if let Some(file) = read_flag(args, "brief-file")? {
                fs::read_to_string(cwd.join(file))?
            } else {
                required_flag(args, "brief")?
            };
            if brief.trim().is_empty() {
                return Err(Error::new(
                    "empty_brief",
                    crate::i18n::text("brief가 비어 있습니다", "The brief is empty"),
                ));
            }
            if store::work_dir(cwd, &slug)?.join("checks.json").exists() {
                return Err(Error::new(
                    "work_exists",
                    crate::i18n::text("이미 존재하는 작업", "Work already exists"),
                ));
            }
            let at = now();
            let audit = has_flag(args, "audit") || contract["risk"] == "high";
            let baseline = fingerprint::capture_workspace(cwd)?;
            let work = json!({"slug":slug,"brief":brief.trim(),"createdAt":at,"done":false,"auditRequired":audit,"baseline":baseline,"checks":[],"contract":contract});
            store::append_journal(
                cwd,
                &slug,
                &json!({"ts":at,"event":"plan.init","brief":work["brief"],"auditRequired":audit,"contract":contract,"baseline":baseline}),
            )?;
            store::save(cwd, &work)?;
            crate::lprint!("작업 시작: {slug}", "Work started: {slug}");
            if contract["risk"] == "high" && !has_flag(args, "audit") {
                crate::lprint!(
                    "high risk 정책으로 독립 검수를 자동 요구합니다",
                    "High-risk policy automatically requires an independent audit"
                );
            }
        }
        "contract" => {
            ensure_flags(
                args,
                &[
                    "slug",
                    "require",
                    "forbid",
                    "commit",
                    "reason",
                    "activate-habit",
                    "allow-path",
                    "forbid-path",
                    "remove-allow-path",
                    "remove-forbid-path",
                ],
                &["check-commit"],
            )?;
            let activations = read_flags(args, "activate-habit")?;
            if let Some(target) = activations.first() {
                if activations.len() != 1
                    || args
                        .iter()
                        .any(|a| a.starts_with("--") && a != "--slug" && a != "--activate-habit")
                {
                    return Err(Error::new(
                        "usage",
                        crate::i18n::text(
                            "habit 활성화는 단독 동작",
                            "Habit activation must be a standalone operation",
                        ),
                    ));
                }
                return super::habit::activate(cwd, &required_flag(args, "slug")?, target);
            }
            let mut w = resolve(cwd, args, true)?;
            if let Some(e) = contract::mutate(&mut w, args)? {
                store::append_journal(cwd, s(&w["slug"]), &e)?;
                store::save(cwd, &w)?;
            }
            crate::lprint!("계약: {}", "Contract: {}", s(&w["contract"]["commit"]));
        }
        "source" => {
            ensure_flags(args, &["slug", "fingerprint"], &[])?;
            let w = resolve(cwd, args, false)?;
            state::assert_open(&w)?;
            let fp = required_flag(args, "fingerprint")?;
            if !state::valid_hash(&fp) {
                return Err(Error::new(
                    "usage",
                    crate::i18n::text(
                        "--fingerprint 소문자 SHA-256 필요",
                        "--fingerprint requires a lowercase SHA-256",
                    ),
                ));
            }
            let path = store::work_dir(cwd, s(&w["slug"]))?.join("checks.json");
            let mut raw = store::read_json(&path)?;
            raw["verificationPlanSourceFingerprint"] = json!(fp);
            state::validate_work(raw.clone())?;
            let mode = std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&path)?.permissions());
            store::write_json_atomic_mode(&path, &raw, mode)?;
            crate::lprint!(
                "source fingerprint 기록됨: {fp}",
                "Source fingerprint recorded: {fp}"
            );
        }
        "list" => {
            ensure_flags(args, &["slug"], &["json"])?;
            let w = resolve(cwd, args, true)?;
            if has_flag(args, "json") {
                print_json(&w)?
            } else {
                print_work(&w)
            }
        }
        "add" => {
            ensure_flags(
                args,
                &["desc", "cmd", "expect", "kind", "slug"],
                &["manual", "expert", "from-brief", "dry-run"],
            )?;
            let mut w = resolve(cwd, args, false)?;
            let from = has_flag(args, "from-brief");
            let inputs = if from {
                if ["desc", "cmd", "expect", "kind"]
                    .iter()
                    .any(|f| read_flag(args, f).ok().flatten().is_some())
                    || has_flag(args, "manual")
                    || has_flag(args, "expert")
                {
                    return Err(Error::new(
                        "usage",
                        crate::i18n::text(
                            "from-brief와 개별 항목 조합 불가",
                            "from-brief cannot be combined with individual check options",
                        ),
                    ));
                }
                parse_brief(s(&w["brief"]))?
            } else {
                if has_flag(args, "dry-run") {
                    return Err(Error::new(
                        "usage",
                        crate::i18n::text(
                            "dry-run은 from-brief 전용",
                            "dry-run requires from-brief",
                        ),
                    ));
                }
                let mut input = json!({"desc":read_flag(args,"desc")?.unwrap_or_default(),"cmd":resolve_cmd(cwd,read_flag(args,"cmd")?)?,"expect":read_flag(args,"expect")?.unwrap_or_default(),"manual":has_flag(args,"manual"),"expert":has_flag(args,"expert")});
                if let Some(k) = read_flag(args, "kind")? {
                    input["kind"] = json!(k)
                }
                vec![input]
            };
            let mut added = vec![];
            for input in inputs {
                added.push(state::add_check(&mut w, &input)?);
            }
            if !has_flag(args, "dry-run") {
                let events=added.iter().map(|c|{let mut e=json!({"ts":now(),"event":"plan.add","check":c["id"],"desc":c["desc"],"cmd":c["cmd"],"expect":c["expect"],"manual":c["manual"],"kind":c["kind"],"expert":c["expert"]});if from{e["source"]=json!("brief");}e}).collect::<Vec<_>>();
                store::append_journal_batch(cwd, s(&w["slug"]), &events)?;
                store::save(cwd, &w)?;
            }
            if from && !has_flag(args, "dry-run") {
                crate::lprint!(
                    "brief에서 {}개 항목 등록 (총 {}개)",
                    "Registered {} checks from the brief ({} total)",
                    added.len(),
                    state::checks(&w).len()
                );
            }
            for c in added {
                println!(
                    "{} {}{}",
                    s(&c["id"]),
                    s(&c["desc"]),
                    if has_flag(args, "dry-run") {
                        " (dry-run)"
                    } else {
                        crate::i18n::text(" 추가됨", " added")
                    }
                );
            }
        }
        "edit" => {
            ensure_flags(
                args,
                &["check", "desc", "cmd", "expect", "kind", "reason", "slug"],
                &[],
            )?;
            let mut w = resolve(cwd, args, false)?;
            let id = required_flag(args, "check")?;
            let reason = read_flag(args, "reason")?.unwrap_or_default();
            let mut patch = json!({});
            for k in ["desc", "cmd", "expect", "kind"] {
                let mut value = read_flag(args, k)?;
                if k == "cmd" {
                    value = resolve_cmd(cwd, value)?;
                }
                if let Some(v) = value {
                    patch[k] = json!(v)
                }
            }
            match state::edit(&mut w, &id, &patch, &reason) {
                Ok(reverted) => {
                    store::append_journal(
                        cwd,
                        s(&w["slug"]),
                        &json!({"ts":now(),"event":"plan.edit","check":id,"patch":patch,"reason":reason,"reverted":reverted}),
                    )?;
                    store::save(cwd, &w)?;
                    crate::lprint!("{id} 수정됨", "{id} updated");
                }
                Err(e) => {
                    denied(cwd, &w, "plan.edit", &e, json!({"check":id}))?;
                    return Err(e);
                }
            }
        }
        _ => {
            return Err(Error::new(
                "usage",
                crate::i18n::text("plan 하위 명령 오류", "Invalid plan subcommand"),
            ));
        }
    }
    Ok(())
}
pub fn parse_brief(brief: &str) -> Result<Vec<Value>> {
    let mut started = false;
    let mut out = vec![];
    let mut issues = vec![];
    let item = regex::Regex::new(r"^-\s*desc:\s*").unwrap();
    let marker =
        regex::Regex::new(r"\s+\((regression|behavior|edge|static|manual|expert)\)$").unwrap();
    let expect_split = regex::Regex::new(r"\s+/\s+expect:\s*").unwrap();
    let cmd_split = regex::Regex::new(r"\s+/\s+cmd:\s*").unwrap();
    let section = regex::Regex::new(r"^##\s*(?:검증 항목|Verification checks)").unwrap();
    let heading = regex::Regex::new(r"^##\s").unwrap();
    for (i, line) in brief.lines().enumerate() {
        let line = line.trim();
        if !started {
            if section.is_match(line) {
                started = true
            }
            continue;
        }
        if heading.is_match(line) {
            break;
        }
        if !item.is_match(line) {
            continue;
        }
        let body = item.replace(line, "");
        let parts = expect_split.split(&body).collect::<Vec<_>>();
        if parts.len() != 2 {
            issues.push(i + 1);
            continue;
        }
        let cmd_parts = cmd_split.split(parts[0]).collect::<Vec<_>>();
        if cmd_parts.len() > 2 {
            issues.push(i + 1);
            continue;
        }
        let desc = cmd_parts[0].trim();
        let mark = marker.captures(desc).map(|c| c[1].to_owned());
        let desc = marker.replace(desc, "").trim().to_owned();
        let manual = mark.as_deref() == Some("manual") || mark.as_deref() == Some("expert");
        let cmd = cmd_parts
            .get(1)
            .map(|s| {
                let s = s.trim();
                s.strip_prefix('`')
                    .and_then(|v| v.strip_suffix('`'))
                    .map(str::trim)
                    .unwrap_or(s)
            })
            .filter(|s| !s.is_empty());
        if manual && cmd.is_some()
            || !manual && cmd.is_none()
            || desc.is_empty()
            || parts[1].trim().is_empty()
        {
            issues.push(i + 1);
            continue;
        }
        let mut v = json!({"desc":desc,"cmd":cmd,"expect":parts[1].trim(),"manual":manual,"expert":mark.as_deref()==Some("expert")});
        if let Some(k) = mark {
            v["kind"] = json!(if k == "expert" { "manual" } else { &k });
        }
        out.push(v);
    }
    if !started || out.is_empty() || !issues.is_empty() {
        return Err(Error::new(
            "brief_checks_invalid",
            crate::lfmt!(
                "검증 항목 초안 파싱 실패: {issues:?}",
                "Cannot parse draft verification checks: {issues:?}"
            ),
        ));
    }
    Ok(out)
}
pub fn pass(cwd: &Path, args: &[String]) -> Result<()> {
    let (id, args) = args
        .split_first()
        .filter(|(id, _)| !id.starts_with("--"))
        .ok_or_else(|| {
            Error::new(
                "usage",
                crate::i18n::text("항목 ID 필요", "A check ID is required"),
            )
        })?;
    ensure_flags(
        args,
        &[
            "observed",
            "note",
            "reviewer",
            "slug",
            "expected-plan-fingerprint",
        ],
        &["manual", "red"],
    )?;
    let mut w = resolve(cwd, args, false)?;
    state::assert_plan(&w, read_flag(args, "expected-plan-fingerprint")?.as_deref())?;
    let result = (|| {
        let i = state::passable(&w, id)?;
        let c = w["checks"][i].clone();
        let red = has_flag(args, "red");
        let manual = has_flag(args, "manual");
        let observed = read_flag(args, "observed")?;
        let reviewer = read_flag(args, "reviewer")?;
        let note = read_flag(args, "note")?;
        let at = now();
        let mut e;
        if red {
            if manual
                || observed.is_some()
                || reviewer.is_some()
                || state::kind(&c) != "regression"
                || b(&c["manual"])
            {
                return Err(Error::new(
                    "red_not_allowed",
                    crate::i18n::text(
                        "red는 regression 자동 항목 전용",
                        "red is only available for automatic regression checks",
                    ),
                ));
            }
            e = evidence::automatic(cwd, s(&w["slug"]), id, s(&c["cmd"]), true, true)?;
        } else {
            if state::kind(&c) == "regression" && c.get("redEvidence").is_none() {
                return Err(Error::new(
                    "red_evidence_required",
                    crate::i18n::text(
                        "먼저 --red로 실패 재현",
                        "First reproduce the failure with --red",
                    ),
                ));
            }
            if b(&c["manual"]) {
                if !manual {
                    return Err(Error::new(
                        "manual_required",
                        crate::i18n::text("--manual 필요", "--manual is required"),
                    ));
                }
                let observed = observed.ok_or_else(|| {
                    Error::new(
                        "usage",
                        crate::i18n::text("--observed 필요", "--observed is required"),
                    )
                })?;
                let bytes = store::contained(cwd, &observed, "observed", usize::MAX / 2)?;
                if bytes.is_empty() {
                    return Err(Error::new(
                        "observed_empty",
                        crate::i18n::text("증거 파일 비어 있음", "The evidence file is empty"),
                    ));
                }
                e = json!({"observed":observed,"sha256":sha256(bytes),"manual":true});
                if let Some(r) = reviewer {
                    e["reviewer"] = json!(contract::safe_text(&r, "reviewer", 240)?);
                }
            } else {
                if manual || observed.is_some() || reviewer.is_some() {
                    return Err(Error::new(
                        "manual_not_allowed",
                        crate::i18n::text(
                            "자동 항목 수동 증거 거부",
                            "Manual evidence is not accepted for automatic checks",
                        ),
                    ));
                }
                e = evidence::automatic(cwd, s(&w["slug"]), id, s(&c["cmd"]), false, true)?;
            }
        }
        if let Some(n) = note {
            e["note"] = json!(if b(&c["expert"]) {
                contract::safe_text(&n, "note", 240)?
            } else {
                n
            });
        }
        if b(&c["expert"]) && (s(&e["note"]).is_empty() || s(&e["reviewer"]).is_empty()) {
            return Err(Error::new(
                "expert_evidence_required",
                crate::i18n::text(
                    "전문가와 판단 근거 필요",
                    "An expert reviewer and reasoning are required",
                ),
            ));
        }
        let mut event = json!({"ts":at,"event":if red{"pass.red"}else{"pass"},"check":id});
        event
            .as_object_mut()
            .unwrap()
            .extend(e.as_object().unwrap().clone());
        e["at"] = json!(at);
        w["checks"][i][if red { "redEvidence" } else { "evidence" }] = e;
        if !red {
            w["checks"][i]["status"] = json!("proven");
        }
        store::append_journal(cwd, s(&w["slug"]), &event)?;
        store::save(cwd, &w)?;
        println!(
            "{id} {} ({}/{})",
            if red {
                crate::i18n::text("red 증거 기록", "Red evidence recorded")
            } else {
                crate::i18n::text("통과", "Passed")
            },
            state::proven_count(&w),
            state::checks(&w).len()
        );
        Ok(())
    })();
    if let Err(e) = &result {
        denied(cwd, &w, "pass", e, json!({"check":id}))?;
    }
    result
}
pub fn recheck(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(args, &["check", "slug", "expected-plan-fingerprint"], &[])?;
    let mut w = resolve(cwd, args, false)?;
    state::assert_plan(&w, read_flag(args, "expected-plan-fingerprint")?.as_deref())?;
    let failed = evidence::recheck(cwd, &mut w, read_flag(args, "check")?.as_deref(), false)?;
    store::save(cwd, &w)?;
    if !failed.is_empty() {
        return Err(Error::new(
            "recheck_failed",
            crate::lfmt!("재검증 실패: {}", "Recheck failed: {}", failed.join(", ")),
        ));
    }
    crate::lprint!("재검증 통과", "Recheck passed");
    Ok(())
}
pub fn audit(cwd: &Path, args: &[String]) -> Result<()> {
    let (sub, args) = args.split_first().ok_or_else(|| {
        Error::new(
            "usage",
            crate::i18n::text("audit 하위 명령 필요", "An audit subcommand is required"),
        )
    })?;
    if sub == "brief" {
        ensure_flags(args, &["slug"], &["json"])?;
        let w = resolve(cwd, args, true)?;
        let journal = store::read_journal(cwd, s(&w["slug"]))?;
        if has_flag(args, "json") {
            return print_json(&json!({"work":w,"journal":journal}));
        }
        print_work(&w);
        if w["contract"].get("outcome").is_some() {
            crate::lprint!(
                "## 선언한 outcome (GDM 미측정)\n{}",
                "## Declared outcome (not measured by GDM)\n{}",
                w["contract"]["outcome"]
            );
        }
        crate::lprint!(
            "\n## 원 요청\n{}\n\n## 작업 계약\n{}",
            "\n## Original request\n{}\n\n## Work contract\n{}",
            s(&w["brief"]),
            w["contract"]
        );
        for c in state::checks(&w) {
            crate::lprint!(
                "{} · {} · 증거 {}",
                "{} · {} · Evidence {}",
                s(&c["id"]),
                state::kind(c),
                c["evidence"]
            )
        }
        crate::lprint!(
            "검수보고에 정확한 판정 marker와 implementationModel, auditModel을 기록하세요",
            "Record the exact verdict marker, implementationModel and auditModel in the audit report"
        );
        return Ok(());
    }
    if sub != "verdict" {
        return Err(Error::new(
            "usage",
            crate::i18n::text("audit 하위 명령 오류", "Invalid audit subcommand"),
        ));
    }
    ensure_flags(
        args,
        &["report", "slug", "implementation-model", "audit-model"],
        &["pass", "fail"],
    )?;
    let pass = has_flag(args, "pass");
    if pass == has_flag(args, "fail") {
        return Err(Error::new(
            "usage",
            crate::i18n::text(
                "--pass 또는 --fail 정확히 하나 필요",
                "Provide exactly one of --pass or --fail",
            ),
        ));
    }
    let report = required_flag(args, "report")?;
    let implementation = contract::safe_text(
        &required_flag(args, "implementation-model")?,
        "implementation-model",
        240,
    )?;
    let audit_model =
        contract::safe_text(&required_flag(args, "audit-model")?, "audit-model", 240)?;
    let bytes = store::contained(cwd, &report, "report", usize::MAX / 2)?;
    if bytes.is_empty() {
        return Err(Error::new(
            "report_empty",
            crate::i18n::text("보고서 비어 있음", "The report is empty"),
        ));
    }
    let content = String::from_utf8_lossy(&bytes);
    let markers = content
        .lines()
        .filter(|l| l.starts_with("**판정:"))
        .collect::<Vec<_>>();
    if markers.len() != 1 || !["**판정: 통과**", "**판정: 반려**"].contains(&markers[0]) {
        return Err(Error::new(
            "audit_verdict_invalid",
            crate::i18n::text(
                "보고서 판정 marker 정확히 하나 필요",
                "The report must contain exactly one verdict marker",
            ),
        ));
    }
    if (markers[0] == "**판정: 통과**") != pass {
        return Err(Error::new(
            "audit_verdict_mismatch",
            crate::i18n::text(
                "보고서와 인자 판정 불일치",
                "The report verdict does not match the argument",
            ),
        ));
    }
    if !content.contains(&format!("implementationModel: {implementation}"))
        || !content.contains(&format!("auditModel: {audit_model}"))
    {
        return Err(Error::new(
            "audit_model_mismatch",
            crate::i18n::text("모델 표시 불일치", "Model labels do not match"),
        ));
    }
    let mut w = resolve(cwd, args, false)?;
    let result = (|| {
        state::assert_open(&w)?;
        if state::checks(&w).is_empty() || state::proven_count(&w) != state::checks(&w).len() {
            return Err(Error::new(
                "audit_premature",
                crate::i18n::text(
                    "모든 항목 통과 후 검수 가능",
                    "All checks must pass before the audit",
                ),
            ));
        }
        if implementation.to_lowercase() == audit_model.to_lowercase() {
            return Err(Error::new(
                "audit_independence",
                crate::i18n::text(
                    "구현 모델과 검수 모델은 달라야 합니다",
                    "The implementation and audit models must differ",
                ),
            ));
        }
        let at = now();
        let a = json!({"result":if pass{"pass"}else{"fail"},"report":report,"reportSha256":sha256(bytes),"implementationModel":implementation,"auditModel":audit_model,"workspace":fingerprint::capture_workspace(cwd)?,"stateHash":state::checks_hash(&w),"at":at});
        let mut event = json!({"ts":at,"event":"audit"});
        event
            .as_object_mut()
            .unwrap()
            .extend(a.as_object().unwrap().clone());
        event.as_object_mut().unwrap().remove("at");
        w["audit"] = a;
        store::append_journal(cwd, s(&w["slug"]), &event)?;
        store::save(cwd, &w)?;
        crate::lprint!(
            "검수 {} 기록됨",
            "Audit {} recorded",
            if pass {
                crate::i18n::text("통과", "Passed")
            } else {
                crate::i18n::text("반려", "Rejected")
            }
        );
        Ok(())
    })();
    if let Err(e) = &result {
        denied(cwd, &w, "audit", e, json!({}))?;
    }
    result
}
pub fn done(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(args, &["slug", "expected-plan-fingerprint"], &[])?;
    let mut w = resolve(cwd, args, false)?;
    state::assert_plan(&w, read_flag(args, "expected-plan-fingerprint")?.as_deref())?;
    let result = (|| {
        state::assert_open(&w)?;
        if let Some(blocker) = super::team::blockers(&w).first() {
            return Err(Error::new(s(&blocker["code"]), s(&blocker["message"])));
        }
        super::team::verify_artifacts(cwd, &w)?;
        let scope = |w: &Value| -> Result<()> {
            let problems = fingerprint::scope_problems(w, &fingerprint::capture_workspace(cwd)?);
            if !problems.is_empty() {
                return Err(Error::new(
                    "scope_violation",
                    fingerprint::describe_scope(&problems),
                ));
            }
            Ok(())
        };
        scope(&w)?;
        let requires = b(&w["auditRequired"]) || w["contract"]["risk"] == "high";
        if requires && w["audit"]["result"] == "pass" {
            let problems = fingerprint::audit_problems(cwd, &w["audit"])?;
            if !problems.is_empty() {
                return Err(Error::new("audit_stale", problems.join(", ")));
            }
        }
        let bound = requires
            && w["audit"]["result"] == "pass"
            && w["audit"].get("workspace").is_some_and(|v| !v.is_null());
        if !bound {
            let failed = evidence::recheck(cwd, &mut w, None, true)?;
            if !failed.is_empty() {
                store::save(cwd, &w)?;
                return Err(Error::new(
                    "unproven",
                    crate::lfmt!(
                        "완료 전 재검증 실패: {}",
                        "Recheck before completion failed: {}",
                        failed.join(", ")
                    ),
                ));
            }
        }
        scope(&w)?;
        let stale = evidence::stale(cwd, &w);
        if !stale.is_empty() {
            let mut ids = vec![];
            for (i, red, _) in &stale {
                let id = w["checks"][*i]["id"].clone();
                if !ids.contains(&id) {
                    ids.push(id)
                }
                evidence::revert(&mut w, *i, *red);
            }
            store::append_journal(
                cwd,
                s(&w["slug"]),
                &json!({"ts":now(),"event":"evidence_stale","checks":ids}),
            )?;
            store::save(cwd, &w)?;
            return Err(Error::new(
                "evidence_stale",
                stale
                    .iter()
                    .map(|x| x.2.clone())
                    .collect::<Vec<_>>()
                    .join(", "),
            ));
        }
        super::team::verify_artifacts(cwd, &w)?;
        if let Some(blocker) = state::completion_blockers(&w).first() {
            return Err(Error::new(s(&blocker["code"]), s(&blocker["message"])));
        }
        let at = now();
        w["done"] = json!(true);
        w["doneAt"] = json!(at);
        store::append_journal(
            cwd,
            s(&w["slug"]),
            &json!({"ts":at,"event":"done","checks":state::checks(&w).len()}),
        )?;
        store::save(cwd, &w)?;
        crate::lprint!(
            "작업 완료: {} ({}/{})",
            "Work completed: {} ({}/{})",
            s(&w["slug"]),
            state::checks(&w).len(),
            state::checks(&w).len()
        );
        Ok(())
    })();
    if let Err(e) = &result {
        denied(cwd, &w, "done", e, json!({}))?;
    }
    result
}
pub fn status(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(args, &[], &["json", "checks"])?;
    let mut summaries = vec![];
    for w in store::list(cwd)? {
        let journal = store::read_journal(cwd, s(&w["slug"]))?;
        let mut summary = json!({"slug":w["slug"],"done":w["done"],"proven":state::proven_count(&w),"total":state::checks(&w).len(),"blockers":state::completion_blockers(&w),"audit":fingerprint::audit_state(cwd,&w)?,"contract":w["contract"],"delivery":w["delivery"]});
        if w.get("team").is_some() {
            summary["team"] = super::team::summary(&w);
        }
        if let Some(last) = journal.last() {
            summary["lastEvent"] = last["event"].clone();
            summary["lastAt"] = last["ts"].clone();
        }
        if has_flag(args, "checks") {
            summary["checks"] = w["checks"].clone();
        }
        if !has_flag(args, "json") {
            if has_flag(args, "checks") {
                print_work(&w);
            } else {
                println!(
                    "[{}] {} ({}/{})",
                    if b(&w["done"]) {
                        crate::i18n::text("완료  ", "Completed  ")
                    } else {
                        crate::i18n::text("진행 중", "In progress")
                    },
                    s(&w["slug"]),
                    state::proven_count(&w),
                    state::checks(&w).len()
                );
            }
            if let Some(last) = journal.last() {
                crate::lprint!(
                    "  마지막: {} {}",
                    "  Latest: {} {}",
                    s(&last["ts"]),
                    s(&last["event"])
                );
            }
            print_team(&w);
            if let Some(delivery) = w.get("delivery") {
                crate::lprint!(
                    "  전달: {} · PR {} · CI {}",
                    "  Delivery: {} · PR {} · CI {}",
                    s(&delivery["branch"]),
                    delivery["pr"]["number"].as_str().unwrap_or("—"),
                    delivery["ci"]["status"].as_str().unwrap_or("—")
                );
            }
        }
        summaries.push(summary);
    }
    if has_flag(args, "json") {
        print_json(&json!(summaries))?
    }
    Ok(())
}
pub fn resume(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(args, &["slug"], &["json"])?;
    let w = resolve(cwd, args, true)?;
    let journal = store::read_journal(cwd, s(&w["slug"]))?;
    let tail = &journal[journal.len().saturating_sub(8)..];
    if has_flag(args, "json") {
        return print_json(&json!({"work":w,"journal":tail}));
    }
    print_work(&w);
    print_team(&w);
    if w["contract"].get("outcome").is_some() {
        crate::lprint!(
            "선언한 outcome (GDM 미측정):\n{}",
            "Declared outcome (not measured by GDM):\n{}",
            w["contract"]["outcome"]
        );
    }
    crate::lprint!(
        "목표: {}\n계약: {}",
        "Goal: {}\nContract: {}",
        s(&w["brief"]),
        w["contract"]
    );
    let audit = fingerprint::audit_state(cwd, &w)?;
    if !audit.is_empty() {
        println!("{audit}");
    }
    for event in tail {
        println!("{} {}", s(&event["ts"]), s(&event["event"]));
    }
    for attempt in super::attempt::latest(&journal)? {
        crate::lprint!(
            "{} · epoch {} · {} · 가설 {}",
            "{} · epoch {} · {} · Hypothesis {}",
            s(&attempt["fingerprint"]),
            attempt["epoch"],
            s(&attempt["decision"]),
            s(&attempt["hypothesis"])
        );
    }
    if w.get("delivery").is_some() {
        crate::lprint!("전달: {}", "Delivery: {}", w["delivery"]);
    }
    Ok(())
}
fn print_team(w: &Value) {
    if let Some(team) = w.get("team") {
        crate::lprint!(
            "  작업 조율: {} · 다음 단계: gdm team next --slug {}",
            "  Team coordination: {} · Next: gdm team next --slug {}",
            s(&team["mode"]),
            s(&w["slug"])
        );
        println!("{}", super::team::summary(w));
    }
}
pub fn miss(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(args, &["desc", "type", "check", "slug"], &[])?;
    let w = resolve(cwd, args, true)?;
    let desc = required_flag(args, "desc")?;
    let mut e = json!({"ts":now(),"event":"miss","desc":desc});
    for k in ["type", "check"] {
        if let Some(v) = read_flag(args, k)? {
            if k == "check" {
                state::check_index(&w, &v)?;
            }
            e[k] = json!(v)
        }
    }
    store::append_journal(cwd, s(&w["slug"]), &e)?;
    crate::lprint!("탈출 결함 기록: {desc}", "Escaped defect recorded: {desc}");
    Ok(())
}
pub fn feedback(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(args, &["value", "reason", "source", "slug"], &["json"])?;
    let value = required_flag(args, "value")?;
    if !["good", "bad"].contains(&value.as_str()) {
        return Err(Error::new(
            "usage",
            crate::i18n::text("value는 good 또는 bad", "value must be good or bad"),
        ));
    }
    let reason = read_flag(args, "reason")?
        .map(|s| contract::safe_text(&s, "reason", 240))
        .transpose()?;
    let source = contract::opaque_id(
        &read_flag(args, "source")?.unwrap_or("manual".into()),
        "source",
    )?;
    if value == "bad" && reason.is_none() {
        return Err(Error::new(
            "usage",
            crate::i18n::text(
                "--value bad에는 --reason <사유>가 필요합니다",
                "--value bad requires --reason <reason>",
            ),
        ));
    }
    let w = if let Some(slug) = read_flag(args, "slug")? {
        store::load(cwd, &slug)?
    } else {
        let works = store::list(cwd)?;
        let has_active = works.iter().any(|w| !b(&w["done"]));
        let mut timed = vec![];
        for w in works.into_iter().filter(|w| !has_active || !b(&w["done"])) {
            let j = store::read_journal(cwd, s(&w["slug"]))?;
            let ts = j
                .last()
                .map(|e| s(&e["ts"]))
                .unwrap_or(s(&w["createdAt"]))
                .to_owned();
            timed.push((ts, w));
        }
        timed.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| s(&a.1["slug"]).cmp(s(&b.1["slug"])))
        });
        timed
            .into_iter()
            .next()
            .ok_or_else(|| Error::new("no_active", crate::i18n::text("작업 없음", "No work")))?
            .1
    };
    let mut result = json!({"slug":w["slug"],"value":value,"source":source});
    if let Some(r) = reason {
        result["reason"] = json!(r)
    }
    let mut e = result.clone();
    e.as_object_mut().unwrap().remove("slug");
    e["ts"] = json!(now());
    e["event"] = json!("feedback");
    store::append_journal(cwd, s(&w["slug"]), &e)?;
    if has_flag(args, "json") {
        print_json(&result)
    } else {
        crate::lprint!(
            "피드백 기록: {} — {value}",
            "Feedback recorded: {} — {value}",
            s(&w["slug"])
        );
        Ok(())
    }
}
fn presets(cwd: &Path) -> Result<Value> {
    let p = store::root(cwd).join("presets.json");
    store::inspect(&store::root(cwd), true)?;
    if !store::inspect(&p, false)? {
        return Ok(json!({}));
    }
    let v = store::read_json(&p)?;
    if !v.is_object() || v.as_object().unwrap().values().any(|v| !v.is_string()) {
        return Err(Error::new(
            "state_corrupt",
            crate::i18n::text("presets 객체 오류", "Invalid presets object"),
        ));
    }
    Ok(v)
}
pub fn preset(cwd: &Path, args: &[String]) -> Result<()> {
    let (sub, rest) = args.split_first().ok_or_else(|| {
        Error::new(
            "usage",
            crate::i18n::text("preset 하위 명령 필요", "A preset subcommand is required"),
        )
    })?;
    let mut v = presets(cwd)?;
    match sub.as_str() {
        "list" => {
            for (k, v) in v.as_object().unwrap() {
                println!("@{k} = {}", s(v));
            }
            return Ok(());
        }
        "set" => {
            let name = rest.first().ok_or_else(|| {
                Error::new(
                    "usage",
                    crate::i18n::text("이름 필요", "A name is required"),
                )
            })?;
            if !regex::Regex::new(r"^[a-z0-9][a-z0-9-]*$")
                .unwrap()
                .is_match(name)
            {
                return Err(Error::new(
                    "usage",
                    crate::i18n::text("프리셋 이름 오류", "Invalid preset name"),
                ));
            }
            let cmd = rest.get(1).ok_or_else(|| {
                Error::new(
                    "usage",
                    crate::i18n::text("명령 필요", "A command is required"),
                )
            })?;
            v[name] = json!(cmd);
            println!("@{name} = {cmd}");
        }
        "rm" => {
            let name = rest.first().ok_or_else(|| {
                Error::new(
                    "usage",
                    crate::i18n::text("이름 필요", "A name is required"),
                )
            })?;
            if v.as_object_mut().unwrap().remove(name).is_none() {
                return Err(Error::new(
                    "preset_not_found",
                    crate::i18n::text("프리셋 없음", "Preset not found"),
                ));
            }
            crate::lprint!("@{name} 삭제됨", "@{name} removed");
        }
        _ => {
            return Err(Error::new(
                "usage",
                crate::i18n::text("preset 하위 명령 오류", "Invalid preset subcommand"),
            ));
        }
    }
    store::ensure_dir(&store::root(cwd))?;
    store::write_json_atomic(&store::root(cwd).join("presets.json"), &v)
}
pub fn repair(cwd: &Path, args: &[String]) -> Result<()> {
    if args.first().map(String::as_str) != Some("state") {
        return Err(Error::new(
            "usage",
            crate::i18n::text("repair state 필요", "Use repair state"),
        ));
    }
    let args = &args[1..];
    ensure_flags(args, &["slug"], &["trailing-nul"])?;
    if !has_flag(args, "trailing-nul") {
        return Err(Error::new(
            "usage",
            crate::i18n::text("--trailing-nul 필요", "--trailing-nul is required"),
        ));
    }
    let slug = required_flag(args, "slug")?;
    let p = store::work_dir(cwd, &slug)?.join("checks.json");
    let mut bytes = store::read_regular(&p, 16 * 1024 * 1024)?;
    let len = bytes.len();
    while bytes.last() == Some(&0) {
        bytes.pop();
    }
    let removed = len - bytes.len();
    if removed == 0 {
        return Err(Error::new(
            "repair_not_applicable",
            crate::i18n::text("파일 끝 NUL 없음", "No trailing NUL in the file"),
        ));
    }
    let w = state::validate_work(serde_json::from_slice(&bytes)?)?;
    if w["slug"] != slug {
        return Err(Error::new(
            "state_corrupt",
            crate::i18n::text("slug 불일치", "Slug mismatch"),
        ));
    }
    store::write_atomic(&p, &bytes)?;
    store::append_journal(
        cwd,
        &slug,
        &json!({"ts":now(),"event":"state.repair","kind":"trailing-nul","removedBytes":removed}),
    )?;
    crate::lprint!(
        "{slug} 상태 복구 완료: trailing NUL {removed}바이트 제거",
        "State repaired for {slug}: removed {removed} trailing NUL bytes"
    );
    Ok(())
}
