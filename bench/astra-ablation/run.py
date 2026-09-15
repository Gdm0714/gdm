#!/usr/bin/env python3
"""Local, sequential Astra instruction ablation. Does not install any candidate."""
import argparse
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import statistics
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BENCH = Path.home() / "projects/harness-bench"
HIDDEN = Path.home() / "projects/harness-bench-hidden"
INSTALLED = Path.home() / ".codex/skills/gdm-go/SKILL.md"
MODEL = "gpt-6-astra"
EFFORT = "xhigh"
ARMS = ["current", "ondemand", "calibrated"]
BRANCHES = {"t1": "t1-bugs", "t2": "t2-feature", "t3": "t3-hardening"}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

def command(argv, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True, check=True).stdout

def remove_section(text, heading):
    pattern = r"^" + re.escape(heading) + r"\n.*?(?=^## |\Z)"
    text, n = re.subn(pattern, "", text, flags=re.M | re.S)
    assert n == 1, heading
    return text

def prompts(current):
    ondemand = current
    for marker in ["GDM_TARGET_ADAPTER_V1", "GDM_WORK_PROTOCOL_V1", "GDM_WORK_PROTOCOL_V2"]:
        ondemand, n = re.subn(r"<!-- " + marker + r"_BEGIN -->.*?<!-- " + marker + r"_END -->\n?", "", ondemand, flags=re.S)
        assert n == 1, marker
    ondemand, n = re.subn(r"^## Codex native delegation contract\n.*?(?=^1\. 지속 계획)", "", ondemand, flags=re.M | re.S)
    assert n == 1
    for heading in ["## 대화형 웹 검증", "## 작업 유형별 관행 (실사용 빈도 기반)", "## 예시"]:
        ondemand = remove_section(ondemand, heading)
    ondemand += "\n## 필요할 때 읽는 참고\n역할 인계·다중 에이전트·웹 UI 검증·도메인 예시는 해당 기능을 실제로 사용할 때 읽는다. 이번 과제는 로컬 단일 실행자 작업이다. 핵심 CLI 검증 게이트는 그대로 적용한다.\n"
    calibrated = ondemand
    calibrated, n = re.subn(r"- IMPORTANT: check는 3~7개로 유지한다\. 그보다 많으면 작업을 쪼개는 신호다\.", "- IMPORTANT: check 수는 요청의 독립적인 수용 조건과 위험에 맞춘다. 개수를 맞추기 위한 검사는 추가하지 않는다.", calibrated)
    assert n == 1
    calibrated = calibrated.replace("작업을 3~7개의 `regression|behavior|edge|static|manual` 항목으로 분해해", "작업에 필요한 `regression|behavior|edge|static|manual` 항목으로 분해해")
    calibrated = calibrated.replace("소스·설정 동작 변경은 `--simplify`를 사용하고 proven `static` check로", "구조 복잡성 위험이 있는 변경만 `--simplify`를 사용하고 proven `static` check로")
    calibrated = calibrated.replace("소스·설정 동작을 바꾸면 `--simplify`를 붙인다.", "구조 복잡성 위험이 있는 변경에만 `--simplify`를 붙인다.")
    calibrated, n = re.subn(r"4\. `gdm done` 성공 뒤.*?5\. 이 피드백 checkpoint까지 끝난 뒤에만 완료를 보고한다\.", "4. `gdm done` 성공 뒤 완료를 보고한다. 반복 실패나 adopted habit이 있는 작업만 habit harvest/evaluate를 수행하며, 수확 자체를 완료의 추가 조건으로 삼지 않는다.\n5.", calibrated, flags=re.S)
    assert n == 1
    calibrated += "\n## 검증 범위 조정\n요청의 결과와 관련 경계 조건을 검증한다. 기존 결함의 red→green, 범위 보존, evidence 무결성과 gdm done 게이트는 유지한다. 검사 통과 후에는 새 변경·실패·남은 우려가 있을 때만 검증을 넓히거나 반복한다. 이 규칙은 CLI가 요구하는 done 재실행을 생략할 권한이 아니다.\n"
    return dict(zip(ARMS, [current, ondemand, calibrated]))

DISABLED = ["multi_agent", "multi_agent_v2", "apps", "plugins", "hooks", "browser_use", "browser_use_external", "computer_use", "image_generation", "in_app_browser", "skill_search", "tool_suggest", "workspace_dependencies", "goals", "remote_plugin", "plugin_sharing", "skill_mcp_dependency_install", "auth_elicitation", "tool_call_mcp_elicitation", "shell_snapshot"]

def argv(workspace, output):
    result = [shutil.which("codex"), "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "-C", str(workspace), "-s", "workspace-write", "-m", MODEL, "-c", f'model_reasoning_effort="{EFFORT}"', "-c", 'approval_policy="never"', "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"']
    for feature in DISABLED:
        result += ["--disable", feature]
    return result + ["-o", str(output), "--json", "-"]

def fixture(task, workspace):
    data = command(["git", "-C", str(BENCH), "archive", BRANCHES[task]])
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(workspace, filter="data")
    command(["git", "init", "-q", str(workspace)])
    command(["git", "-C", str(workspace), "add", "."])
    command(["git", "-C", str(workspace), "-c", "user.name=Benchmark", "-c", "user.email=benchmark@localhost", "commit", "-qm", "fixture baseline"])

def run_test(workspace, target, output):
    p = subprocess.run([shutil.which("bun"), "test", target], cwd=workspace, capture_output=True, timeout=90)
    data = p.stdout + p.stderr
    output.write_bytes(data)
    text = data.decode(errors="replace")
    def count(kind):
        match = re.search(r"\b(\d+) " + kind + r"\b", text)
        return int(match.group(1)) if match else None
    return {"exitCode": p.returncode, "pass": count("pass"), "fail": count("fail"), "sha256": digest(data)}

def run_one(run_dir, task, arm, trial, arm_text):
    run_id = f"{task}-{arm}-{trial}"
    log = run_dir / run_id
    log.mkdir()
    workspace = log / "workspace"
    workspace.mkdir()
    fixture(task, workspace)
    original_visible = (workspace / "test/visible.test.ts").read_bytes()
    brief = (HIDDEN / "briefs" / f"{task}.md").read_text()
    prompt = "# 작업 브리프\n" + brief + "\n# 적용 지침\n" + arm_text + "\n# 공통 실행 조건\n이것은 비대화형 로컬 벤치마크다. 위 작업을 직접 구현하고 검증하라. gdm CLI는 PATH에 있다. 기존 가시 테스트는 수정하지 말고 새 테스트는 추가할 수 있다. 작업 디렉터리 밖 파일 읽기·쓰기, 외부 검색·네트워크, 다른 과제·실험 로그 탐색과 하위 위임은 금지한다. 단 설치된 gdm 실행과 CLI 도움말 조회는 허용한다. 이 과제는 이미 주어진 로컬 함수 계약의 구현이므로 별도 기술 설계 판단이나 외부 설계자 호출이 필요하지 않다. 이 조건은 모든 arm에 동일하다. 로컬 분석·수정·검증은 승인되어 있으므로 통상적인 선택은 합리적으로 결정하고 진행하라. .gdm 상태는 CLI로만 변경한다. commit/push/PR은 하지 않는다. gdm done이 성공한 경우에만 마지막 줄에 HARNESS_DONE: <요약>을 출력하라.\n"
    (log / "prompt.md").write_text(prompt)
    args = argv(workspace, log / "final.md")
    write_json(log / "invocation.json", {"argv": args, "promptSha256": digest(prompt.encode()), "modelRequested": MODEL, "reasoningRequested": EFFORT})
    env = {k:v for k,v in os.environ.items() if not k.startswith("GDM_")}
    started = time.monotonic()
    print(f"START {run_id}", flush=True)
    with (log / "events.jsonl").open("wb") as stdout, (log / "stderr.log").open("wb") as stderr:
        p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, env=env, start_new_session=True)
        timed_out = False
        try:
            p.communicate(prompt.encode(), timeout=480)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
    elapsed = time.monotonic() - started
    events = []
    for line in (log / "events.jsonl").read_text().splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    usages = [e["usage"] for e in events if e.get("type") == "turn.completed" and "usage" in e]
    completed = [e.get("item", {}) for e in events if e.get("type") == "item.completed"]
    commands = [e for e in completed if e.get("type") == "command_execution"]
    final = (log / "final.md").read_text() if (log / "final.md").exists() else ""
    command(["git", "-C", str(workspace), "add", "-N", "."])
    diff = command(["git", "-C", str(workspace), "diff", "HEAD"])
    (log / "changes.diff").write_bytes(diff)
    states = []
    for path in workspace.glob(".gdm/*/checks.json"):
        states.append(json.loads(path.read_text()))
    hidden = workspace / "benchmark-hidden.test.ts"
    assert not hidden.exists()
    hidden.write_bytes((HIDDEN / f"{task}.hidden.test.ts").read_bytes())
    try:
        hidden_result = run_test(workspace, "./benchmark-hidden.test.ts", log / "hidden.txt")
    finally:
        hidden.unlink()
    visible_result = run_test(workspace, "./test/visible.test.ts", log / "visible.txt")
    usage = usages[0] if len(usages) == 1 else {}
    result = {"id": run_id, "task": task, "arm": arm, "trial": trial, "exitCode": p.returncode, "timeout": timed_out, "seconds": round(elapsed, 3), "promptBytes": len(prompt.encode()), "usage": usage, "usageValid": len(usages) == 1 and usage.get("input_tokens", 0) > 0, "freshInputTokens": usage.get("input_tokens", 0) - usage.get("cached_input_tokens", 0), "commandCount": len(commands), "failedCommands": sum(e.get("exit_code", 0) != 0 for e in commands), "hidden": hidden_result, "visible": visible_result, "visibleUnchanged": original_visible == (workspace / "test/visible.test.ts").read_bytes(), "doneMarker": "HARNESS_DONE:" in final, "workDone": any(s.get("done") for s in states), "checks": sum(len(s.get("checks", [])) for s in states), "eventsSha256": digest((log / "events.jsonl").read_bytes()), "diffSha256": digest(diff), "finalSha256": digest(final.encode())}
    result["success"] = p.returncode == 0 and not timed_out and hidden_result["exitCode"] == 0 and visible_result["exitCode"] == 0 and result["visibleUnchanged"] and result["doneMarker"] and result["workDone"]
    write_json(log / "result.json", result)
    with (run_dir / "results.jsonl").open("a") as file:
        file.write(json.dumps(result, ensure_ascii=False) + "\n")
    print(f"END {run_id} success={result['success']} seconds={elapsed:.1f} fresh={result['freshInputTokens']} commands={len(commands)} hidden={hidden_result['pass']}/{hidden_result['fail']}", flush=True)
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--max-runs", type=int, default=18)
    options = parser.parse_args()
    run_dir = Path(tempfile.mkdtemp(prefix="gdm-astra-ablation-20260908-"))
    (HERE / "latest-run.txt").write_text(str(run_dir) + "\n")
    arm_text = prompts(INSTALLED.read_text())
    for arm, value in arm_text.items():
        (run_dir / f"{arm}.md").write_text(value)
    for a, b in zip(ARMS, ARMS[1:]):
        (run_dir / f"{a}-to-{b}.diff").write_text("".join(difflib.unified_diff(arm_text[a].splitlines(True), arm_text[b].splitlines(True), fromfile=a, tofile=b)))
    # Each task has the exact reversed order in trial 2; starting arm rotates by task.
    orders = [["current", "ondemand", "calibrated"], ["ondemand", "calibrated", "current"], ["calibrated", "current", "ondemand"]]
    schedule = []
    for trial in [1, 2]:
        for index, task in enumerate(BRANCHES):
            order = orders[index] if trial == 1 else list(reversed(orders[index]))
            schedule += [{"task": task, "arm": arm, "trial": trial} for arm in order]
    artifacts = [INSTALLED, Path(__file__), *[HIDDEN / f"{task}.hidden.test.ts" for task in BRANCHES], *[HIDDEN / "briefs" / f"{task}.md" for task in BRANCHES]]
    manifest = {"schema": "gdm-astra-ablation/v1", "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "repoHead": command(["git", "rev-parse", "HEAD"], ROOT).decode().strip(), "modelRequested": MODEL, "reasoningRequested": EFFORT, "codexVersion": command([shutil.which("codex"), "--version"]).decode().strip(), "gdmVersion": command([shutil.which("gdm"), "--version"]).decode().strip(), "codexSha256": digest(Path(shutil.which("codex")).resolve().read_bytes()), "gdmSha256": digest(Path(shutil.which("gdm")).read_bytes()), "artifacts": [{"path": str(p), "sha256": digest(p.read_bytes())} for p in artifacts], "fixtureCommits": {task:command(["git", "-C", str(BENCH), "rev-parse", branch]).decode().strip() for task,branch in BRANCHES.items()}, "arms": {arm:{"bytes":len(value.encode()), "sha256":digest(value.encode())} for arm,value in arm_text.items()}, "schedule": schedule[:options.max_runs], "timeoutSeconds":480, "primaryOutcome":"hidden and original visible tests pass, original tests unchanged, real gdm done and completion marker", "secondaryOutcomes":["wall time", "fresh input", "total input", "cached input", "output", "commands", "checks"], "limitations":["3 small reused fixtures: ceiling effect, no large-repository quality generalization", "single implementer, no external designer, no browser, no remote tools; those policy changes are not tested", "CLI requested model identity is observable; server identity is not independently attested", "machine grading only; no blind qualitative LLM judge", "hidden tests outside workspace withheld until model exits; OS read access is not a hard hidden-test security boundary", "calibrated combines several workflow changes; cannot attribute its outcome to one rule"]}
    write_json(run_dir / "manifest.json", manifest)
    print(f"RUN_DIR {run_dir}", flush=True)
    if not options.execute:
        return
    results = [run_one(run_dir, **entry, arm_text=arm_text[entry["arm"]]) for entry in manifest["schedule"]]
    summaries = {}
    for arm in ARMS:
        rows = [r for r in results if r["arm"] == arm]
        if rows:
            summaries[arm] = {"runs":len(rows), "successes":sum(r["success"] for r in rows), **{key:statistics.median(r[key] for r in rows) for key in ["seconds", "freshInputTokens", "commandCount", "checks"]}}
    write_json(run_dir / "summary.json", summaries)
    print(json.dumps(summaries, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
