#!/usr/bin/env python3
"""Run the original full check sequence and preserve untruncated failure output."""
import datetime
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
logs = root / "bench/model-routing/regression-diagnostics"
logs.mkdir(exist_ok=True)
for label, command in [
    ("typecheck", ["bun", "run", "typecheck"]),
    ("suite", ["bun", "test"]),
    ("build", ["bun", "run", "build"]),
    ("smoke", ["bun", "run", "smoke"]),
]:
    result = subprocess.run(command, cwd=root / "cli", stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    log = logs / f"{stamp}-{label}.log"
    log.write_text(result.stdout)
    print(f"{label}: exit {result.returncode}; full log {log.relative_to(root)}", flush=True)
    lines = result.stdout.splitlines()
    if result.returncode:
        for index, line in enumerate(lines):
            if line.startswith("(fail)"):
                print("\n".join(lines[max(0, index - 30):index + 1]), flush=True)
    print("\n".join(lines[-15:]), flush=True)
    if result.returncode:
        sys.exit(result.returncode if result.returncode > 0 else 1)
