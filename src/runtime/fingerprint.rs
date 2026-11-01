use super::{
    contract,
    state::{b, s},
    store,
};
use crate::support::{Error, Result, sha256};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::MetadataExt,
    },
    path::{Path, PathBuf},
    process::Command,
};
fn git(cwd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let o = Command::new("/usr/bin/git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()?;
    if !o.status.success() {
        return Err(Error::new(
            "source_fingerprint_failed",
            String::from_utf8_lossy(&o.stderr).trim(),
        ));
    }
    if o.stdout.len() > 64 * 1024 * 1024 {
        return Err(Error::new("source_fingerprint_failed", "Git output limit"));
    }
    Ok(o.stdout)
}
fn root(cwd: &Path) -> Result<PathBuf> {
    let r = git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
    )?;
    let r = String::from_utf8_lossy(&r);
    Ok(PathBuf::from(
        r.trim_end_matches('\n').trim_end_matches('\r'),
    ))
}
fn excluded(p: &[u8]) -> bool {
    p == b".gdm.lock" || p == b".gdm" || p.starts_with(b".gdm/")
}
fn nul(b: &[u8]) -> Result<Vec<Vec<u8>>> {
    if !b.is_empty() && b.last() != Some(&0) {
        return Err(Error::new("source_fingerprint_failed", "Git NUL format"));
    }
    Ok(b.split(|c| *c == 0)
        .filter(|p| !p.is_empty())
        .map(|p| p.to_vec())
        .collect())
}
pub fn current_position(cwd: &Path) -> Result<Option<(String, String)>> {
    let Ok(head) = git(cwd, &["rev-parse", "HEAD"]) else {
        return Ok(None);
    };
    let Ok(branch) = git(cwd, &["branch", "--show-current"]) else {
        return Ok(None);
    };
    let head = String::from_utf8_lossy(&head).trim().to_lowercase();
    let branch = String::from_utf8_lossy(&branch).trim().to_owned();
    if head.is_empty() || branch.is_empty() {
        return Ok(None);
    }
    Ok(Some((head, branch)))
}
pub fn capture_workspace(cwd: &Path) -> Result<Value> {
    let Ok(root) = root(cwd) else {
        return Ok(Value::Null);
    };
    let head = git(&root, &["rev-parse", "HEAD"])
        .ok()
        .map(|v| String::from_utf8_lossy(&v).trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or("unborn".into());
    let Ok(list) = git(
        &root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    ) else {
        return Ok(Value::Null);
    };
    let mut paths = nul(&list)?;
    paths.sort();
    let mut all = vec![];
    let mut files = vec![];
    for p in paths {
        if excluded(&p) {
            continue;
        }
        let name = String::from_utf8_lossy(&p).into_owned();
        if name.split('/').any(|x| x == "..") {
            continue;
        }
        let path = root.join(OsString::from_vec(p));
        let mut bytes = format!("path\0{name}\0").into_bytes();
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => {
                bytes.extend(b"symlink\0");
                bytes.extend(fs::read_link(&path)?.as_os_str().as_bytes());
                bytes.push(0)
            }
            Ok(m) if m.is_file() => {
                bytes.extend(
                    format!(
                        "file\0{}\0",
                        if m.mode() & 0o111 != 0 {
                            "executable"
                        } else {
                            "regular"
                        }
                    )
                    .as_bytes(),
                );
                bytes.extend(fs::read(&path)?);
            }
            Err(_) => bytes.extend(b"deleted\0"),
            _ => {}
        }
        all.extend(&bytes);
        files.push(json!({"path":name,"sha256":sha256(bytes)}));
    }
    Ok(json!({"kind":"git","head":head,"sha256":sha256(all),"files":files}))
}
fn count(b: &mut Vec<u8>, n: u64) {
    b.extend(n.to_be_bytes())
}
fn bytes(b: &mut Vec<u8>, s: &[u8]) {
    count(b, s.len() as u64);
    b.extend(s)
}
pub fn capture_source(cwd: &Path) -> Result<Value> {
    let root = root(cwd)?;
    let excludes = [
        "--",
        ".",
        ":(exclude).gdm",
        ":(exclude).gdm/**",
        ":(exclude).gdm.lock",
    ];
    let list = git(
        &root,
        &[
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ][..],
            &excludes,
        ]
        .concat(),
    )?;
    let index = git(
        &root,
        &[&["ls-files", "--stage", "-z"][..], &excludes].concat(),
    )?;
    let status = git(
        &root,
        &[
            &["status", "--porcelain=v2", "-z", "--untracked-files=all"][..],
            &excludes,
        ]
        .concat(),
    )?;
    let mut paths = nul(&list)?
        .into_iter()
        .filter(|p| !excluded(p))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    let mut buffer = vec![];
    bytes(&mut buffer, b"gidem-source-fingerprint-v1");
    bytes(&mut buffer, &index);
    bytes(&mut buffer, &status);
    count(&mut buffer, paths.len() as u64);
    for p in &paths {
        if p.first() == Some(&b'/')
            || p.split(|c| *c == b'/')
                .any(|s| s.is_empty() || s == b"." || s == b"..")
        {
            return Err(Error::new("source_fingerprint_failed", "unsafe Git path"));
        }
        bytes(&mut buffer, p);
        let path = root.join(OsString::from_vec(p.clone()));
        match fs::symlink_metadata(&path) {
            Ok(m) => {
                let kind = if m.file_type().is_symlink() {
                    "symlink"
                } else if m.is_file() {
                    "file"
                } else if m.is_dir() {
                    "directory"
                } else {
                    "other"
                };
                bytes(&mut buffer, kind.as_bytes());
                count(&mut buffer, u64::from(m.mode() & 0o7777));
                if kind == "symlink" {
                    bytes(&mut buffer, fs::read_link(path)?.as_os_str().as_bytes());
                } else if kind == "file" {
                    bytes(&mut buffer, &fs::read(path)?);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => bytes(&mut buffer, b"deleted"),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(json!({"schemaVersion":1,"sha256":sha256(buffer),"fileCount":paths.len()}))
}
pub fn scope_problems(w: &Value, current: &Value) -> Vec<Value> {
    let Some(base) = w.get("baseline") else {
        return vec![];
    };
    let allowed = w["contract"]["allowedPaths"]
        .as_array()
        .cloned()
        .unwrap_or(vec![json!(".")]);
    let forbidden = w["contract"]["forbiddenPaths"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let unrestricted = allowed.contains(&json!(".")) && forbidden.is_empty();
    if base.is_null() || current.is_null() {
        return if unrestricted {
            vec![]
        } else {
            vec![json!({"path":"(workspace)","reason":"unverifiable"})]
        };
    }
    let Some(before) = base["files"].as_array() else {
        return if base["sha256"] == current["sha256"] {
            vec![]
        } else {
            vec![json!({"path":"(workspace)","reason":"unverifiable"})]
        };
    };
    let Some(after) = current["files"].as_array() else {
        return vec![json!({"path":"(workspace)","reason":"unverifiable"})];
    };
    let map = |values: &Vec<Value>| {
        values
            .iter()
            .map(|v| (s(&v["path"]).to_owned(), s(&v["sha256"]).to_owned()))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let before = map(before);
    let after = map(after);
    let mut paths = before
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter(|p| before.get(p) != after.get(p))
        .filter_map(|p| {
            let reason = if forbidden.iter().any(|f| contract::matches(&p, s(f))) {
                "forbidden"
            } else if !allowed.iter().any(|f| contract::matches(&p, s(f))) {
                "outside-allowed"
            } else {
                return None;
            };
            Some(json!({"path":p,"reason":reason}))
        })
        .collect()
}
pub fn audit_problems(cwd: &Path, w: &Value) -> Result<Vec<String>> {
    let a = &w["audit"];
    let mut errors = vec![];
    if s(&a["reportSha256"]).is_empty() {
        errors.push(
            crate::i18n::text(
                "검수보고 해시가 없습니다",
                "The audit report hash is missing",
            )
            .into(),
        )
    } else {
        match store::contained(cwd, s(&a["report"]), "report", usize::MAX / 2) {
            Ok(v) if sha256(&v) == s(&a["reportSha256"]) => {}
            Ok(_) => errors.push(
                crate::i18n::text(
                    "검수보고가 판정 후 변경됐습니다",
                    "The audit report changed after the verdict",
                )
                .into(),
            ),
            Err(_) => errors.push(
                crate::i18n::text(
                    "검수보고를 안전하게 읽을 수 없습니다",
                    "The audit report cannot be read safely",
                )
                .into(),
            ),
        }
    }
    if s(&a["implementationModel"]).is_empty() || s(&a["auditModel"]).is_empty() {
        errors.push(
            crate::i18n::text(
                "구현 모델 또는 검수 모델 기록이 없습니다",
                "The implementation or audit model is not recorded",
            )
            .into(),
        )
    } else {
        let models = a
            .get("implementationModels")
            .and_then(Value::as_array)
            .map(|values| values.iter().map(|v| s(v).to_owned()).collect::<Vec<_>>())
            .unwrap_or_else(|| vec![s(&a["implementationModel"]).to_owned()]);
        if let Err(error) = validate_audit_models(cwd, w, &models, s(&a["auditModel"])) {
            errors.push(error.to_string());
        }
    }
    match a.get("workspace") {
        None => errors.push(
            crate::i18n::text(
                "검수 시점 워크트리 지문이 없습니다",
                "The worktree fingerprint at audit time is missing",
            )
            .into(),
        ),
        Some(v) if !v.is_null() => {
            let current = capture_workspace(cwd)?;
            if current.is_null() || current["sha256"] != v["sha256"] {
                errors.push(
                    crate::i18n::text(
                        "검수 후 워크트리 내용이 변경됐습니다",
                        "The worktree changed after the audit",
                    )
                    .into(),
                )
            }
        }
        _ => {}
    }
    Ok(errors)
}
/// Declared model attribution is not remote identity attestation. New adaptive
/// attempts additionally bind the declaration to the immutable selected route.
pub(crate) fn validate_audit_models(
    cwd: &Path,
    work: &Value,
    models: &[String],
    audit: &str,
) -> Result<()> {
    let normalized: std::collections::BTreeSet<_> =
        models.iter().map(|m| m.to_lowercase()).collect();
    if models.is_empty() || models.len() > 64 || normalized.len() != models.len() {
        return Err(Error::new(
            "audit_model_mismatch",
            "Declare each implementation model once",
        ));
    }
    if normalized.contains(&audit.to_lowercase()) {
        return Err(Error::new(
            "audit_independence",
            crate::i18n::text(
                "구현 모델과 검수 모델은 달라야 합니다",
                "The implementation and audit models must differ",
            ),
        ));
    }
    let (recorded, unknown) = super::team::implementation_models(cwd, work)?;
    if recorded
        .iter()
        .any(|m| !normalized.contains(&m.to_lowercase()))
    {
        return Err(Error::new(
            "audit_model_mismatch",
            "Audit must include every recorded implementation model",
        ));
    }
    if unknown && work["team"]["allocation"]["request"]["input"]["promptVersion"] == 3 {
        return Err(Error::new(
            "audit_model_unknown",
            "Adaptive implementation history has unknown model attribution",
        ));
    }
    Ok(())
}

pub fn audit_state(cwd: &Path, w: &Value) -> Result<String> {
    if !b(&w["auditRequired"]) && w["contract"]["risk"] != "high" {
        return Ok("".into());
    }
    Ok(if w.get("audit").is_none() {
        crate::i18n::text("검수: 필요 (미실시)", "Audit: required (not yet performed)")
    } else if w["audit"]["result"] == "fail" {
        crate::i18n::text("검수: 반려", "Audit: rejected")
    } else if s(&w["audit"]["stateHash"]) != super::state::checks_hash(w) {
        crate::i18n::text(
            "검수: 무효 (상태 변경됨, 재검수 필요)",
            "Audit: invalid (state changed; audit again)",
        )
    } else if audit_problems(cwd, w)?.is_empty() {
        crate::i18n::text("검수: 통과", "Audit: passed")
    } else {
        crate::i18n::text(
            "검수: 무효 (보고서 또는 워크트리 변경됨, 재검수 필요)",
            "Audit: invalid (report or worktree changed; audit again)",
        )
    }
    .into())
}

pub fn describe_scope(problems: &[Value]) -> String {
    let detail = problems
        .iter()
        .map(|p| format!("{}({})", s(&p["path"]), s(&p["reason"])))
        .collect::<Vec<_>>()
        .join(", ");
    let mut recovery = vec![];
    if problems.iter().any(|p| p["reason"] == "outside-allowed") {
        recovery.push(crate::i18n::text(
            "범위 확장: gdm plan contract --allow-path <경로> --reason <사유>",
            "Expand scope: gdm plan contract --allow-path <path> --reason <reason>",
        ))
    }
    if problems.iter().any(|p| p["reason"] == "forbidden") {
        recovery.push(crate::i18n::text(
            "금지 해제: gdm plan contract --remove-forbid-path <경로> --reason <사유>",
            "Remove restriction: gdm plan contract --remove-forbid-path <path> --reason <reason>",
        ))
    }
    if problems.iter().any(|p| p["reason"] == "unverifiable") {
        recovery.push(crate::i18n::text(
            "Git 저장소에서 다시 plan init하거나 경로 제한을 명시적으로 해제",
            "Run plan init again in a Git repository or explicitly remove the path restriction",
        ))
    }
    crate::lfmt!(
        "변경 범위 계약 위반: {detail}. {}",
        "Change scope violates the contract: {detail}. {}",
        recovery.join(" · ")
    )
}

#[cfg(test)]
mod model_tests {
    use super::*;

    #[test]
    fn audit_covers_all_declared_writers() {
        let directory = tempfile::tempdir().unwrap();
        let work = json!({"team":{"tasks":[
            {"access":"write","attempts":[{"execution":{"model":"writer-a"}}]},
            {"access":"write","attempts":[{"execution":{"model":"writer-b"}}]},
            {"access":"read","attempts":[{"execution":{"model":"reader"}}]}
        ]}});
        let all = vec!["writer-a".to_owned(), "writer-b".to_owned()];
        assert!(validate_audit_models(directory.path(), &work, &all, "reader").is_ok());
        assert!(validate_audit_models(directory.path(), &work, &all[..1], "reader").is_err());
        assert!(validate_audit_models(directory.path(), &work, &all, "WRITER-B").is_err());
    }
}
