use crate::support::{Error, Result, sha256};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Component, Path, PathBuf},
};
const PREFIX: &str = "GDM_AGENT_ENVELOPE_V1=";
const TTL: i64 = 1_800_000;
fn err(s: impl Into<String>) -> Error {
    Error::new("agent_state_corrupt", s)
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn ts(v: &Value, k: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s(v, k))
        .map(|d| d.timestamp_millis())
        .unwrap_or(i64::MIN / 2)
}
fn iso(t: i64) -> String {
    chrono::DateTime::from_timestamp_millis(t)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn active(v: &Value) -> bool {
    matches!(s(v, "state"), "pending" | "running")
}
fn protocol(v: &Value) -> &str {
    if s(v, "spawnProtocol") == "v2" {
        "v2"
    } else {
        "v1"
    }
}
fn exact(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty() && s.trim() == s)
}
fn digest(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn del(v: &mut Value, key: &str) {
    v.as_object_mut().unwrap().remove(key);
}
fn values<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    v[key].as_object().into_iter().flat_map(|m| m.values())
}
fn canonical(v: &Value) -> String {
    match v {
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(o) => {
            let mut keys: ocean::Keys = o.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical(&o[k])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => v.to_string(),
    }
}
// A local alias keeps canonical ordering independent of serde's map feature.
mod ocean {
    pub type Keys<'a> = Vec<&'a String>;
}
pub fn home(cwd: &Path) -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("CODEX_HOME").filter(|s| !s.is_empty()) {
        let p = PathBuf::from(p);
        return Ok(if p.is_absolute() { p } else { cwd.join(p) });
    }
    std::env::var_os("HOME")
        .filter(|s| !s.is_empty())
        .map(|h| PathBuf::from(h).join(".codex"))
        .ok_or_else(|| err("CODEX_HOME or HOME is required"))
}
fn normalize_path(cwd: &Path, p: &str) -> String {
    if p == "*" {
        return p.into();
    }
    let converted = p.replace('\\', "/");
    let p = Path::new(&converted);
    let full = if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    };
    let mut out = PathBuf::new();
    for c in full.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}
pub fn parse_envelope(message: &str) -> Result<Value> {
    let mut lines = message.lines();
    let first = lines.next().unwrap_or("");
    let text = first
        .strip_prefix(PREFIX)
        .ok_or_else(|| err(format!("{PREFIX} must begin the first message line")))?;
    if lines.any(|l| l.starts_with(PREFIX)) {
        return Err(err("message must not contain an additional envelope line"));
    }
    let v: Value = serde_json::from_str(text)
        .map_err(|e| err(format!("agent envelope must be single-line JSON: {e}")))?;
    let o = v
        .as_object()
        .ok_or_else(|| err("agent envelope must be a JSON object"))?;
    let keys = [
        "taskId",
        "parentId",
        "role",
        "scope",
        "ownership",
        "deliverable",
        "verify",
        "stopWhen",
        "canDelegate",
        "childQuota",
        "depth",
        "blockedBy",
    ];
    if o.len() != keys.len() || keys.iter().any(|k| !o.contains_key(*k)) {
        return Err(err("agent envelope fields are invalid"));
    }
    for k in [
        "taskId",
        "parentId",
        "role",
        "scope",
        "deliverable",
        "verify",
        "stopWhen",
    ] {
        if v[k].as_str().is_none_or(|x| {
            x.trim().is_empty() || (["taskId", "parentId", "scope"].contains(&k) && x.trim() != x)
        }) {
            return Err(err(format!("{k} must be a non-empty string")));
        }
    }
    let ownership = v["ownership"]
        .as_object()
        .ok_or_else(|| err("ownership must be an object"))?;
    if ownership.len() != 2
        || !ownership.contains_key("mode")
        || !ownership.contains_key("resources")
        || !["read", "write"].contains(&s(&v["ownership"], "mode"))
    {
        return Err(err("ownership fields are invalid"));
    }
    for (a, nonempty) in [
        (&v["ownership"]["resources"], true),
        (&v["blockedBy"], false),
    ] {
        if a.as_array()
            .is_none_or(|a| (nonempty && a.is_empty()) || a.iter().any(|s| !exact(s)))
        {
            return Err(err(
                "envelope arrays require non-empty strings without surrounding whitespace",
            ));
        }
    }
    if !v["canDelegate"].is_boolean() {
        return Err(err("canDelegate must be a boolean"));
    }
    if v["childQuota"].as_u64().is_none_or(|n| n > 2) {
        return Err(err("childQuota must be an integer from 0 through 2"));
    }
    if v["depth"].as_u64().is_none_or(|n| !(1..=3).contains(&n)) {
        return Err(err("depth must be an integer from 1 through 3"));
    }
    Ok(v)
}
fn normalize_envelope(cwd: &Path, mut v: Value) -> Value {
    v["scope"] = json!(normalize_path(cwd, s(&v, "scope")));
    for p in v["ownership"]["resources"].as_array_mut().unwrap() {
        *p = json!(normalize_path(cwd, p.as_str().unwrap()));
    }
    v
}
fn unstructured(id: &str, digest: &str) -> Value {
    let id = &sha256(id)[..20];
    let scope = format!("unstructured/{id}/{}", &digest[..20]);
    json!({"taskId":format!("unstructured-{id}"),"parentId":"unstructured-root","role":"unstructured","scope":scope,"ownership":{"mode":"read","resources":[scope]},"deliverable":"delegated task result","verify":"parent verifies the returned result","stopWhen":"SubagentStop is observed","canDelegate":true,"childQuota":2,"depth":1,"blockedBy":[]})
}
fn safe_file(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err(err(format!(
            "agent state path is not a regular file: {}",
            path.display()
        )));
    }
    Ok(())
}
fn safe_dir(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let m = fs::symlink_metadata(path)?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(err("agent state path is not a regular directory"));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
fn new_ledger(t: i64) -> Value {
    json!({"schemaVersion":1,"createdAt":iso(t),"updatedAt":iso(t),"totalAcceptedAttempts":0,"reservations":{},"agents":{},"orphanPosts":{}})
}
fn valid_ledger(v: &Value) -> Result<()> {
    let valid_time = |v: &Value, k: &str| chrono::DateTime::parse_from_rfc3339(s(v, k)).is_ok();
    if v["schemaVersion"] != 1
        || !valid_time(v, "createdAt")
        || !valid_time(v, "updatedAt")
        || ts(v, "updatedAt") < ts(v, "createdAt")
        || v["totalAcceptedAttempts"]
            .as_u64()
            .is_none_or(|n| n > 9_007_199_254_740_991)
        || ["reservations", "agents", "orphanPosts"]
            .iter()
            .any(|k| !v[k].is_object())
    {
        return Err(err("agent ledger is corrupt"));
    }
    if v["reservations"].as_object().unwrap().len() as u64
        != v["totalAcceptedAttempts"].as_u64().unwrap()
    {
        return Err(err("agent ledger attempt count is inconsistent"));
    }
    let mut tasks = BTreeSet::new();
    for (id, r) in v["reservations"].as_object().unwrap() {
        if s(r, "toolUseId") != id
            || !exact(&r["toolUseId"])
            || !digest(&r["toolInputDigest"])
            || !["structured", "unstructured"].contains(&s(r, "contractMode"))
            || !["pending", "running", "failed", "stopped", "expired"].contains(&s(r, "state"))
            || !valid_time(r, "reservedAt")
            || !valid_time(r, "expiresAt")
            || ts(r, "expiresAt") < ts(r, "reservedAt")
        {
            return Err(err("invalid reservation"));
        }
        parse_envelope(&format!("{PREFIX}{}", r["envelope"]))?;
        if !tasks.insert(s(&r["envelope"], "taskId")) {
            return Err(err("agent ledger contains duplicate task ids"));
        }
        for k in ["callerAgentId", "agentId"] {
            if r.get(k).is_some() && !exact(&r[k]) {
                return Err(err("invalid reservation identity"));
            }
        }
        if r.get("spawnProtocol").is_some() && !["v1", "v2"].contains(&s(r, "spawnProtocol")) {
            return Err(err("invalid spawn protocol"));
        }
        if (protocol(r) == "v2" && !exact(&r["taskName"]))
            || (protocol(r) == "v1" && r.get("taskName").is_some())
        {
            return Err(err("invalid task name"));
        }
        if (s(r, "state") == "stopped") != r.get("stoppedAt").is_some() {
            return Err(err("invalid stopped reservation"));
        }
        if r.get("postOutcome").is_some() != r.get("postObservedAt").is_some()
            || (r.get("postOutcome").is_some()
                && !["succeeded", "failed"].contains(&s(r, "postOutcome")))
        {
            return Err(err("invalid post checkpoint"));
        }
        if r.get("postResponseDigest").is_some()
            && (!digest(&r["postResponseDigest"]) || r.get("postOutcome").is_none())
        {
            return Err(err("invalid post digest"));
        }
        if r.get("postResponseDigest").is_some()
            && ((s(r, "postOutcome") == "succeeded"
                && !["running", "stopped", "expired"].contains(&s(r, "state")))
                || (s(r, "postOutcome") == "failed"
                    && !["failed", "running", "expired"].contains(&s(r, "state"))))
        {
            return Err(err("invalid post state"));
        }
        if r.get("failureReason").is_some_and(|v| !v.is_string()) {
            return Err(err("invalid failure reason"));
        }
        for k in ["postObservedAt", "stoppedAt"] {
            if r.get(k).is_some() && !valid_time(r, k) {
                return Err(err("invalid observation time"));
            }
        }
        if r.get("agentLinkAuthority").is_some()
            && (!["provisional", "post", "caller", "serialized-v2"]
                .contains(&s(r, "agentLinkAuthority"))
                || r.get("agentId").is_none())
        {
            return Err(err("invalid agent link authority"));
        }
        if let Some(agent) = r["agentId"].as_str() {
            if s(&v["agents"][agent], "reservationToolUseId") != id {
                return Err(err("agent ledger reservation link is inconsistent"));
            }
            if s(r, "state") == "stopped"
                && (s(r, "agentLinkAuthority") == "provisional"
                    || s(&v["agents"][agent], "state") != "stopped")
            {
                return Err(err("agent ledger stopped state is inconsistent"));
            }
        }
    }
    for (id, a) in v["agents"].as_object().unwrap() {
        if s(a, "agentId") != id
            || !exact(&a["agentId"])
            || !a["agentType"].is_string()
            || !["pending", "running", "stopped"].contains(&s(a, "state"))
            || !valid_time(a, "firstObservedAt")
            || (s(a, "state") == "stopped") != a.get("stoppedAt").is_some()
        {
            return Err(err("invalid agent observation"));
        }
        for k in ["startedAt", "stoppedAt"] {
            if a.get(k).is_some() && (!valid_time(a, k) || ts(a, k) < ts(a, "firstObservedAt")) {
                return Err(err("invalid lifecycle time"));
            }
        }
        if a.get("startedAt").is_some()
            && a.get("stoppedAt").is_some()
            && ts(a, "stoppedAt") < ts(a, "startedAt")
        {
            return Err(err("invalid lifecycle time order"));
        }
        if a.get("reservationToolUseId").is_some() && !exact(&a["reservationToolUseId"]) {
            return Err(err("invalid lifecycle reservation identity"));
        }
        if let Some(r) = a["reservationToolUseId"].as_str()
            && s(&v["reservations"][r], "agentId") != id
        {
            return Err(err("agent ledger agent link is inconsistent"));
        }
    }
    for (id, p) in v["orphanPosts"].as_object().unwrap() {
        if s(p, "toolUseId") != id
            || !exact(&p["toolUseId"])
            || !["succeeded", "failed"].contains(&s(p, "outcome"))
            || !valid_time(p, "observedAt")
        {
            return Err(err("invalid orphan post"));
        }
        if p.get("toolInputDigest").is_some() != p.get("responseDigest").is_some()
            || ["toolInputDigest", "responseDigest"]
                .iter()
                .any(|k| p.get(*k).is_some() && !digest(&p[*k]))
            || ["callerAgentId", "agentId"]
                .iter()
                .any(|k| p.get(*k).is_some() && !exact(&p[*k]))
            || (p.get("spawnProtocol").is_some() && !["v1", "v2"].contains(&s(p, "spawnProtocol")))
            || (protocol(p) == "v2" && !exact(&p["taskName"]))
            || (protocol(p) == "v1" && p.get("taskName").is_some())
        {
            return Err(err("invalid orphan post identity"));
        }
    }
    Ok(())
}
fn prune(v: &mut Value, t: i64) {
    for r in v["reservations"].as_object_mut().unwrap().values_mut() {
        if r.get("agentId").is_some() && r.get("agentLinkAuthority").is_none() {
            r["agentLinkAuthority"] = json!("provisional");
        }
        if s(r, "state") == "stopped" && s(r, "agentLinkAuthority") == "provisional" {
            r["state"] = json!(if s(r, "postOutcome") == "failed" {
                "failed"
            } else {
                "running"
            });
            del(r, "stoppedAt");
        }
        if active(r) && ts(r, "expiresAt") <= t {
            let reason = if r.get("postOutcome").is_none() && s(r, "state") == "pending" {
                "pre_acknowledgement_expired"
            } else {
                "lifecycle_lease_expired"
            };
            r["state"] = json!("expired");
            r["failureReason"] = json!(reason);
            del(r, "stoppedAt");
        }
    }
    let mut orphan_ids: Vec<_> = v["orphanPosts"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, p)| (id.clone(), ts(p, "observedAt")))
        .collect();
    orphan_ids.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (id, _) in orphan_ids.iter().skip(32) {
        v["orphanPosts"].as_object_mut().unwrap().remove(id);
    }
    let mut unlinked: Vec<_> = v["agents"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, a)| a.get("reservationToolUseId").is_none())
        .map(|(id, a)| {
            (
                id.clone(),
                s(a, "state") != "stopped",
                ts(
                    a,
                    if a.get("stoppedAt").is_some() {
                        "stoppedAt"
                    } else if a.get("startedAt").is_some() {
                        "startedAt"
                    } else {
                        "firstObservedAt"
                    },
                ),
            )
        })
        .collect();
    unlinked.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
    for (id, _, _) in unlinked.iter().skip(32) {
        v["agents"].as_object_mut().unwrap().remove(id);
    }
    v["agents"].as_object_mut().unwrap().retain(|_, a| {
        a.get("reservationToolUseId").is_some()
            || s(a, "state") == "stopped"
            || ts(
                a,
                if a.get("startedAt").is_some() {
                    "startedAt"
                } else {
                    "firstObservedAt"
                },
            ) + TTL
                > t
    });
}
fn active_count(v: &Value, t: i64) -> usize {
    values(v, "reservations")
        .filter(|r| active(r) && ts(r, "expiresAt") > t)
        .count()
        + values(v, "agents")
            .filter(|a| {
                a.get("reservationToolUseId").is_none()
                    && active(a)
                    && ts(
                        a,
                        if a.get("startedAt").is_some() {
                            "startedAt"
                        } else {
                            "firstObservedAt"
                        },
                    ) + TTL
                        > t
            })
            .count()
}
fn with_ledger(
    cwd: &Path,
    session: &str,
    t: i64,
    f: impl FnOnce(&mut Value, i64) -> Result<Value>,
) -> Result<Value> {
    let root = home(cwd)?.join("gdm");
    safe_dir(&root)?;
    let dir = root.join("agent-ledgers");
    safe_dir(&dir)?;
    let path = dir.join(format!("{}.json", sha256(session)));
    let lockpath = path.with_extension("json.lock");
    let _lock = super::lock::acquire(&lockpath, true)?;
    let mut ledger = if path.try_exists()? {
        safe_file(&path)?;
        let v: Value = serde_json::from_slice(&fs::read(&path)?)?;
        valid_ledger(&v).map_err(|e| err(format!("agent ledger is corrupt: {}", e.message)))?;
        v
    } else {
        new_ledger(t)
    };
    let before = ledger.clone();
    let t = t.max(ts(&ledger, "updatedAt"));
    prune(&mut ledger, t);
    let result = f(&mut ledger, t)?;
    if before != ledger {
        ledger["updatedAt"] = json!(iso(t));
        valid_ledger(&ledger)?;
        let mut temp = tempfile::Builder::new()
            .prefix(".ledger.")
            .tempfile_in(&dir)?;
        temp.write_all(format!("{}\n", serde_json::to_string_pretty(&ledger)?).as_bytes())?;
        temp.as_file().sync_all()?;
        if path.exists() {
            safe_file(&path)?;
        }
        fs::rename(temp.path(), &path)?;
        if let Ok(directory) = fs::File::open(&dir) {
            let _ = directory.sync_all();
        }
    }
    Ok(result)
}
fn allow() -> Value {
    json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}})
}
fn deny(reason: &str) -> Value {
    json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}})
}
fn policy(code: &str, detail: impl std::fmt::Display) -> Value {
    deny(&format!("gdm agent gate denied ({code}): {detail}"))
}
fn required<'a>(v: &'a Value, k: &str, trim: bool) -> Result<&'a str> {
    let text = v[k]
        .as_str()
        .ok_or_else(|| err(format!("{k} must be a non-empty string")))?;
    if text.is_empty() || (trim && text.trim() != text) {
        return Err(err(format!(
            "{k} must be a non-empty string without surrounding whitespace"
        )));
    }
    Ok(text)
}
#[derive(Clone)]
struct Spawn {
    session: String,
    id: String,
    input: Value,
    digest: String,
    protocol: String,
    task: Option<String>,
    caller: Option<String>,
    spawn: bool,
}
fn spawn(v: &Value) -> Result<Spawn> {
    let session = required(v, "session_id", true)?;
    let tool = required(v, "tool_name", false)?;
    let id = required(v, "tool_use_id", true)?;
    let caller = if v.get("agent_id").is_some() {
        Some(required(v, "agent_id", true)?.into())
    } else {
        None
    };
    if !v["tool_input"].is_object() {
        return Err(err("tool_input must be an object"));
    }
    let i = &v["tool_input"];
    let namespace = tool.strip_suffix("spawn_agent").unwrap_or("");
    let reserved = [
        "api_tool",
        "browser",
        "computer",
        "container",
        "file_search",
        "functions",
        "image_gen",
        "multi_tool_use",
        "python",
        "python_user_visible",
        "submodel_delegator",
        "terminal",
        "tool_search",
        "web",
    ];
    let is_spawn = [
        "Agent",
        "spawn_agent",
        "collaborationspawn_agent",
        "collaboration.spawn_agent",
    ]
    .contains(&tool)
        || (Regex::new(r"^[A-Za-z0-9_-]{1,64}spawn_agent$")
            .unwrap()
            .is_match(tool)
            && namespace != "mcp"
            && !namespace.starts_with("mcp__")
            && !reserved.contains(&namespace)
            && exact(&i["task_name"])
            && !s(i, "message").is_empty());
    let task = if is_spawn && i.get("task_name").is_some() {
        Some(required(i, "task_name", true)?.to_owned())
    } else {
        None
    };
    Ok(Spawn {
        session: session.into(),
        id: id.into(),
        input: i.clone(),
        digest: sha256(canonical(i)),
        protocol: if task.is_some() { "v2" } else { "v1" }.into(),
        task,
        caller,
        spawn: is_spawn,
    })
}
fn task_id(v: &Value, id: &str) -> Option<String> {
    v["reservations"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, r)| s(&r["envelope"], "taskId") == id)
        .map(|(id, _)| id.clone())
}
fn unresolved(v: &Value) -> Vec<String> {
    v["reservations"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, r)| active(r) && r.get("agentId").is_none())
        .map(|(k, _)| k.clone())
        .collect()
}
fn unique_v2(v: &Value) -> Option<String> {
    let ids = unresolved(v);
    (ids.len() == 1 && protocol(&v["reservations"][&ids[0]]) == "v2").then(|| ids[0].clone())
}
fn ensure_agent(v: &mut Value, id: &str, t: i64) {
    if v["agents"].get(id).is_none() {
        v["agents"][id] =
            json!({"agentId":id,"agentType":"unknown","state":"pending","firstObservedAt":iso(t)});
    }
}
fn reset_reservation(r: &mut Value) {
    del(r, "agentId");
    del(r, "agentLinkAuthority");
    del(r, "stoppedAt");
    if s(r, "state") != "expired" {
        r["state"] = json!(match s(r, "postOutcome") {
            "failed" => "failed",
            "succeeded" => "running",
            _ => "pending",
        });
    }
}
fn link(v: &mut Value, rid: &str, aid: &str, authority: &str) -> Result<()> {
    let r = v["reservations"][rid].clone();
    let a = v["agents"][aid].clone();
    let authoritative = authority != "provisional";
    if let Some(previous) = r["agentId"].as_str()
        && previous != aid
    {
        if !authoritative || s(&r, "agentLinkAuthority") != "provisional" {
            return Err(err("agent_id conflicts with reservation"));
        }
        if s(&v["agents"][previous], "reservationToolUseId") == rid {
            del(&mut v["agents"][previous], "reservationToolUseId");
        }
        reset_reservation(&mut v["reservations"][rid]);
    }
    if let Some(previous) = a["reservationToolUseId"].as_str()
        && previous != rid
    {
        if !authoritative || s(&v["reservations"][previous], "agentLinkAuthority") != "provisional"
        {
            return Err(err("agent already has authoritative reservation"));
        }
        reset_reservation(&mut v["reservations"][previous]);
    }
    v["reservations"][rid]["agentId"] = json!(aid);
    if s(&v["reservations"][rid], "agentLinkAuthority").is_empty()
        || s(&v["reservations"][rid], "agentLinkAuthority") == "provisional"
        || authoritative
    {
        v["reservations"][rid]["agentLinkAuthority"] = json!(authority);
    }
    v["agents"][aid]["reservationToolUseId"] = json!(rid);
    if s(&r, "postOutcome") != "failed" {
        if s(&a, "state") == "stopped"
            && s(&v["reservations"][rid], "agentLinkAuthority") != "provisional"
        {
            v["reservations"][rid]["state"] = json!("stopped");
            v["reservations"][rid]["stoppedAt"] = a["stoppedAt"].clone();
        } else if s(&a, "state") == "running" {
            v["reservations"][rid]["state"] = json!("running");
        }
    }
    Ok(())
}
fn caller_resolution(
    v: &Value,
    envelope: &Value,
    mode: &str,
    caller: Option<&str>,
) -> Option<String> {
    let caller = caller?;
    let candidate = if mode == "structured" {
        task_id(v, s(envelope, "parentId"))
    } else {
        let ids: Vec<_> = unresolved(v)
            .into_iter()
            .filter(|id| protocol(&v["reservations"][id]) == "v2")
            .collect();
        (ids.len() == 1).then(|| ids[0].clone())
    }?;
    let r = &v["reservations"][&candidate];
    if !active(r) || r.get("agentId").is_some() || s(&v["agents"][caller], "state") == "stopped" {
        return None;
    }
    if let Some(other) = v["agents"][caller]["reservationToolUseId"].as_str()
        && other != candidate
        && s(&v["reservations"][other], "agentLinkAuthority") != "provisional"
    {
        return None;
    }
    Some(candidate)
}
fn pre_policy(v: &Value, e: &Value, caller: Option<&str>) -> Option<Value> {
    let task = s(e, "taskId");
    let parent = s(e, "parentId");
    if task_id(v, task).is_some() {
        return Some(policy(
            "duplicate_task_id",
            format!("taskId {task} was already accepted"),
        ));
    }
    if task == parent {
        return Some(policy(
            "self_replication",
            "taskId and parentId must differ",
        ));
    }
    let p_id = task_id(v, parent);
    let p = p_id.as_ref().map(|id| &v["reservations"][id]);
    if caller.is_none() {
        if parent == "root" {
            if e["depth"] != 1 {
                return Some(policy(
                    "root_parent_guardrail",
                    "a root spawn must declare depth=1",
                ));
            }
        } else if p.is_none_or(|p| !active(p)) {
            return Some(policy(
                "declared_parent_guardrail",
                format!(
                    "caller identity is unavailable and declared parent {parent} is missing or no longer active"
                ),
            ));
        }
    } else if let Some(caller) = caller {
        if parent == "root" || p.is_none_or(|p| !active(p)) {
            return Some(policy(
                "caller_parent_guardrail",
                "caller must declare its linked active parent task",
            ));
        }
        let p = p.unwrap();
        let a = &v["agents"][caller];
        if s(a, "state") == "stopped"
            || (p.get("agentId").is_some()
                && s(p, "agentId") != caller
                && s(p, "agentLinkAuthority") != "provisional")
            || (a.get("reservationToolUseId").is_some()
                && s(a, "reservationToolUseId") != s(p, "toolUseId")
                && s(
                    &v["reservations"][s(a, "reservationToolUseId")],
                    "agentLinkAuthority",
                ) != "provisional")
        {
            return Some(policy(
                "caller_parent_conflict",
                "caller is not one-to-one linked to declared parent",
            ));
        }
    }
    if let Some(p) = p {
        let pe = &p["envelope"];
        if pe["scope"] == e["scope"] {
            return Some(policy(
                "same_scope_self_replication",
                "child scope duplicates parent scope",
            ));
        }
        if pe["canDelegate"] != true {
            return Some(policy(
                "parent_delegation_guardrail",
                "declared parent cannot delegate",
            ));
        }
        let children = values(v, "reservations")
            .filter(|r| s(&r["envelope"], "parentId") == parent)
            .count();
        if children >= pe["childQuota"].as_u64().unwrap_or(0) as usize {
            return Some(policy(
                "parent_child_quota_guardrail",
                "declared parent child quota is exhausted",
            ));
        }
        if e["depth"].as_u64() != pe["depth"].as_u64().map(|d| d + 1) {
            return Some(policy(
                "parent_depth_guardrail",
                "child depth must be parent depth + 1",
            ));
        }
    }
    for dep in e["blockedBy"].as_array().unwrap() {
        if task_id(v, dep.as_str().unwrap())
            .is_none_or(|id| s(&v["reservations"][&id], "state") != "stopped")
        {
            return Some(policy(
                "unmet_blocked_by",
                "dependency has no associated SubagentStop turn signal; this signal is not proof of success",
            ));
        }
    }
    for r in values(v, "reservations").filter(|r| active(r)) {
        let re = &r["envelope"];
        if s(r, "contractMode") == "structured" && re["scope"] == e["scope"] {
            return Some(policy(
                "duplicate_active_scope",
                format!("scope duplicates active task {}", s(re, "taskId")),
            ));
        }
        if s(&e["ownership"], "mode") == "write" && s(&re["ownership"], "mode") == "write" {
            for a in e["ownership"]["resources"].as_array().unwrap() {
                for b in re["ownership"]["resources"].as_array().unwrap() {
                    let a = a.as_str().unwrap();
                    let b = b.as_str().unwrap();
                    if a == "*"
                        || b == "*"
                        || a == b
                        || a.starts_with(&format!("{b}/"))
                        || b.starts_with(&format!("{a}/"))
                    {
                        return Some(policy(
                            "write_ownership_overlap",
                            format!("write ownership overlaps active task {}", s(re, "taskId")),
                        ));
                    }
                }
            }
        }
    }
    None
}
fn bind_caller(v: &mut Value, rid: Option<&str>, caller: Option<&str>, t: i64) -> Result<()> {
    if let (Some(rid), Some(caller)) = (rid, caller) {
        ensure_agent(v, caller, t);
        link(v, rid, caller, "caller")?;
        v["agents"][caller]["state"] = json!("running");
        if v["agents"][caller].get("startedAt").is_none() {
            v["agents"][caller]["startedAt"] = json!(iso(t));
        }
        v["reservations"][rid]["state"] = json!("running");
        del(&mut v["reservations"][rid], "stoppedAt");
        v["reservations"][rid]["expiresAt"] = json!(iso(t + TTL));
    }
    Ok(())
}
fn pre(cwd: &Path, input: &Value, t: i64) -> Result<Value> {
    let p = spawn(input)?;
    if !p.spawn {
        return Ok(allow());
    }
    let message = s(&p.input, "message");
    let mode = if message
        .lines()
        .next()
        .unwrap_or("")
        .trim_start()
        .starts_with(PREFIX)
    {
        "structured"
    } else {
        "unstructured"
    };
    let e = if mode == "structured" {
        normalize_envelope(cwd, parse_envelope(message)?)
    } else {
        unstructured(&p.id, &p.digest)
    };
    with_ledger(cwd, &p.session, t, |v, t| {
        if let Some(old) = v["reservations"].get(&p.id) {
            let exact = s(old, "contractMode") == mode
                && protocol(old) == p.protocol
                && old.get("taskName").and_then(Value::as_str) == p.task.as_deref()
                && s(old, "toolInputDigest") == p.digest
                && old["envelope"] == e
                && old.get("callerAgentId").and_then(Value::as_str) == p.caller.as_deref();
            return Ok(policy(
                if exact {
                    "tool_use_id_already_reserved"
                } else {
                    "tool_use_id_conflict"
                },
                format!("tool_use_id {} was already accepted", p.id),
            ));
        }
        if mode == "structured" {
            if let Some(denial) = pre_policy(v, &e, p.caller.as_deref()) {
                return Ok(denial);
            }
        } else if p
            .caller
            .as_ref()
            .is_some_and(|id| s(&v["agents"][id], "state") == "stopped")
        {
            return Ok(policy(
                "caller_parent_conflict",
                "caller was already observed stopped",
            ));
        }
        let resolution = caller_resolution(v, &e, mode, p.caller.as_deref());
        if unresolved(v).iter().any(|id| {
            Some(id) != resolution.as_ref()
                && (p.protocol == "v2" || protocol(&v["reservations"][id]) == "v2")
        }) {
            return Ok(policy(
                "v2_identity_handshake_pending",
                "a task is still in an identity-ambiguous window involving V2 lifecycle correlation",
            ));
        }
        let parent = if mode == "structured" {
            task_id(v, s(&e, "parentId"))
        } else {
            resolution
        };
        let mut projected = v.clone();
        bind_caller(&mut projected, parent.as_deref(), p.caller.as_deref(), t)?;
        let count = active_count(&projected, t);
        if count >= 32 {
            return Ok(policy(
                "session_active_execution_limit",
                format!(
                    "session has {count} pending/running execution leases; limit is 32. Finished history does not consume capacity"
                ),
            ));
        }
        *v = projected;
        let mut r = json!({"toolUseId":p.id,"toolInputDigest":p.digest,"contractMode":mode,"spawnProtocol":p.protocol,"envelope":e,"state":"pending","reservedAt":iso(t),"expiresAt":iso(t+60_000)});
        if let Some(task) = p.task {
            r["taskName"] = json!(task);
        }
        if let Some(caller) = p.caller {
            r["callerAgentId"] = json!(caller);
        }
        v["reservations"][&p.id] = r;
        v["totalAcceptedAttempts"] = json!(v["totalAcceptedAttempts"].as_u64().unwrap() + 1);
        if let Some(post) = v["orphanPosts"].get(&p.id).cloned() {
            apply_post(v, &p.id, &post, t)?;
            v["orphanPosts"].as_object_mut().unwrap().remove(&p.id);
        }
        Ok(allow())
    })
}
fn nested_id(v: &Value, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    match v {
        Value::Array(a) => a.iter().any(|v| nested_id(v, depth + 1)),
        Value::Object(o) => {
            (depth > 0 && (o.contains_key("agent_id") || o.contains_key("agentId")))
                || o.iter()
                    .filter(|(k, _)| depth != 0 || !["agent_id", "agentId"].contains(&k.as_str()))
                    .any(|(_, v)| nested_id(v, depth + 1))
        }
        _ => false,
    }
}
fn post_record(input: &Value, p: &Spawn, t: i64) -> Result<Value> {
    let response = input
        .get("tool_response")
        .ok_or_else(|| err("PostToolUse tool_response is required"))?;
    let decoded = if let Some(text) = response.as_str() {
        serde_json::from_str(text).unwrap_or_else(|_| response.clone())
    } else {
        response.clone()
    };
    let failed = ["success", "ok"].iter().any(|k| decoded[*k] == false)
        || ["isError", "is_error"].iter().any(|k| decoded[*k] == true)
        || ["exitCode", "exit_code"]
            .iter()
            .any(|k| decoded[*k].as_i64().is_some_and(|n| n != 0))
        || ["failed", "failure", "error"].contains(&s(&decoded, "status").to_lowercase().as_str())
        || decoded
            .get("error")
            .is_some_and(|v| !v.is_null() && v != false);
    let mut post = json!({"toolUseId":p.id,"toolInputDigest":p.digest,"responseDigest":sha256(canonical(response)),"spawnProtocol":p.protocol,"outcome":if failed{"failed"}else{"succeeded"},"observedAt":iso(t)});
    if let Some(task) = &p.task {
        post["taskName"] = json!(task);
    }
    if let Some(caller) = &p.caller {
        post["callerAgentId"] = json!(caller);
    }
    if decoded.is_object() && !nested_id(&decoded, 0) {
        let ids: Vec<_> = ["agent_id", "agentId"]
            .iter()
            .filter_map(|k| decoded.get(*k))
            .collect();
        if !ids.is_empty() && ids.iter().all(|id| exact(id) && id == &ids[0]) {
            post["agentId"] = ids[0].clone();
        }
    }
    Ok(post)
}
fn apply_post(v: &mut Value, rid: &str, post: &Value, t: i64) -> Result<()> {
    let r = v["reservations"][rid].clone();
    if s(&r, "state") == "expired" {
        return Err(err(
            "PostToolUse arrived after acknowledgement/lifecycle lease expired",
        ));
    }
    for (rk, pk) in [
        ("toolInputDigest", "toolInputDigest"),
        ("taskName", "taskName"),
        ("callerAgentId", "callerAgentId"),
    ] {
        if r[rk] != post[pk] {
            return Err(err(format!(
                "PostToolUse {pk} does not match reservation {rid}"
            )));
        }
    }
    if protocol(&r) != s(post, "spawnProtocol") {
        return Err(err("PostToolUse protocol does not match reservation"));
    }
    if r.get("postOutcome").is_some() {
        if r["postOutcome"] != post["outcome"]
            || r.get("postResponseDigest")
                .is_some_and(|d| d != &post["responseDigest"])
        {
            return Err(err("conflicting PostToolUse was observed"));
        }
        if r.get("postResponseDigest").is_some() {
            if s(post, "outcome") == "succeeded"
                && post.get("agentId").is_some()
                && r["agentId"] != post["agentId"]
            {
                return Err(err("conflicting PostToolUse identity"));
            }
            return Ok(());
        }
    }
    v["reservations"][rid]["postOutcome"] = post["outcome"].clone();
    v["reservations"][rid]["postObservedAt"] = post["observedAt"].clone();
    v["reservations"][rid]["postResponseDigest"] = post["responseDigest"].clone();
    v["reservations"][rid]["expiresAt"] = json!(iso(t + TTL));
    if let Some(aid) = post["agentId"].as_str() {
        ensure_agent(v, aid, t);
        link(v, rid, aid, "post")?;
    }
    let aid = s(&v["reservations"][rid], "agentId");
    let a = v["agents"][aid].clone();
    if s(post, "outcome") == "failed" {
        v["reservations"][rid]["failureReason"] = json!("spawn tool reported failure");
        del(&mut v["reservations"][rid], "stoppedAt");
        v["reservations"][rid]["state"] = json!(if s(&a, "state") == "running" {
            "running"
        } else {
            "failed"
        });
    } else if s(&a, "state") == "stopped"
        && s(&v["reservations"][rid], "agentLinkAuthority") != "provisional"
    {
        v["reservations"][rid]["state"] = json!("stopped");
        v["reservations"][rid]["stoppedAt"] = a["stoppedAt"].clone();
    } else {
        v["reservations"][rid]["state"] = json!("running");
        del(&mut v["reservations"][rid], "stoppedAt");
    }
    Ok(())
}
fn post(cwd: &Path, input: &Value, t: i64) -> Result<Value> {
    let p = spawn(input)?;
    if !p.spawn {
        return Ok(json!({}));
    }
    with_ledger(cwd, &p.session, t, |v, t| {
        let post = post_record(input, &p, t)?;
        if v["reservations"].get(&p.id).is_none() {
            if let Some(old) = v["orphanPosts"].get(&p.id) {
                let mut old = old.clone();
                let mut new = post.clone();
                del(&mut old, "observedAt");
                del(&mut new, "observedAt");
                if old != new {
                    return Err(err("conflicting PostToolUse was observed"));
                }
                return Ok(json!({}));
            }
            if v["orphanPosts"].as_object().unwrap().len() >= 32 {
                return Err(err("unmatched PostToolUse record limit is 32"));
            }
            v["orphanPosts"][&p.id] = post;
        } else {
            apply_post(v, &p.id, &post, t)?;
        }
        Ok(json!({}))
    })
}
fn room(v: &mut Value) -> bool {
    let a: Vec<_> = v["agents"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, a)| a.get("reservationToolUseId").is_none())
        .map(|(id, a)| (id.clone(), a.clone()))
        .collect();
    if a.len() < 32 {
        return true;
    }
    if let Some((id, _)) = a
        .iter()
        .filter(|(_, a)| s(a, "state") == "stopped")
        .min_by_key(|(_, a)| ts(a, "stoppedAt"))
    {
        v["agents"].as_object_mut().unwrap().remove(id);
        true
    } else {
        false
    }
}
fn lifecycle(cwd: &Path, input: &Value, t: i64, stop: bool) -> Result<Value> {
    let session = required(input, "session_id", true)?;
    let aid = required(input, "agent_id", true)?;
    let kind = required(input, "agent_type", false)?;
    with_ledger(cwd, session, t, |v, t| {
        let existing = v["agents"].get(aid).cloned();
        let linked = existing
            .as_ref()
            .and_then(|a| a["reservationToolUseId"].as_str())
            .map(str::to_owned);
        if existing
            .as_ref()
            .is_some_and(|a| s(a, "state") == "stopped")
        {
            return Ok(json!({}));
        }
        if !stop
            && existing
                .as_ref()
                .is_some_and(|a| s(a, "state") == "running")
            && linked
                .as_ref()
                .is_none_or(|id| active(&v["reservations"][id]))
        {
            return Ok(json!({}));
        }
        let candidate = if existing.is_none() {
            unique_v2(v).or_else(|| {
                if stop
                    || unresolved(v)
                        .iter()
                        .any(|id| protocol(&v["reservations"][id]) == "v2")
                {
                    return None;
                }
                let ids: Vec<_> = v["reservations"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .filter(|(_, r)| {
                        protocol(r) == "v1"
                            && s(r, "state") == "pending"
                            && r.get("agentId").is_none()
                            && ts(r, "reservedAt") <= t
                            && ts(r, "expiresAt") > t
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                (ids.len() == 1).then(|| ids[0].clone())
            })
        } else {
            None
        };
        if existing.is_none() && candidate.is_none() && !room(v) {
            return Ok(
                json!({"systemMessage":"gdm agent gate: unlinked lifecycle observation limit reached; the event could not be correlated safely"}),
            );
        }
        ensure_agent(v, aid, t);
        v["agents"][aid]["agentType"] = json!(kind);
        v["agents"][aid]["state"] = json!(if stop { "stopped" } else { "running" });
        v["agents"][aid][if stop { "stoppedAt" } else { "startedAt" }] = json!(iso(t));
        if let Some(rid) = linked.or(candidate) {
            let authority = if protocol(&v["reservations"][&rid]) == "v2" {
                "serialized-v2"
            } else {
                "provisional"
            };
            if v["agents"][aid].get("reservationToolUseId").is_none() {
                link(v, &rid, aid, authority)?;
            }
            if stop {
                if active(&v["reservations"][&rid])
                    && s(&v["reservations"][&rid], "agentLinkAuthority") != "provisional"
                {
                    if s(&v["reservations"][&rid], "postOutcome") == "failed" {
                        v["reservations"][&rid]["state"] = json!("failed");
                        del(&mut v["reservations"][&rid], "stoppedAt");
                    } else {
                        v["reservations"][&rid]["state"] = json!("stopped");
                        v["reservations"][&rid]["stoppedAt"] = json!(iso(t));
                    }
                }
            } else {
                v["reservations"][&rid]["state"] = json!("running");
                v["reservations"][&rid]["expiresAt"] = json!(iso(t + TTL));
                del(&mut v["reservations"][&rid], "stoppedAt");
                if ["pre_acknowledgement_expired", "lifecycle_lease_expired"]
                    .contains(&s(&v["reservations"][&rid], "failureReason"))
                    && s(&v["reservations"][&rid], "postOutcome") != "failed"
                {
                    del(&mut v["reservations"][&rid], "failureReason");
                }
            }
        }
        Ok(json!({}))
    })
}
fn stop(cwd: &Path, input: &Value, t: i64) -> Result<Value> {
    let session = required(input, "session_id", true)?;
    if input.get("stop_hook_active").is_some() && !input["stop_hook_active"].is_boolean() {
        return Err(err("stop_hook_active must be a boolean when present"));
    }
    with_ledger(cwd, session, t, |v, _| {
        let mut pending = 0;
        let mut running = 0;
        let mut ids = vec![];
        for r in values(v, "reservations").filter(|r| active(r)) {
            if s(r, "state") == "pending" {
                pending += 1
            } else {
                running += 1
            }
            ids.push(s(&r["envelope"], "taskId").to_owned());
        }
        for a in
            values(v, "agents").filter(|a| active(a) && a.get("reservationToolUseId").is_none())
        {
            if s(a, "state") == "pending" {
                pending += 1
            } else {
                running += 1
            }
            ids.push(format!("agent:{}", s(a, "agentId")));
        }
        if ids.is_empty() {
            return Ok(json!({}));
        }
        ids.truncate(32);
        let reason = format!(
            "gdm agent gate: delegated work remains pending ({pending}) or running ({running}) [{}]. Reconcile or stop those agents before ending the turn.",
            ids.join(", ")
        );
        if input["stop_hook_active"] == true {
            Ok(
                json!({"systemMessage":format!("{reason} The Stop guardrail already continued once, so it will not create an infinite continuation loop.")}),
            )
        } else {
            Ok(json!({"decision":"block","reason":reason}))
        }
    })
}
pub fn run(cwd: &Path, stdin: &str) -> Value {
    run_at(cwd, stdin, chrono::Utc::now().timestamp_millis())
}
pub fn run_at(cwd: &Path, stdin: &str, t: i64) -> Value {
    let input = serde_json::from_str::<Value>(stdin);
    let event = input
        .as_ref()
        .ok()
        .map(|v| s(v, "hook_event_name"))
        .unwrap_or("");
    let result = match &input {
        Ok(v) if v.is_object() => match event {
            "PreToolUse" => pre(cwd, v, t),
            "PostToolUse" => post(cwd, v, t),
            "SubagentStart" => lifecycle(cwd, v, t, false),
            "SubagentStop" => lifecycle(cwd, v, t, true),
            "Stop" => stop(cwd, v, t),
            _ => Err(err(format!("unsupported hook event: {event}"))),
        },
        _ => Err(err("hook stdin must be a JSON object")),
    };
    match result {
        Ok(v) => v,
        Err(e) => {
            let reason = format!("gdm agent gate failed closed: {}", e.message);
            let continued = input
                .as_ref()
                .ok()
                .is_some_and(|v| v["stop_hook_active"] == true);
            match event {
                "PostToolUse" | "SubagentStop" | "Stop" => {
                    if continued && event != "PostToolUse" {
                        json!({"systemMessage":format!("{reason}. The hook already requested one continuation and will not loop again.")})
                    } else {
                        json!({"decision":"block","reason":reason})
                    }
                }
                "SubagentStart" => json!({"systemMessage":reason}),
                _ => deny(&reason),
            }
        }
    }
}
pub fn summary(cwd: &Path) -> Result<Value> {
    let dir = home(cwd)?.join("gdm/agent-ledgers");
    let mut summary = json!({"schemaVersion":1,"directory":dir,"sessions":0,"corruptLedgers":0,"totalAcceptedAttempts":0,"structuredAttempts":0,"unstructuredAttempts":0,"pending":0,"running":0,"stopped":0,"failed":0,"expired":0,"activeExecutions":0,"hardSessionActiveExecutionLimit":32,"executionLimitBasis":"pending/running leases; historical attempts are excluded","preAcknowledgementTtlMs":60000,"lifecycleLeaseMs":TTL,"parentDelegationEnforcement":"caller-bound when agent_id is present; declaration-based compatibility fallback otherwise","subagentStopSemantics":"turn-stop sequencing hint only; it is not thread termination or verified completion","lifecycleAssociation":"V1 lifecycle-only association is provisional; V2 serialized handshakes associate turns; reuse and interrupt remain cooperative"});
    if !dir.exists() {
        return Ok(summary);
    }
    let m = fs::symlink_metadata(&dir)?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(err("agent ledger directory is invalid"));
    }
    let t = chrono::Utc::now().timestamp_millis();
    fn inc(v: &mut Value, k: &str, n: u64) {
        v[k] = json!(v[k].as_u64().unwrap() + n);
    }
    let ledger_name = Regex::new(r"^[a-f0-9]{64}\.json$").unwrap();
    for e in fs::read_dir(&dir)? {
        let e = e?;
        if !ledger_name.is_match(&e.file_name().to_string_lossy()) {
            continue;
        }
        let result = (|| {
            safe_file(&e.path())?;
            let mut v: Value = serde_json::from_slice(&fs::read(e.path())?)?;
            valid_ledger(&v)?;
            prune(&mut v, t);
            Ok::<_, Error>(v)
        })();
        match result {
            Ok(v) => {
                inc(&mut summary, "sessions", 1);
                inc(
                    &mut summary,
                    "totalAcceptedAttempts",
                    v["totalAcceptedAttempts"].as_u64().unwrap(),
                );
                inc(&mut summary, "activeExecutions", active_count(&v, t) as u64);
                for r in values(&v, "reservations") {
                    inc(
                        &mut summary,
                        if s(r, "contractMode") == "structured" {
                            "structuredAttempts"
                        } else {
                            "unstructuredAttempts"
                        },
                        1,
                    );
                    inc(
                        &mut summary,
                        if active(r) && ts(r, "expiresAt") <= t {
                            "expired"
                        } else {
                            s(r, "state")
                        },
                        1,
                    );
                }
            }
            Err(_) => inc(&mut summary, "corruptLedgers", 1),
        }
    }
    Ok(summary)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_envelope_has_no_policy_bypass() {
        let v = parse_envelope(" GDM_AGENT_ENVELOPE_V1={}");
        assert!(v.is_err());
    }
    #[test]
    fn path_overlap_normalization() {
        assert_eq!(
            normalize_path(Path::new("/repo"), "src/../lib"),
            "/repo/lib"
        );
    }
    #[test]
    fn non_spawn_probe_does_not_need_state() {
        let v = run(
            Path::new("/no"),
            r#"{"session_id":"probe","hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"x","tool_input":{}}"#,
        );
        assert_eq!(v, allow());
    }
    #[test]
    fn malformed_input_fails_closed() {
        assert_eq!(
            run(Path::new("/tmp"), "oops")["hookSpecificOutput"]["permissionDecision"],
            "deny"
        );
    }
}
