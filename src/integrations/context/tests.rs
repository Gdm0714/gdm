use super::*;
use serde_json::json;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    assert!(
        Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(&root)
            .status()
            .unwrap()
            .success()
    );
    for (p, s) in [
        (
            "src/state.ts",
            "import { journal } from './journal.ts';\nexport const boundary = journal;\n",
        ),
        ("src/journal.ts", "export const journal = true;\n"),
        (
            "test/state.test.ts",
            "import { boundary } from '../src/state.ts'; void boundary;\n",
        ),
        (
            "docs/architecture.md",
            "# Validation Boundary\n\nThe implementation is [`state.ts`](../src/state.ts).\n",
        ),
        (
            "package.json",
            "{\n  \"name\": \"@acme/core\",\n  \"scripts\": {\"verify\": \"true\"}\n}\n",
        ),
        (".github/CODEOWNERS", "/src/state.ts @backend\n"),
        (".env", "password = private-fixture-value\n"),
    ] {
        let target = root.join(p);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, s).unwrap();
    }
    dir
}
fn request(root: &Path) -> Value {
    json!({"schemaVersion":"gdm-context-query/v1","root":fs::canonicalize(root).unwrap(),"op":"pack","terms":["validation","boundary","backend","core"],"seeds":["src/state.ts"],"edgeTypes":schema::EDGES,"maxDepth":2,"budget":{"maxBytes":4096,"maxNodes":24,"maxEdges":48,"maxSnippets":5}})
}
#[test]
fn context_links_budget_and_trust() {
    let dir = fixture();
    let raw = request(dir.path());
    let root = raw["root"].as_str().unwrap();
    let pack = query(&raw, Some(root)).unwrap();
    assert_eq!(pack["st"], "ok");
    assert_eq!(pack["fr"], "fresh");
    assert!(
        pack["n"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n[0] == "owner:@backend")
    );
    assert!(!pack.to_string().contains("private-fixture-value"));
    assert!(pack.to_string().len() <= 4096);
    assert_eq!(query(&raw, None).unwrap()["st"], "untrusted");
    let mut small = raw.clone();
    small["budget"]["maxBytes"] = json!(512);
    assert!(query(&small, Some(root)).unwrap().to_string().len() <= 512);
    small["op"] = json!("route");
    let route = query(&small, Some(root)).unwrap();
    assert_eq!(route["e"], json!([]));
    assert_eq!(route["sn"], json!([]));
}
#[test]
fn rejects_encoded_and_compatibility_secrets() {
    let dir = fixture();
    for s in [
        "password = x",
        "Author%69zation: x",
        "Ａuthorization: x",
        "Author\u{200b}ization: x",
        "pass_word: x",
        r#"\"Authorization\": \"x\""#,
        "API: Overview",
    ] {
        let mut raw = request(dir.path());
        raw["terms"] = json!([s]);
        assert!(query(&raw, None).is_err(), "{s}");
    }
}
#[test]
fn corrupt_work_fails_closed() {
    let dir = fixture();
    fs::create_dir_all(dir.path().join(".gdm/broken")).unwrap();
    fs::write(dir.path().join(".gdm/broken/checks.json"), "{}").unwrap();
    let raw = request(dir.path());
    let pack = query(&raw, raw["root"].as_str()).unwrap();
    assert_eq!(pack["st"], "error");
    assert_eq!(pack["u"]["why"], json!(["gdm-metadata-invalid"]));
}
#[cfg(unix)]
#[test]
fn refuses_root_and_file_symlinks() {
    use std::os::unix::fs::symlink;
    let dir = fixture();
    symlink("state.ts", dir.path().join("src/link.ts")).unwrap();
    let raw = request(dir.path());
    let pack = query(&raw, raw["root"].as_str()).unwrap();
    assert!(
        pack["u"]["why"]
            .as_array()
            .unwrap()
            .contains(&json!("unsafe-or-nonregular-candidate-skipped"))
    );
    let mut graph = json!({"schemaVersion":"gdm-graph-query/v1","root":raw["root"],"entry":"src/link.ts","direction":"dependencies","maxDepth":2});
    assert!(super::graph::query(&graph).is_err());
    graph["entry"] = json!("../escape.ts");
    assert!(super::graph::query(&graph).is_err());
}
fn oracle(raw: &Value, graph: bool) -> Value {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut cmd = Command::new("bun");
    if graph {
        cmd.arg(repo.join("cli/src/graph-nav-provider.ts"))
            .arg("query");
    } else {
        cmd.arg("-e").arg("import {runContextQuery} from './cli/src/context-nav/index.ts'; const raw=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(runContextQuery(raw,{GDM_CONTEXT_TRUSTED_ROOT:raw.root}))); ").current_dir(repo);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Bun oracle must be installed when enabled");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(raw.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn native_matches_typescript_oracle() {
    if std::env::var_os("GDM_RUN_BUN_ORACLE").is_none() {
        return;
    }
    let dir = fixture();
    let raw = request(dir.path());
    assert_eq!(
        query(&raw, raw["root"].as_str()).unwrap(),
        oracle(&raw, false)
    );
    let mut raw = raw;
    for bytes in [512, 1024, 4096] {
        raw["budget"]["maxBytes"] = json!(bytes);
        for op in ["route", "pack"] {
            raw["op"] = json!(op);
            assert_eq!(
                query(&raw, raw["root"].as_str()).unwrap(),
                oracle(&raw, false),
                "{op} {bytes}"
            );
        }
    }
    for direction in ["dependencies", "dependents"] {
        let raw = json!({"schemaVersion":"gdm-graph-query/v1","root":raw["root"],"entry":"src/state.ts","direction":direction,"maxDepth":2});
        assert_eq!(super::graph::query(&raw).unwrap(), oracle(&raw, true));
    }
}
#[test]
fn graph_frontier_and_unresolved() {
    let dir = fixture();
    fs::write(
        dir.path().join("src/journal.ts"),
        "import './missing'; import('./lazy'); require('./req');\n",
    )
    .unwrap();
    let raw = json!({"schemaVersion":"gdm-graph-query/v1","root":fs::canonicalize(dir.path()).unwrap(),"entry":"src/state.ts","direction":"dependencies","maxDepth":1});
    let result = super::graph::query(&raw).unwrap();
    assert_eq!(result["coverage"]["completeWithinRequestedDepth"], false);
    assert!(
        result["unresolved"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["reason"] == "relative-target-unresolved-or-outside-candidate-cap")
    );
    if std::env::var_os("GDM_RUN_BUN_ORACLE").is_some() {
        assert_eq!(result, oracle(&raw, true));
    }
}

#[test]
fn native_work_projection_matches_typescript_oracle() {
    if std::env::var_os("GDM_RUN_BUN_ORACLE").is_none() {
        return;
    }
    let dir = fixture();
    let script = r#"
      import {initWork,addCheck,passCheck} from './cli/src/state.ts';
      import {saveWork,writeWorkOutput} from './cli/src/store.ts';
      import {createHash} from 'node:crypto';
      const root=process.env.GDM_FIXTURE_ROOT;
      let work=initWork('validation-boundary','Cobalt compass decision','2026-01-01T00:00:00.000Z',false,{required:[],forbidden:[],activeHabits:[],commit:'forbidden',allowedPaths:['src/state.ts']});
      work=addCheck(work,{desc:'Validation boundary has journal evidence',cmd:'true',expect:'journal evidence exists',kind:'behavior'}).work;
      saveWork(root,work);
      const body='EVIDENCE_BODY_MUST_NOT_BE_INDEXED\n';
      const observed=writeWorkOutput(root,work.slug,'c1.txt',body);
      work=passCheck(work,'c1',{observed,sha256:createHash('sha256').update(body).digest('hex'),exitCode:0,manual:false},'2026-01-01T00:01:00.000Z');
      saveWork(root,work);
    "#;
    let result = Command::new("bun")
        .arg("-e")
        .arg(script)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("GDM_FIXTURE_ROOT", fs::canonicalize(dir.path()).unwrap())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let raw = request(dir.path());
    let native = query(&raw, raw["root"].as_str()).unwrap();
    assert_eq!(native["st"], "ok", "{native}");
    assert_eq!(native, oracle(&raw, false));
    assert!(
        !native
            .to_string()
            .contains("EVIDENCE_BODY_MUST_NOT_BE_INDEXED")
    );
}
