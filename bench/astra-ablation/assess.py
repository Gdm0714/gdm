#!/usr/bin/env python3
"""Reconstruct completion from CLI state, command events and exact evidence bytes."""
import hashlib
import json
from pathlib import Path
import re
import statistics

HERE = Path(__file__).resolve().parent
run = Path((HERE / "latest-run.txt").read_text().strip())
rows = []
for file in sorted(run.glob("t*/result.json")):
    row = json.loads(file.read_text())
    workspace = file.parent / "workspace"
    states = [json.loads(p.read_text()) for p in workspace.glob(".gdm/*/checks.json")]
    events = []
    for line in (file.parent / "events.jsonl").read_text().splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    commands = [e["item"] for e in events if e.get("type") == "item.completed" and e.get("item", {}).get("type") == "command_execution"]
    done_commands = [c for c in commands if "gdm done" in c.get("command", "") and c.get("exit_code") == 0]
    checks = [c for s in states for c in s.get("checks", [])]
    evidence_ok = bool(checks)
    for check in checks:
        ev = check.get("evidence") or {}
        path = workspace / ev.get("observed", "")
        evidence_ok &= check.get("status") == "proven" and path.is_file() and not path.is_symlink()
        if path.is_file():
            evidence_ok &= hashlib.sha256(path.read_bytes()).hexdigest() == ev.get("sha256")
    row["workDone"] = bool(states) and all(s.get("done") for s in states)
    row["doneCommandObserved"] = bool(done_commands)
    row["evidenceHashesValid"] = bool(evidence_ok)
    row["checks"] = len(checks)
    row["staticChecks"] = sum(c.get("kind") == "static" for c in checks)
    row["harvestCommands"] = sum("gdm habit harvest" in c.get("command", "") for c in commands)
    row["privacyRejectedCommands"] = sum("오류(privacy_rejected)" in c.get("aggregated_output", "") for c in commands)
    row["helpErrorCommands"] = sum(c.get("exit_code") != 0 and re.search(r"gdm (?:help|[^;\n]*--help)", c.get("command", "")) is not None for c in commands)
    row["outsideInstructionRead"] = any(re.search(r"(?:cat|sed|head|tail)\s+[^;\n]*(?:/\.codex/skills/|/\.agents/skills/)", c.get("command", "")) is not None for c in commands)
    stderr = (file.parent / "stderr.log").read_text()
    errors = [e.get("message", "") for e in events if e.get("type") == "error"]
    row["infrastructureError"] = bool(re.search(r"failed to lookup address|Connection failed|waiting for network|failed to refresh available models", stderr + "\n" + "\n".join(errors))) or (file.parent / "infrastructure-abort.json").exists()
    event_stat = (file.parent / "events.jsonl").stat()
    row["eventFileTimelineSeconds"] = round(event_stat.st_mtime - getattr(event_stat, "st_birthtime", event_stat.st_ctime), 3)
    row["wallClockDiscontinuity"] = abs(row["eventFileTimelineSeconds"] - row["seconds"]) > 10
    row["measurementValid"] = row["usageValid"] and not row["infrastructureError"] and not row["wallClockDiscontinuity"] and not row["outsideInstructionRead"]
    row["success"] = row["exitCode"] == 0 and not row["timeout"] and row["hidden"]["exitCode"] == 0 and row["visible"]["exitCode"] == 0 and row["visibleUnchanged"] and row["doneMarker"] and row["workDone"] and row["doneCommandObserved"] and row["evidenceHashesValid"]
    rows.append(row)
summary = {}
for arm in ["current", "ondemand", "calibrated"]:
    selected = [r for r in rows if r["arm"] == arm]
    if selected:
        valid = [r for r in selected if r["measurementValid"]]
        summary[arm] = {"runs": len(selected), "successes": sum(r["success"] for r in selected), "measurementValidRuns":len(valid), "infrastructureErrors":sum(r["infrastructureError"] for r in selected), "median": {k: statistics.median(r[k] for r in valid) for k in ["seconds", "freshInputTokens", "commandCount", "checks", "staticChecks", "harvestCommands"]} if valid else None, "usageMedian": {k:statistics.median(r["usage"].get(k, 0) for r in valid) for k in ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]} if valid else None}
paired = []
for task in ["t1", "t2", "t3"]:
    for trial in [1, 2]:
        selected = {r["arm"]:r for r in rows if r["task"] == task and r["trial"] == trial}
        for control, treatment in [("current", "ondemand"), ("ondemand", "calibrated"), ("current", "calibrated")]:
            if control in selected and treatment in selected:
                a, b = selected[control], selected[treatment]
                paired.append({"task":task, "trial":trial, "control":control, "treatment":treatment, "measurementValid":a["measurementValid"] and b["measurementValid"], "bothSuccess":a["success"] and b["success"], "deltaPercent":{key:round((b[key]/a[key]-1)*100,2) if a[key] else None for key in ["seconds", "freshInputTokens", "commandCount"]}})
result = {"assessorSha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "rawRunnerCompletionCorrection":"Initial executed runner looked for state.json, but gdm persists checks.json. Raw records are preserved; this assessor reconstructs completion from checks.json, command exit and evidence hashes for all arms equally. Generation and hidden-test results are unchanged.", "runs":rows, "summary":summary, "paired":paired}
(run / "assessed.json").write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
print(json.dumps({"n":len(rows), "summary":summary}, ensure_ascii=False, indent=2))
