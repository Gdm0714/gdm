#!/usr/bin/env python3
"""Keep full regression output, including failures from a completion replay."""
import datetime
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
logs = ROOT / "bench/astra-quality/check-logs"
logs.mkdir(exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
for label, command in [("typecheck", ["bun", "run", "typecheck"]), ("suite", ["bun", "test"]),
                       ("build", ["bun", "run", "build"]), ("smoke", ["bun", "run", "smoke"])]:
    r = subprocess.run(command, cwd=ROOT / "cli", stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    path = logs / f"{stamp}-{label}.log"
    path.write_text(r.stdout)
    print(f"{label}: exit {r.returncode}; {path.relative_to(ROOT)}", flush=True)
    print("\n".join(r.stdout.splitlines()[-15:]), flush=True)
    if r.returncode: sys.exit(r.returncode if r.returncode > 0 else 1)
