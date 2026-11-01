//! Durable coordinator-owned tasks. A worker report is evidence, never acceptance.
use super::{contract, credentials, evidence, protocol, state, store};
use crate::support::{
    Error, Result, now, print_json, read_flag, read_flags, required_flag, sha256,
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path};

mod planning;
mod request;

const SCHEMA: &str = "gdm-team/v1";
const MAX_TASKS: usize = 64;
// A Work budget is separate from the host's available worker slots.
const MAX_ACTIVE_WORKERS: u64 = 32;
const MAX_ATTEMPTS: usize = 64;
const MAX_ARTIFACT: usize = 1024 * 1024;
const MAX_NUMBER: u64 = 9_007_199_254_740_991;
fn err(code: &str, message: impl Into<String>) -> Error {
    Error::new(code, message)
}
fn corrupt() -> Error {
    err("state_corrupt", "Invalid durable team state")
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    state::s(&v[key])
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn tasks(work: &Value) -> &[Value] {
    array(&work["team"]["tasks"])
}
fn latest(task: &Value) -> &Value {
    array(&task["attempts"]).last().unwrap_or(&Value::Null)
}
fn exact(v: &Value, required: &[&str], optional: &[&str]) -> bool {
    v.as_object().is_some_and(|o| {
        required.iter().all(|k| o.contains_key(*k))
            && o.keys()
                .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
    })
}
fn text_ok(v: &Value, field: &str, max: usize) -> bool {
    v.as_str()
        .is_some_and(|v| contract::safe_text(v, field, max).is_ok_and(|n| n == v))
}
fn id_ok(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|v| contract::opaque_id(v, "team-id").is_ok())
}
fn timestamp(v: &Value) -> bool {
    v.as_str().is_some_and(contract::canonical_timestamp)
}
// Wall clocks may move backwards. Lifecycle ordering uses the greatest recorded
// event time, while retaining the original canonical timestamps for old Work.
fn event_time(work: &Value) -> String {
    fn latest_time(value: &Value, time: &mut String) {
        match value {
            Value::String(value) if value > time && contract::canonical_timestamp(value) => {
                *time = value.clone();
            }
            Value::Array(values) => values.iter().for_each(|v| latest_time(v, time)),
            Value::Object(values) => values.values().for_each(|v| latest_time(v, time)),
            _ => {}
        }
    }
    let mut time = now();
    latest_time(&work["team"], &mut time);
    time
}
fn reason(value: &str) -> Result<String> {
    let value = contract::safe_text(value, "reason", 480)?;
    if value.chars().filter(|c| c.is_alphanumeric()).count() < 8 {
        return Err(err(
            "usage",
            "--reason must explain the decision in at least eight letters or digits",
        ));
    }
    Ok(value)
}
fn path(value: &str, artifact: bool) -> Result<String> {
    if value.len() > 512 || value.contains('\\') || value.trim() != value {
        return Err(err(
            "path_rejected",
            "Team paths must be bounded repository-relative paths",
        ));
    }
    contract::assert_no_sensitive(value, "team-path")?;
    if value.is_empty() || value.starts_with('/') || value.split('/').any(|p| p == "..") {
        return Err(err(
            "path_rejected",
            "Team paths cannot escape the repository",
        ));
    }
    let parts: Vec<_> = value
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.is_empty()
        || parts.iter().any(|p| {
            p.eq_ignore_ascii_case(".git") || (!artifact && p.eq_ignore_ascii_case(".gdm"))
        })
    {
        return Err(err(
            "path_rejected",
            "Declare a specific path outside reserved state directories",
        ));
    }
    Ok(parts.join("/"))
}
fn safe_path(cwd: &Path, value: &str, artifact: bool) -> Result<String> {
    let value = path(value, artifact)?;
    let mut current = cwd.to_path_buf();
    for component in value.split('/') {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(err("path_rejected", "Team paths cannot traverse symlinks"));
            }
            Ok(m) if !m.is_dir() && current != cwd.join(&value) => {
                return Err(err(
                    "path_rejected",
                    "A team path parent is not a directory",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(value)
}
fn artifact(cwd: &Path, value: &str) -> Result<Value> {
    let value = safe_path(cwd, value, true)?;
    let bytes = store::contained(cwd, &value, "team-artifact", MAX_ARTIFACT)?;
    let content = std::str::from_utf8(&bytes).map_err(|_| {
        err(
            "artifact_encoding_invalid",
            "Team artifacts must be UTF-8 text",
        )
    })?;
    if content.trim().is_empty() || content.contains('\0') {
        return Err(err(
            "artifact_encoding_invalid",
            "Team artifacts must contain nonempty text without NUL bytes",
        ));
    }
    if credentials::contains_credentials(content) {
        return Err(err(
            "privacy_rejected",
            "Team artifacts must not contain credential-shaped values",
        ));
    }
    Ok(json!({"path":value,"sha256":sha256(bytes)}))
}
fn archive_artifact(
    cwd: &Path,
    work: &Value,
    task: &Value,
    attempt: &str,
    source: &Value,
) -> Result<Value> {
    let identity = sha256(format!("{}\0{}", s(task, "id"), attempt));
    let name = format!("team-{identity}.txt");
    let relative = format!(".gdm/{}/out/{name}", s(work, "slug"));
    let directory = store::ensure_work_dir(cwd, s(work, "slug"))?.join("out");
    store::ensure_dir(&directory)?;
    let bytes = store::contained(cwd, s(source, "path"), "team-artifact", MAX_ARTIFACT)?;
    if sha256(&bytes) != source["sha256"] {
        return Err(err(
            "team_artifact_changed",
            "Result artifact changed while archiving",
        ));
    }
    let destination = directory.join(name);
    // The repository lock serializes report publication. A crash can leave an
    // archive without a canonical report. Only that uncommitted file may be
    // replaced; a report referenced by any attempt remains immutable.
    let committed = tasks(work).iter().any(|task| {
        array(&task["attempts"])
            .iter()
            .any(|attempt| attempt["report"]["archivedArtifact"]["path"] == relative)
    });
    if !committed && store::inspect(&destination, false)? {
        store::write_atomic(&destination, &bytes)?;
        return Ok(json!({"path":relative,"sha256":source["sha256"]}));
    }
    // New archives are published without replacing any concurrent file.
    let temporary = directory.join(format!(".team-{}.tmp", uuid::Uuid::new_v4()));
    store::write_atomic(&temporary, &bytes)?;
    let published = fs::hard_link(&temporary, &destination);
    let _ = fs::remove_file(&temporary);
    match published {
        Ok(()) => fs::File::open(&directory)?.sync_all()?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if store::read_regular(&destination, MAX_ARTIFACT as u64)? != bytes {
                return Err(err(
                    "team_artifact_changed",
                    "The immutable attempt archive already contains different bytes",
                ));
            }
        }
        Err(e) => return Err(e.into()),
    }
    Ok(json!({"path":relative,"sha256":source["sha256"]}))
}

fn check_receipts(work: &Value, task: &Value) -> Value {
    json!(array(&task["checks"]).iter().map(|id| {
        let check = state::checks(work).iter().find(|c| c["id"] == *id).unwrap_or(&Value::Null);
        let definition = json!({"id":check["id"],"desc":check["desc"],"cmd":check["cmd"],"expect":check["expect"],"kind":state::kind(check),"manual":check["manual"],"expert":check.get("expert").cloned().unwrap_or(json!(false)),"redRequired":check.get("redRequired").cloned().unwrap_or(json!(false))});
        json!({"id":id,"sha256":sha256(protocol::canonical_json(&definition))})
    }).collect::<Vec<_>>())
}
fn own_acceptance_current(work: &Value, task: &Value) -> bool {
    task["status"] == "accepted"
        && array(&task["checks"]).iter().all(|id| {
            state::checks(work)
                .iter()
                .any(|c| c["id"] == *id && c["status"] == "proven")
        })
        && latest(task)["review"]["checks"] == check_receipts(work, task)
        && latest(task)["review"]["resultDigest"]
            == sha256(protocol::canonical_json(&latest(task)["report"]))
}
fn dependency_receipts(work: &Value, task: &Value) -> Value {
    json!(array(&task["dependsOn"]).iter().map(|id| {
        let dependency = tasks(work).iter().find(|t| t["id"] == *id).unwrap();
        json!({"taskId":id,"attemptId":latest(dependency)["id"],"resultDigest":sha256(protocol::canonical_json(&latest(dependency)["report"]))})
    }).collect::<Vec<_>>())
}
fn dependencies_match(work: &Value, task: &Value, accepted_ids: &BTreeSet<String>) -> bool {
    array(&task["dependsOn"])
        .iter()
        .all(|id| accepted_ids.contains(state::s(id)))
        && latest(task)["dependencies"] == dependency_receipts(work, task)
}
// Task order is topological, so dependency acceptance needs no recursive traversal.
fn accepted_ids(work: &Value) -> BTreeSet<String> {
    let mut accepted = BTreeSet::new();
    for task in tasks(work) {
        if own_acceptance_current(work, task) && dependencies_match(work, task, &accepted) {
            accepted.insert(s(task, "id").to_owned());
        }
    }
    accepted
}
fn accepted(work: &Value, task: &Value) -> bool {
    accepted_ids(work).contains(s(task, "id"))
}
fn dependencies_current(work: &Value, task: &Value) -> bool {
    dependencies_match(work, task, &accepted_ids(work))
}

fn overlaps(a: &Value, b: &Value) -> bool {
    (a["access"] == "write" || b["access"] == "write")
        && array(&a["paths"]).iter().any(|p| {
            array(&b["paths"]).iter().any(|q| {
                contract::matches(state::s(p), state::s(q))
                    || contract::matches(state::s(q), state::s(p))
            })
        })
}
fn strings(v: &Value, min: usize, max: usize, predicate: impl Fn(&Value) -> bool) -> bool {
    let Some(values) = v.as_array() else {
        return false;
    };
    let mut seen = BTreeSet::new();
    (min..=max).contains(&values.len())
        && values
            .iter()
            .all(|v| predicate(v) && seen.insert(v.as_str().unwrap_or("")))
}
fn report_valid(report: &Value) -> bool {
    exact(
        report,
        &["outcome", "summary", "artifact", "archivedArtifact", "at"],
        &["metrics"],
    ) && ["completed", "failed", "cancelled", "inconclusive"].contains(&s(report, "outcome"))
        && text_ok(&report["summary"], "summary", 1000)
        && timestamp(&report["at"])
        && exact(&report["artifact"], &["path", "sha256"], &[])
        && path(s(&report["artifact"], "path"), true)
            .is_ok_and(|p| p == s(&report["artifact"], "path"))
        && state::valid_hash(s(&report["artifact"], "sha256"))
        && exact(&report["archivedArtifact"], &["path", "sha256"], &[])
        && path(s(&report["archivedArtifact"], "path"), true)
            .is_ok_and(|p| p == s(&report["archivedArtifact"], "path"))
        && report["archivedArtifact"]["sha256"] == report["artifact"]["sha256"]
        && report.get("metrics").is_none_or(|m| {
            exact(m, &["source"], &["tokens", "elapsedMs"])
                && m["source"] == "reported"
                && (m.get("tokens").is_some() || m.get("elapsedMs").is_some())
                && ["tokens", "elapsedMs"].iter().all(|k| {
                    m.get(*k)
                        .is_none_or(|n| n.as_u64().is_some_and(|n| n <= MAX_NUMBER))
                })
        })
}
fn review_valid(review: &Value, task: &Value) -> bool {
    if !exact(
        review,
        &["decision", "reason", "at"],
        &["checks", "resultDigest"],
    ) || !["accept", "reject"].contains(&s(review, "decision"))
        || !text_ok(&review["reason"], "reason", 480)
        || !timestamp(&review["at"])
    {
        return false;
    }
    if review["decision"] == "reject" {
        return review.get("checks").is_none() && review.get("resultDigest").is_none();
    }
    let Some(receipts) = review["checks"].as_array() else {
        return false;
    };
    state::valid_hash(s(review, "resultDigest"))
        && receipts.len() == array(&task["checks"]).len()
        && receipts
            .iter()
            .zip(array(&task["checks"]))
            .all(|(receipt, id)| {
                exact(receipt, &["id", "sha256"], &[])
                    && receipt["id"] == *id
                    && state::valid_hash(s(receipt, "sha256"))
            })
}
/// Validate persisted shapes and all lifecycle invariants without reading repository files.
pub fn validate(work: &Value) -> Result<()> {
    let Some(team) = work.get("team") else {
        return Ok(());
    };
    if !exact(
        team,
        &[
            "schemaVersion",
            "mode",
            "maxActive",
            "configuredAt",
            "tasks",
        ],
        &["reason", "sessionId", "allocation", "allocationHistory"],
    ) || team["schemaVersion"] != SCHEMA
        || !["coordinated", "single"].contains(&s(team, "mode"))
        || team["maxActive"]
            .as_u64()
            .is_none_or(|n| !(1..=MAX_ACTIVE_WORKERS).contains(&n))
        || (team["mode"] == "single" && team["maxActive"] != 1)
        || !timestamp(&team["configuredAt"])
        || team.get("sessionId").is_some_and(|v| !id_ok(v))
        || team
            .get("reason")
            .is_some_and(|v| !v.as_str().is_some_and(|v| reason(v).is_ok_and(|n| n == v)))
        || (team["mode"] == "single" && team.get("reason").is_none())
        || team["tasks"].as_array().is_none_or(|v| v.len() > MAX_TASKS)
    {
        return Err(corrupt());
    }
    let mut ids = BTreeSet::new();
    let mut attempt_ids = BTreeSet::new();
    let mut assignees = BTreeSet::new();
    let mut active = vec![];
    for task in tasks(work) {
        if !exact(
            task,
            &[
                "id",
                "role",
                "paths",
                "access",
                "deliverable",
                "acceptance",
                "checks",
                "dependsOn",
                "status",
                "attempts",
            ],
            &[
                "withdrawal",
                "routeId",
                "effort",
                "selectionReason",
                "acceptanceMode",
            ],
        ) || !id_ok(&task["id"])
            || !id_ok(&task["role"])
            || task.get("routeId").is_some_and(|r| !id_ok(r))
            || task.get("acceptanceMode").is_some_and(|m| {
                *m != "artifact-review"
                    || task["role"] != "knowledge"
                    || task["access"] != "read"
                    || !matches!(
                        work["team"]["allocation"]["request"]["input"]["promptVersion"].as_u64(),
                        Some(2 | 3)
                    )
            })
            || !["read", "write"].contains(&s(task, "access"))
            || !text_ok(&task["deliverable"], "deliverable", 480)
            || !text_ok(&task["acceptance"], "acceptance", 480)
            || !strings(&task["paths"], 1, 32, |v| {
                v.as_str()
                    .is_some_and(|v| path(v, false).is_ok_and(|p| p == v))
            })
            || !strings(
                &task["checks"],
                if task["acceptanceMode"] == "artifact-review" {
                    0
                } else {
                    1
                },
                64,
                |v| id_ok(v) && state::checks(work).iter().any(|c| c["id"] == *v),
            )
            || (task["acceptanceMode"] == "artifact-review" && !array(&task["checks"]).is_empty())
            || !strings(&task["dependsOn"], 0, MAX_TASKS, |v| {
                id_ok(v) && ids.contains(state::s(v))
            })
            || !ids.insert(s(task, "id"))
            || ![
                "pending",
                "active",
                "reported",
                "accepted",
                "rejected",
                "withdrawn",
            ]
            .contains(&s(task, "status"))
            || task["attempts"]
                .as_array()
                .is_none_or(|a| a.len() > MAX_ATTEMPTS)
        {
            return Err(corrupt());
        }
        let attempts = array(&task["attempts"]);
        for (index, attempt) in attempts.iter().enumerate() {
            if !exact(
                attempt,
                &["id", "assignee", "claimedAt", "dependencies"],
                &["report", "review", "retry", "execution"],
            ) || !id_ok(&attempt["id"])
                || !execution_matches(work, task, attempt.get("execution"))
                || !id_ok(&attempt["assignee"])
                || !attempt_ids.insert(s(attempt, "id"))
                || !timestamp(&attempt["claimedAt"])
                || !attempt["dependencies"].as_array().is_some_and(|receipts| {
                    receipts.len() == array(&task["dependsOn"]).len()
                        && receipts
                            .iter()
                            .zip(array(&task["dependsOn"]))
                            .all(|(r, id)| {
                                exact(r, &["taskId", "attemptId", "resultDigest"], &[])
                                    && r["taskId"] == *id
                                    && id_ok(&r["attemptId"])
                                    && state::valid_hash(s(r, "resultDigest"))
                                    && tasks(work).iter().find(|t| t["id"] == *id).is_some_and(
                                        |dependency| {
                                            array(&dependency["attempts"]).iter().any(|a| {
                                                a["id"] == r["attemptId"]
                                                    && a["report"]["outcome"] == "completed"
                                                    && r["resultDigest"]
                                                        == sha256(protocol::canonical_json(
                                                            &a["report"],
                                                        ))
                                            })
                                        },
                                    )
                            })
                })
                || s(attempt, "claimedAt") < s(team, "configuredAt")
                || (index > 0 && s(attempt, "claimedAt") < s(&attempts[index - 1]["retry"], "at"))
                || attempt.get("report").is_some_and(|r| {
                    !report_valid(r)
                        || s(r, "at") < s(attempt, "claimedAt")
                        || r["archivedArtifact"]["path"]
                            != format!(
                                ".gdm/{}/out/team-{}.txt",
                                s(work, "slug"),
                                sha256(format!("{}\0{}", s(task, "id"), s(attempt, "id")))
                            )
                })
                || attempt.get("review").is_some_and(|r| {
                    !review_valid(r, task)
                        || attempt.get("report").is_none()
                        || s(r, "at") < s(&attempt["report"], "at")
                        || (r["decision"] == "accept"
                            && (attempt["report"]["outcome"] != "completed"
                                || r["resultDigest"]
                                    != sha256(protocol::canonical_json(&attempt["report"]))))
                })
                || attempt.get("retry").is_some_and(|r| {
                    !exact(r, &["reason", "at"], &[])
                        || !text_ok(&r["reason"], "reason", 480)
                        || !timestamp(&r["at"])
                        || attempt.get("report").is_none()
                        || (attempt["report"]["outcome"] == "completed"
                            && attempt["review"]["decision"] != "reject")
                        || s(r, "at") < s(&attempt["report"], "at")
                        || (attempt.get("review").is_some()
                            && s(r, "at") < s(&attempt["review"], "at"))
                })
                || (index + 1 < attempts.len() && attempt.get("retry").is_none())
            {
                return Err(corrupt());
            }
        }
        let last = latest(task);
        let prior_status = if attempts.is_empty() || last.get("retry").is_some() {
            "pending"
        } else if last.get("report").is_none() {
            "active"
        } else if last["review"]["decision"] == "accept" {
            "accepted"
        } else if last["review"]["decision"] == "reject" {
            "rejected"
        } else {
            "reported"
        };
        let expected = if let Some(withdrawal) = task.get("withdrawal") {
            if !exact(withdrawal, &["reason", "at", "attemptId"], &[])
                || !withdrawal["reason"]
                    .as_str()
                    .is_some_and(|v| reason(v).is_ok_and(|r| r == v))
                || !timestamp(&withdrawal["at"])
                || s(withdrawal, "at") < s(team, "configuredAt")
                || withdrawal["attemptId"] != last["id"]
                || !(prior_status == "pending"
                    || (["reported", "rejected"].contains(&prior_status)
                        && last["report"]["outcome"] == "cancelled"))
                || s(withdrawal, "at") < s(last, "claimedAt")
                || ["report", "review", "retry"]
                    .iter()
                    .any(|key| s(withdrawal, "at") < s(&last[*key], "at"))
            {
                return Err(corrupt());
            }
            "withdrawn"
        } else {
            prior_status
        };
        if s(task, "status") != expected {
            return Err(corrupt());
        }
        if task["status"] == "active" {
            if !assignees.insert(s(last, "assignee"))
                || (team.get("sessionId").is_some() && last["assignee"] == team["sessionId"])
                || active.iter().any(|other| overlaps(task, other))
            {
                return Err(corrupt());
            }
            active.push(task.clone());
        }
    }
    if active.len() as u64 > team["maxActive"].as_u64().unwrap() {
        return Err(corrupt());
    }
    if tasks(work).iter().any(|task| {
        task["status"] != "withdrawn"
            && array(&task["dependsOn"]).iter().any(|id| {
                tasks(work).iter().any(|dependency| {
                    dependency["id"] == *id && dependency["status"] == "withdrawn"
                })
            })
    }) {
        return Err(corrupt());
    }
    planning::validate(work)?;
    Ok(())
}
/// File-independent completion gates, also used by legacy work completion.
pub fn blockers(work: &Value) -> Vec<Value> {
    let Some(team) = work.get("team") else {
        return vec![];
    };
    if validate(work).is_err() {
        return vec![json!({"code":"team_state_corrupt","message":"Team state is invalid"})];
    }
    let mut out = planning::blockers(work);
    let current = accepted_ids(work);
    if team["mode"] == "coordinated" && tasks(work).is_empty() {
        out.push(json!({"code":"team_tasks_required","message":"Coordinated work requires at least one scoped task"}));
    }
    for task in tasks(work) {
        if task["status"] == "withdrawn" {
            continue;
        }
        if task["status"] != "accepted" {
            out.push(json!({"code":"team_task_unaccepted","taskId":task["id"],"status":task["status"],"message":"The coordinator must accept every required task"}));
        } else if !current.contains(s(task, "id")) {
            out.push(json!({"code":"team_acceptance_stale","taskId":task["id"],"message":"Linked checks, dependencies or the result changed; review this task again"}));
        }
    }
    out
}
/// Re-read accepted artifacts and linked evidence at the final completion gate.
pub fn verify_artifacts(cwd: &Path, work: &Value) -> Result<()> {
    validate(work)?;
    planning::verify_history(cwd, work)?;
    for task in tasks(work).iter().filter(|t| t["status"] == "accepted") {
        verify_task(cwd, work, task)?;
    }
    Ok(())
}
/// An unfinished Work may be exported for diagnosis while checks or dependency
/// acceptance need repair. That does not permit altered accepted artifacts.
pub fn verify_snapshot_artifacts(cwd: &Path, work: &Value) -> Result<()> {
    validate(work)?;
    planning::verify_history(cwd, work)?;
    for task in tasks(work).iter().filter(|t| t["status"] == "accepted") {
        verify_result_files(cwd, task)?;
        verify_linked_evidence(cwd, work, task)?;
    }
    Ok(())
}
fn verify_task(cwd: &Path, work: &Value, task: &Value) -> Result<()> {
    if !dependencies_current(work, task) {
        return Err(err(
            "team_dependency_stale",
            if latest(task)["dependencies"] != dependency_receipts(work, task) {
                "Dependency results changed; reject and retry this task against current accepted results"
            } else {
                "Dependency acceptance needs verification; review the upstream task before reviewing this result"
            },
        ));
    }
    verify_result(cwd, work, task)?;
    let mut pending: Vec<&Value> = array(&task["dependsOn"]).iter().collect();
    let mut seen = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(state::s(id)) {
            continue;
        }
        let dependency = &tasks(work)[index(work, state::s(id))?];
        verify_result(cwd, work, dependency)?;
        pending.extend(array(&dependency["dependsOn"]).iter());
    }
    Ok(())
}
fn verify_result_files(cwd: &Path, task: &Value) -> Result<()> {
    for key in ["artifact", "archivedArtifact"] {
        let recorded = &latest(task)["report"][key];
        if artifact(cwd, s(recorded, "path"))? != *recorded {
            return Err(err(
                "team_artifact_changed",
                format!("Task {} result artifact changed", s(task, "id")),
            ));
        }
    }
    Ok(())
}
fn verify_result(cwd: &Path, work: &Value, task: &Value) -> Result<()> {
    verify_result_files(cwd, task)?;
    if array(&task["checks"]).iter().any(|id| {
        !state::checks(work)
            .iter()
            .any(|c| c["id"] == *id && c["status"] == "proven")
    }) {
        return Err(err(
            "team_checks_unproven",
            "All linked checks must be proven before accepting a task",
        ));
    }
    verify_linked_evidence(cwd, work, task)
}
fn verify_linked_evidence(cwd: &Path, work: &Value, task: &Value) -> Result<()> {
    for (index, _, _) in evidence::stale(cwd, work) {
        if array(&task["checks"])
            .iter()
            .any(|id| state::checks(work)[index]["id"] == *id)
        {
            return Err(err(
                "stale_evidence",
                "Linked task evidence is missing or changed",
            ));
        }
    }
    Ok(())
}
pub fn summary(work: &Value) -> Value {
    let Some(team) = work.get("team") else {
        return Value::Null;
    };
    let current = accepted_ids(work);
    let count = |status: &str| tasks(work).iter().filter(|t| t["status"] == status).count();
    let states: Vec<_> = tasks(work)
        .iter()
        .map(|task| {
            let action = match s(task, "status") {
                "withdrawn" => "withdrawn",
                "active" => "wait",
                "rejected" => "retry",
                "reported" if latest(task)["report"]["outcome"] != "completed" => "retry",
                "reported" => "review",
                "accepted" if current.contains(s(task,"id")) => "accepted",
                "accepted" => "review",
                _ => "dispatch-when-ready",
            };
            json!({"taskId":task["id"],"attemptId":latest(task)["id"],"status":task["status"],"action":action})
        })
        .collect();
    json!({"schemaVersion":SCHEMA,"mode":team["mode"],"maxActive":team["maxActive"],"sessionId":team["sessionId"],"taskCount":tasks(work).len(),"pending":count("pending"),"active":count("active"),"reported":count("reported"),"rejected":count("rejected"),"withdrawn":count("withdrawn"),"accepted":current.len(),"taskStates":states,"blockers":blockers(work),"allocation":planning::projection(work)})
}

fn grammar(args: &[String], allowed: &[&str], repeatable: &[&str]) -> Result<()> {
    let mut seen = BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let Some(flag) = args[index].strip_prefix("--") else {
            return Err(err("usage", "Team commands accept named flags only"));
        };
        let (key, inline) = flag
            .split_once('=')
            .map_or((flag, None), |(k, v)| (k, Some(v)));
        if !allowed.contains(&key) || (!repeatable.contains(&key) && !seen.insert(key)) {
            return Err(err(
                "usage",
                format!("Unknown or duplicate team flag --{key}"),
            ));
        }
        if ["json", "dry-run", "replan", "from-request"].contains(&key) {
            if inline.is_some() {
                return Err(err("usage", format!("--{key} does not take a value")));
            }
        } else if inline.is_none() {
            index += 1;
            if args.get(index).is_none_or(|v| v.starts_with("--")) {
                return Err(err("usage", format!("--{key} requires a value")));
            }
        } else if inline == Some("") {
            return Err(err("usage", format!("--{key} requires a value")));
        }
        index += 1;
    }
    Ok(())
}
fn index(work: &Value, id: &str) -> Result<usize> {
    tasks(work)
        .iter()
        .position(|t| t["id"] == id)
        .ok_or_else(|| err("team_task_not_found", "The named team task does not exist"))
}
fn configured(work: &Value) -> Result<()> {
    if work.get("team").is_none() {
        return Err(err("team_not_configured", "Run gdm team configure first"));
    }
    Ok(())
}
fn persist(cwd: &Path, work: &mut Value, event: &str, details: Value) -> Result<()> {
    // Use the same predicate as export before committing any new immutable
    // metadata. Legacy records remain readable for diagnosis.
    protocol::no_credentials(&work["team"])?;
    // A team mutation changes the state bound by enhanced completion receipts.
    // Preserve the prior receipt as history before clearing current completion.
    super::verification::invalidate(work);
    work["done"] = json!(false);
    work.as_object_mut().unwrap().remove("doneAt");
    work.as_object_mut().unwrap().remove("audit");
    validate(work)?;
    let entry = json!({"ts":event_time(work),"event":format!("team.{event}"),"team":details,"teamStateSha256":sha256(protocol::canonical_json(&work["team"]))});
    // checks.json is canonical. Commit it before the diagnostic journal so a
    // journal failure cannot hide a newly required task or a rejected result.
    store::save(cwd, work)?;
    store::append_journal(cwd, s(work, "slug"), &entry)
}
fn number(args: &[String], name: &str) -> Result<Option<u64>> {
    read_flag(args, name)?
        .map(|v| {
            v.parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_NUMBER)
                .ok_or_else(|| {
                    err(
                        "usage",
                        format!("--{name} must be a nonnegative bounded integer"),
                    )
                })
        })
        .transpose()
}
fn configure(cwd: &Path, work: &mut Value, args: &[String]) -> Result<()> {
    let mode = required_flag(args, "mode")?;
    if !["coordinated", "single"].contains(&mode.as_str()) {
        return Err(err("usage", "--mode must be coordinated or single"));
    }
    let why = read_flag(args, "reason")?.map(|v| reason(&v)).transpose()?;
    if mode == "single" && why.is_none() {
        return Err(err("usage", "Single mode requires a substantive --reason"));
    }
    let cap = number(args, "max-active")?.unwrap_or(if mode == "single" { 1 } else { 3 });
    if !(1..=MAX_ACTIVE_WORKERS).contains(&cap) || (mode == "single" && cap != 1) {
        return Err(err(
            "usage",
            format!("--max-active must be 1 through {MAX_ACTIVE_WORKERS}; single mode requires 1"),
        ));
    }
    let session = read_flag(args, "session")?
        .map(|v| contract::opaque_id(&v, "session"))
        .transpose()?;
    let old = &work["team"];
    if !old.is_null() {
        if old["mode"] == "coordinated"
            && mode == "single"
            && !tasks(work).is_empty()
            && !blockers(work).is_empty()
        {
            return Err(err(
                "team_transition",
                "Outstanding coordinated tasks prevent switching to single mode",
            ));
        }
        if tasks(work)
            .iter()
            .filter(|t| t["status"] == "active")
            .count() as u64
            > cap
        {
            return Err(err(
                "team_active_limit",
                "The new limit is smaller than the active task count",
            ));
        }
        if session
            .as_ref()
            .is_some_and(|id| old.get("sessionId").is_some_and(|old| old != id))
        {
            if tasks(work).iter().any(|t| t["status"] == "active") {
                return Err(err(
                    "team_transition",
                    "Coordinator handover requires all active attempts to report first",
                ));
            }
            if why.is_none() {
                return Err(err(
                    "usage",
                    "Coordinator handover requires a substantive --reason",
                ));
            }
        }
    }
    let mut team = json!({"schemaVersion":SCHEMA,"mode":mode,"maxActive":cap,"configuredAt":old.get("configuredAt").cloned().unwrap_or_else(||json!(now())),"tasks":old.get("tasks").cloned().unwrap_or_else(||json!([]))});
    if let Some(why) = why {
        team["reason"] = json!(why);
    } else if old["mode"] == mode
        && let Some(why) = old.get("reason")
    {
        team["reason"] = why.clone();
    }
    if let Some(session) = session {
        team["sessionId"] = json!(session);
    } else if let Some(session) = old.get("sessionId") {
        team["sessionId"] = session.clone();
    }
    for key in ["allocation", "allocationHistory"] {
        if let Some(value) = old.get(key) {
            team[key] = value.clone();
        }
    }
    if work["team"] == team {
        return Ok(());
    }
    let handover = if old.get("sessionId").is_some() && old["sessionId"] != team["sessionId"] {
        json!({"fromSessionId":old["sessionId"],"toSessionId":team["sessionId"],"reason":team["reason"]})
    } else {
        Value::Null
    };
    work["team"] = team;
    persist(
        cwd,
        work,
        "configure",
        json!({"mode":mode,"maxActive":cap,"handover":handover}),
    )
}
fn add(cwd: &Path, work: &mut Value, args: &[String]) -> Result<()> {
    configured(work)?;
    planning::locked(work)?;
    let id = contract::opaque_id(&required_flag(args, "task")?, "task")?;
    let prior = tasks(work).iter().position(|t| t["id"] == id);
    if prior.is_some_and(|i| {
        !array(&tasks(work)[i]["attempts"]).is_empty() || tasks(work)[i]["status"] == "withdrawn"
    }) {
        return Err(err(
            "team_task_locked",
            "A task plan cannot change after its first claim",
        ));
    }
    if prior.is_none() && tasks(work).len() >= MAX_TASKS {
        return Err(err("team_task_limit", "At most 64 tasks are allowed"));
    }
    let paths = read_flags(args, "path")?
        .iter()
        .map(|p| safe_path(cwd, p, false))
        .collect::<Result<Vec<_>>>()?;
    let role = contract::opaque_id(&required_flag(args, "role")?, "role")?;
    let access = required_flag(args, "access")?;
    if !["read", "write"].contains(&access.as_str()) {
        return Err(err("usage", "--access must be read or write"));
    }
    let deliverable =
        contract::safe_text(&required_flag(args, "deliverable")?, "deliverable", 480)?;
    let acceptance = contract::safe_text(&required_flag(args, "acceptance")?, "acceptance", 480)?;
    let checks = read_flags(args, "check")?;
    let deps = read_flags(args, "depends-on")?;
    if paths.is_empty() || checks.is_empty() {
        return Err(err("usage", "Every task requires --path and --check"));
    }
    for check in &checks {
        contract::opaque_id(check, "check")?;
        state::check_index(work, check)?;
    }
    for dep in &deps {
        contract::opaque_id(dep, "depends-on")?;
        let dep_index = index(work, dep)?;
        if tasks(work)[dep_index]["status"] == "withdrawn" {
            return Err(err(
                "team_dependency",
                "A withdrawn task cannot be a dependency",
            ));
        }
        if dep == &id || prior.is_some_and(|i| dep_index >= i) {
            return Err(err(
                "team_dependency",
                "Dependencies must precede the task in the task plan",
            ));
        }
    }
    let task = json!({"id":id,"role":role,"paths":paths,"access":access,"deliverable":deliverable,"acceptance":acceptance,"checks":checks,"dependsOn":deps,"status":"pending","attempts":[]});
    if let Some(i) = prior {
        if work["team"]["tasks"][i] == task {
            return Ok(());
        }
        work["team"]["tasks"][i] = task.clone();
    } else {
        work["team"]["tasks"]
            .as_array_mut()
            .unwrap()
            .push(task.clone());
    }
    validate(work).map_err(|_| {
        err(
            "usage",
            "Task paths, checks and dependencies must be unique and bounded",
        )
    })?;
    persist(cwd, work, "add", task)
}
fn adaptive(work: &Value) -> bool {
    work["team"]["allocation"]["request"]["input"]["promptVersion"] == 3
}
fn execution_matches(work: &Value, task: &Value, execution: Option<&Value>) -> bool {
    if !adaptive(work) {
        return execution.is_none();
    }
    let Some(e) = execution else {
        return false;
    };
    let Some(route) = request::route(work, task) else {
        return false;
    };
    exact(
        e,
        &["routeId", "provider", "model", "effort", "source"],
        &[],
    ) && e["source"] == "host-declared"
        && e["routeId"] == task["routeId"]
        && e["provider"] == route["provider"]
        && e["model"] == route["model"]
        && e["effort"] == task["effort"]
}
fn historical_teams(cwd: &Path, work: &Value) -> Result<Vec<Value>> {
    planning::verify_history(cwd, work)?;
    array(&work["team"]["allocationHistory"])
        .iter()
        .map(|h| {
            let bytes = store::contained(
                cwd,
                s(&h["artifact"], "path"),
                "team-plan-history",
                MAX_ARTIFACT,
            )?;
            let old: Value = serde_json::from_slice(&bytes)?;
            Ok(old["team"].clone())
        })
        .collect()
}
/// Known host-declared implementation models and whether any worker attribution is absent.
pub(crate) fn implementation_models(cwd: &Path, work: &Value) -> Result<(Vec<String>, bool)> {
    let mut teams = historical_teams(cwd, work)?;
    teams.push(work["team"].clone());
    let mut models = BTreeSet::new();
    let mut unknown = false;
    for team in teams {
        for task in array(&team["tasks"])
            .iter()
            .filter(|t| t["access"] == "write")
        {
            for attempt in array(&task["attempts"]) {
                if let Some(model) = attempt["execution"]["model"]
                    .as_str()
                    .filter(|m| *m != "inherit")
                {
                    models.insert(model.to_owned());
                } else {
                    unknown = true;
                }
            }
        }
    }
    Ok((models.into_iter().collect(), unknown))
}
fn claim_execution(
    cwd: &Path,
    work: &Value,
    task: &Value,
    args: &[String],
) -> Result<Option<Value>> {
    let keys = [
        "execution-route",
        "execution-provider",
        "execution-model",
        "execution-effort",
    ];
    if !adaptive(work) {
        if keys
            .iter()
            .any(|k| read_flag(args, k).ok().flatten().is_some())
        {
            return Err(err(
                "team_execution_invalid",
                "Legacy assignments have no adaptive execution declaration",
            ));
        }
        return Ok(None);
    }
    let effort = required_flag(args, "execution-effort")?;
    let execution = json!({"routeId":required_flag(args,"execution-route")?,"provider":required_flag(args,"execution-provider")?,"model":required_flag(args,"execution-model")?,"effort":if effort=="inherit" {Value::Null} else {json!(effort)},"source":"host-declared"});
    if !execution_matches(work, task, Some(&execution)) {
        return Err(err(
            "team_execution_invalid",
            "Host declaration must exactly match selected route, provider, model and effort; substitution is forbidden",
        ));
    }
    let route = request::route(work, task).unwrap();
    if route["execution"] != "native" {
        return Err(err(
            "team_execution_unavailable",
            "This host only launches native worker routes; replan unavailable execution",
        ));
    }
    if let Some(limit) = route["maxInvocations"].as_u64() {
        let mut teams = historical_teams(cwd, work)?;
        teams.push(work["team"].clone());
        let mut used = 0u64;
        for team in teams {
            for attempt in array(&team["tasks"])
                .iter()
                .flat_map(|t| array(&t["attempts"]))
            {
                let e = &attempt["execution"];
                if e.is_null() {
                    return Err(err(
                        "team_invocation_limit",
                        "Historical claims lack attribution; a cumulative cap cannot be proven",
                    ));
                }
                if e["provider"] == execution["provider"] && e["model"] == execution["model"] {
                    used += 1;
                }
            }
        }
        if used >= limit {
            return Err(err(
                "team_invocation_limit",
                "Cumulative provider/model claim reservation limit reached, including failed attempts",
            ));
        }
    }
    Ok(Some(execution))
}

fn claim(cwd: &Path, work: &mut Value, args: &[String]) -> Result<()> {
    configured(work)?;
    let i = index(work, &required_flag(args, "task")?)?;
    let assignee = contract::opaque_id(&required_flag(args, "assignee")?, "assignee")?;
    let attempt = contract::opaque_id(&required_flag(args, "attempt")?, "attempt")?;
    let task = &tasks(work)[i];
    planning::claim(cwd, work, task, &assignee, &attempt)?;
    if task["status"] != "pending" {
        return Err(err("team_transition", "Only a pending task can be claimed"));
    }
    if array(&task["attempts"]).len() >= MAX_ATTEMPTS {
        return Err(err(
            "team_attempt_limit",
            "At most 64 attempts per task are allowed",
        ));
    }
    if tasks(work)
        .iter()
        .any(|t| array(&t["attempts"]).iter().any(|a| a["id"] == attempt))
    {
        return Err(err(
            "team_attempt_conflict",
            "Attempt identifiers must be unique across the team",
        ));
    }
    if work["team"]["sessionId"] == assignee {
        return Err(err(
            "team_assignee_conflict",
            "The coordinator session cannot claim its own worker task",
        ));
    }
    for dep in array(&task["dependsOn"]) {
        let dependency = &tasks(work)[index(work, state::s(dep))?];
        if !accepted(work, dependency) {
            return Err(err(
                "team_dependency",
                "All dependencies must have current coordinator acceptance",
            ));
        }
        verify_task(cwd, work, dependency)?;
    }
    for p in array(&task["paths"]) {
        safe_path(cwd, state::s(p), false)?;
    }
    let active: Vec<_> = tasks(work)
        .iter()
        .filter(|t| t["status"] == "active")
        .collect();
    if active.len() as u64 >= work["team"]["maxActive"].as_u64().unwrap() {
        return Err(err(
            "team_active_limit",
            "The active task limit has been reached",
        ));
    }
    if active.iter().any(|t| latest(t)["assignee"] == assignee) {
        return Err(err(
            "team_assignee_conflict",
            "An assignee may own only one active task",
        ));
    }
    if active.iter().any(|other| overlaps(task, other)) {
        return Err(err(
            "team_scope_conflict",
            "An active task has overlapping read or write ownership",
        ));
    }
    let execution = claim_execution(cwd, work, task, args)?;
    let task_id = task["id"].clone();
    let dependencies = dependency_receipts(work, task);
    let claimed_at = event_time(work);
    work["team"]["tasks"][i]["attempts"]
        .as_array_mut()
        .unwrap()
        .push(
            json!({"id":attempt,"assignee":assignee,"claimedAt":claimed_at,"dependencies":dependencies}),
        );
    if let Some(execution) = execution.clone() {
        work["team"]["tasks"][i]["attempts"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["execution"] = execution;
    }
    work["team"]["tasks"][i]["status"] = json!("active");
    persist(
        cwd,
        work,
        "claim",
        json!({"taskId":task_id,"attemptId":attempt,"assignee":assignee,"execution":execution}),
    )
}
fn report(cwd: &Path, work: &mut Value, args: &[String]) -> Result<()> {
    configured(work)?;
    let i = index(work, &required_flag(args, "task")?)?;
    let attempt_id = contract::opaque_id(&required_flag(args, "attempt")?, "attempt")?;
    let task = &tasks(work)[i];
    let previous = latest(task);
    if previous["id"] != attempt_id || previous.get("retry").is_some() {
        return Err(err(
            "team_attempt_conflict",
            "The report does not match the current task attempt",
        ));
    }
    let outcome = required_flag(args, "outcome")?;
    if !["completed", "failed", "cancelled", "inconclusive"].contains(&outcome.as_str()) {
        return Err(err("usage", "Unknown task report outcome"));
    }
    let mut report = json!({"outcome":outcome,"summary":contract::safe_text(&required_flag(args,"summary")?,"summary",1000)?,"artifact":artifact(cwd,&required_flag(args,"artifact")?)?,"at":previous["report"].get("at").cloned().unwrap_or_else(||json!(event_time(work)))});
    let archive_path = format!(
        ".gdm/{}/out/team-{}.txt",
        s(work, "slug"),
        sha256(format!("{}\0{}", s(task, "id"), attempt_id))
    );
    report["archivedArtifact"] = json!({"path":archive_path,"sha256":report["artifact"]["sha256"]});
    let mut metrics = json!({"source":"reported"});
    for (flag, key) in [("tokens", "tokens"), ("elapsed-ms", "elapsedMs")] {
        if let Some(n) = number(args, flag)? {
            metrics[key] = json!(n);
        }
    }
    if metrics.as_object().unwrap().len() > 1 {
        report["metrics"] = metrics;
    }
    protocol::no_credentials(&report)?;
    if let Some(existing) = previous.get("report") {
        if *existing == report {
            return verify_result_files(cwd, task);
        }
        return Err(err(
            "team_report_conflict",
            "A terminal report can only be replayed with an identical payload",
        ));
    }
    if task["status"] != "active" {
        return Err(err(
            "team_transition",
            "Only an active attempt can report a result",
        ));
    }
    let n = array(&task["attempts"]).len() - 1;
    let task_id = task["id"].clone();
    let mut candidate = work.clone();
    candidate["team"]["tasks"][i]["attempts"][n]["report"] = report.clone();
    candidate["team"]["tasks"][i]["status"] = json!("reported");
    validate(&candidate)?;
    protocol::no_credentials(&candidate["team"])?;
    archive_artifact(cwd, work, task, &attempt_id, &report["artifact"])?;
    *work = candidate;
    persist(
        cwd,
        work,
        "report",
        json!({"taskId":task_id,"attemptId":attempt_id,"report":report}),
    )
}
fn review(cwd: &Path, work: &mut Value, args: &[String]) -> Result<()> {
    configured(work)?;
    let i = index(work, &required_flag(args, "task")?)?;
    let decision = required_flag(args, "decision")?;
    if !["accept", "reject"].contains(&decision.as_str()) {
        return Err(err("usage", "--decision must be accept or reject"));
    }
    let why = contract::safe_text(&required_flag(args, "reason")?, "reason", 480)?;
    let task = &tasks(work)[i];
    if task["status"] == "withdrawn" {
        return Err(err(
            "team_transition",
            "A withdrawn task cannot be reviewed",
        ));
    }
    let last = latest(task);
    let expected_attempt = contract::opaque_id(&required_flag(args, "attempt")?, "attempt")?;
    if last["id"] != expected_attempt || last.get("retry").is_some() {
        return Err(err(
            "team_attempt_conflict",
            "The action does not match the current task attempt",
        ));
    }
    if last.get("report").is_none() || last.get("retry").is_some() {
        return Err(err(
            "team_transition",
            "A current terminal report is required for review",
        ));
    }
    let mut review = json!({"decision":decision,"reason":why,"at":event_time(work)});
    if decision == "accept" {
        if last["report"]["outcome"] != "completed" {
            return Err(err(
                "team_report_incomplete",
                "Only a completed report can be accepted",
            ));
        }
        verify_task(cwd, work, task)?;
        review["checks"] = check_receipts(work, task);
        review["resultDigest"] = json!(sha256(protocol::canonical_json(&last["report"])));
    }
    let n = array(&task["attempts"]).len() - 1;
    let task_id = task["id"].clone();
    let attempt_id = last["id"].clone();
    work["team"]["tasks"][i]["attempts"][n]["review"] = review.clone();
    work["team"]["tasks"][i]["status"] = json!(if decision == "accept" {
        "accepted"
    } else {
        "rejected"
    });
    persist(
        cwd,
        work,
        "review",
        json!({"taskId":task_id,"attemptId":attempt_id,"review":review}),
    )
}
fn retry(cwd: &Path, work: &mut Value, args: &[String]) -> Result<()> {
    configured(work)?;
    let i = index(work, &required_flag(args, "task")?)?;
    let why = contract::safe_text(&required_flag(args, "reason")?, "reason", 480)?;
    let task = &tasks(work)[i];
    let last = latest(task);
    let expected_attempt = contract::opaque_id(&required_flag(args, "attempt")?, "attempt")?;
    if last["id"] != expected_attempt || last.get("retry").is_some() {
        return Err(err(
            "team_attempt_conflict",
            "The action does not match the current task attempt",
        ));
    }
    if !["reported", "rejected"].contains(&s(task, "status"))
        || (last["report"]["outcome"] == "completed" && task["status"] != "rejected")
    {
        return Err(err(
            "team_transition",
            "Retry requires an unsuccessful or rejected current report",
        ));
    }
    let n = array(&task["attempts"]).len() - 1;
    let task_id = task["id"].clone();
    let attempt_id = last["id"].clone();
    let retry = json!({"reason":why,"at":event_time(work)});
    work["team"]["tasks"][i]["attempts"][n]["retry"] = retry.clone();
    work["team"]["tasks"][i]["status"] = json!("pending");
    persist(
        cwd,
        work,
        "retry",
        json!({"taskId":task_id,"attemptId":attempt_id,"retry":retry}),
    )
}
fn withdraw(cwd: &Path, work: &mut Value, args: &[String]) -> Result<()> {
    configured(work)?;
    planning::locked(work)?;
    let i = index(work, &required_flag(args, "task")?)?;
    let why = reason(&required_flag(args, "reason")?)?;
    let expected = read_flag(args, "attempt")?
        .map(|id| contract::opaque_id(&id, "attempt"))
        .transpose()?;
    let task = &tasks(work)[i];
    let last = latest(task);
    if expected.as_deref() != last["id"].as_str() {
        return Err(err(
            "team_attempt_conflict",
            "Withdrawal must identify the current attempt, or omit it for an unclaimed task",
        ));
    }
    if task["status"] == "withdrawn" {
        return if task["withdrawal"]["reason"] == why {
            Ok(())
        } else {
            Err(err(
                "team_transition",
                "A withdrawal is immutable; register a new task for new scope",
            ))
        };
    }
    if !(task["status"] == "pending"
        || (["reported", "rejected"].contains(&s(task, "status"))
            && last["report"]["outcome"] == "cancelled"))
    {
        return Err(err(
            "team_transition",
            "Withdraw only pending tasks or attempts reported as cancelled; active work must stop and report first",
        ));
    }
    if tasks(work).iter().any(|other| {
        other["status"] != "withdrawn"
            && array(&other["dependsOn"])
                .iter()
                .any(|id| *id == task["id"])
    }) {
        return Err(err(
            "team_dependency",
            "Withdraw or replace dependent tasks before withdrawing their prerequisite",
        ));
    }
    let withdrawal = json!({"reason":why,"at":event_time(work),"attemptId":last["id"]});
    let task_id = task["id"].clone();
    work["team"]["tasks"][i]["status"] = json!("withdrawn");
    work["team"]["tasks"][i]["withdrawal"] = withdrawal.clone();
    persist(
        cwd,
        work,
        "withdraw",
        json!({"taskId":task_id,"withdrawal":withdrawal}),
    )
}
fn next(cwd: &Path, work: &Value) -> Value {
    if work.get("team").is_none() {
        return json!({"action":"configure","command":format!("gdm team configure --slug {} --mode coordinated",s(work,"slug"))});
    }
    let mut allocation_blockers = planning::blockers(work);
    if let Err(error) = planning::verify_history(cwd, work) {
        allocation_blockers.push(json!({"code":error.code,"message":error.message}));
    }
    if !allocation_blockers.is_empty() {
        return json!({"schemaVersion":"gdm-team-next/v1","automaticExecution":false,"actions":[{"action":"blocked","blockers":allocation_blockers}],"allocation":planning::projection(work)});
    }
    let mut actions = vec![];
    let current = accepted_ids(work);
    let active: Vec<_> = tasks(work)
        .iter()
        .filter(|t| t["status"] == "active")
        .collect();
    let mut selected = active.clone();
    for task in tasks(work) {
        let id = s(task, "id");
        if task["status"] == "rejected"
            || (task["status"] == "reported" && latest(task)["report"]["outcome"] != "completed")
        {
            actions.push(json!({"action":"retry","taskId":id,"attemptId":latest(task)["id"],"message":"Inspect the report and retry with a reason"}));
        } else if task["status"] == "reported"
            || (task["status"] == "accepted"
                && (!current.contains(s(task, "id")) || verify_task(cwd, work, task).is_err()))
        {
            actions.push(json!({"action":"review","taskId":id,"attemptId":latest(task)["id"],"message":"Verify the artifact and linked checks, then record accept or reject"}));
        } else if task["status"] == "pending"
            && (selected.len() as u64) < work["team"]["maxActive"].as_u64().unwrap_or(0)
            && !selected.iter().any(|other| overlaps(task, other))
            && array(&task["dependsOn"]).iter().all(|id| {
                tasks(work).iter().any(|t| {
                    t["id"] == *id
                        && current.contains(s(t, "id"))
                        && verify_task(cwd, work, t).is_ok()
                })
            })
        {
            let mut action = json!({"action":"dispatch","taskId":id,"role":task["role"],"paths":task["paths"],"access":task["access"],"deliverable":task["deliverable"],"acceptance":task["acceptance"],"checks":task["checks"],"message":"The coordinator must claim this task with its assignee and attempt before launching the scoped worker"});
            if let Some(route) = request::route(work, task) {
                action["route"] = route.clone();
                action["routeId"] = task["routeId"].clone();
                for key in ["effort", "selectionReason"] {
                    if let Some(v) = task.get(key) {
                        action[key] = v.clone();
                    }
                }
                action["prompt"] = json!(request::dispatch_prompt(work, task));
                if let Some(mode) = task.get("acceptanceMode") {
                    action["acceptanceMode"] = mode.clone();
                }
            }
            actions.push(action);
            selected.push(task);
        }
    }
    if actions.is_empty() {
        if tasks(work).is_empty() && work["team"]["mode"] == "coordinated" {
            actions.push(json!({"action":"plan","message":"Add scoped tasks with deliverables and linked checks"}));
        } else if blockers(work).is_empty() {
            actions.push(
                json!({"action":"validate","command":format!("gdm done --slug {}",s(work,"slug"))}),
            );
        } else {
            actions.push(json!({"action":"wait","message":"Collect active worker reports before dispatching dependent tasks","activeTasks":active.iter().map(|t|t["id"].clone()).collect::<Vec<_>>()}));
        }
    }
    json!({"schemaVersion":"gdm-team-next/v1","automaticExecution":false,"actions":actions})
}
/// The runtime acquires its repository lock before calling mutating commands.
pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    let (command, args) = args
        .split_first()
        .ok_or_else(|| err("usage", "A team subcommand is required"))?;
    let (allowed, repeatable): (&[&str], &[&str]) = match command.as_str() {
        "configure" => (&["slug", "mode", "reason", "max-active", "session"], &[]),
        "auto" => (
            &[
                "slug",
                "file",
                "dry-run",
                "json",
                "replan",
                "reason",
                "from-request",
                "provider",
                "model",
                "max-active",
                "executor",
                "context",
                "capabilities-file",
            ],
            &["context"],
        ),
        "add" => (
            &[
                "slug",
                "task",
                "role",
                "path",
                "access",
                "deliverable",
                "acceptance",
                "check",
                "depends-on",
            ],
            &["path", "check", "depends-on"],
        ),
        "claim" => (
            &[
                "slug",
                "task",
                "assignee",
                "attempt",
                "execution-route",
                "execution-provider",
                "execution-model",
                "execution-effort",
            ],
            &[],
        ),
        "report" => (
            &[
                "slug",
                "task",
                "attempt",
                "outcome",
                "summary",
                "artifact",
                "tokens",
                "elapsed-ms",
            ],
            &[],
        ),
        "review" => (&["slug", "task", "attempt", "decision", "reason"], &[]),
        "retry" => (&["slug", "task", "attempt", "reason"], &[]),
        "withdraw" => (&["slug", "task", "attempt", "reason"], &[]),
        "status" | "next" => (&["slug", "json"], &[]),
        _ => return Err(err("usage", "Unknown team subcommand")),
    };
    grammar(args, allowed, repeatable)?;
    if command == "auto" && args.iter().any(|a| a == "--from-request") {
        return print_json(&request::run(cwd, args)?);
    }
    if command == "auto"
        && args.iter().any(|a| {
            [
                "--provider",
                "--model",
                "--max-active",
                "--executor",
                "--context",
                "--capabilities-file",
            ]
            .contains(&a.split('=').next().unwrap_or(""))
        })
    {
        return Err(err(
            "usage",
            "Planner options require --from-request; --file is a manual import",
        ));
    }
    let slug = required_flag(args, "slug")?;
    let mut work = store::load(cwd, &slug)?;
    validate(&work)?;
    match command.as_str() {
        "configure" => configure(cwd, &mut work, args)?,
        "auto" => return print_json(&planning::run(cwd, &mut work, args)?),
        "add" => add(cwd, &mut work, args)?,
        "claim" => claim(cwd, &mut work, args)?,
        "report" => report(cwd, &mut work, args)?,
        "review" => review(cwd, &mut work, args)?,
        "retry" => retry(cwd, &mut work, args)?,
        "withdraw" => withdraw(cwd, &mut work, args)?,
        "status" => {}
        "next" => return print_json(&next(cwd, &work)),
        _ => unreachable!(),
    }
    let mut output = summary(&work);
    if output.is_object() {
        output["tasks"] = work["team"]["tasks"].clone();
    }
    if command == "status" && output.is_object() {
        for task in tasks(&work).iter().filter(|t| t["status"] == "accepted") {
            if let Err(error) = verify_task(cwd, &work, task) {
                output["blockers"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"code":error.code,"taskId":task["id"],"message":error.message}));
            }
        }
    }
    print_json(&output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).into()).collect()
    }
    fn fixture() -> (tempfile::TempDir, Value) {
        let repo = tempfile::tempdir().unwrap();
        let mut work = json!({"slug":"team-test","brief":"Durable team coordination","createdAt":"2026-01-01T00:00:00.000Z","done":false,"checks":[{"id":"c1","desc":"Review result","cmd":null,"expect":"Reviewed","manual":true,"status":"open"}],"contract":contract::default_contract()});
        store::save(repo.path(), &work).unwrap();
        configure(
            repo.path(),
            &mut work,
            &args(&["--mode", "coordinated", "--session", "coordinator-one"]),
        )
        .unwrap();
        fs::write(
            repo.path().join("result.txt"),
            "Worker findings and verification details",
        )
        .unwrap();
        (repo, work)
    }
    fn task(cwd: &Path, work: &mut Value, id: &str, path: &str, access: &str, deps: &[&str]) {
        let mut options = args(&[
            "--task",
            id,
            "--role",
            "implementation",
            "--path",
            path,
            "--access",
            access,
            "--deliverable",
            "Implement scoped change",
            "--acceptance",
            "Linked check passes",
            "--check",
            "c1",
        ]);
        for dep in deps {
            options.extend(args(&["--depends-on", dep]));
        }
        add(cwd, work, &options).unwrap();
    }
    fn begin(cwd: &Path, work: &mut Value, id: &str, worker: &str, attempt: &str) -> Result<()> {
        claim(
            cwd,
            work,
            &args(&["--task", id, "--assignee", worker, "--attempt", attempt]),
        )
    }
    fn finish(cwd: &Path, work: &mut Value, id: &str, attempt: &str, outcome: &str) -> Result<()> {
        report(
            cwd,
            work,
            &args(&[
                "--task",
                id,
                "--attempt",
                attempt,
                "--outcome",
                outcome,
                "--summary",
                "Scoped work result recorded",
                "--artifact",
                "result.txt",
                "--tokens",
                "42",
            ]),
        )
    }
    fn decide(cwd: &Path, work: &mut Value, id: &str, decision: &str) -> Result<()> {
        let attempt = s(latest(&tasks(work)[index(work, id)?]), "id").to_owned();
        review(
            cwd,
            work,
            &args(&[
                "--task",
                id,
                "--attempt",
                &attempt,
                "--decision",
                decision,
                "--reason",
                "Result and checks inspected",
            ]),
        )
    }
    fn prove(cwd: &Path, work: &mut Value) {
        let path = store::output(cwd, "team-test", "proof.txt", b"Check passed").unwrap();
        work["checks"][0]["status"] = json!("proven");
        work["checks"][0]["evidence"] =
            json!({"observed":path,"sha256":sha256(b"Check passed"),"manual":true,"at":now()});
        store::save(cwd, work).unwrap();
    }
    #[test]
    fn adaptive_execution_declaration_is_exact_and_legacy_absent() {
        let route = json!({"id":"chosen","provider":"native","model":"available-model"});
        let work = json!({"team":{"allocation":{"request":{"input":{"promptVersion":3,"capabilities":{"routes":[route]}}}}}});
        let task = json!({"routeId":"chosen","effort":"high"});
        let mut e = json!({"routeId":"chosen","provider":"native","model":"available-model","effort":"high","source":"host-declared"});
        assert!(execution_matches(&work, &task, Some(&e)));
        assert!(!execution_matches(&work, &task, None));
        e["model"] = json!("substituted-model");
        assert!(!execution_matches(&work, &task, Some(&e)));
        e["model"] = json!("available-model");
        e["effort"] = Value::Null;
        assert!(!execution_matches(&work, &task, Some(&e)));
        let legacy = json!({"team":{}});
        assert!(execution_matches(&legacy, &task, None));
        assert!(!execution_matches(&legacy, &task, Some(&e)));
    }

    #[test]
    fn report_is_not_acceptance_and_done_rechecks_preserve_definition_receipt() {
        let (repo, mut work) = fixture();
        task(
            repo.path(),
            &mut work,
            "build",
            "src/feature.rs",
            "write",
            &[],
        );
        begin(repo.path(), &mut work, "build", "worker-one", "attempt-one").unwrap();
        finish(repo.path(), &mut work, "build", "attempt-one", "completed").unwrap();
        assert_eq!(blockers(&work)[0]["code"], "team_task_unaccepted");
        assert!(decide(repo.path(), &mut work, "build", "accept").is_err());
        prove(repo.path(), &mut work);
        decide(repo.path(), &mut work, "build", "accept").unwrap();
        assert!(blockers(&work).is_empty());
        verify_artifacts(repo.path(), &work).unwrap();
        // done regenerates evidence metadata while preserving the check definition.
        work["checks"][0]["evidence"]["at"] = json!("2026-11-01T00:00:00.000Z");
        assert!(blockers(&work).is_empty());
        work["checks"][0]["expect"] = json!("A different result");
        assert_eq!(blockers(&work)[0]["code"], "team_acceptance_stale");
        decide(repo.path(), &mut work, "build", "accept").unwrap();
        assert!(blockers(&work).is_empty());
        fs::write(repo.path().join("result.txt"), "Changed result").unwrap();
        assert!(verify_artifacts(repo.path(), &work).is_err());
    }
    #[test]
    fn ownership_conflicts_cover_parent_paths_and_read_read_is_allowed() {
        let (repo, mut work) = fixture();
        task(repo.path(), &mut work, "read-parent", "src", "read", &[]);
        task(
            repo.path(),
            &mut work,
            "read-child",
            "src/lib.rs",
            "read",
            &[],
        );
        task(
            repo.path(),
            &mut work,
            "write-child",
            "src/lib.rs",
            "write",
            &[],
        );
        begin(repo.path(), &mut work, "read-parent", "reader-one", "a1").unwrap();
        begin(repo.path(), &mut work, "read-child", "reader-two", "a2").unwrap();
        assert_eq!(
            begin(repo.path(), &mut work, "write-child", "writer", "a3")
                .unwrap_err()
                .code,
            "team_scope_conflict"
        );
        assert!(validate(&work).is_ok());
    }
    #[test]
    fn dependencies_need_acceptance_and_cap_and_assignee_are_enforced() {
        let (repo, mut work) = fixture();
        configure(
            repo.path(),
            &mut work,
            &args(&["--mode", "coordinated", "--max-active", "1"]),
        )
        .unwrap();
        task(repo.path(), &mut work, "first", "one.rs", "write", &[]);
        task(
            repo.path(),
            &mut work,
            "second",
            "two.rs",
            "write",
            &["first"],
        );
        task(repo.path(), &mut work, "third", "three.rs", "write", &[]);
        assert_eq!(
            begin(repo.path(), &mut work, "second", "worker-two", "a2")
                .unwrap_err()
                .code,
            "team_dependency"
        );
        assert!(begin(repo.path(), &mut work, "first", "coordinator-one", "a0").is_err());
        begin(repo.path(), &mut work, "first", "worker-one", "a1").unwrap();
        assert_eq!(
            begin(repo.path(), &mut work, "third", "worker-three", "a3")
                .unwrap_err()
                .code,
            "team_active_limit"
        );
        finish(repo.path(), &mut work, "first", "a1", "completed").unwrap();
        assert!(begin(repo.path(), &mut work, "second", "worker-two", "a2").is_err());
        prove(repo.path(), &mut work);
        decide(repo.path(), &mut work, "first", "accept").unwrap();
        begin(repo.path(), &mut work, "second", "worker-two", "a2").unwrap();
    }
    #[test]
    fn failed_attempts_require_retry_and_preserve_history() {
        let (repo, mut work) = fixture();
        task(
            repo.path(),
            &mut work,
            "build",
            "src/feature.rs",
            "write",
            &[],
        );
        begin(repo.path(), &mut work, "build", "worker-one", "attempt-one").unwrap();
        finish(
            repo.path(),
            &mut work,
            "build",
            "attempt-one",
            "inconclusive",
        )
        .unwrap();
        assert!(decide(repo.path(), &mut work, "build", "accept").is_err());
        assert!(begin(repo.path(), &mut work, "build", "worker-two", "attempt-two").is_err());
        retry(
            repo.path(),
            &mut work,
            &args(&[
                "--task",
                "build",
                "--attempt",
                "attempt-one",
                "--reason",
                "Resolve missing evidence",
            ]),
        )
        .unwrap();
        assert!(
            finish(
                repo.path(),
                &mut work,
                "build",
                "attempt-one",
                "inconclusive"
            )
            .is_err()
        );
        assert!(begin(repo.path(), &mut work, "build", "worker-two", "attempt-one").is_err());
        begin(repo.path(), &mut work, "build", "worker-two", "attempt-two").unwrap();
        assert_eq!(array(&tasks(&work)[0]["attempts"]).len(), 2);
        assert_eq!(
            tasks(&work)[0]["attempts"][0]["report"]["outcome"],
            "inconclusive"
        );
        assert!(validate(&work).is_ok());
    }
    #[test]
    fn report_replay_is_exact_and_does_not_append_a_journal_event() {
        let (repo, mut work) = fixture();
        task(
            repo.path(),
            &mut work,
            "build",
            "src/feature.rs",
            "write",
            &[],
        );
        begin(repo.path(), &mut work, "build", "worker-one", "attempt-one").unwrap();
        finish(repo.path(), &mut work, "build", "attempt-one", "failed").unwrap();
        let count = store::read_journal(repo.path(), "team-test").unwrap().len();
        finish(repo.path(), &mut work, "build", "attempt-one", "failed").unwrap();
        assert_eq!(
            store::read_journal(repo.path(), "team-test").unwrap().len(),
            count
        );
        assert_eq!(
            finish(repo.path(), &mut work, "build", "attempt-one", "completed")
                .unwrap_err()
                .code,
            "team_report_conflict"
        );
        assert_eq!(
            latest(&tasks(&work)[0])["report"]["metrics"]["source"],
            "reported"
        );
    }
    #[test]
    fn loading_rejects_unknown_fields_cycles_and_forged_acceptance() {
        let (repo, mut work) = fixture();
        task(repo.path(), &mut work, "first", "one.rs", "write", &[]);
        task(
            repo.path(),
            &mut work,
            "second",
            "two.rs",
            "write",
            &["first"],
        );
        let mut bad = work.clone();
        bad["team"]["tasks"][0]["status"] = json!("accepted");
        assert!(validate(&bad).is_err());
        bad = work.clone();
        bad["team"]["tasks"][0]["dependsOn"] = json!(["second"]);
        assert!(validate(&bad).is_err());
        bad = work.clone();
        bad["team"]["tasks"][0]["hidden"] = json!(true);
        assert!(validate(&bad).is_err());
        bad = work.clone();
        bad["team"]["tasks"][0]["deliverable"] = json!("Bearer secret-token");
        assert!(validate(&bad).is_err());
    }
    #[test]
    fn paths_are_normalized_and_symlinks_reserved_paths_and_escapes_are_rejected() {
        let (repo, mut work) = fixture();
        assert_eq!(
            safe_path(repo.path(), "./src//feature.rs", false).unwrap(),
            "src/feature.rs"
        );
        for bad in [
            ".",
            "../escape",
            "/absolute",
            ".gdm/state",
            ".git/config",
            "nested/.git/config",
        ] {
            assert!(safe_path(repo.path(), bad, false).is_err(), "{bad}");
        }
        std::os::unix::fs::symlink(repo.path().join("result.txt"), repo.path().join("link.txt"))
            .unwrap();
        assert!(artifact(repo.path(), "link.txt").is_err());
        task(
            repo.path(),
            &mut work,
            "build",
            "src/feature.rs",
            "write",
            &[],
        );
        begin(repo.path(), &mut work, "build", "worker-one", "a1").unwrap();
        fs::write(repo.path().join("result.txt"), [0xff]).unwrap();
        assert!(finish(repo.path(), &mut work, "build", "a1", "completed").is_err());
    }
    #[test]
    fn coordinated_empty_plan_and_downgrade_cannot_bypass_required_tasks() {
        let (repo, mut work) = fixture();
        assert_eq!(blockers(&work)[0]["code"], "team_tasks_required");
        configure(
            repo.path(),
            &mut work,
            &args(&["--mode", "single", "--reason", "Small isolated change"]),
        )
        .unwrap();
        assert!(blockers(&work).is_empty());
        configure(repo.path(), &mut work, &args(&["--mode", "coordinated"])).unwrap();
        task(
            repo.path(),
            &mut work,
            "build",
            "src/feature.rs",
            "write",
            &[],
        );
        assert!(
            configure(
                repo.path(),
                &mut work,
                &args(&["--mode", "single", "--reason", "Small isolated change"])
            )
            .is_err()
        );
        let mut legacy = work.clone();
        legacy.as_object_mut().unwrap().remove("team");
        assert!(blockers(&legacy).is_empty());
        assert!(validate(&legacy).is_ok());
    }
    #[test]
    fn accepted_report_cannot_retry_without_explicit_rejection() {
        let (repo, mut work) = fixture();
        task(
            repo.path(),
            &mut work,
            "build",
            "src/feature.rs",
            "write",
            &[],
        );
        begin(repo.path(), &mut work, "build", "worker-one", "a1").unwrap();
        finish(repo.path(), &mut work, "build", "a1", "completed").unwrap();
        prove(repo.path(), &mut work);
        decide(repo.path(), &mut work, "build", "accept").unwrap();
        assert!(
            retry(
                repo.path(),
                &mut work,
                &args(&[
                    "--task",
                    "build",
                    "--attempt",
                    "a1",
                    "--reason",
                    "Revise prior result"
                ])
            )
            .is_err()
        );
        decide(repo.path(), &mut work, "build", "reject").unwrap();
        assert!(!blockers(&work).is_empty());
        retry(
            repo.path(),
            &mut work,
            &args(&[
                "--task",
                "build",
                "--attempt",
                "a1",
                "--reason",
                "Revise prior result",
            ]),
        )
        .unwrap();
        assert_eq!(tasks(&work)[0]["status"], "pending");
    }
    #[test]
    fn coordinator_handover_requires_reason_and_no_active_attempts() {
        let (repo, mut work) = fixture();
        task(
            repo.path(),
            &mut work,
            "build",
            "src/feature.rs",
            "write",
            &[],
        );
        begin(repo.path(), &mut work, "build", "worker-one", "a1").unwrap();
        let options = args(&[
            "--mode",
            "coordinated",
            "--session",
            "coordinator-two",
            "--reason",
            "Resume in a new coordinator session",
        ]);
        assert_eq!(
            configure(repo.path(), &mut work, &options)
                .unwrap_err()
                .code,
            "team_transition"
        );
        finish(repo.path(), &mut work, "build", "a1", "completed").unwrap();
        assert!(
            configure(
                repo.path(),
                &mut work,
                &args(&["--mode", "coordinated", "--session", "coordinator-two"])
            )
            .is_err()
        );
        configure(repo.path(), &mut work, &options).unwrap();
        assert_eq!(work["team"]["sessionId"], "coordinator-two");
        let journal = store::read_journal(repo.path(), "team-test").unwrap();
        assert_eq!(
            journal.last().unwrap()["team"]["handover"]["fromSessionId"],
            "coordinator-one"
        );
        assert_eq!(
            journal.last().unwrap()["team"]["handover"]["toSessionId"],
            "coordinator-two"
        );
    }
    #[test]
    fn credentials_are_rejected_and_dispatch_respects_available_slots() {
        let (repo, mut work) = fixture();
        configure(
            repo.path(),
            &mut work,
            &args(&["--mode", "coordinated", "--max-active", "1"]),
        )
        .unwrap();
        task(repo.path(), &mut work, "first", "one.rs", "write", &[]);
        task(repo.path(), &mut work, "second", "two.rs", "write", &[]);
        let instructions = next(repo.path(), &work);
        assert_eq!(array(&instructions["actions"]).len(), 1);
        assert_eq!(instructions["actions"][0]["action"], "dispatch");
        fs::write(
            repo.path().join("result.txt"),
            "Authorization: Bearer synthetic-test-value",
        )
        .unwrap();
        assert_eq!(
            artifact(repo.path(), "result.txt").unwrap_err().code,
            "privacy_rejected"
        );
    }
    #[test]
    fn upstream_retry_invalidates_dependent_acceptance_until_a_new_attempt() {
        let (repo, mut work) = fixture();
        task(repo.path(), &mut work, "upstream", "one.rs", "write", &[]);
        task(
            repo.path(),
            &mut work,
            "downstream",
            "two.rs",
            "write",
            &["upstream"],
        );
        prove(repo.path(), &mut work);
        begin(repo.path(), &mut work, "upstream", "worker-one", "a1").unwrap();
        finish(repo.path(), &mut work, "upstream", "a1", "completed").unwrap();
        decide(repo.path(), &mut work, "upstream", "accept").unwrap();
        begin(repo.path(), &mut work, "downstream", "worker-two", "b1").unwrap();
        finish(repo.path(), &mut work, "downstream", "b1", "completed").unwrap();
        decide(repo.path(), &mut work, "downstream", "accept").unwrap();
        assert!(blockers(&work).is_empty());
        decide(repo.path(), &mut work, "upstream", "reject").unwrap();
        retry(
            repo.path(),
            &mut work,
            &args(&[
                "--task",
                "upstream",
                "--attempt",
                "a1",
                "--reason",
                "Revise upstream result",
            ]),
        )
        .unwrap();
        begin(repo.path(), &mut work, "upstream", "worker-one", "a2").unwrap();
        finish(repo.path(), &mut work, "upstream", "a2", "completed").unwrap();
        decide(repo.path(), &mut work, "upstream", "accept").unwrap();
        assert!(validate(&work).is_ok());
        assert_eq!(blockers(&work)[0]["taskId"], "downstream");
        assert_eq!(next(repo.path(), &work)["actions"][0]["action"], "review");
        assert_eq!(
            decide(repo.path(), &mut work, "downstream", "accept")
                .unwrap_err()
                .code,
            "team_dependency_stale"
        );
        assert!(verify_artifacts(repo.path(), &work).is_err());
        // A late reviewer cannot use A1 approval to approve A2.
        let before = work.clone();
        assert_eq!(
            review(
                repo.path(),
                &mut work,
                &args(&[
                    "--task",
                    "upstream",
                    "--attempt",
                    "a1",
                    "--decision",
                    "accept",
                    "--reason",
                    "Late result review"
                ])
            )
            .unwrap_err()
            .code,
            "team_attempt_conflict"
        );
        assert_eq!(
            retry(
                repo.path(),
                &mut work,
                &args(&[
                    "--task",
                    "upstream",
                    "--attempt",
                    "a1",
                    "--reason",
                    "Late result retry"
                ])
            )
            .unwrap_err()
            .code,
            "team_attempt_conflict"
        );
        assert_eq!(work, before);
        decide(repo.path(), &mut work, "downstream", "reject").unwrap();
        retry(
            repo.path(),
            &mut work,
            &args(&[
                "--task",
                "downstream",
                "--attempt",
                "b1",
                "--reason",
                "Recheck current upstream result",
            ]),
        )
        .unwrap();
        begin(repo.path(), &mut work, "downstream", "worker-two", "b2").unwrap();
        finish(repo.path(), &mut work, "downstream", "b2", "completed").unwrap();
        decide(repo.path(), &mut work, "downstream", "accept").unwrap();
        assert!(blockers(&work).is_empty());
        verify_artifacts(repo.path(), &work).unwrap();
        assert_eq!(
            latest(&tasks(&work)[1])["dependencies"][0]["attemptId"],
            "a2"
        );
    }
    #[test]
    fn retry_preserves_archived_result_and_archive_tampering_blocks_acceptance() {
        let (repo, mut work) = fixture();
        task(
            repo.path(),
            &mut work,
            "build",
            "src/feature.rs",
            "write",
            &[],
        );
        begin(repo.path(), &mut work, "build", "worker-one", "a1").unwrap();
        finish(repo.path(), &mut work, "build", "a1", "failed").unwrap();
        let archived = latest(&tasks(&work)[0])["report"]["archivedArtifact"].clone();
        let original = fs::read(repo.path().join(s(&archived, "path"))).unwrap();
        retry(
            repo.path(),
            &mut work,
            &args(&[
                "--task",
                "build",
                "--attempt",
                "a1",
                "--reason",
                "Repair result and verify again",
            ]),
        )
        .unwrap();
        fs::write(repo.path().join("result.txt"), "Second attempt findings").unwrap();
        begin(repo.path(), &mut work, "build", "worker-one", "a2").unwrap();
        finish(repo.path(), &mut work, "build", "a2", "completed").unwrap();
        assert_eq!(
            fs::read(repo.path().join(s(&archived, "path"))).unwrap(),
            original
        );
        let second = latest(&tasks(&work)[0])["report"]["archivedArtifact"].clone();
        assert_ne!(second["path"], archived["path"]);
        prove(repo.path(), &mut work);
        fs::write(repo.path().join(s(&second, "path")), "Tampered archive").unwrap();
        assert_eq!(
            decide(repo.path(), &mut work, "build", "accept")
                .unwrap_err()
                .code,
            "team_artifact_changed"
        );
        assert!(finish(repo.path(), &mut work, "build", "a2", "completed").is_err());
    }
    #[test]
    fn backwards_wall_clock_does_not_corrupt_team_transitions() {
        let (repo, mut work) = fixture();
        work["team"]["configuredAt"] = json!("2099-01-01T00:00:00.000Z");
        task(repo.path(), &mut work, "build", "src", "write", &[]);
        begin(repo.path(), &mut work, "build", "worker", "a1").unwrap();
        finish(repo.path(), &mut work, "build", "a1", "completed").unwrap();
        prove(repo.path(), &mut work);
        decide(repo.path(), &mut work, "build", "reject").unwrap();
        retry(
            repo.path(),
            &mut work,
            &args(&[
                "--task",
                "build",
                "--attempt",
                "a1",
                "--reason",
                "Inspect changed result",
            ]),
        )
        .unwrap();
        begin(repo.path(), &mut work, "build", "worker", "a2").unwrap();
        assert_eq!(
            latest(&tasks(&work)[0])["claimedAt"],
            "2099-01-01T00:00:00.000Z"
        );
        validate(&work).unwrap();
    }
}
