"""Evidence parsing shared by the quality pilot; no model calls in this module."""
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]
def sha(value): return hashlib.sha256(value).hexdigest()
def load(path): return json.loads(Path(path).read_text())
def save(path, value): Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
def hashes(root): return {str(p.relative_to(root)): sha(p.read_bytes()) for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()}
def finite(n): return isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) and n >= 0
def valid_usage(u): return isinstance(u, dict) and all(finite(u.get(k)) for k in FIELDS) and finite(u.get("cost", {}).get("total"))
def totals(items):
    return {**{k: sum(u[k] for u in items) for k in FIELDS}, "apiCostEstimateUSD": sum(u["cost"]["total"] for u in items)}

def parse_events(path):
    usages, children, messages, tools = [], [], [], []
    attempts = {}; invalid = 0; models = set(); final = ""; stop = None; ended = False
    for line in Path(path).read_text().splitlines():
        if not line.strip(): continue
        try: e = json.loads(line)
        except ValueError: invalid += 1; continue
        if e.get("type") == "message_end" and e.get("message", {}).get("role") == "assistant":
            m = e["message"]; models.add(m.get("provider", "") + "/" + m.get("model", "")); stop = m.get("stopReason")
            final = "\n".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text")
            messages.append({"stopReason": stop, "error": m.get("errorMessage")})
            if valid_usage(m.get("usage")): usages.append(m["usage"])
        if e.get("type") == "tool_execution_start" and e.get("toolName") == "gdm_delegate":
            tasks = e.get("args", {}).get("tasks")
            attempts[e["toolCallId"]] = {"id": e["toolCallId"], "tasks": tasks, "ended": False}
        if e.get("type") == "tool_execution_end":
            result = e.get("result", {}); error = e.get("isError") is True or result.get("isError") is True
            tools.append({"name": e.get("toolName"), "error": error})
            if e.get("toolName") == "gdm_delegate":
                attempt = attempts.setdefault(e["toolCallId"], {"id": e["toolCallId"], "tasks": None})
                observed = result.get("details", {}).get("results", [])
                text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
                status = result.get("details", {}).get("delegation", {})
                rejected = status.get("status") == "rejected" or "GDM_PI_DELEGATION_REJECTED:" in text
                attempt.update(ended=True, error=error or rejected, rejected=rejected, summary=status,
                               childCount=len(observed), errorText=text if error or rejected else "")
                children.extend({**c, "toolCallId": e["toolCallId"], "childIndex": i} for i, c in enumerate(observed))
        if e.get("type") == "agent_end" and not e.get("willRetry", False): ended = True
    complete = bool(messages) and ended and stop == "stop" and len(usages) == len(messages) and all(a.get("ended") for a in attempts.values()) and all(c.get("usageComplete") and valid_usage(c.get("usage")) for c in children)
    child_usages = [c["usage"] for c in children if valid_usage(c.get("usage"))]
    return {"reportedModels": sorted(models), "assistantTurns": len(messages), "messages": messages,
            "mainUsage": totals(usages), "totalUsage": totals(usages + child_usages), "usageComplete": complete,
            "children": children, "delegateAttempts": list(attempts.values()), "tools": tools,
            "invalidJsonLines": invalid, "agentEnded": ended, "stopReason": stop, "final": final}

def parse_object(text):
    value = text.strip()
    if value.startswith("```"): value = re.sub(r"^```(?:json)?\s*|\s*```$", "", value)
    try: result = json.loads(value)
    except (ValueError, TypeError): return None
    return result if isinstance(result, dict) else None

def trace_records(log):
    path = log / "trace/trace.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

def phase_evidence(log, parsed, specialist):
    records = trace_records(log); issues = []; phases = []
    if not records: return {"compliant": False, "issues": ["missing trace"], "phases": []}
    first = records[0]; last = records[-1]
    final_hashes = {p: h for p, h in hashes(log / "final-snapshot").items() if p.startswith("src/")}
    independent_hash = sha(json.dumps(final_hashes, separators=(",", ":")).encode())
    if independent_hash != last["sourceHash"]: issues.append("graded final source differs from last observed source")
    if first["kind"] != "start" or last["kind"] != "settled": issues.append("incomplete trace lifecycle")
    mutation = next((r["index"] for r in records if r["sourceHash"] != first["sourceHash"]), None)
    if any(r["unsafe"] for r in records): issues.append("unsafe or oversized snapshot entries")
    for c in parsed["children"]:
        before = next((r for r in records if r.get("toolCallId") == c["toolCallId"] and r["kind"] == "before"), None)
        after = next((r for r in records if r.get("toolCallId") == c["toolCallId"] and r["kind"] == "after"), None)
        data = parse_object(c.get("output", ""))
        required = set(name for name in (before or {}).get("hashes", {}) if name.startswith("src/")) | {"TASK.md"}
        reads = set()
        for call in c.get("toolCalls", []):
            if call.get("name") == "read" and not call.get("isError") and call.get("path"):
                p = Path(call["path"])
                try: reads.add(str((p if p.is_absolute() else log / "workspace" / p).resolve().relative_to((log / "workspace").resolve())))
                except ValueError: issues.append("specialist read outside workspace")
        identity = c.get("model") == specialist and c.get("reportedModels") == [specialist] and c.get("thinking") == "medium"
        response = bool(data and isinstance(data.get("summary"), str) and data["summary"].strip())
        if c.get("role") == "design": response = response and isinstance(data.get("plan"), list) and bool(data["plan"])
        elif c.get("role") == "reviewer":
            response = response and isinstance(data.get("findings"), list) and all(
                isinstance(f, dict) and all(isinstance(f.get(k), str) and f[k].strip() for k in ["id", "file", "issue", "check"])
                for f in data["findings"])
        else: response = False
        phases.append({"role": c.get("role"), "toolCallId": c["toolCallId"], "ok": c.get("ok", False),
            "identityComplete": identity, "responseComplete": bool(response), "missingReads": sorted(required - reads),
            "startIndex": before["index"] if before else None, "endIndex": after["index"] if after else None,
            "sourceBefore": before["sourceHash"] if before else None, "sourceAfter": after["sourceHash"] if after else None,
            "snapshot": before["snapshot"] if before else None, "response": data,
            "valid": bool(c.get("ok") and identity and response and before and after and not(required - reads))})
    if specialist:
        designs = [p for p in phases if p["role"] == "design" and p["valid"]]
        reviews = [p for p in phases if p["role"] == "reviewer" and p["valid"]]
        if mutation is None: issues.append("no implementation mutation observed")
        if mutation is None or not any(p["endIndex"] < mutation for p in designs):
            issues.append("no successful design before first source change")
        if not any(p["sourceBefore"] == p["sourceAfter"] == last["sourceHash"] for p in reviews):
            issues.append("no successful review of final source content")
        try: decisions = load(log / "workspace/DECISIONS.json")["dispositions"]
        except (OSError, ValueError, KeyError, TypeError): decisions = []; issues.append("missing finding dispositions")
        if not isinstance(decisions, list): decisions = []; issues.append("invalid finding dispositions")
        for ordinal, review in enumerate([p for p in phases if p["role"] == "reviewer" and p["ok"]], 1):
            if not review["responseComplete"]: continue
            for f in review["response"]["findings"]:
                if not any(isinstance(d, dict) and d.get("review") == ordinal and d.get("finding") == f["id"] and
                    d.get("decision") in ["fixed", "rejected"] and isinstance(d.get("reason"), str) and d["reason"].strip()
                    for d in decisions):
                    issues.append(f"missing disposition for review {ordinal} finding {f['id']}")
        if any(p["role"] not in ["design", "reviewer"] for p in phases): issues.append("unexpected specialist role")
    elif parsed["delegateAttempts"] or phases: issues.append("delegation in standalone control")
    return {"compliant": not issues, "issues": issues, "phases": phases,
            "firstMutationIndex": mutation, "finalSourceHash": independent_hash,
            "preReviewSnapshot": next((r["snapshot"] for r in records if r["kind"] == "before" and "reviewer" in r["roles"]), None)}

def grade(work, target, output):
    try:
        r = subprocess.run(["bun", "test", target], cwd=work, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45)
        data = r.stdout; code = r.returncode
    except subprocess.TimeoutExpired as e: data = (e.stdout or b"") + b"\nGRADING_TIMEOUT"; code = 124
    output.write_bytes(data); text = data.decode(errors="replace")
    passed = re.findall(r"^\(pass\) (.*?) \[[\d.]+ms\]$", text, re.M)
    # Bun omits timing for tests that complete within the clock's resolution.
    passed += re.findall(r"^\(pass\) ([^\n\[]+)$", text, re.M)
    failed = re.findall(r"^\(fail\) (.*?)(?: \[[\d.]+ms\])?$", text, re.M)
    return {"exitCode": code, "passed": passed, "failed": failed, "sha256": sha(data)}

def grade_snapshot(snapshot, baseline, hidden, destination):
    destination.mkdir(parents=True, exist_ok=False)
    work = destination / "workspace"; shutil.copytree(snapshot, work)
    for name in ["package.json", "test/visible.test.ts", "TASK.md"]:
        (work / name).parent.mkdir(parents=True, exist_ok=True); shutil.copy2(baseline / name, work / name)
    shutil.copy2(hidden, work / "benchmark-hidden.test.ts")
    return {"hidden": grade(work, "./benchmark-hidden.test.ts", destination / "hidden.log"),
            "visible": grade(work, "./test/visible.test.ts", destination / "visible.log")}
