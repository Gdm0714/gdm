use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::symlink,
    path::Path,
    process::{Command, Output, Stdio},
};
fn cmd(cwd: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_gdm"));
    c.current_dir(cwd)
        .args(["--language", "en"])
        .args(args)
        .env("GDM_CONFIG_DIR", cwd.join("config"))
        .env_remove("GDM_ENTRY_DISABLED");
    if cwd.join("providers").is_dir() {
        c.env("PATH", cwd.join("providers"));
    }
    c
}
fn run(cwd: &Path, args: &[&str]) -> Output {
    cmd(cwd, args).output().unwrap()
}
fn value(o: Output) -> Value {
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_slice(&o.stdout).unwrap()
}
fn hook(cwd: &Path, t: &str, v: Value) -> Value {
    let mut c = cmd(cwd, &["entry", "hook", "--target", t])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin
        .take()
        .unwrap()
        .write_all(v.to_string().as_bytes())
        .unwrap();
    value(c.wait_with_output().unwrap())
}
fn event(cwd: &Path, t: &str, id: &str, prompt: &str) -> Value {
    if t == "gid" {
        json!({"schema":"gid-extension-event/v1","session_id":"session","cwd":cwd,"handler":{"type":"hook","event":"input"},"invocation_id":id,"payload":{"message":{"role":"user","text":prompt}},"continuation_of":null})
    } else {
        json!({"hook_event_name":"UserPromptSubmit","session_id":"session","cwd":cwd,"turn_id":id,"prompt":prompt})
    }
}
fn status(cwd: &Path, t: &str) -> Value {
    value(run(
        cwd,
        &[
            "entry",
            "status",
            "--target",
            t,
            "--session",
            "session",
            "--json",
        ],
    ))
}
fn decide(cwd: &Path, t: &str, token: &str, kind: &str, slug: Option<&str>) -> Output {
    let mut a = vec![
        "entry",
        "decide",
        "--target",
        t,
        "--session",
        "session",
        "--request",
        token,
        "--kind",
        kind,
        "--json",
    ];
    if let Some(s) = slug {
        a.extend(["--slug", s]);
    }
    run(cwd, &a)
}
fn work(cwd: &Path, slug: &str) {
    let o = run(
        cwd,
        &[
            "plan",
            "init",
            "--slug",
            slug,
            "--brief",
            "Fix ordinary request",
            "--require",
            "verified behavior",
        ],
    );
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}
#[test]
fn ordinary_requests_are_observed_without_classification_or_model_invocation() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir(d.path().join("providers")).unwrap();
    for name in ["codex", "claude", "gid"] {
        let provider = d.path().join("providers").join(name);
        fs::write(
            &provider,
            format!(
                "#!/bin/sh\nprintf invoked >> '{}'\nexit 99\n",
                d.path().join("provider-invoked").display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(provider, fs::Permissions::from_mode(0o755)).unwrap();
    }
    for t in ["codex", "claude", "gid"] {
        let out = hook(
            d.path(),
            t,
            event(d.path(), t, "one", "Fix the failing save behavior"),
        );
        assert!(out.to_string().contains("GDM_AUTOMATIC_ENTRY_V1"));
        let s = status(d.path(), t);
        assert!(s["requestId"].as_str().unwrap().len() > 20);
        assert!(s["kind"].is_null());
        assert!(!d.path().join(".gdm/sample").exists());
        assert!(s["slug"].is_null());
    }
    assert!(!d.path().join("provider-invoked").exists());
    let state = fs::read_dir(d.path().join(".gdm/.entry"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(!fs::read_to_string(state).unwrap().contains("failing save"));
}
#[test]
fn work_binding_replay_stale_tokens_and_request_scope() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    hook(p, "codex", event(p, "codex", "one", "Fix this"));
    let first = status(p, "codex")["requestId"].as_str().unwrap().to_owned();
    value(decide(p, "codex", &first, "work", None));
    work(p, "sample");
    let bound = value(decide(p, "codex", &first, "work", Some("sample")));
    assert_eq!(bound["slug"], "sample");
    assert_eq!(
        value(decide(p, "codex", &first, "work", Some("sample")))["slug"],
        "sample"
    );
    hook(p, "codex", event(p, "codex", "one", "Fix this"));
    assert_eq!(status(p, "codex")["requestId"], first);
    hook(p, "codex", event(p, "codex", "two", "Continue fixing"));
    let second = status(p, "codex");
    assert_ne!(second["requestId"], first);
    assert_eq!(second["activeWorkSlug"], "sample");
    assert!(
        !decide(p, "codex", &first, "question", None)
            .status
            .success()
    );
    hook(p, "codex", event(p, "codex", "one", "Fix this"));
    assert_eq!(status(p, "codex")["requestId"], second["requestId"]);
    work(p, "other");
    assert!(
        !decide(
            p,
            "codex",
            second["requestId"].as_str().unwrap(),
            "work",
            Some("other")
        )
        .status
        .success()
    );
    assert_eq!(
        value(decide(
            p,
            "codex",
            second["requestId"].as_str().unwrap(),
            "optout",
            None
        ))["activeWorkSlug"],
        "sample"
    );
}
#[test]
fn questions_and_optout_have_no_work_and_do_not_block() {
    for kind in ["question", "optout"] {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        hook(p, "claude", event(p, "claude", "one", "Explain the design"));
        let s = status(p, "claude");
        value(decide(
            p,
            "claude",
            s["requestId"].as_str().unwrap(),
            kind,
            None,
        ));
        let out = hook(
            p,
            "claude",
            json!({"session_id":"session","cwd":p,"hook_event_name":"Stop"}),
        );
        assert_eq!(out, json!({}));
        assert!(!p.join(".gdm/sample").exists());
    }
}
#[test]
fn direct_edit_gate_and_bounded_stop_are_observable() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    hook(p, "codex", event(p, "codex", "one", "Implement"));
    let edit =
        json!({"session_id":"session","cwd":p,"hook_event_name":"PreToolUse","tool_name":"Write"});
    assert_eq!(
        hook(p, "codex", edit.clone())["hookSpecificOutput"]["permissionDecision"],
        "deny"
    );
    let stop = json!({"session_id":"session","cwd":p,"hook_event_name":"Stop"});
    assert_eq!(hook(p, "codex", stop.clone())["decision"], "block");
    assert_eq!(hook(p, "codex", stop.clone()), json!({}));
    let s = status(p, "codex");
    value(decide(
        p,
        "codex",
        s["requestId"].as_str().unwrap(),
        "work",
        None,
    ));
    work(p, "sample");
    value(decide(
        p,
        "codex",
        s["requestId"].as_str().unwrap(),
        "work",
        Some("sample"),
    ));
    assert_eq!(
        hook(p, "codex", edit.clone())["hookSpecificOutput"]["permissionDecision"],
        "deny"
    );
    let o = run(
        p,
        &[
            "plan", "add", "--slug", "sample", "--desc", "behavior", "--cmd", "true", "--expect",
            "verified",
        ],
    );
    assert!(o.status.success());
    fs::write(p.join("roles.json"),json!({"schemaVersion":"gdm-team-plan/v1","executor":"native","maxActive":1,"modules":[{"id":"implementation","paths":["src"],"checks":["c1"],"deliverable":"Fix","acceptance":"verified"}],"independentVerification":false}).to_string()).unwrap();
    let o = run(
        p,
        &["team", "auto", "--slug", "sample", "--file", "roles.json"],
    );
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    assert_eq!(hook(p, "codex", edit), json!({}));
    let shell = hook(
        p,
        "codex",
        json!({"session_id":"session","cwd":p,"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"anything"}}),
    );
    assert_eq!(shell, json!({}));
}
#[test]
fn gid_real_envelope_continuation_and_advisory_behavior() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let first = event(p, "gid", "one", "Implement the change");
    hook(p, "gid", first.clone());
    let s = status(p, "gid");
    assert_eq!(s["enforcement"], "advisory");
    let mut continuation = first;
    continuation["invocation_id"] = json!("two");
    continuation["continuation_of"] = json!("one");
    hook(p, "gid", continuation);
    assert_eq!(status(p, "gid")["requestId"], s["requestId"]);
    let out = hook(
        p,
        "gid",
        json!({"schema":"gid-extension-event/v1","session_id":"session","cwd":p,"handler":{"type":"hook","event":"tool_call"},"payload":{"call":{"name":"write_file"}}}),
    );
    assert_eq!(out, json!({}));
}
#[test]
fn claude_pending_replay_reuses_token_but_decided_identical_prompt_is_new() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let e = event(p, "claude", "ignored", "Explain this");
    hook(p, "claude", e.clone());
    let s = status(p, "claude");
    hook(p, "claude", e.clone());
    assert_eq!(status(p, "claude")["requestId"], s["requestId"]);
    value(decide(
        p,
        "claude",
        s["requestId"].as_str().unwrap(),
        "question",
        None,
    ));
    hook(p, "claude", e);
    assert_ne!(status(p, "claude")["requestId"], s["requestId"]);
}
#[test]
fn workers_and_suppressed_provider_hooks_do_not_create_state() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let mut e = event(p, "codex", "one", "Implement");
    e["agent_id"] = json!("worker");
    assert_eq!(hook(p, "codex", e), json!({}));
    let mut c = cmd(p, &["entry", "hook", "--target", "claude"])
        .env("GDM_ENTRY_DISABLED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin.take().unwrap().write_all(b"malformed").unwrap();
    assert_eq!(value(c.wait_with_output().unwrap()), json!({}));
    assert!(!p.join(".gdm").exists());
}
#[test]
fn unsafe_state_and_malformed_identity_are_rejected() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), p.join(".gdm")).unwrap();
    assert!(
        gdm::integrations::entry::hook(p, "codex", &event(p, "codex", "one", "Fix").to_string())
            .is_err()
    );
    fs::remove_file(p.join(".gdm")).unwrap();
    let mut e = event(p, "codex", "one", "Fix");
    e["session_id"] = json!("");
    assert!(gdm::integrations::entry::hook(p, "codex", &e.to_string()).is_err());
    assert!(gdm::integrations::entry::hook(p, "codex", &" ".repeat(65537)).is_err());
    assert!(gdm::integrations::entry::hook(p, "codex", "[]").is_err());
}
