//! Explicit, local failure-to-regression cases. Nothing in feedback is executed.
use super::{contract, credentials, evidence, fingerprint, state, store};
use crate::support::{
    Error, Result, ensure_flags, now, print_json, read_flag, read_flags, required_flag, sha256,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_FILE: usize = 128 * 1024;
const MAX_FILES: usize = 16;
const MAX_CASE: u64 = 4 * 1024 * 1024;
const MAX_LOG: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub id: String,
    pub work: String,
    pub event_index: usize,
    pub event_sha256: String,
    pub kind: String,
    pub reason: String,
    pub source: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    path: String,
    sha256: String,
    text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    schema: String,
    case_id: String,
    work: String,
    created_at: String,
    candidate: Candidate,
    command: String,
    expect: String,
    timeout_ms: u64,
    fixtures: Vec<Fixture>,
}

fn error(code: &str, detail: &str) -> Error {
    Error::new(code, detail)
}

pub fn candidates(cwd: &Path, slug: &str) -> Result<Vec<Candidate>> {
    store::load(cwd, slug)?;
    let mut result = Vec::new();
    for (event_index, event) in store::read_journal(cwd, slug)?.into_iter().enumerate() {
        let kind = state::s(&event["event"]);
        let reason = match kind {
            "feedback" if event["value"] == "bad" => state::s(&event["reason"]),
            "miss" => state::s(&event["desc"]),
            _ => continue,
        };
        if reason.is_empty() {
            continue;
        }
        let event_sha256 = sha256(serde_json::to_vec(&event)?);
        let identity = json!({"work":slug,"eventIndex":event_index,"eventSha256":event_sha256});
        result.push(Candidate {
            id: format!("reg-{}", &sha256(serde_json::to_vec(&identity)?)[..24]),
            work: slug.into(),
            event_index,
            event_sha256,
            kind: kind.into(),
            reason: reason.into(),
            source: event["source"].as_str().unwrap_or("manual").into(),
        });
    }
    Ok(result)
}

fn directory(cwd: &Path, slug: &str, create: bool) -> Result<PathBuf> {
    let path = store::work_dir(cwd, slug)?.join("regressions");
    if create {
        store::ensure_dir(&path)?;
    } else {
        store::inspect(&path, true)?;
    }
    Ok(path)
}

fn fixture_path(value: &str) -> Result<String> {
    let normalized = contract::path(value, "fixture")?;
    if normalized != value
        || normalized == "."
        || normalized.split('/').any(|p| p == ".git" || p == ".gdm")
    {
        return Err(error(
            "path_rejected",
            "Fixture must be a normalized repository-relative file path",
        ));
    }
    Ok(normalized)
}

fn check_text(text: &str, field: &str, limit: usize) -> Result<()> {
    if text.is_empty() || text.len() > limit || text.contains('\0') {
        return Err(error("usage", &format!("Invalid {field} size or encoding")));
    }
    if credentials::contains_credentials(text) {
        return Err(error(
            "privacy_rejected",
            &format!("Credential-shaped value in {field}"),
        ));
    }
    Ok(())
}

fn validate(case: &Case) -> Result<()> {
    if case.schema != "gdm-regression-case/v1"
        || case.work != case.candidate.work
        || !contract::canonical_timestamp(&case.created_at)
    {
        return Err(error("state_corrupt", "Invalid regression case identity"));
    }
    state::validate_slug(&case.case_id)?;
    state::validate_slug(&case.work)?;
    check_text(&case.command, "command", 8192)?;
    contract::safe_text(&case.expect, "expect", 512)?;
    if !(100..=600_000).contains(&case.timeout_ms)
        || case.fixtures.is_empty()
        || case.fixtures.len() > MAX_FILES
    {
        return Err(error(
            "usage",
            "Use 1 to 16 fixtures and a timeout between 100 and 600000 ms",
        ));
    }
    let mut seen = BTreeSet::new();
    for fixture in &case.fixtures {
        fixture_path(&fixture.path)?;
        if !seen.insert(&fixture.path)
            || fixture.text.len() > MAX_FILE
            || fixture.text.contains('\0')
        {
            return Err(error(
                "state_corrupt",
                "Invalid or duplicate regression fixture",
            ));
        }
        if sha256(&fixture.text) != fixture.sha256 {
            return Err(error(
                "artifact_changed",
                "Regression fixture digest mismatch",
            ));
        }
        if credentials::contains_credentials(&fixture.text) {
            return Err(error(
                "privacy_rejected",
                "Credential-shaped value in fixture",
            ));
        }
    }
    Ok(())
}

fn capture(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(
        args,
        &[
            "slug",
            "candidate",
            "case",
            "fixture",
            "cmd",
            "expect",
            "timeout-ms",
        ],
        &["json"],
    )?;
    let slug = required_flag(args, "slug")?;
    let candidate_id = required_flag(args, "candidate")?;
    let candidate = candidates(cwd, &slug)?
        .into_iter()
        .find(|c| c.id == candidate_id)
        .ok_or_else(|| {
            error(
                "regression_candidate_missing",
                "Candidate is not in this Work journal",
            )
        })?;
    // Feedback is untrusted provenance, never an instruction or check command.
    check_text(&candidate.reason, "candidate reason", 8192)?;
    let case_id = required_flag(args, "case")?;
    state::validate_slug(&case_id)?;
    let paths = read_flags(args, "fixture")?;
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(error("usage", "Specify 1 to 16 --fixture files"));
    }
    let mut fixtures = Vec::new();
    for path in paths {
        fixture_path(&path)?;
        let bytes = store::contained(cwd, &path, "fixture", MAX_FILE)?;
        let text = String::from_utf8(bytes)
            .map_err(|_| error("artifact_encoding_invalid", "Fixtures must be UTF-8 text"))?;
        fixtures.push(Fixture {
            path,
            sha256: sha256(&text),
            text,
        });
    }
    fixtures.sort_by(|a, b| a.path.cmp(&b.path));
    let case = Case {
        schema: "gdm-regression-case/v1".into(),
        case_id,
        work: slug.clone(),
        created_at: now(),
        candidate,
        command: required_flag(args, "cmd")?,
        expect: required_flag(args, "expect")?,
        timeout_ms: read_flag(args, "timeout-ms")?
            .map(|s| s.parse::<u64>())
            .transpose()
            .map_err(|_| error("usage", "Invalid timeout-ms"))?
            .unwrap_or(60_000),
        fixtures,
    };
    validate(&case)?;
    let path = directory(cwd, &slug, true)?.join(format!("{}.json", case.case_id));
    if store::inspect(&path, false)? {
        return Err(error(
            "regression_case_exists",
            "Cases are immutable; use a new case name for a revision",
        ));
    }
    // Refuse an orphaned journal identity as well as an existing file.
    if store::read_journal(cwd, &slug)?
        .iter()
        .any(|e| e["event"] == "regression.capture" && e["caseId"] == case.case_id)
    {
        return Err(error(
            "regression_case_exists",
            "Case identity was already captured",
        ));
    }
    let bytes = serde_json::to_vec_pretty(&case)?;
    if bytes.len() as u64 > MAX_CASE {
        return Err(error(
            "artifact_too_large",
            "Serialized regression case exceeds 4 MiB",
        ));
    }
    let digest = sha256(&bytes);
    store::write_atomic(&path, &bytes)?;
    store::append_journal(
        cwd,
        &slug,
        &json!({"ts":now(),"event":"regression.capture","caseId":case.case_id,
        "sha256":digest,"candidateId":case.candidate.id,"candidateEventSha256":case.candidate.event_sha256}),
    )?;
    print_json(
        &json!({"caseId":case.case_id,"slug":slug,"sha256":digest,"candidateId":case.candidate.id,
        "fixtureCount":case.fixtures.len(),"commandExecuted":false}),
    )
}

fn load(cwd: &Path, slug: &str, id: &str) -> Result<(Case, String)> {
    state::validate_slug(id)?;
    store::load(cwd, slug)?;
    let bytes = store::read_regular(
        &directory(cwd, slug, false)?.join(format!("{id}.json")),
        MAX_CASE,
    )?;
    let digest = sha256(&bytes);
    let case: Case = serde_json::from_slice(&bytes)?;
    validate(&case)?;
    if case.work != slug || case.case_id != id {
        return Err(error("state_corrupt", "Case does not belong to this Work"));
    }
    let captures = store::read_journal(cwd, slug)?
        .into_iter()
        .filter(|e| e["event"] == "regression.capture" && e["caseId"] == id)
        .collect::<Vec<_>>();
    if captures.len() != 1
        || captures[0]["sha256"] != digest
        || captures[0]["candidateId"] != case.candidate.id
        || captures[0]["candidateEventSha256"] != case.candidate.event_sha256
    {
        return Err(error(
            "artifact_changed",
            "Case is not bound to its recorded capture digest",
        ));
    }
    if !candidates(cwd, slug)?.contains(&case.candidate) {
        return Err(error(
            "artifact_changed",
            "Candidate provenance no longer matches",
        ));
    }
    Ok((case, digest))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn replay(cwd: &Path, args: &[String]) -> Result<()> {
    ensure_flags(args, &["slug", "case", "expected-case-sha256"], &["json"])?;
    let slug = required_flag(args, "slug")?;
    let id = required_flag(args, "case")?;
    let (case, digest) = load(cwd, &slug, &id)?;
    if read_flag(args, "expected-case-sha256")?.is_some_and(|expected| expected != digest) {
        return Err(error(
            "artifact_changed",
            "Expected case digest does not match",
        ));
    }
    let temp = tempfile::Builder::new()
        .prefix("gdm-regression-")
        .tempdir()?;
    for fixture in &case.fixtures {
        let path = temp.path().join(&fixture.path);
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| error("path_rejected", "Fixture parent is missing"))?,
        )?;
        fs::write(path, &fixture.text)?;
    }
    // A local scratch directory is not an OS sandbox. The user-authored command
    // may explicitly inspect the current implementation through this variable.
    let project = cwd.canonicalize()?;
    let command = format!(
        "export GDM_REGRESSION_PROJECT={}\n{}",
        shell_quote(&project.to_string_lossy()),
        case.command
    );
    let position = fingerprint::current_position(cwd)?;
    let run_id = uuid::Uuid::new_v4().to_string();
    store::append_journal(
        cwd,
        &slug,
        &json!({"ts":now(),"event":"regression.replay-start","caseId":id,
        "caseSha256":digest,"runId":run_id}),
    )?;
    let execution = evidence::execute_bounded(
        temp.path(),
        &command,
        Some(Duration::from_millis(case.timeout_ms)),
    )?;
    let mut log = execution.body;
    let truncated = log.len() > MAX_LOG;
    if truncated {
        let mut end = MAX_LOG / 2;
        while !log.is_char_boundary(end) {
            end -= 1;
        }
        let mut start = log.len() - MAX_LOG / 2;
        while !log.is_char_boundary(start) {
            start += 1;
        }
        log = format!(
            "{}\n[Regression output truncated]\n{}",
            &log[..end],
            &log[start..]
        );
    }
    let observed = store::output(
        cwd,
        &slug,
        &format!("regression-{run_id}.txt"),
        log.as_bytes(),
    )?;
    let passed = execution.code == Some(0) && execution.error.is_none();
    let result = json!({"ts":now(),"event":"regression.replay","schema":"gdm-regression-result/v1",
        "runId":run_id,"caseId":id,"caseSha256":digest,"candidateId":case.candidate.id,
        "passed":passed,"exitCode":execution.code,"error":execution.error,"observed":observed,
        "outputSha256":sha256(&log),"outputTruncated":truncated,
        "gitHead":position.as_ref().map(|p|&p.0),"gitBranch":position.as_ref().map(|p|&p.1)});
    store::append_journal(cwd, &slug, &result)?;
    print_json(&result)?;
    if passed {
        Ok(())
    } else {
        Err(error(
            "regression_failed",
            "Regression check failed; see recorded result",
        ))
    }
}

pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    let (sub, args) = args.split_first().ok_or_else(|| {
        error(
            "usage",
            "Use regression candidates, capture, show, or replay",
        )
    })?;
    match sub.as_str() {
        "candidates" => {
            ensure_flags(args, &["slug"], &["json"])?;
            let works = if let Some(slug) = read_flag(args, "slug")? {
                vec![store::load(cwd, &slug)?]
            } else {
                store::list(cwd)?
            };
            let mut all = Vec::new();
            for work in works {
                all.extend(candidates(cwd, state::s(&work["slug"]))?);
            }
            print_json(&json!({"schema":"gdm-regression-candidates/v1","candidates":all}))
        }
        "capture" => capture(cwd, args),
        "show" => {
            ensure_flags(args, &["slug", "case"], &["json"])?;
            let (case, digest) = load(
                cwd,
                &required_flag(args, "slug")?,
                &required_flag(args, "case")?,
            )?;
            print_json(&json!({"case":case,"sha256":digest}))
        }
        "replay" => replay(cwd, args),
        _ => Err(error(
            "usage",
            "Use regression candidates, capture, show, or replay",
        )),
    }
}
