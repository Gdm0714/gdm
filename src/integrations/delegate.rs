//! Bounded native Pi delegation: role policy, process ownership and stream parser.
//! The host owns only UI registration and supplies its native session identity.
use crate::computer_use::process::Owned;
use crate::support::{Error, Result, print_json};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
fn err(s: impl Into<String>) -> Error {
    Error::new("pi_delegation_rejected", s)
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn credentials(s: &str) -> bool {
    [
        r"(?i)(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}",
        r"(?i)\bghp_[A-Za-z0-9]{8,}\b",
        r"(?i)\bgithub_pat_[A-Za-z0-9_]{8,}\b",
        r"\bAKIA[A-Z0-9]{12,}\b",
        r"(?i)\bBearer\s+\S+",
        r"(?i)BEGIN [A-Z ]*PRIVATE KEY",
        r"\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
    ]
    .iter()
    .any(|r| regex::Regex::new(r).unwrap().is_match(s))
}
pub fn validate(v: &Value) -> Result<()> {
    if v.as_object()
        .is_none_or(|o| o.len() != 1 || !o.contains_key("tasks"))
    {
        return Err(err("delegate request must contain exactly one tasks field"));
    }
    let tasks = v["tasks"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| err("delegate request requires at least one task"))?;
    if tasks.len() > 3 {
        return Err(err(
            "delegate request exceeds the 3-child concurrency limit",
        ));
    }
    for (i, t) in tasks.iter().enumerate() {
        let required = ["role", "scope", "task", "deliverable", "verify"];
        if t.as_object().is_none_or(|o| {
            o.len() != 5 + usize::from(o.contains_key("thinking"))
                || required.iter().any(|k| !o.contains_key(*k))
        }) {
            return Err(err(format!(
                "task {} must contain exactly role, scope, task, deliverable, verify and optional thinking",
                i + 1
            )));
        }
        if !["scout", "design", "reviewer"].contains(&text(t, "role")) {
            return Err(err("unsupported read-only role"));
        }
        if t.get("thinking").is_some() && !["medium", "high"].contains(&text(t, "thinking")) {
            return Err(err("task thinking must be medium|high"));
        }
        for k in ["scope", "task", "deliverable", "verify"] {
            if text(t, k).trim().is_empty() {
                return Err(err(format!(
                    "task {} field {k} must be nonempty text",
                    i + 1
                )));
            }
        }
        let serialized = serde_json::to_string(t)?;
        if serialized.len() > 16384 {
            return Err(err("task exceeds the 16384-byte limit"));
        }
        if credentials(&serialized) {
            return Err(err("task contains a credential-shaped value"));
        }
    }
    Ok(())
}
fn model_valid(s: &str) -> bool {
    s.len() <= 160
        && regex::Regex::new(r"^[A-Za-z0-9._+-]+/[A-Za-z0-9._+-]+$")
            .unwrap()
            .is_match(s)
}
fn thinking_valid(s: &str) -> bool {
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&s)
}
pub fn configuration(role: &str, thinking: Option<&str>) -> Result<Value> {
    let (prefix, model) = match role {
        "scout" => ("SCOUT", "openai-codex/gpt-5.6-luna"),
        "design" => ("DESIGN", "openai-codex/gpt-6-astra"),
        "reviewer" => ("REVIEW", "openai-codex/gpt-6-astra"),
        _ => return Err(err("unsupported read-only role")),
    };
    let model = std::env::var(format!("GDM_PI_{prefix}_MODEL"))
        .or_else(|_| std::env::var("GDM_PI_CHILD_MODEL"))
        .unwrap_or(model.into());
    let configured = std::env::var(format!("GDM_PI_{prefix}_THINKING"))
        .or_else(|_| std::env::var("GDM_PI_CHILD_THINKING"))
        .unwrap_or("medium".into());
    if !model_valid(&model) || !thinking_valid(&configured) {
        return Err(err("invalid role model or thinking configuration"));
    }
    if thinking.is_some_and(|s| !["medium", "high"].contains(&s)) {
        return Err(err("task thinking override must be medium|high"));
    }
    Ok(json!({"model":model,"thinking":thinking.unwrap_or(&configured)}))
}
fn child_args(v: &Value) -> Result<Vec<String>> {
    let model = text(v, "model");
    let thinking = text(v, "thinking");
    if !model_valid(model) || !thinking_valid(thinking) {
        return Err(err("invalid child model or thinking level"));
    }
    Ok([
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-approve",
        "--tools",
        "read,grep,find,ls",
        "--system-prompt",
        text(v, "systemPrompt"),
        "--model",
        model,
        "--thinking",
        thinking,
        &format!("Task:\n{}", text(v, "taskText")),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect())
}
#[derive(Default)]
struct Reader {
    output: String,
    assistant: u64,
    usage_turns: u64,
    reasoning_turns: u64,
    compactions: u64,
    compaction_usage: u64,
    compacting: bool,
    ended: bool,
    settled: bool,
    stop: Option<String>,
    provider_error: String,
    models: Vec<String>,
    starts: BTreeMap<String, Value>,
    calls: Vec<Value>,
    usage: Value,
}
impl Reader {
    fn new() -> Self {
        Self {
            usage: json!({"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0,"totalTokens":0.0,"reasoning":0.0,"cost":{"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0,"total":0.0}}),
            ..Default::default()
        }
    }
    fn add_usage(&mut self, u: &Value) -> bool {
        let fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
        let costs = ["input", "output", "cacheRead", "cacheWrite", "total"];
        let valid = |v: &Value| v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0);
        if fields.iter().any(|k| !valid(&u[*k])) || costs.iter().any(|k| !valid(&u["cost"][*k])) {
            return false;
        }
        for k in fields {
            self.usage[k] = json!(self.usage[k].as_f64().unwrap() + u[k].as_f64().unwrap());
        }
        for k in costs {
            self.usage["cost"][k] =
                json!(self.usage["cost"][k].as_f64().unwrap() + u["cost"][k].as_f64().unwrap());
        }
        if valid(&u["reasoning"]) {
            self.usage["reasoning"] =
                json!(self.usage["reasoning"].as_f64().unwrap() + u["reasoning"].as_f64().unwrap());
            self.reasoning_turns += 1;
        }
        true
    }
    fn line(&mut self, line: &[u8]) -> Result<()> {
        if line.len() > 2 * 1024 * 1024 {
            return Err(err("child event line limit exceeded"));
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let e: Value =
            serde_json::from_slice(line).map_err(|_| err("child emitted malformed JSON event"))?;
        if !e.is_object() || !e["type"].is_string() {
            return Err(err("child emitted malformed JSON event"));
        }
        match text(&e, "type") {
            "agent_start" => {
                if !self.settled {
                    self.ended = false;
                }
            }
            "agent_end" => {
                if e["willRetry"] != true {
                    self.ended = true;
                }
            }
            "agent_settled" => {
                self.settled = true;
                self.ended = true;
            }
            "compaction_start" => self.compacting = true,
            "compaction_end" => {
                self.compacting = false;
                self.compactions += 1;
                if self.add_usage(&e["result"]["usage"]) {
                    self.compaction_usage += 1;
                }
                if e["willRetry"] == true && !self.settled {
                    self.ended = false;
                }
            }
            "tool_execution_start" => {
                if let Some(id) = e["toolCallId"].as_str()
                    && self.starts.len() < 256
                {
                    let mut call = json!({"name":e["toolName"]});
                    if let Some(path) = e["args"]["path"].as_str()
                        && path.encode_utf16().count() <= 1024
                        && !credentials(path)
                    {
                        call["path"] = json!(path);
                    }
                    self.starts.insert(id.to_owned(), call);
                }
            }
            "tool_execution_end" => {
                if let Some(mut call) = self.starts.remove(text(&e, "toolCallId"))
                    && self.calls.len() < 256
                {
                    call["isError"] = json!(e["isError"] == true || e["result"]["isError"] == true);
                    self.calls.push(call);
                }
            }
            "message_end" => {
                let m = &e["message"];
                if !m.is_object() || !m["role"].is_string() {
                    return Err(err("child emitted malformed message_end event"));
                }
                if m["role"] != "assistant" {
                    return Ok(());
                }
                if self.ended || !m["content"].is_array() {
                    return Err(err("child emitted malformed assistant event"));
                }
                self.assistant += 1;
                self.stop = m["stopReason"].as_str().map(str::to_owned);
                self.provider_error = text(m, "errorMessage").to_owned();
                if m["provider"].is_string() && m["model"].is_string() {
                    let identity = format!("{}/{}", text(m, "provider"), text(m, "model"));
                    if !self.models.contains(&identity) {
                        self.models.push(identity);
                    }
                }
                if self.add_usage(&m["usage"]) {
                    self.usage_turns += 1;
                }
                let parts = m["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|p| p["type"] == "text")
                    .map(|p| {
                        p["text"]
                            .as_str()
                            .ok_or_else(|| err("child emitted malformed assistant text"))
                    })
                    .collect::<Result<Vec<_>>>()?;
                self.output = parts.join("\n");
                if self.output.len() > 128 * 1024 {
                    self.output.clear();
                    return Err(err("child output limit exceeded"));
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn finish(&self) -> Result<()> {
        if !self.ended || self.compacting || self.assistant == 0 {
            return Err(err("child JSON stream incomplete"));
        }
        if self.stop.as_deref() != Some("stop") {
            return Err(err(if self.provider_error.is_empty() {
                format!(
                    "child assistant stopped with {}",
                    self.stop.as_deref().unwrap_or("undefined")
                )
            } else {
                self.provider_error.clone()
            }));
        }
        Ok(())
    }
    fn result(&self) -> Value {
        let mut usage = self.usage.clone();
        if self.reasoning_turns != self.assistant + self.compactions {
            usage["reasoning"] = Value::Null;
        }
        json!({"output":self.output,"assistantTurns":self.assistant,"reportedModels":self.models,"stopReason":self.stop,"toolCalls":self.calls,"usage":if self.usage_turns+self.compaction_usage>0{usage}else{Value::Null},"usageComplete":self.assistant>0&&self.usage_turns==self.assistant&&self.compaction_usage==self.compactions&&!self.compacting})
    }
}
fn child_result(
    v: &Value,
    reader: &Reader,
    spawned: bool,
    elapsed: u128,
    code: Option<i32>,
    failure: String,
) -> Value {
    let mut result = v["metadata"]
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| json!({}));
    for (key, value) in reader.result().as_object().unwrap() {
        result[key] = value.clone();
    }
    result["model"] = v["model"].clone();
    result["thinking"] = v["thinking"].clone();
    result["spawned"] = json!(spawned);
    result["elapsedMs"] = json!(elapsed);
    result["exitCode"] = json!(code);
    result["ok"] = json!(code == Some(0) && failure.is_empty());
    result["usageComplete"] = json!(result["ok"] == true && result["usageComplete"] == true);
    result["error"] = json!(failure);
    result
}
fn configured_timeout(value: Option<&str>) -> u64 {
    value
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| (1000..=900000).contains(n))
        .unwrap_or(600000)
}
fn child(cwd: &Path, v: &Value) -> Result<Value> {
    let executable = text(v, "executable");
    if !Path::new(executable).is_absolute() {
        return Err(err("identity-bound absolute Pi executable required"));
    }
    let args = child_args(v)?;
    // Host configuration uses the original decimal-only, 1s..15min policy.
    // Explicit low-level RPC durations remain useful for bounded runner tests.
    let timeout = v.get("timeoutMs").map_or_else(
        || configured_timeout(std::env::var("GDM_PI_CHILD_TIMEOUT_MS").ok().as_deref()),
        |value| {
            value
                .as_u64()
                .filter(|n| *n > 0 && *n <= 900000)
                .unwrap_or(600000)
        },
    );
    let start = Instant::now();
    let mut cmd = Command::new(executable);
    cmd.args(args)
        .current_dir(cwd)
        .env("GDM_PI_DELEGATED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut owned = match Owned::spawn(&mut cmd) {
        Ok(owned) => owned,
        Err(error) => {
            return Ok(child_result(
                v,
                &Reader::new(),
                false,
                start.elapsed().as_millis(),
                None,
                format!("child spawn failed: {}", error.message),
            ));
        }
    };
    let mut stdout = owned.child.stdout.take().unwrap();
    let mut stderr = owned.child.stderr.take().unwrap();
    let overflow = Arc::new(AtomicBool::new(false));
    let out_over = overflow.clone();
    let err_over = overflow.clone();
    let out = thread::spawn(move || {
        let mut reader = Reader::new();
        let mut total = 0;
        let mut pending = vec![];
        let mut chunk = [0u8; 8192];
        let mut failure = None;
        loop {
            let count = match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    failure = Some(e.to_string());
                    break;
                }
            };
            total += count;
            if total > 8 * 1024 * 1024 {
                failure = Some("child event stream limit exceeded".into());
                break;
            }
            pending.extend_from_slice(&chunk[..count]);
            while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = pending.drain(..=pos).collect();
                if let Err(e) = reader.line(&line[..line.len() - 1]) {
                    failure = Some(e.message);
                    break;
                }
            }
            if failure.is_some() {
                break;
            }
            if pending.len() > 2 * 1024 * 1024 {
                failure = Some("child event line limit exceeded".into());
                break;
            }
        }
        if failure.is_none()
            && !pending.is_empty()
            && let Err(e) = reader.line(&pending)
        {
            failure = Some(e.message);
        }
        if failure.is_some() {
            out_over.store(true, Ordering::SeqCst);
        }
        (reader, failure)
    });
    let diagnostic = thread::spawn(move || {
        let mut bytes = vec![];
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let remaining = 65536usize.saturating_sub(bytes.len());
                    bytes.extend_from_slice(&chunk[..n.min(remaining)]);
                    if n > remaining {
                        err_over.store(true, Ordering::SeqCst);
                        return (bytes, true);
                    }
                }
                Err(_) => break,
            }
        }
        (bytes, false)
    });
    let mut failure = String::new();
    let status = loop {
        if overflow.load(Ordering::SeqCst) {
            failure = "child bounded stream failed".into();
            owned.stop();
            break None;
        }
        if crate::computer_use::cancelled() {
            failure = "child aborted".into();
            owned.stop();
            break None;
        }
        if start.elapsed() > Duration::from_millis(timeout) {
            failure = "child timeout".into();
            owned.stop();
            break None;
        }
        if let Some(status) = owned.exit_code()? {
            break Some(status);
        }
        thread::sleep(Duration::from_millis(10));
    };
    owned.stop();
    let (reader, stream_error) = out.join().map_err(|_| err("child reader panicked"))?;
    let (stderr, stderr_over) = diagnostic
        .join()
        .map_err(|_| err("child stderr reader panicked"))?;
    if let Some(e) = stream_error {
        failure = e;
    }
    if stderr_over {
        failure = "child stderr limit exceeded".into();
    }
    let code = status;
    if failure.is_empty()
        && code == Some(0)
        && let Err(e) = reader.finish()
    {
        failure = e.message;
    }
    if failure.is_empty() && code != Some(0) {
        failure = if stderr.is_empty() {
            format!("child exited {:?}", code)
        } else {
            String::from_utf8_lossy(&stderr).into_owned()
        };
    }
    Ok(child_result(
        v,
        &reader,
        true,
        start.elapsed().as_millis(),
        code,
        failure,
    ))
}
pub fn rpc(cwd: &Path, v: &Value) -> Result<Value> {
    match text(v, "action") {
        "budget" => budget(v),
        "validate" => {
            validate(&v["request"])?;
            Ok(json!({"valid":true}))
        }
        "configure" => configuration(text(v, "role"), v["thinking"].as_str()),
        "arguments" => Ok(json!(child_args(v)?)),
        "run" => child(cwd, v),
        "parse-events" => {
            let mut r = Reader::new();
            for line in text(v, "stream").as_bytes().split(|b| *b == b'\n') {
                r.line(line)?;
            }
            r.finish()?;
            Ok(r.result())
        }
        _ => Err(err("unknown delegation action")),
    }
}

fn budget(v: &Value) -> Result<Value> {
    use fs2::FileExt;
    use std::{
        fs,
        fs::OpenOptions,
        io::Write,
        os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    };
    let agent_dir = v["agentDir"]
        .as_str()
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("GDM_PI_AGENT_DIR").map(std::path::PathBuf::from))
        .ok_or_else(|| err("GDM_PI_AGENT_DIR must be absolute"))?;
    if !agent_dir.is_absolute() {
        return Err(err("GDM_PI_AGENT_DIR must be absolute"));
    }
    let info = fs::symlink_metadata(&agent_dir)?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(err("agent directory must be regular"));
    }
    let session = text(v, "sessionId");
    if session.is_empty() || session.trim() != session || session.len() > 1024 {
        return Err(err("native session identity is required"));
    }
    let root = agent_dir.join("delegate-ledgers");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)?;
    let info = fs::symlink_metadata(&root)?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(err("delegate ledger root is not a regular directory"));
    }
    let path = root.join(format!("{}.json", crate::support::sha256(session)));
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path.with_extension("lock"))?;
    lock.lock_exclusive()?;
    let mut state = match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            json!({"schemaVersion":"gdm-pi-delegate-budget/v1","active":0,"total":0})
        }
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => {
            serde_json::from_slice::<Value>(&fs::read(&path)?)?
        }
        _ => return Err(err("delegate budget path is invalid")),
    };
    if state["schemaVersion"] != "gdm-pi-delegate-budget/v1"
        || state["active"].as_u64().is_none_or(|n| n > 3)
        || state["total"].as_u64().is_none_or(|n| n > 8)
        || state["active"].as_u64() > state["total"].as_u64()
    {
        return Err(err("delegate budget state is corrupt"));
    }
    let mut active = state["active"].as_u64().unwrap();
    let mut total = state["total"].as_u64().unwrap();
    let operation = text(v, "operation");
    match operation {
        "snapshot" => {}
        "reserve" => {
            let count = v["count"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| err("delegate count must be a positive integer"))?;
            if count > 3 || active + count > 3 {
                return Err(err("delegate concurrency would exceed 3"));
            }
            if total + count > 8 {
                return Err(err("delegate session total would exceed 8"));
            }
            active += count;
            total += count;
        }
        "release" => {
            let count = v["count"]
                .as_u64()
                .ok_or_else(|| err("delegate count must be nonnegative"))?;
            active = active.saturating_sub(count);
        }
        _ => return Err(err("unknown delegate budget operation")),
    }
    if operation != "snapshot" {
        state["active"] = json!(active);
        state["total"] = json!(total);
        let temporary = root.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(format!("{}\n", state).as_bytes())?;
        file.sync_all()?;
        fs::rename(temporary, path)?;
    }
    Ok(json!({"active":active,"total":total}))
}
pub fn run(cwd: &Path, args: &[String], stdin: &str) -> Result<()> {
    crate::computer_use::signals()?;
    if args != ["rpc"] {
        return Err(err("gdm delegate rpc (JSON on stdin)"));
    }
    print_json(&rpc(cwd, &serde_json::from_str(stdin)?)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_credential_tasks() {
        assert!(validate(&json!({"tasks":[{"role":"scout","scope":"src","task":"use Bearer abc","deliverable":"report","verify":"check"}]})).is_err());
    }
    #[test]
    fn complete_stream_and_truncation() {
        let mut r = Reader::new();
        r.line(br#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}"#).unwrap();
        assert!(r.finish().is_err());
        r.line(br#"{"type":"agent_end"}"#).unwrap();
        r.finish().unwrap();
        assert_eq!(r.result()["output"], "ok");
        assert_eq!(r.result()["usageComplete"], false);
    }
    #[test]
    fn retries_require_final_completion() {
        let mut r = Reader::new();
        r.line(br#"{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}"#).unwrap();
        r.line(br#"{"type":"agent_end","willRetry":true}"#).unwrap();
        assert!(r.finish().is_err());
    }
}
