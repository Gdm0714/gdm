//! Local, provider-free request entry. The conversation model supplies semantics.
use crate::{
    runtime::{state, store},
    support::{Error, Result, has_flag, print_json, required_flag, sha256},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
const HANDLER: &str = "gdm-entry-v1";
const LIMIT: usize = 65536;
fn bad(message: impl Into<String>) -> Error {
    Error::new("entry_invalid", message)
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn target(args: &[String]) -> Result<String> {
    let t = required_flag(args, "target")?;
    if !["codex", "claude", "gid"].contains(&t.as_str()) {
        return Err(bad("unsupported entry target"));
    }
    Ok(t)
}
fn identity(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 256 || id.chars().any(|c| c.is_control()) {
        return Err(bad("missing or invalid host identity"));
    }
    Ok(())
}
fn state_path(cwd: &Path, target: &str, session: &str, create: bool) -> Result<PathBuf> {
    identity(session)?;
    let root = cwd.join(".gdm");
    let dir = root.join(".entry");
    if create {
        store::ensure_dir(&root)?;
        store::ensure_dir(&dir)?;
    } else {
        store::inspect(&root, true)?;
        store::inspect(&dir, true)?;
    }
    Ok(dir.join(format!(
        "{}.json",
        sha256(format!(
            "{target}\0{}\0{session}",
            cwd.canonicalize()?.display()
        ))
    )))
}
fn blank(target: &str, session: &str) -> Value {
    json!({"schemaVersion":"gdm-entry/v1","target":target,"sessionId":session,"requestId":null,"kind":null,"slug":null,"activeWorkSlug":null,"enforcement":if target=="gid" {"advisory"}else{"recognized-edit-and-bounded-stop"},"stopCorrections":0,"recentEvents":[]})
}
fn load(path: &Path, target: &str, session: &str) -> Result<Value> {
    if !store::inspect(path, false)? {
        return Ok(blank(target, session));
    }
    let v: Value = serde_json::from_slice(&store::read_regular(path, LIMIT as u64)?)?;
    if v["schemaVersion"] != "gdm-entry/v1"
        || v["target"] != target
        || v["sessionId"] != session
        || !v["recentEvents"].is_array()
    {
        return Err(bad("entry state identity or schema mismatch"));
    }
    Ok(v)
}
fn active(cwd: &Path, v: &Value) -> Result<bool> {
    match v["activeWorkSlug"].as_str() {
        Some(slug) => Ok(store::load(cwd, slug)?["done"] != true),
        None => Ok(false),
    }
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}
fn guidance(v: &Value) -> String {
    let base = format!(
        "gdm entry decide --target {} --session {} --request {}",
        text(v, "target"),
        quote(text(v, "sessionId")),
        quote(text(v, "requestId"))
    );
    format!(
        "GDM_AUTOMATIC_ENTRY_V1\nTarget: {}; genuine session: {}; request token: {}.\nThe current conversation model must classify the original request. For implementation/fix use `{base} --kind work --json`; inquiry/explanation use `{base} --kind question --json`; explicit user opt-out use `{base} --kind optout --json`. This local declaration never calls a model. Preserve the original request and user permissions. Read-only discovery is allowed. Questions need no Work or planner. Opt-out is request-scoped and preserves pending Work.\nFor work, use installed gdm-go (gdm-full only when requested/required): inspect, gdm plan init with original requirements and real checks, then repeat `{base} --kind work --slug <existing-work> --json`. Resume active Work {:?} via gdm status/team next; do not create duplicate Work or rerun a planner on every event. Follow existing gdm team auto --from-request with actual capabilities and free capacity; it chooses single/coordinated. Claim before actual host native spawn, collect/report/review results, and complete checks/audit/done before final completion. Never invent executors, model capabilities, worker success or GDM acceptance. If executor unavailable, report/replan explicitly. Native leaf workers must not initialize root entry. No nested paid classifier/planner from hooks.\nLimits: gid entry is context-only; Codex/Claude gates cover recognized direct edit tools and one Stop correction per request; opaque shell/MCP mutations are not classified. Claude has no guaranteed event identity; identical prompt replay after a decision may be a new request. Installation does not prove hooks enabled/trusted in this session.",
        text(v, "target"),
        text(v, "sessionId"),
        text(v, "requestId"),
        v["activeWorkSlug"]
    )
}
fn context(target: &str, event: &str, message: String) -> Value {
    if target == "gid" {
        json!({"context_note":message})
    } else {
        json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":message}})
    }
}
pub fn hook(cwd: &Path, target: &str, input: &str) -> Result<Value> {
    if std::env::var("GDM_ENTRY_DISABLED").ok().as_deref() == Some("1") {
        return Ok(json!({}));
    }
    if input.len() > LIMIT {
        return Err(bad("entry input exceeds 64 KiB"));
    }
    let event: Value = serde_json::from_str(input)?;
    if !event.is_object() {
        return Err(bad("host envelope must be an object"));
    }
    let gid = target == "gid";
    let name = if gid {
        text(&event["handler"], "event")
    } else {
        text(&event, "hook_event_name")
    };
    let allowed = if gid {
        ["input", "before_turn", "tool_call", "turn_end"].as_slice()
    } else {
        ["UserPromptSubmit", "PreToolUse", "Stop"].as_slice()
    };
    if !allowed.contains(&name) {
        return Err(bad("unsupported entry event"));
    }
    if gid
        && (event["schema"] != "gid-extension-event/v1"
            && event["schemaVersion"] != "gid-extension-event/v1")
    {
        return Err(bad("invalid gid envelope schema"));
    }
    if target == "codex"
        && event
            .get("agent_id")
            .is_some_and(|v| !v.is_null() && v.as_str() != Some(""))
    {
        return Ok(json!({}));
    }
    // No invented Claude/gid worker marker: hosts without worker identity remain advisory here.
    let session = text(&event, "session_id");
    identity(session)?;
    let project = text(&event, "cwd");
    if project.is_empty() || Path::new(project).canonicalize()? != cwd.canonicalize()? {
        return Err(bad("host cwd does not match invocation cwd"));
    }
    let request_event = name == "UserPromptSubmit" || name == "input";
    let path = state_path(cwd, target, session, request_event)?;
    if !request_event && !path.exists() {
        return Ok(json!({}));
    }
    let _lock = super::agent::lock::acquire(&path.with_extension("lock"), false)?;
    let mut v = load(&path, target, session)?;
    if request_event {
        let prompt = if gid {
            {
                let message = &event["payload"]["message"];
                if message["role"] != "user" {
                    return Err(bad("gid input must contain original user message"));
                }
                text(message, "text")
            }
        } else {
            text(&event, "prompt")
        };
        if prompt.is_empty() {
            return Err(bad("request event lacks original prompt"));
        }
        let digest = sha256(prompt);
        let observed = if target == "codex" {
            let turn = text(&event, "turn_id");
            identity(turn)?;
            sha256(format!("turn:{turn}"))
        } else if gid {
            let id = text(&event, "invocation_id");
            identity(id)?;
            sha256(format!("invocation:{id}"))
        } else {
            String::new()
        };
        let continuation = text(&event, "continuation_of");
        let seen = !observed.is_empty()
            && v["recentEvents"]
                .as_array()
                .unwrap()
                .iter()
                .any(|x| x == &observed);
        let continuing = gid
            && !continuation.is_empty()
            && v["recentEvents"]
                .as_array()
                .unwrap()
                .iter()
                .any(|x| x == &sha256(format!("invocation:{continuation}")));
        let pending_replay =
            target == "claude" && v["kind"].is_null() && v["promptDigest"] == digest;
        if seen && v["eventIdentity"] != observed {
            return Ok(json!({}));
        } // stale replay never replaces current token
        if !seen && !continuing && !pending_replay {
            v["requestId"] = json!(uuid::Uuid::new_v4().simple().to_string());
            v["kind"] = Value::Null;
            v["slug"] = Value::Null;
            v["stopCorrections"] = json!(0);
            v["promptDigest"] = json!(digest);
        }
        if !observed.is_empty() && !seen {
            let a = v["recentEvents"].as_array_mut().unwrap();
            a.push(json!(observed));
            if a.len() > 64 {
                a.remove(0);
            }
        }
        v["eventIdentity"] = json!(observed);
        store::write_json_atomic(&path, &v)?;
        return Ok(context(target, name, guidance(&v)));
    }
    if v["requestId"].is_null() || v["kind"] == "optout" || v["kind"] == "question" {
        return Ok(json!({}));
    }
    if gid {
        return if name == "before_turn" {
            Ok(context(target, name, guidance(&v)))
        } else {
            Ok(json!({}))
        };
    }
    if name == "PreToolUse" {
        let edit = [
            "Write",
            "Edit",
            "MultiEdit",
            "apply_patch",
            "functions.apply_patch",
        ]
        .contains(&text(&event, "tool_name"));
        let allocated = if let Some(slug) = v["slug"].as_str() {
            let work = store::load(cwd, slug)?;
            let allocation = crate::runtime::team::summary(&work)["allocation"].clone();
            !allocation.is_null()
                && allocation["blockers"]
                    .as_array()
                    .is_some_and(|b| b.is_empty())
        } else {
            false
        };
        if edit && (v["kind"].is_null() || !allocated) {
            return Ok(
                json!({"hookSpecificOutput":{"hookEventName":name,"permissionDecision":"deny","permissionDecisionReason":guidance(&v)}}),
            );
        }
    }
    if name == "Stop"
        && (v["kind"].is_null() || v["slug"].is_null() || active(cwd, &v)?)
        && v["stopCorrections"] == 0
        && event["stop_hook_active"] != true
    {
        v["stopCorrections"] = json!(1);
        store::write_json_atomic(&path, &v)?;
        return Ok(
            json!({"decision":"block","reason":format!("Resolve entry classification or pending Work before completion. {}",guidance(&v))}),
        );
    }
    Ok(json!({}))
}
fn decide(cwd: &Path, args: &[String]) -> Result<Value> {
    crate::support::ensure_flags(
        args,
        &["target", "session", "request", "kind", "slug"],
        &["json"],
    )?;
    let target = target(args)?;
    let session = required_flag(args, "session")?;
    let request = required_flag(args, "request")?;
    let kind = required_flag(args, "kind")?;
    if !["work", "question", "optout"].contains(&kind.as_str()) {
        return Err(bad("invalid request kind"));
    }
    let slug = crate::support::read_flag(args, "slug")?;
    if slug.is_some() && kind != "work" {
        return Err(bad("only work decisions bind a slug"));
    }
    let path = state_path(cwd, &target, &session, false)?;
    if !path.exists() {
        return Err(bad("no observed host request"));
    }
    let _lock = super::agent::lock::acquire(&path.with_extension("lock"), false)?;
    let mut v = load(&path, &target, &session)?;
    if v["requestId"] != request {
        return Err(bad("stale request token"));
    }
    if !v["kind"].is_null() && v["kind"] != kind && kind != "optout" {
        return Err(bad(
            "request already decided; only explicit opt-out may override",
        ));
    }
    if let Some(slug) = slug {
        state::validate_slug(&slug)?;
        let w = store::load(cwd, &slug)?;
        if w["done"] == true {
            return Err(bad("cannot bind completed Work"));
        }
        if v["activeWorkSlug"].as_str().is_some_and(|old| old != slug) && active(cwd, &v)? {
            return Err(bad("unfinished Work binding must be resumed, not replaced"));
        }
        v["slug"] = json!(slug);
        v["activeWorkSlug"] = v["slug"].clone();
    }
    v["kind"] = json!(kind);
    store::write_json_atomic(&path, &v)?;
    let mut output = v.clone();
    output["guidance"] = json!(guidance(&v));
    Ok(output)
}

// Installation operates only on managed entry handlers, preserving the agent gate.
fn safe_path(path: &Path) -> Result<()> {
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        match fs::symlink_metadata(ancestor) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(bad(format!("unsafe symlink: {}", ancestor.display())));
            }
            Ok(m) if ancestor != path && !m.is_dir() => {
                return Err(bad("configuration parent is not a directory"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn config_path(target: &str) -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| bad("HOME missing"))?;
    let home = PathBuf::from(home);
    let p = match target {
        "codex" => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("hooks.json"),
        "claude" => home.join(".claude/settings.json"),
        "gid" => PathBuf::from(
            std::env::var_os("GID_CONFIG_DIR")
                .ok_or_else(|| bad("gid registration requires explicit GID_CONFIG_DIR"))?,
        )
        .join("extensions/gdm-entry-v1.json"),
        _ => return Err(bad("unsupported target")),
    };
    if !p.is_absolute() {
        return Err(bad("configuration directory must be absolute"));
    }
    safe_path(&p)?;
    Ok(p)
}
fn read_config(path: &Path) -> Result<Option<Vec<u8>>> {
    if !store::inspect(path, false)? {
        return Ok(None);
    }
    Ok(Some(store::read_regular(path, 1024 * 1024)?))
}
fn managed(h: &Value) -> bool {
    let command = text(h, "command");
    ["codex", "claude"].iter().any(|target| {
        let suffix = format!(" entry hook --target {target} --handler-id {HANDLER}");
        command
            .strip_suffix(&suffix)
            .and_then(|prefix| {
                prefix
                    .strip_prefix('\'')
                    .and_then(|body| body.strip_suffix('\''))
            })
            .is_some_and(|encoded| {
                let decoded = encoded.replace("'\"'\"'", "'");
                Path::new(&decoded).is_absolute()
                    && command == format!("{}{}", quote(&decoded), suffix)
            })
    })
}
fn merged(target: &str, before: Option<&[u8]>, binary: &str) -> Result<Value> {
    if target == "gid" {
        if let Some(bytes) = before {
            let prior: Value = serde_json::from_slice(bytes)?;
            if prior["schema"] != "gid-extension/v1" || prior["name"] != HANDLER {
                return Err(bad("refusing unrelated gid manifest"));
            }
        }
        return Ok(
            json!({"schema":"gid-extension/v1","name":HANDLER,"version":"1.0.0","hooks": (["input","before_turn"].map(|event|json!({"event":event,"command":[binary,"entry","hook","--target","gid"],"timeout":10})))}),
        );
    }
    let mut v: Value = match before {
        Some(b) => serde_json::from_slice(b)?,
        None => json!({}),
    };
    if !v.is_object() || v.get("hooks").is_some_and(|x| !x.is_object()) {
        return Err(bad("settings must be object with hooks object"));
    }
    if v.get("hooks").is_none() {
        v["hooks"] = json!({});
    }
    for event in ["UserPromptSubmit", "PreToolUse", "Stop"] {
        let mut keep = vec![];
        if let Some(groups) = v["hooks"].get(event) {
            for group in groups
                .as_array()
                .ok_or_else(|| bad("hook event must be an array"))?
            {
                let handlers = group["hooks"]
                    .as_array()
                    .ok_or_else(|| bad("hook group lacks hooks array"))?;
                let mut g = group.clone();
                let h: Vec<_> = handlers.iter().filter(|h| !managed(h)).cloned().collect();
                if !h.is_empty() {
                    g["hooks"] = json!(h);
                    keep.push(g);
                }
            }
        }
        let mut group = json!({"hooks":[{"type":"command","command":format!("{} entry hook --target {target} --handler-id {HANDLER}",quote(binary)),"timeout":10}]});
        if event == "PreToolUse" {
            group["matcher"] =
                json!("^(Write|Edit|MultiEdit|apply_patch|functions\\.apply_patch)$");
        }
        keep.push(group);
        v["hooks"][event] = json!(keep);
    }
    Ok(v)
}
fn install(cwd: &Path, args: &[String]) -> Result<Value> {
    crate::support::ensure_flags(args, &["target", "binary"], &["json", "dry-run"])?;
    let t = target(args)?;
    let binary = required_flag(args, "binary")?;
    let dry = has_flag(args, "dry-run");
    let exe = Path::new(&binary);
    if !exe.is_absolute()
        || binary.contains(['\n', '\r'])
        || !fs::metadata(exe).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    {
        return Err(bad("binary must be absolute and executable"));
    }
    // Probe local protocol with recursion disabled; never starts a provider.
    let mut probe = Command::new(&binary);
    probe
        .args(["entry", "hook", "--target", &t])
        .env("GDM_ENTRY_DISABLED", "1")
        .current_dir(cwd);
    let output = crate::computer_use::process::capture(
        probe,
        b"{}".to_vec(),
        Duration::from_secs(3),
        LIMIT,
    )?;
    if output.code != 0
        || !output.stderr.is_empty()
        || serde_json::from_slice::<Value>(&output.stdout).ok() != Some(json!({}))
    {
        return Err(bad("entry executable protocol probe failed"));
    }
    let path = config_path(&t)?;
    let backup = path.with_extension("json.gdm-entry-backup");
    safe_path(&backup)?;
    if backup.exists() {
        store::inspect(&backup, false)?;
    }
    let before = read_config(&path)?;
    let v = merged(&t, before.as_deref(), &binary)?;
    let after = format!("{}\n", serde_json::to_string_pretty(&v)?).into_bytes();
    let changed = before.as_ref() != Some(&after);
    if !dry {
        let parent = path.parent().unwrap();
        fs::create_dir_all(parent)?;
        safe_path(&path)?;
        let _lock =
            super::agent::lock::acquire(&path.with_extension("json.gdm-entry-lock"), false)?;
        if read_config(&path)? != before {
            return Err(bad("configuration drift during installation"));
        }
        let mode = fs::metadata(&path)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0o600);
        if changed {
            if let Some(bytes) = &before {
                if !backup.exists() {
                    store::write_atomic(&backup, bytes)?;
                }
            }
            store::write_atomic_mode(&path, &after, mode)?;
        }
        if t == "gid" && gid_available() {
            let mut register = Command::new("gid");
            register
                .args(["extension", "add"])
                .arg(&path)
                .arg("--trust")
                .current_dir(cwd);
            let registration = crate::computer_use::process::capture(
                register,
                vec![],
                Duration::from_secs(10),
                LIMIT,
            );
            if !registration.as_ref().is_ok_and(|o| o.code == 0) {
                if read_config(&path)?.as_ref() == Some(&after) {
                    match &before {
                        Some(b) => store::write_atomic_mode(&path, b, mode)?,
                        None => fs::remove_file(&path)?,
                    }
                }
                return Err(bad(
                    "gid registration failed; manifest restored; registry is owned by gid",
                ));
            }
        }
    }
    Ok(
        json!({"schemaVersion":"gdm-entry-install/v1","target":t,"configPath":path,"backupPath":backup,"changed":changed,"dryRun":dry,"configured":!dry,"registered":t=="gid"&&!dry&&gid_available(),"effective":"unverified","limitations":if t=="gid"{"Requires a new native session; ask-mode approvals remain; re-register after binary upgrades"}else{"Host feature/trust/session activation not observed; opaque shell/MCP edits are advisory"}}),
    )
}
fn gid_available() -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| {
            fs::metadata(dir.join("gid"))
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
    })
}
fn uninstall(cwd: &Path, args: &[String]) -> Result<Value> {
    crate::support::ensure_flags(args, &["target"], &["json", "dry-run"])?;
    let t = target(args)?;
    let path = config_path(&t)?;
    let dry = has_flag(args, "dry-run");
    let Some(before) = read_config(&path)? else {
        return Ok(json!({"target":t,"changed":false,"dryRun":dry}));
    };
    let mut v: Value = serde_json::from_slice(&before)?;
    if t == "gid" {
        if v["name"] != HANDLER || v["schema"] != "gid-extension/v1" {
            return Err(bad("refusing to remove unrelated manifest"));
        }
        if !dry {
            if gid_available() {
                let mut remove = Command::new("gid");
                remove
                    .args(["extension", "remove", HANDLER])
                    .current_dir(cwd);
                let out = crate::computer_use::process::capture(
                    remove,
                    vec![],
                    Duration::from_secs(10),
                    LIMIT,
                )?;
                if out.code != 0 {
                    return Err(bad("gid unregister failed; manifest preserved"));
                }
            } else {
                return Err(bad(
                    "gid unavailable; unregister before removing the manifest",
                ));
            }
            if read_config(&path)?.as_ref() != Some(&before) {
                return Err(bad("manifest changed while unregistering"));
            }
            fs::remove_file(&path)?;
        }
        return Ok(json!({"target":t,"changed":true,"dryRun":dry}));
    }
    if !v.is_object() || v.get("hooks").is_some_and(|h| !h.is_object()) {
        return Err(bad("invalid hook settings"));
    }
    if let Some(hooks) = v["hooks"].as_object_mut() {
        for event in ["UserPromptSubmit", "PreToolUse", "Stop"] {
            if let Some(groups) = hooks.get_mut(event) {
                let groups = groups
                    .as_array_mut()
                    .ok_or_else(|| bad("invalid hook event"))?;
                for group in groups.iter_mut() {
                    let handlers = group["hooks"]
                        .as_array_mut()
                        .ok_or_else(|| bad("invalid hook group"))?;
                    handlers.retain(|h| !managed(h));
                }
                groups.retain(|g| !g["hooks"].as_array().unwrap().is_empty());
                if groups.is_empty() {
                    hooks.remove(event);
                }
            }
        }
    }
    let after = format!("{}\n", serde_json::to_string_pretty(&v)?).into_bytes();
    let changed = after != before;
    if changed && !dry {
        let _lock =
            super::agent::lock::acquire(&path.with_extension("json.gdm-entry-lock"), false)?;
        if read_config(&path)?.as_ref() != Some(&before) {
            return Err(bad("settings changed during uninstall"));
        }
        let mode = fs::metadata(&path)?.permissions().mode() & 0o777;
        store::write_atomic_mode(&path, &after, mode)?;
    }
    Ok(json!({"target":t,"changed":changed,"dryRun":dry,"backupPreserved":true}))
}
pub fn run(cwd: &Path, args: &[String], input: &str) -> Result<()> {
    let (command, args) = args
        .split_first()
        .ok_or_else(|| bad("entry command required"))?;
    let result = match command.as_str() {
        "hook" => {
            crate::support::ensure_flags(args, &["target", "handler-id"], &[])?;
            if let Some(id) = crate::support::read_flag(args, "handler-id")? {
                if id != HANDLER {
                    return Err(bad("unknown handler identity"));
                }
            }
            hook(cwd, &target(args)?, input)?
        }
        "status" => {
            crate::support::ensure_flags(args, &["target", "session"], &["json"])?;
            let t = target(args)?;
            let session = required_flag(args, "session")?;
            load(&state_path(cwd, &t, &session, false)?, &t, &session)?
        }
        "decide" => decide(cwd, args)?,
        "install" => install(cwd, args)?,
        "uninstall" => uninstall(cwd, args)?,
        _ => return Err(bad("unknown entry command")),
    };
    print_json(&result)
}
