#!/usr/bin/env python3
"""Headless executable gid-native -> scoped workers -> real GDM completion QA.

Uses supplied binaries and a deterministic tool-free Claude protocol fixture.
No build, provider connection, real authentication, desktop, or user state changes.
All runtime state is temporary; only a concise JSON assertion receipt is printed.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
SLUG = "gid-executable-e2e"
FINAL = "GID_GDM_EXECUTABLE_E2E_DONE"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def terminate_tree(process):
    """Snapshot only our descendants before signalling their owned groups."""
    listing = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,pgid="], capture_output=True,
        text=True, timeout=5, check=True,
    )
    rows = [tuple(map(int, line.split())) for line in listing.stdout.splitlines()]
    owned = {process.pid}
    while True:
        expanded = owned | {pid for pid, parent, _ in rows if parent in owned}
        if expanded == owned:
            break
        owned = expanded
    groups = {group for pid, _, group in rows if pid in owned}
    groups.discard(os.getpgrp())
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for group in groups:
            try:
                os.killpg(group, sig)
            except ProcessLookupError:
                pass
        for pid in owned:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        if sig == signal.SIGTERM:
            time.sleep(0.2)
    process.wait(timeout=5)


def run(argv, cwd, env, timeout=30):
    process = subprocess.Popen(
        [str(arg) for arg in argv], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except BaseException:
        terminate_tree(process)
        raise
    require(process.returncode == 0,
            f"{Path(str(argv[0])).name} exited {process.returncode}:\n"
            f"{stderr[-5000:]}\n{stdout[-7000:]}")
    return stdout


FAKE_CLAUDE = r'''
import json
import os
from pathlib import Path
import re
import shlex
import sys

CONFIG = __FIXTURE_CONFIG__
args = sys.argv[1:]
def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)
if args == ["--version"]:
    print("2.1.0 (Claude Code deterministic fixture)")
    sys.exit(0)
if args == ["auth", "status", "--json"]:
    emit({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty"})
    sys.exit(0)
def pair(flag, value):
    return any(args[i:i+2] == [flag, value] for i in range(len(args)-1))
assert "--safe-mode" in args and "--no-session-persistence" in args
assert pair("--tools", "") and pair("--permission-mode", "dontAsk")
assert pair("--mcp-config", '{"mcpServers":{}}') and "--strict-mcp-config" in args
assert pair("--input-format", "stream-json")
for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
    assert key not in os.environ, "credential passed to fixture"
raw = sys.stdin.read()
raw = json.loads(raw)["message"]["content"][0]["text"]
context = json.loads(raw.rsplit("\n\n", 1)[1])
assert "PI_E2E_MUST_NOT_LOAD" not in raw
policy = json.loads(re.search(r"^gid_execution_policy=(.+)$", context["system"], re.M).group(1))
session = policy["sessionId"]
results = {m["tool_result"]["call_id"]: m["tool_result"] for m in context["messages"] if m.get("tool_result")}
tools = {tool["name"] for tool in context["tools"]}
reply = {"text": "", "thinking": "", "tool_calls": []}
def call(ident, name, arguments):
    assert name in tools, (name, tools)
    reply["tool_calls"] = [{"id": ident, "name": name, "arguments_json": json.dumps(arguments)}]
def successful(ident):
    assert ident in results and not results[ident]["is_error"], results.get(ident)
    return results[ident]["content"]
def gdm(*arguments):
    return " ".join(["GDM_CONFIG_DIR=" + shlex.quote(CONFIG["gdm_config"]),
                     shlex.quote(CONFIG["gdm"]), "--language", "en",
                     *(shlex.quote(str(value)) for value in arguments)])
def commands(lines):
    return "set -eu\n" + "\n".join(lines)
work_path = Path(CONFIG["workspace"]) / ".gdm" / CONFIG["slug"] / "checks.json"
done = work_path.exists() and json.loads(work_path.read_text())["done"]
loaded_gid = False
if policy["delegatedWorker"]:
    assert "delegate_tasks" not in tools
    assert policy["access"] == "workspace-write", policy
    prompt = "\n".join(m.get("text", "") for m in context["messages"] if m["role"] == "user")
    task = next(name for name in ("alpha", "beta") if "E2E_WORKER_" + name in prompt)
    prefix = "child-" + task
    if prefix + "-scope" not in results:
        call(prefix + "-scope", "write", {"path": "forbidden-" + task + ".txt", "content": "must not exist"})
    elif prefix + "-write" not in results:
        denied = results[prefix + "-scope"]
        assert denied["is_error"], denied
        assert "outside this delegated task's paths" in denied["content"], denied
        call(prefix + "-write", "write", {"path": "owned/" + task + ".txt", "content": task + " from scoped gid worker\n"})
    else:
        successful(prefix + "-write")
        reply["text"] = "CHILD_RESULT_" + task + ": wrote owned/" + task + ".txt; out-of-scope write denied; coordinator verification required."
else:
    assert "delegate_tasks" in tools
    assert all(not ident.startswith("child-") for ident in results), "child results injected into parent context"
    if "root-skill" not in results:
        call("root-skill", "read_skill", {"name": "gdm-go"})
    else:
        skill = successful("root-skill")
        assert "target ID: `gid`" in skill and "delegate_tasks" in skill
        assert "target ID: `codex`" not in skill and "target ID: `claude`" not in skill
        loaded_gid = True
        if "root-plan" not in results:
            lines = [gdm("plan", "init", "--slug", CONFIG["slug"], "--brief", "Verify two real scoped gid workers through GDM completion",
                         "--require", "Both worker deliverables must pass real checks and coordinator review", "--risk", "low", "--verification", "deterministic")]
            for task in ("alpha", "beta"):
                check = shlex.join([CONFIG["python"], "-c", "from pathlib import Path; assert Path(" + repr("owned/" + task + ".txt") + ").read_text() == " + repr(task + " from scoped gid worker\n")])
                lines.append(gdm("plan", "add", "--slug", CONFIG["slug"], "--desc", task + " delegated output", "--cmd", check,
                                 "--expect", "exact scoped worker content", "--kind", "behavior"))
            lines.append(gdm("team", "configure", "--slug", CONFIG["slug"], "--mode", "coordinated", "--max-active", "2", "--session", session))
            for task, check_id in (("alpha", "c1"), ("beta", "c2")):
                lines.append(gdm("team", "add", "--slug", CONFIG["slug"], "--task", task, "--role", "implementation",
                                 "--path", "owned/" + task + ".txt", "--access", "write", "--deliverable", task + " text file",
                                 "--acceptance", "exact scoped worker content", "--check", check_id))
                lines.append(gdm("team", "claim", "--slug", CONFIG["slug"], "--task", task, "--assignee", "worker-" + task, "--attempt", task + "-a1"))
            call("root-plan", "bash", {"command": commands(lines), "timeout": 30})
        elif "root-delegate" not in results:
            successful("root-plan")
            work = json.loads(work_path.read_text())
            assert work["team"]["sessionId"] == session
            assert [task["status"] for task in work["team"]["tasks"]] == ["active", "active"]
            call("root-delegate", "delegate_tasks", {"tasks": [
                {"id": task, "prompt": "E2E_WORKER_" + task + ": write your owned text file and report observed verification. Preserve other workers' files.",
                 "paths": ["owned/" + task + ".txt"], "access": "write", "deliverable": task + " text file", "acceptance": "exact scoped worker content"}
                for task in ("alpha", "beta")]})
        elif "root-evidence" not in results:
            observed = successful("root-delegate")
            assert all("CHILD_RESULT_" + task in observed for task in ("alpha", "beta")), observed
            call("root-evidence", "write", {"path": "worker-results.md", "content":
                 "# Collected gid worker observations\n\nRoot session: " + session + "\n\n" + observed +
                 "\n\nThese collected observations are not acceptance. The coordinator will execute GDM checks and reviews next.\n"})
        elif "root-finish" not in results:
            successful("root-evidence")
            lines = []
            for task, check_id in (("alpha", "c1"), ("beta", "c2")):
                lines.append(gdm("pass", check_id, "--slug", CONFIG["slug"]))
                lines.append(gdm("team", "report", "--slug", CONFIG["slug"], "--task", task, "--attempt", task + "-a1", "--outcome", "completed",
                                 "--summary", "Collected worker result and executed exact-content check", "--artifact", "worker-results.md"))
                lines.append(gdm("team", "review", "--slug", CONFIG["slug"], "--task", task, "--attempt", task + "-a1", "--decision", "accept",
                                 "--reason", "Exact content check passed and collected worker report was reviewed"))
            lines.append(gdm("done", "--slug", CONFIG["slug"]))
            call("root-finish", "bash", {"command": commands(lines), "timeout": 30})
        else:
            successful("root-finish")
            assert done, "root completion attempted before GDM Work done"
            reply["text"] = CONFIG["final"]
record = {"session": session, "policy": policy, "toolNames": sorted(tools),
          "resultIds": sorted(results), "decision": reply, "gidSkillLoaded": loaded_gid,
          "workDoneBeforeDecision": bool(done)}
with (Path(CONFIG["records"]) / (session + ".jsonl")).open("a") as stream:
    stream.write(json.dumps(record) + "\n")
emit({"type": "system", "subtype": "init", "tools": ["StructuredOutput"]})
emit({"type": "result", "subtype": "success", "is_error": False, "structured_output": reply,
      "usage": {"input_tokens": 10, "output_tokens": 5}})
'''


def records(database):
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        return [(kind, json.loads(payload)) for kind, payload in connection.execute(
            "SELECT kind, payload FROM entries ORDER BY seq")]
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gid", type=Path, required=True, help="existing gid executable")
    parser.add_argument("--gdm", type=Path, required=True, help="existing GDM executable")
    options = parser.parse_args()
    gid, gdm = options.gid.resolve(strict=True), options.gdm.resolve(strict=True)
    require(os.access(gid, os.X_OK) and os.access(gdm, os.X_OK), "both binaries must be executable")
    binary_hashes = {"gidSHA256": hashlib.sha256(gid.read_bytes()).hexdigest(),
                     "gdmSHA256": hashlib.sha256(gdm.read_bytes()).hexdigest()}
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="gid-gdm-executable-e2e-") as temporary:
        temporary = Path(temporary).resolve()
        workspace, data, config = (temporary / name for name in ("workspace", "gid-data", "gid-config"))
        for directory in (workspace, data, config, temporary / "records", workspace / "fixture-config"):
            directory.mkdir()
        # Minimal inherited environment: no credentials, provider settings, hooks,
        # remote-control endpoints or user session identifiers enter the fixture.
        env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT") if key in os.environ}
        env.update(GID_DATA_DIR=str(data), GID_CONFIG_DIR=str(config),
                   GDM_CONFIG_DIR=str(workspace / "fixture-config"), GDM_COMMAND_TIMEOUT_MS="10000")
        run([gdm, "render-skills", "--target", "gid", "--source-root", ROOT / "skills",
             "--agents-root", ROOT / "agents", "--output", config / "skills"], workspace, env)
        manifest = json.loads((config / "skills/gdm-target-manifest.json").read_text())
        require(manifest["target"] == "gid", "renderer did not produce gid target")
        pi = workspace / ".pi/skills/pi-only"
        pi.mkdir(parents=True)
        (pi / "SKILL.md").write_text("---\nname: pi-only\ndescription: PI_E2E_MUST_NOT_LOAD\n---\nPI_E2E_MUST_NOT_LOAD\n")
        fake = temporary / "fake-claude.py"
        fixture = {"gdm": str(gdm), "python": sys.executable, "workspace": str(workspace),
                   "gdm_config": env["GDM_CONFIG_DIR"], "slug": SLUG, "final": FINAL,
                   "records": str(temporary / "records")}
        fake.write_text("#!" + sys.executable + "\n" + FAKE_CLAUDE.replace("__FIXTURE_CONFIG__", repr(fixture)))
        fake.chmod(0o700)
        output = run([gid, "--engine", "native", "--provider", "claude", "--claude", fake,
                      "--mode", "json", "--cwd", workspace, "--permissions", "skip", "--sandbox", "off",
                      "--no-context-files", "--no-prompt-templates", "--no-skills",
                      "--skill", config / "skills/gdm-go/SKILL.md", "--model-retries", "0",
                      "--no-usage-records", "--print", "Run the deterministic gid GDM delegation fixture."],
                     workspace, env, timeout=150)
        events = [json.loads(line) for line in output.splitlines() if line.strip()]
        session = next(event["session"]["id"] for event in events if event["type"] == "session")
        require(events[-1]["type"] == "agent_end" and events[-1]["success"], "native agent did not finish successfully")
        completions = [event["message"] for event in events if event["type"] == "message_end" and not event["message"]["tool_calls"]]
        require(len(completions) == 1 and completions[0]["text"] == FINAL, "unexpected root completion or leaked child answer")
        root_calls = [event for event in events if event["type"].startswith("tool_execution_")]
        require(all(event["toolCallId"].startswith("root-") for event in root_calls), "child tool event leaked into root event stream")
        require(all(not event["isError"] for event in root_calls if event["type"] == "tool_execution_end"), "root tool failed")
        work = json.loads((workspace / ".gdm" / SLUG / "checks.json").read_text())
        require(work["done"] and work["doneAt"], "real GDM Work is not done")
        require(work["team"]["sessionId"] == session, "GDM Work is not bound to runtime session")
        require(len(work["checks"]) == 2 and all(check["status"] == "proven" for check in work["checks"]), "checks lack real GDM evidence")
        for check in work["checks"]:
            evidence = check["evidence"]
            require(evidence["exitCode"] == 0 and not evidence["manual"], "check did not execute successfully")
            require(hashlib.sha256((workspace / evidence["observed"]).read_bytes()).hexdigest() == evidence["sha256"], "GDM check evidence hash mismatch")
        journal = [json.loads(line) for line in (workspace / ".gdm" / SLUG / "journal.jsonl").read_text().splitlines()]
        require(any(event.get("event") == "done" for event in journal), "GDM completion journal record missing")
        for task in work["team"]["tasks"]:
            name = task["id"]
            require(task["status"] == "accepted", f"task {name} lacks coordinator acceptance")
            require((workspace / "owned" / (name + ".txt")).read_text() == name + " from scoped gid worker\n", "worker output incorrect")
            require(not (workspace / ("forbidden-" + name + ".txt")).exists(), "worker escaped its declared write scope")
            attempt = task["attempts"][0]
            require(attempt["report"]["outcome"] == "completed" and attempt["review"]["decision"] == "accept", "missing real report/review")
            archive = attempt["report"]["archivedArtifact"]
            require(hashlib.sha256((workspace / archive["path"]).read_bytes()).hexdigest() == archive["sha256"], "GDM archived evidence hash mismatch")
        model_records = [json.loads(line) for path in (temporary / "records").glob("*.jsonl") for line in path.read_text().splitlines()]
        root_records = [row for row in model_records if not row["policy"]["delegatedWorker"]]
        child_records = [row for row in model_records if row["policy"]["delegatedWorker"]]
        require(any(row["gidSkillLoaded"] for row in root_records), "native read_skill did not load gid variant")
        require({row["session"] for row in root_records} == {session}, "model used invented coordinator session")
        require(len({row["session"] for row in child_records}) == 2, "two genuine child sessions were not executed")
        require(all("delegate_tasks" not in row["toolNames"] for row in child_records), "leaf worker can delegate recursively")
        final_records = [row for row in root_records if row["decision"]["text"] == FINAL]
        require(len(final_records) == 1 and final_records[0]["workDoneBeforeDecision"], "final answer preceded Work done")
        databases = list(data.rglob("sessions.sqlite3"))
        root_entries = next(rows for path in databases if (rows := records(path)) and any(kind == "delegation_started" for kind, _ in rows))
        terminals = [payload for kind, payload in root_entries if kind == "delegation_result"]
        require(len(terminals) == 2 and all(row["status"] == "completed" for row in terminals), "durable child terminal records missing")
        require({row["sessionId"] for row in terminals} == {row["session"] for row in child_records}, "collected results do not match real child sessions")
        require(all(not payload.get("call_id", "").startswith("child-") for kind, payload in root_entries if kind == "tool_result"), "child tool results injected into root history")
        require(binary_hashes["gidSHA256"] == hashlib.sha256(gid.read_bytes()).hexdigest()
                and binary_hashes["gdmSHA256"] == hashlib.sha256(gdm.read_bytes()).hexdigest(),
                "supplied executable changed during verification; rerun with stable binaries")
        receipt = {"status": "passed", **binary_hashes, "elapsedSeconds": round(time.monotonic() - started, 2),
                   "assertions": ["real native Claude transport with tool-free fixture", "gid-target gdm-go loaded by native read_skill",
                                  "runtime session bound to real GDM Work", "two real scoped leaf workers joined",
                                  "two forbidden writes denied", "no Pi instruction loaded", "no child answer or tool completion leaked to root",
                                  "GDM checks, hashed reports, coordinator reviews and done", "single root final after Work done"]}
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
