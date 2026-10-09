use super::ledger;
use crate::support::{Error, Result, has_flag, print_json, required_flag};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::Path,
    process::Command,
    time::Duration,
};
const HANDLER: &str = "gdm-agent-gate-v1";
const EVENTS: [&str; 5] = [
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];
const MATCHER: &str = r"^(Agent|spawn_agent|collaborationspawn_agent|collaboration\.spawn_agent|[A-Za-z0-9_-]{1,64}spawn_agent)$";
fn err(s: impl Into<String>) -> Error {
    Error::new("agent_hooks_config_invalid", s)
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn regular(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err(err(format!(
            "path is not a regular file: {}",
            path.display()
        )));
    }
    Ok(())
}
fn read(path: &Path) -> Result<(Vec<u8>, Value)> {
    if fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Ok((vec![], json!({})));
    }
    regular(path)?;
    let b = fs::read(path)?;
    let v: Value = serde_json::from_slice(&b)?;
    if !v.is_object() || v.get("hooks").is_some_and(|h| !h.is_object()) {
        return Err(err(
            "Codex hooks config must be an object with hooks object",
        ));
    }
    Ok((b, v))
}
fn command(binary: &str) -> Result<String> {
    if binary.contains(['\n', '\r']) || !Path::new(binary).is_absolute() {
        return Err(err(
            "hook executable must have an absolute single-line path",
        ));
    }
    Ok(format!(
        "'{}' agent hook --handler-id {HANDLER}",
        binary.replace('\'', "'\"'\"'")
    ))
}
fn extract(command_text: &str) -> Option<String> {
    let text = command_text.strip_suffix(&format!(" agent hook --handler-id {HANDLER}"))?;
    let body = text.strip_prefix('\'')?.strip_suffix('\'')?;
    let decoded = body.replace("'\"'\"'", "'");
    (command(&decoded).ok().as_deref() == Some(command_text)).then_some(decoded)
}
fn managed(h: &Value) -> bool {
    regex::Regex::new(r#"(?:^|\s)--handler-id(?:=|\s+)(?:['"])?gdm-agent-gate-v1(?:['"])?(?:\s|$)"#)
        .unwrap()
        .is_match(s(h, "command"))
}

fn executable(path: &str) -> bool {
    Path::new(path).is_absolute()
        && fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}
pub fn feature(cwd: &Path) -> Result<Value> {
    let path = ledger::home(cwd)?.join("config.toml");
    let mut out =
        json!({"state":"default-enabled","configPath":path,"inlineHooksConfigured":false});
    let invalid = |mut out: Value, kind: &str, message: &str| {
        out["state"] = json!("invalid");
        out["invalidKind"] = json!(kind);
        out["invalidMessage"] = json!(message);
        out
    };
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Ok(invalid(out, "read", &e.to_string())),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
            return Ok(invalid(
                out,
                "path",
                "config.toml path is not a regular file",
            ));
        }
        Ok(_) => {}
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => return Ok(invalid(out, "read", &e.to_string())),
    };
    let doc = match text.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(e) => return Ok(invalid(out, "parse", &e.to_string())),
    };
    let inline = doc.get("hooks");
    out["inlineHooksConfigured"] = json!(inline.is_some());
    let features = doc.get("features");
    if inline.is_some_and(|v| !v.is_table_like()) || features.is_some_and(|v| !v.is_table_like()) {
        return Ok(invalid(
            out,
            "shape",
            "config.toml hooks or features must be TOML tables",
        ));
    }
    if let Some(features) = features.and_then(|v| v.as_table_like()) {
        let a = features.get("hooks");
        let b = features.get("codex_hooks");
        if a.is_some() && b.is_some() {
            return Ok(invalid(
                out,
                "conflict",
                "hooks and deprecated codex_hooks cannot both be configured",
            ));
        }
        if let Some(value) = a.or(b) {
            if let Some(enabled) = value.as_bool() {
                out["state"] = json!(if enabled { "enabled" } else { "disabled" });
            } else {
                return Ok(invalid(out, "shape", "hooks feature must be true or false"));
            }
        }
    }
    Ok(out)
}
fn groups<'a>(config: &'a Value, event: &str) -> Result<Vec<&'a Value>> {
    let Some(value) = config["hooks"].get(event) else {
        return Ok(vec![]);
    };
    let groups = value
        .as_array()
        .ok_or_else(|| err(format!("{event} must be an array")))?;
    for g in groups {
        if !g.is_object() || !g["hooks"].is_array() {
            return Err(err(format!("{event} matcher group is invalid")));
        }
    }
    Ok(groups.iter().collect())
}
fn hook_status(cwd: &Path, config: &Value, exists: bool, current: Option<&str>) -> Result<Value> {
    let home = ledger::home(cwd)?;
    let mut installed = vec![];
    let mut missing = vec![];
    let mut duplicate = vec![];
    let mut invalid = vec![];
    let mut commands = vec![];
    let mut paths = vec![];
    for event in EVENTS {
        let mut candidates = vec![];
        for g in groups(config, event)? {
            for h in g["hooks"].as_array().unwrap() {
                if managed(h) {
                    candidates.push((g, h));
                }
            }
        }
        match candidates.as_slice() {
            [] => missing.push(event),
            [(g, h)] => {
                if let Some(command) = h["command"].as_str() {
                    commands.push(command.to_owned());
                }
                let path = extract(s(h, "command"));
                if let Some(p) = &path {
                    paths.push(p.clone());
                }
                let matcher = if ["PreToolUse", "PostToolUse"].contains(&event) {
                    g["matcher"] == MATCHER
                } else {
                    g.get("matcher").is_none()
                };
                if h["type"] == "command" && path.is_some() && h["timeout"] == 10 && matcher {
                    installed.push(event)
                } else {
                    invalid.push(event)
                }
            }
            _ => duplicate.push(event),
        }
    }
    let consistent = commands.len() == 5 && commands.iter().all(|c| c == &commands[0]);
    let configured = installed.len() == 5
        && consistent
        && missing.is_empty()
        && duplicate.is_empty()
        && invalid.is_empty();
    let path = if configured && paths.len() == 5 && paths.iter().all(|p| p == &paths[0]) {
        Some(paths[0].clone())
    } else {
        None
    };
    let exe = path.as_ref().is_some_and(|p| executable(p));
    let matches = current.map(|c| {
        path.as_ref().is_some_and(|p| {
            p == c
                || fs::canonicalize(p)
                    .ok()
                    .zip(fs::canonicalize(c).ok())
                    .is_some_and(|(a, b)| a == b)
        })
    });
    let feature = feature(cwd)?;
    Ok(
        json!({"schemaVersion":1,"configPath":home.join("hooks.json"),"backupPath":home.join("hooks.json.gdm-backup"),"handlerId":HANDLER,"configExists":exists,"configured":configured,"executable":configured&&exe,"executablePath":path,"executableError":if configured&&!exe{Some("hook executable is unavailable")}else{None},"currentExecutablePath":current,"matchesCurrentExecutable":matches,"inlineHooksConfigured":feature["inlineHooksConfigured"],"multipleSources":exists&&feature["inlineHooksConfigured"]==true,"installed":configured&&exe&&matches!=Some(false),"installedEvents":installed,"missingEvents":missing,"duplicateEvents":duplicate,"invalidEvents":invalid,"commandsConsistent":consistent,"command":commands.first()}),
    )
}
pub fn status(cwd: &Path) -> Result<Value> {
    let path = ledger::home(cwd)?.join("hooks.json");
    let (_, config) = read(&path)?;
    let current = std::env::current_exe()?;
    let hooks = hook_status(cwd, &config, path.exists(), current.to_str())?;
    let feature = feature(cwd)?;
    let effective = if hooks["configured"] != true {
        "not-configured"
    } else if hooks["executable"] != true {
        "not-executable"
    } else if hooks["matchesCurrentExecutable"] == false {
        "executable-drift"
    } else if feature["state"] == "disabled" {
        "disabled"
    } else if feature["state"] == "invalid" {
        "invalid-feature"
    } else {
        "unverified"
    };
    Ok(
        json!({"schemaVersion":1,"installed":hooks["installed"],"configured":hooks["configured"],"executable":hooks["executable"],"feature":feature,"trust":"unknown","effective":effective,"hooks":hooks,"ledgers":ledger::summary(cwd)?}),
    )
}
fn probe(binary: &str) -> Result<()> {
    if !executable(binary) {
        return Err(Error::new(
            "agent_hooks_binary_invalid",
            crate::i18n::text(
                "hook 실행 파일을 확인할 수 없거나 실행 권한이 없습니다",
                "The hook executable is missing or not executable",
            ),
        ));
    }
    let mut command = Command::new(binary);
    command.args(["agent", "hook", "--handler-id", HANDLER]);
    let output = crate::computer_use::process::capture(command,
        br#"{"session_id":"gdm-hook-install-probe","hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"gdm-hook-install-probe","tool_input":{}}"#.to_vec(),
        Duration::from_secs(3), 64 * 1024).map_err(|e| Error::new("agent_hooks_binary_invalid", crate::lfmt!("hook 실행 파일 프로토콜 검증 실패: {}", "Hook executable protocol validation failed: {}", e.message)))?;
    let expected =
        json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}});
    if output.code != 0
        || !output.stderr.is_empty()
        || serde_json::from_slice::<Value>(&output.stdout).ok() != Some(expected)
    {
        return Err(Error::new(
            "agent_hooks_binary_invalid",
            crate::i18n::text(
                "hook 실행 파일이 gdm agent hook 프로토콜 검증에 실패했습니다",
                "The hook executable failed gdm agent hook protocol validation",
            ),
        ));
    }
    Ok(())
}

pub fn install(cwd: &Path, args: &[String]) -> Result<()> {
    crate::support::ensure_flags(args, &["binary"], &["json", "dry-run"])?;
    for flag in ["--binary", "--json", "--dry-run"] {
        if args.iter().filter(|s| s.as_str() == flag).count() > 1 {
            return Err(err("duplicate install flag"));
        }
    }
    let binary = required_flag(args, "binary")?;
    probe(&binary)?;
    let feature = feature(cwd)?;
    if feature["state"] == "invalid" {
        return Err(err("Codex hooks feature configuration is invalid"));
    }
    let dry = has_flag(args, "dry-run");
    let home = ledger::home(cwd)?;
    let path = home.join("hooks.json");
    let backup = home.join("hooks.json.gdm-backup");
    if let Ok(m) = fs::symlink_metadata(&home)
        && (!m.is_dir() || m.file_type().is_symlink())
    {
        return Err(err(
            "Codex configuration directory is not a regular directory",
        ));
    }
    if fs::symlink_metadata(&backup).is_ok() {
        regular(&backup)?;
    }
    let lock = if dry {
        None
    } else {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&home)?;
        let f = super::lock::acquire(&home.join("hooks.json.gdm-lock"), false)?;
        Some(f)
    };
    let (before, mut config) = read(&path)?;
    let existed = path.exists();
    if config.get("hooks").is_none() {
        config["hooks"] = json!({});
    }
    for (index, event) in EVENTS.iter().enumerate() {
        let mut keep = vec![];
        for group in groups(&config, event)? {
            let mut next = group.clone();
            let handlers: Vec<_> = group["hooks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|h| !managed(h))
                .cloned()
                .collect();
            if !handlers.is_empty() {
                next["hooks"] = json!(handlers);
                keep.push(next);
            }
        }
        let statuses = [
            "Checking delegated agent envelope",
            "Reconciling delegated agent spawn",
            "Recording delegated agent start",
            "Recording delegated agent stop",
            "Checking delegated agent completion",
        ];
        let mut next = json!({"hooks":[{"type":"command","command":command(&binary)?,"timeout":10,"statusMessage":statuses[index]}]});
        if index < 2 {
            next["matcher"] = json!(MATCHER);
        }
        keep.push(next);
        config["hooks"][*event] = json!(keep);
    }
    let bytes = format!("{}\n", serde_json::to_string_pretty(&config)?).into_bytes();
    let changed = bytes != before;
    let mut backup_created = false;
    if changed && !dry {
        let unchanged = || -> Result<()> {
            if read(&path)?.0 != before || path.exists() != existed {
                return Err(Error::new(
                    "agent_hooks_config_drift",
                    "Codex hooks changed while installing",
                ));
            }
            Ok(())
        };
        unchanged()?;
        if existed && !backup.exists() {
            let mut prepared = tempfile::Builder::new()
                .prefix(".hooks-backup.")
                .tempfile_in(&home)?;
            prepared.write_all(&before)?;
            prepared.as_file().sync_all()?;
            match fs::hard_link(prepared.path(), &backup) {
                Ok(()) => backup_created = true,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => regular(&backup)?,
                Err(e) => return Err(e.into()),
            }
        }
        let mode = if existed {
            fs::metadata(&path)?.permissions().mode() & 0o777
        } else {
            0o600
        };
        let mut temp = tempfile::Builder::new()
            .prefix(".hooks.")
            .tempfile_in(&home)?;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(mode))?;
        temp.write_all(&bytes)?;
        temp.as_file().sync_all()?;
        unchanged()?;
        fs::rename(temp.path(), &path)?;
        if let Ok(directory) = fs::File::open(&home) {
            let _ = directory.sync_all();
        }
    }
    let mut result = hook_status(cwd, &config, true, Some(&binary))?;
    result["changed"] = json!(changed);
    result["backupCreated"] = json!(backup_created);
    result["dryRun"] = json!(dry);
    drop(lock);
    if has_flag(args, "json") {
        print_json(&result)
    } else {
        println!(
            "Codex agent hooks {}: {}",
            if dry {
                crate::i18n::text("사전검증 완료", "Preflight passed")
            } else if changed {
                crate::i18n::text("설치 완료", "Installed")
            } else {
                crate::i18n::text("변경 없음", "Unchanged")
            },
            path.display()
        );
        Ok(())
    }
}

pub fn doctor_lines(cwd: &Path) -> Vec<String> {
    let status = match status(cwd) {
        Ok(v) => v,
        Err(e) => {
            return vec![
                crate::i18n::text(
                    "  Codex 에이전트 게이트: 설정 오류",
                    "  Codex agent gate: invalid settings",
                )
                .into(),
                format!("  → {}", e.message),
            ];
        }
    };
    let hooks = &status["hooks"];
    let feature = &status["feature"];
    let mut lines = if hooks["configured"] != true {
        vec![
            crate::i18n::text(
                "  Codex 에이전트 게이트: 미설치 또는 설정 불완전",
                "  Codex agent gate: not installed or incomplete settings",
            )
            .into(),
            crate::i18n::text(
                "  → gdm agent hook-install --binary <gdm 절대경로>",
                "  → gdm agent hook-install --binary <absolute-gdm-path>",
            )
            .into(),
        ]
    } else if hooks["executable"] != true {
        vec![
            crate::i18n::text(
                "  Codex 에이전트 게이트: 설정됨, 실행 파일 사용 불가",
                "  Codex agent gate: configured but executable unavailable",
            )
            .into(),
            format!("  → {}", s(hooks, "executableError")),
        ]
    } else if hooks["matchesCurrentExecutable"] == false {
        vec![
            crate::i18n::text(
                "  Codex 에이전트 게이트: 실행 파일 드리프트",
                "  Codex agent gate: executable drift",
            )
            .into(),
            format!("  → handler: {}", s(hooks, "executablePath")),
            crate::lfmt!(
                "  → 현재 gdm: {}",
                "  → Current gdm: {}",
                s(hooks, "currentExecutablePath")
            ),
            crate::i18n::text(
                "  → 현재 gdm으로 hook-install을 다시 실행하세요",
                "  → Run hook-install again with the current gdm",
            )
            .into(),
        ]
    } else if feature["state"] == "disabled" {
        vec![
            crate::i18n::text(
                "  Codex 에이전트 게이트: 비활성화",
                "  Codex agent gate: disabled",
            )
            .into(),
            crate::lfmt!(
                "  → {}에 [features] hooks = true를 설정하세요",
                "  → Set [features] hooks = true in {}",
                s(feature, "configPath")
            ),
        ]
    } else if feature["state"] == "invalid" {
        vec![
            crate::i18n::text(
                "  Codex 에이전트 게이트: hooks 기능 설정 오류",
                "  Codex agent gate: invalid hooks feature setting",
            )
            .into(),
            format!("  → {}", s(feature, "invalidMessage")),
        ]
    } else {
        let desc = if feature["state"] == "enabled" {
            crate::i18n::text("사용자 설정 활성", "Enabled in user settings")
        } else {
            crate::i18n::text(
                "명시 설정 없음 · 기본값 활성",
                "No explicit setting · Enabled by default",
            )
        };
        vec![crate::lfmt!("  Codex 에이전트 게이트: 설치됨 (설정 완료 · 실행 가능 · {desc}, 현재 세션 유효값 미확인)", "  Codex agent gate: installed (configured · executable · {desc}; effective session value unverified)"),crate::i18n::text("  → profile·project·CLI·requirements override가 가능하므로 /debug-config에서 유효 features.hooks를 확인하세요", "  → Inspect effective features.hooks in /debug-config; profile, project, CLI or requirements may override it").into(),crate::i18n::text("  → Codex /hooks에서 현재 handler를 검토하고 신뢰해야 실제로 실행됩니다", "  → Review and trust the current handler in Codex /hooks before it can run").into()]
    };
    if hooks["multipleSources"] == true {
        lines.push(crate::i18n::text("  → 경고: 같은 Codex 설정 계층에 hooks.json과 inline [hooks]가 함께 있어 둘 다 로드됩니다", "  → Warning: hooks.json and inline [hooks] coexist in the same Codex configuration layer; both are loaded").into());
    }
    lines
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_shell_quote_roundtrip() {
        let path = "/tmp/it's gdm";
        assert_eq!(extract(&command(path).unwrap()), Some(path.into()));
        assert!(extract("/tmp/gdm agent hook --handler-id gdm-agent-gate-v1; bad").is_none());
    }
    #[test]
    fn managed_marker_boundary() {
        assert!(managed(
            &json!({"command":"gdm agent hook --handler-id gdm-agent-gate-v1"})
        ));
        assert!(!managed(
            &json!({"command":"gdm agent hook --handler-id gdm-agent-gate-v1-other"})
        ));
    }
}
