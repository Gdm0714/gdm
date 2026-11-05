#!/usr/bin/env python3
"""Credential-free real gid entry/dispatch smoke with deterministic model transport.

The real installed gid executable registers and executes the GDM extension,
tools, scoped children and completion guard. Only model replies are fixtures.
No provider connection, authentication, desktop interaction or git operation.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
# Import process-isolation helpers without writing bytecode into the checkout.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("gid_team_fixture", Path(__file__).with_name("gid-team-e2e.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
require, run = base.require, base.run
PROMPT = "Create independent alpha and beta text outputs and verify their exact contents before finishing."
SLUG = "automatic-entry-fixture"
FINAL = "AUTOMATIC_ENTRY_FIXTURE_DONE"


MODEL = r'''
import json, os, re, shlex, sys
from pathlib import Path
CONFIG = __CONFIG__
args = sys.argv[1:]
if args == ["--version"]:
    print("2.1.0 (deterministic Claude transport fixture)"); sys.exit(0)
if args == ["auth", "status", "--json"]:
    print(json.dumps({"loggedIn":True,"authMethod":"claude.ai","apiProvider":"firstParty"})); sys.exit(0)
assert "--safe-mode" in args and "--no-session-persistence" in args
assert args[args.index("--tools")+1] == ""
for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
    assert key not in os.environ
outer = json.loads(sys.stdin.read())
raw = outer["message"]["content"][0]["text"]
context = json.loads(raw.rsplit("\n\n",1)[1])
policy = json.loads(re.search(r"^gid_execution_policy=(.+)$",context["system"],re.M).group(1))
session = policy["sessionId"]
results = {m["tool_result"]["call_id"]:m["tool_result"] for m in context["messages"] if m.get("tool_result")}
tools = {tool["name"] for tool in context["tools"]}
users = "\n".join(m.get("text","") for m in context["messages"] if m["role"] == "user")
reply = {"text":"","thinking":"","tool_calls":[]}
workpath = Path(CONFIG["workspace"])/".gdm"/CONFIG["slug"] / "checks.json"
work = json.loads(workpath.read_text()) if workpath.exists() else None
def call(ident,name,arguments):
    assert name in tools,(name,tools)
    reply["tool_calls"] = [{"id":ident,"name":name,"arguments_json":json.dumps(arguments)}]
def good(ident):
    assert ident in results and not results[ident]["is_error"],results.get(ident)
    return results[ident]["content"]
def gdm(*args):
    return " ".join(["GDM_CONFIG_DIR="+shlex.quote(CONFIG["gdm_config"]),
                     "GDM_CLAUDE_EXECUTABLE="+shlex.quote(CONFIG["planner"]),
                     shlex.quote(CONFIG["gdm"]),"--language en",*(shlex.quote(str(a)) for a in args)])
def bash(ident,lines):
    call(ident,"bash",{"command":"set -eu\n"+"\n".join(lines),"timeout":30})
def decide(kind,slug=None):
    matches = re.findall(r"request token: ([A-Za-z0-9_-]+)\.",users)
    assert matches,"real input extension context absent"
    return gdm("entry","decide","--target","gid","--session",session,"--request",matches[-1],"--kind",kind,
               *(["--slug",slug] if slug else []),"--json")
def claim(task):
    return gdm("team","claim","--slug",CONFIG["slug"],"--task",task,"--assignee","worker-"+task,"--attempt",task+"-a1")
def accept(task,check):
    return [gdm("pass",check,"--slug",CONFIG["slug"]),
            gdm("team","report","--slug",CONFIG["slug"],"--task",task,"--attempt",task+"-a1","--outcome","completed",
                "--summary","Observed native worker result and executed linked check","--artifact","worker-results.md"),
            gdm("team","review","--slug",CONFIG["slug"],"--task",task,"--attempt",task+"-a1","--decision","accept",
                "--reason","Reviewed collected worker result and exact content evidence")]
def dispatch(ids,ident):
    tasks = {t["id"]:t for t in work["team"]["tasks"]}
    actions = {a["taskId"]:a for a in json.loads((Path(CONFIG["workspace"])/"fixture-next.json").read_text())["actions"] if a["action"]=="dispatch"}
    assert all(tasks[task]["status"] == "active" for task in ids),"claim must precede native dispatch"
    assert all(actions[task]["paths"]==tasks[task]["paths"] and actions[task]["route"]["model"]=="inherit" for task in ids)
    call(ident,"delegate_tasks",{"tasks":[{"id":task,"prompt":actions[task]["prompt"]+"\nAUTOMATIC_WORKER_"+task+". Perform only the declared task and return observed results. Do not initialize root entry or delegate.",
         "paths":actions[task]["paths"],"access":actions[task]["access"],"deliverable":actions[task]["deliverable"],"acceptance":actions[task]["acceptance"]} for task in ids]})
if policy["delegatedWorker"]:
    assert "delegate_tasks" not in tools
    task = next(t for t in ("implement-alpha","implement-beta","verify") if "AUTOMATIC_WORKER_"+t in users)
    if task == "verify":
        assert policy["access"] == "read-only",policy
        if "child-read-alpha" not in results:
            call("child-read-alpha","read",{"path":"owned/alpha.txt"})
        elif "child-read-beta" not in results:
            assert "alpha from scoped gid worker" in good("child-read-alpha")
            call("child-read-beta","read",{"path":"owned/beta.txt"})
        else:
            assert "beta from scoped gid worker" in good("child-read-beta")
            reply["text"] = "CHILD_RESULT_verify independently read both exact output contents."
    else:
        task = task.removeprefix("implement-")
        assert policy["access"] == "workspace-write",policy
        if "child-scope" not in results:
            call("child-scope","write",{"path":"forbidden-"+task+".txt","content":"must not exist"})
        elif "child-write" not in results:
            assert results["child-scope"]["is_error"] and "outside this delegated task's paths" in results["child-scope"]["content"]
            call("child-write","write",{"path":"owned/"+task+".txt","content":task+" from scoped gid worker\n"})
        else:
            good("child-write"); reply["text"]="CHILD_RESULT_"+task+" wrote owned content and observed scope denial."
elif CONFIG["scenario"] in ("question","optout"):
    assert "GDM_AUTOMATIC_ENTRY_V1" in users
    if "root-lightweight" not in results:
        bash("root-lightweight",[decide(CONFIG["scenario"])])
    else:
        good("root-lightweight"); reply["text"]="LIGHTWEIGHT_"+CONFIG["scenario"]
else:
    assert CONFIG["prompt"] in users,"plain language request was replaced"
    assert "GDM_AUTOMATIC_ENTRY_V1" in users,"installed input hook not observed"
    if "root-skill" not in results:
        call("root-skill","read_skill",{"name":"gdm-go"})
    elif "root-plan" not in results:
        skill=good("root-skill")
        assert "target ID: `gid`" in skill and "GDM_AUTOMATIC_ENTRY_V1" in skill
        lines=[decide("work"),gdm("plan","init","--slug",CONFIG["slug"],"--brief",CONFIG["prompt"],"--require","Exact independent outputs and reviewed verification","--risk","low","--verification","deterministic")]
        for name in ("alpha","beta","both"):
            names=("alpha","beta") if name=="both" else (name,)
            code="from pathlib import Path; "+"; ".join("assert Path("+repr("owned/"+n+".txt")+").read_text() == "+repr(n+" from scoped gid worker\n") for n in names)
            lines.append(gdm("plan","add","--slug",CONFIG["slug"],"--desc",name+" exact output","--cmd",shlex.join([CONFIG["python"],"-c",code]),"--expect","Exact scoped content","--kind","behavior"))
        lines += [decide("work",CONFIG["slug"]),gdm("team","configure","--slug",CONFIG["slug"],"--mode","coordinated","--max-active","2","--session",session),
                  gdm("team","auto","--slug",CONFIG["slug"],"--from-request","--provider","claude","--model","sonnet","--max-active","2","--executor","native"),
                  gdm("team","auto","--slug",CONFIG["slug"],"--from-request","--provider","claude","--model","sonnet","--max-active","2","--executor","native"),
                  "if "+gdm("done","--slug",CONFIG["slug"])+"; then exit 91; fi"]
        bash("root-plan",lines)
    elif "GDM completion guard:" not in users:
        good("root-plan"); reply["text"]="EARLY_COMPLETION_MUST_BE_CORRECTED"
    elif "root-claims" not in results:
        bash("root-claims",[gdm("entry","status","--target","gid","--session",session,"--json"),gdm("team","next","--slug",CONFIG["slug"])+" > fixture-next.json",claim("implement-alpha"),claim("implement-beta")])
    elif "root-delegate" not in results:
        good("root-claims"); dispatch(["implement-alpha","implement-beta"],"root-delegate")
    elif "root-evidence" not in results:
        output=good("root-delegate")
        assert "CHILD_RESULT_alpha" in output and "CHILD_RESULT_beta" in output,output
        call("root-evidence","write",{"path":"worker-results.md","content":"Collected native implementation observations.\n"+output+"\n"})
    elif "root-review" not in results:
        good("root-evidence")
        bash("root-review",accept("implement-alpha","c1")+accept("implement-beta","c2")+[gdm("team","next","--slug",CONFIG["slug"])+" > fixture-next.json",claim("verify")])
    elif "root-verify" not in results:
        good("root-review"); dispatch(["verify"],"root-verify")
    elif "root-verification-report" not in results:
        output=good("root-verify"); assert "CHILD_RESULT_verify" in output,output
        old=(Path(CONFIG["workspace"])/"worker-results.md").read_text()
        # A new report artifact preserves hashes of the implementation reports.
        call("root-verification-report","write",{"path":"verification-result.md","content":old+output+"\n"})
    elif "root-finish" not in results:
        good("root-verification-report")
        commands=accept("verify","c3")
        commands[1]=commands[1].replace("worker-results.md","verification-result.md")
        bash("root-finish",commands+[gdm("team","next","--slug",CONFIG["slug"]),gdm("done","--slug",CONFIG["slug"])])
    else:
        good("root-finish"); assert work["done"]; reply["text"]=CONFIG["final"]
record={"session":session,"policy":policy,"toolNames":sorted(tools),"decision":reply,
        "entryObserved":"GDM_AUTOMATIC_ENTRY_V1" in users,"guardObserved":"GDM completion guard:" in users,"workDone":bool(work and work["done"])}
with (Path(CONFIG["records"])/(session+".jsonl")).open("a") as stream: stream.write(json.dumps(record)+"\n")
print(json.dumps({"type":"system","subtype":"init","tools":["StructuredOutput"]}))
print(json.dumps({"type":"result","subtype":"success","is_error":False,"structured_output":reply,"usage":{"input_tokens":10,"output_tokens":5}}))
'''


PLANNER = r'''
import json, os, sys
from pathlib import Path
CONFIG = __CONFIG__
if sys.argv[1:] == ["--version"]:
    print("2.1.0 (planner fixture)"); sys.exit(0)
assert os.environ.get("GDM_ENTRY_DISABLED") == "1", "planner entry recursion not suppressed"
raw=sys.stdin.read()
assert CONFIG["prompt"] in raw,"original plain language request missing from planner input"
executor="unavailable" if '"executor": "unavailable"' in raw or '"executor":"unavailable"' in raw else "native"
def assignment(paths,checks):
    return {"paths":paths,"checks":checks,"deliverable":"Reviewable scoped result","acceptance":"Exact requested contents observed","routeId":"native-inherit","createPaths":[]}
modules=[]
for name,check in (("alpha","c1"),("beta","c2")):
    role=assignment(["owned/"+name+".txt"],[check])
    role.update(id=name,dependsOn=[],knowledgeIndependentReason=None)
    modules.append(role)
value={"plan":{"schemaVersion":"gdm-team-plan/v1","executor":executor,"maxActive":2,"knowledge":None,"modules":modules,
               "verification":assignment(["owned"],["c3"]),"independentVerification":None},
       "rationale":"Two independent bounded outputs use two available workers. A separate read only worker verifies both after implementation review."}
with Path(CONFIG["planner_log"]).open("a") as stream: stream.write(json.dumps({"executor":executor,"entryDisabled":True})+"\n")
print(json.dumps({"type":"result","subtype":"success","is_error":False,"structured_output":value,"usage":{"input_tokens":10,"output_tokens":5}}))
'''


def json_command(argv, workspace, env):
    return json.loads(run(argv, workspace, env))


def hook(gdm, target, envelope, workspace, env):
    result = subprocess.run([str(gdm), "entry", "hook", "--target", target], input=json.dumps(envelope),
                            text=True, capture_output=True, cwd=workspace, env=env, timeout=10)
    require(result.returncode == 0, result.stderr)
    return json.loads(result.stdout)


def configuration_preservation(gdm, workspace, env, home):
    env = dict(env, CODEX_HOME=str(home / ".codex"))
    original = {"permissions":{"defaultMode":"default"},"userSetting":"preserve",
                "hooks":{"UserPromptSubmit":[{"matcher":"user-matcher","hooks":[{"type":"command","command":"echo unrelated-user-hook"}]}]}}
    for target, path in (("codex",home / ".codex/hooks.json"),("claude",home / ".claude/settings.json")):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(original))
        before=path.read_bytes()
        json_command([gdm,"entry","install","--target",target,"--binary",gdm,"--dry-run","--json"],workspace,env)
        require(path.read_bytes()==before,"dry run changed existing settings")
        json_command([gdm,"entry","install","--target",target,"--binary",gdm,"--json"],workspace,env)
        installed=path.read_bytes()
        value=json.loads(installed)
        require(value["permissions"]==original["permissions"] and value["userSetting"]=="preserve","entry install changed user settings")
        require(original["hooks"]["UserPromptSubmit"][0] in value["hooks"]["UserPromptSubmit"],"entry install lost unrelated matcher or hook")
        json_command([gdm,"entry","install","--target",target,"--binary",gdm,"--json"],workspace,env)
        require(path.read_bytes()==installed,"entry install is not byte idempotent")
        # New user edits survive managed-only uninstall, with the backup retained.
        value["newUserSetting"]=True
        path.write_text(json.dumps(value))
        json_command([gdm,"entry","uninstall","--target",target,"--json"],workspace,env)
        require(json.loads(path.read_bytes())==dict(original,newUserSetting=True),"uninstall lost unrelated config or retained entry handlers")
        require(path.with_suffix(".json.gdm-entry-backup").read_bytes()==before,"original backup was not preserved")


def unavailable_executor(gdm, temporary, env, planner):
    workspace=temporary / "blocked-workspace"
    (workspace / "owned").mkdir(parents=True)
    for name in ("alpha","beta"):
        (workspace / "owned" / (name+".txt")).write_text("pending\n")
    env=dict(env,GDM_CLAUDE_EXECUTABLE=str(planner))
    run([gdm,"plan","init","--slug","blocked","--brief",PROMPT,"--require","Exact independently verified outputs","--risk","low","--verification","deterministic"],workspace,env)
    for desc in ("alpha","beta","both"):
        run([gdm,"plan","add","--slug","blocked","--desc",desc,"--cmd","true","--expect","Exact content"],workspace,env)
    json_command([gdm,"team","auto","--slug","blocked","--from-request","--provider","claude","--model","sonnet","--max-active","2","--executor","unavailable"],workspace,env)
    next_action=json_command([gdm,"team","next","--slug","blocked"],workspace,env)
    require(next_action["actions"][0]["action"]=="blocked" and "team_executor_unavailable" in json.dumps(next_action),"missing executor did not remain blocked")
    state=json.loads((workspace / ".gdm/blocked/checks.json").read_text())
    require(not state["done"] and all(not task["attempts"] for task in state["team"]["tasks"]),"missing executor dispatched or completed work")
    done=subprocess.run([str(gdm),"done","--slug","blocked"],cwd=workspace,env=env,capture_output=True,text=True,timeout=10)
    require(done.returncode!=0 and "team_executor_unavailable" in done.stderr,"unavailable executor completion was not rejected")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gid", type=Path, default=shutil.which("gid"))
    parser.add_argument("--gdm", type=Path, default=ROOT / "target/release/gdm", help="current release-sized executable; build with cargo build --release --locked")
    options = parser.parse_args()
    require(options.gid is not None, "gid executable is required")
    gid, source_gdm = options.gid.resolve(strict=True), options.gdm.resolve(strict=True)
    hashes = {"gidSHA256":hashlib.sha256(gid.read_bytes()).hexdigest(),"gdmSourceSHA256":hashlib.sha256(source_gdm.read_bytes()).hexdigest()}
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="gdm-automatic-entry-e2e-") as temporary:
        temporary = Path(temporary).resolve()
        workspace, config, data, home = (temporary / n for n in ("workspace","gid-config","gid-data","home"))
        for directory in (workspace, config, data, home, temporary / "bin", temporary / "records", workspace / "owned", workspace / "fixture-config"):
            directory.mkdir()
        # gid caps pinned executables at 32 MiB. Strip only an isolated copy of
        # a debug build; the caller's binary stays byte-for-byte unchanged.
        gdm = temporary / "bin/gdm"
        shutil.copy2(source_gdm, gdm)
        if gdm.stat().st_size > 32 * 1024 * 1024:
            strip = ["/usr/bin/strip", "-S", "-x", gdm] if sys.platform == "darwin" else ["strip", "--strip-debug", gdm]
            run(strip, workspace, {"PATH":"/usr/bin:/bin"})
        require(gdm.stat().st_size <= 32 * 1024 * 1024, "current GDM executable exceeds gid's pinned-program limit after stripping")
        hashes["gdmExecutedSHA256"] = hashlib.sha256(gdm.read_bytes()).hexdigest()
        (temporary / "bin/gid").symlink_to(gid)
        env = {"HOME":str(home),"PATH":str(temporary / "bin")+":/usr/bin:/bin:/usr/sbin:/sbin","LANG":"en_US.UTF-8",
               "GID_CONFIG_DIR":str(config),"GID_DATA_DIR":str(data),"GDM_CONFIG_DIR":str(workspace / "fixture-config"),"GDM_COMMAND_TIMEOUT_MS":"10000"}
        for name in ("alpha","beta"):
            (workspace / "owned" / (name+".txt")).write_text("pending\n")
        fixture = {"workspace":str(workspace),"gdm":str(gdm),"gdm_config":env["GDM_CONFIG_DIR"],"slug":SLUG,
                   "python":sys.executable,"records":str(temporary / "records"),"prompt":PROMPT,"final":FINAL,
                   "planner":str(temporary / "planner.py"),"planner_log":str(temporary / "planner.jsonl"),"scenario":"work"}
        planner = temporary / "planner.py"
        planner.write_text("#!"+sys.executable+"\n"+PLANNER.replace("__CONFIG__",repr(fixture)))
        planner.chmod(0o700)
        run([gdm,"render-skills","--target","gid","--source-root",ROOT / "skills","--agents-root",ROOT / "agents","--output",config / "skills"],workspace,env)
        installed=json_command([gdm,"entry","install","--target","gid","--binary",gdm,"--json"],workspace,env)
        require(installed["registered"],"actual gid extension registration failed")
        extension = config / "gdm-entry-v1.json"
        if not extension.exists():
            extension = next(config.rglob("gdm-entry-v1.json"))
        extension_bytes=extension.read_bytes()
        require(json_command([gdm,"entry","install","--target","gid","--binary",gdm,"--json"],workspace,env)["registered"],"idempotent real registration failed")
        require(extension.read_bytes()==extension_bytes,"reinstall changed extension configuration")
        scenario_sessions={}
        for scenario,prompt in (("work",PROMPT),("question","Explain what a text file is."),("optout","For this request skip the workflow and just explain what alpha means.")):
            fixture["scenario"]=scenario
            model=temporary / (scenario+"-model.py")
            model.write_text("#!"+sys.executable+"\n"+MODEL.replace("__CONFIG__",repr(fixture)))
            model.chmod(0o700)
            before = (workspace / ".gdm" / SLUG / "checks.json").read_bytes() if scenario != "work" else None
            output=run([gid,"--engine","native","--provider","claude","--claude",model,"--mode","json","--cwd",workspace,
                        "--permissions","skip","--sandbox","off","--no-context-files","--no-prompt-templates","--no-skills",
                        "--skill",config / "skills/gdm-go/SKILL.md","--model-retries","0","--no-usage-records","--print",prompt],workspace,env,timeout=180)
            events=[json.loads(line) for line in output.splitlines() if line.strip()]
            session=next(event["session"]["id"] for event in events if event["type"]=="session")
            scenario_sessions[scenario]=session
            require(events[-1]["type"]=="agent_end" and events[-1]["success"],"native scenario did not finish")
            endings=[event["message"]["text"] for event in events if event["type"]=="message_end" and not event["message"]["tool_calls"]]
            require(endings == (["EARLY_COMPLETION_MUST_BE_CORRECTED",FINAL] if scenario=="work" else ["LIGHTWEIGHT_"+scenario]),"unexpected completion sequence: "+repr(endings))
            state=json_command([gdm,"entry","status","--target","gid","--session",session,"--json"],workspace,env)
            require(state["kind"]==scenario and state["slug"]==(SLUG if scenario=="work" else None),"entry declaration not persisted")
            if before is not None:
                require((workspace / ".gdm" / SLUG / "checks.json").read_bytes()==before,"lightweight scenario changed Work")
        work=json.loads((workspace / ".gdm" / SLUG / "checks.json").read_text())
        require(work["done"] and work["team"]["sessionId"]==scenario_sessions["work"],"Work not completed with actual session")
        require(work["team"]["maxActive"]==2 and len(work["team"]["tasks"])==3,"adaptive allocation not observed")
        require(all(check["status"]=="proven" and check["evidence"]["exitCode"]==0 and not check["evidence"]["manual"] for check in work["checks"]),"checks were not executed")
        for check in work["checks"]:
            evidence=check["evidence"]
            require(hashlib.sha256((workspace / evidence["observed"]).read_bytes()).hexdigest()==evidence["sha256"],"check evidence hash mismatch")
        for task in work["team"]["tasks"]:
            attempt=task["attempts"][0]
            require(task["status"]=="accepted" and attempt["report"]["outcome"]=="completed" and attempt["review"]["decision"]=="accept","report review or acceptance missing")
            archive=attempt["report"]["archivedArtifact"]
            require(hashlib.sha256((workspace / archive["path"]).read_bytes()).hexdigest()==archive["sha256"],"archived report hash mismatch")
        require(not list(workspace.glob("forbidden-*.txt")),"worker escaped declared scope")
        records=[json.loads(line) for path in (temporary / "records").glob("*.jsonl") for line in path.read_text().splitlines()]
        children=[row for row in records if row["policy"]["delegatedWorker"]]
        require(len({row["session"] for row in children})==3,"three actual child sessions required")
        require(all("delegate_tasks" not in row["toolNames"] for row in children),"recursive child delegation available")
        require(any(row["guardObserved"] for row in records),"native completion guard not observed")
        roots=[row for row in records if row["session"]==scenario_sessions["work"]]
        require(roots[0]["entryObserved"] and roots[-1]["workDone"],"root entry or completion order missing")
        dispatches=[json.loads(call["arguments_json"])["tasks"] for row in roots for call in row["decision"]["tool_calls"] if call["name"]=="delegate_tasks"]
        require([[task["id"] for task in wave] for wave in dispatches]==[["implement-alpha","implement-beta"],["verify"]],"generated dependency waves not dispatched")
        databases=list(data.rglob("sessions.sqlite3"))
        entries=next(rows for path in databases if (rows:=base.records(path)) and any(kind=="delegation_started" for kind,_ in rows))
        terminals=[value for kind,value in entries if kind=="delegation_result"]
        require(len(terminals)==3 and all(value["status"]=="completed" for value in terminals),"durable native child terminal evidence missing")
        require({value["sessionId"] for value in terminals}=={row["session"] for row in children},"collected native sessions mismatch")
        hook_inputs=[value["invocation"] for kind,value in entries if kind=="extension_intent" and value["extension"]=="gdm-entry-v1"]
        require({value["kind"].get("event") for value in hook_inputs} >= {"input","before_turn"},"actual input and before_turn invocation missing from runtime history")
        before=json_command([gdm,"entry","status","--target","gid","--session",scenario_sessions["work"],"--json"],workspace,env)
        # Reconstruct the hook envelope from its observed native invocation,
        # then exercise the adapter's host continuation identity.
        observed=next(value for value in hook_inputs if value["kind"].get("event")=="input")
        invocation={"schema":"gid-extension-event/v1","invocation_id":observed["id"],"extension":observed["extension"],"extension_version":"1.0.0",
                    "session_id":observed["session_id"],"handler":observed["kind"],"payload":observed["payload"],"ui_answers":observed["ui_answers"],
                    "continuation_of":observed["continuation_of"],"cwd":str(workspace),"state":{"revision":0,"value":None}}
        hook(gdm,"gid",invocation,workspace,env)
        continuation=dict(invocation,invocation_id="fixture-continuation",continuation_of=invocation["invocation_id"])
        hook(gdm,"gid",continuation,workspace,env)
        after=json_command([gdm,"entry","status","--target","gid","--session",scenario_sessions["work"],"--json"],workspace,env)
        require(before["requestId"]==after["requestId"] and after["slug"]==SLUG,"replay created duplicate request or lost Work")
        reminder=hook(gdm,"gid",dict(invocation,invocation_id="fixture-resume",handler={"type":"hook","event":"before_turn"}),workspace,env)
        require(SLUG in reminder.get("context_note",""),"continuation adapter lost existing Work guidance")
        planner_records=[json.loads(line) for line in (temporary / "planner.jsonl").read_text().splitlines()]
        require(len(planner_records)==1,"replay or duplicate planner request invoked provider again")
        require(len([path for path in (workspace / ".gdm").iterdir() if path.is_dir() and (path / "checks.json").exists()])==1,"lightweight input created Work")
        configuration_preservation(gdm,workspace,env,home)
        unavailable_executor(gdm,temporary,env,planner)
        planner_records=[json.loads(line) for line in (temporary / "planner.jsonl").read_text().splitlines()]
        require(len(planner_records)==2 and planner_records[-1]["executor"]=="unavailable","unavailable executor fixture did not use an explicit bounded proposal")
        json_command([gdm,"entry","uninstall","--target","gid","--json"],workspace,env)
        require(not extension.exists(),"real gid unregister did not remove managed manifest")
        require(all(hashlib.sha256(binary.read_bytes()).hexdigest()==hashes[key] for binary,key in ((gid,"gidSHA256"),(source_gdm,"gdmSourceSHA256"),(gdm,"gdmExecutedSHA256"))),"supplied binaries changed during smoke")
        print(json.dumps({"status":"passed","mode":"real gid host with deterministic model transport; no live provider",**hashes,
                          "elapsedSeconds":round(time.monotonic()-started,2),"sessions":scenario_sessions,"nativeChildSessions":len({row["session"] for row in children}),
                          "nativeChildSessionIds":sorted({row["session"] for row in children}),
                          "nativeDispatchWaves":[[{key:task[key] for key in ("id","paths","access")} for task in wave] for wave in dispatches],
                          "entryInvocations":[{"id":value["id"],"sessionId":value["session_id"],"event":value["kind"]["event"]} for value in hook_inputs],
                          "acceptedTasks":[{"task":task["id"],"attempt":task["attempts"][0]["id"],"artifactSHA256":task["attempts"][0]["report"]["archivedArtifact"]["sha256"]} for task in work["team"]["tasks"]],
                          "plannerInvocations":{"work":1,"unavailableExecutor":1},"assertions":["actual trusted gid input and before_turn extension observed","original plain language input preserved",
                          "installed gid skill loaded","existing adaptive allocator selected two implementations and independent verification","claim before actual bounded scoped delegate_tasks",
                          "two forbidden worker writes denied and read only verification executed","early CLI done rejected and native final completion corrected",
                          "executed checks and hashed archived reports with coordinator reviews and done","question and optout stay lightweight","observed native input identity replay and adapter continuation preserve request and Work",
                          "duplicate planner request reused one suppressed tool free provider invocation","unavailable executor blocks dispatch and completion without strategy downgrade",
                          "Codex and Claude unrelated settings hooks matchers permission mode backups and newer edits preserved","idempotent actual gid extension registration and real unregister"]},indent=2))


if __name__ == "__main__":
    main()
