#!/usr/bin/env python3
"""Headless local CLI A/B benchmark; no provider requests or user Work mutations."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
BIN = {arm: HERE / arm / "gdm" for arm in ("before", "after")}
ENV = dict(os.environ, GDM_NO_COLOR="1", LC_ALL="C", LANG="C")


def cli(arm, cwd, args):
    result = subprocess.run([str(BIN[arm]), "--language", "en", *args], cwd=cwd,
                            env=ENV, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f"{arm}: {args}: {result.stderr.decode()[-2000:]}")
    return result.stdout


def init_fixture(path, works, events):
    path.mkdir(parents=True, exist_ok=True)
    if (path / ".gdm").exists():
        return
    # A local empty Git root prevents fingerprinting the surrounding user repo.
    subprocess.run(["/usr/bin/git", "init", "-q", str(path)], check=True)
    (path / "fixtures").mkdir(exist_ok=True)
    (path / "fixtures/input.txt").write_text("expected build diagnostic\n")
    (path / "actual.txt").write_text("expected build diagnostic\n")
    for index in range(works):
        slug = f"sample-{index:02d}"
        cli("after", path, ["plan", "init", "--slug", slug, "--brief", "Synthetic benchmark",
                            "--require", "Preserve diagnostic output"])
        for event in range(events):
            if event % 2:
                args = ["miss", "--slug", slug, "--desc", f"Synthetic missing diagnostic {event:03d}"]
            else:
                args = ["feedback", "--slug", slug, "--value", "bad", "--reason",
                        f"Synthetic output mismatch {event:03d}"]
            cli("after", path, args)


def capture_replay(path):
    init_fixture(path, 1, 20)
    case = path / ".gdm/sample-00/regressions/diagnostic-v1.json"
    if not case.exists():
        candidates = json.loads(cli("after", path, ["regression", "candidates", "--slug", "sample-00", "--json"]))
        cli("after", path, ["regression", "capture", "--slug", "sample-00", "--candidate",
                            candidates["candidates"][0]["id"], "--case", "diagnostic-v1",
                            "--fixture", "fixtures/input.txt", "--cmd",
                            'cmp fixtures/input.txt "$GDM_REGRESSION_PROJECT/actual.txt"',
                            "--expect", "Exact diagnostic bytes", "--timeout-ms", "5000"])


def setup(trials):
    init_fixture(HERE / "fixture", 10, 20)
    for index in range(trials + 2):
        capture_replay(HERE / "replay-fixtures" / f"run-{index:02d}")
    direct = HERE / "direct-fixture"
    (direct / "fixtures").mkdir(parents=True, exist_ok=True)
    (direct / "fixtures/input.txt").write_text("expected build diagnostic\n")
    (direct / "actual.txt").write_text("expected build diagnostic\n")


def correctness():
    fixture = HERE / "fixture"
    status_before = json.loads(cli("before", fixture, ["status", "--json"]))
    status_after = json.loads(cli("after", fixture, ["status", "--json"]))
    assert status_before == status_after, "status behavior changed"
    retro_before = json.loads(cli("before", fixture, ["retro", "--all", "--json"]))
    retro_after = json.loads(cli("after", fixture, ["retro", "--all", "--json"]))
    candidates = retro_after.pop("regressionCandidates")
    assert len(candidates) == 200
    assert retro_before == retro_after, "existing retro fields changed"
    assert retro_before["works"] == 10
    return {"status_equal": True, "existing_retro_fields_equal": True,
            "works": 10, "events_per_work": 20, "regression_candidates": len(candidates),
            "status_canonical_sha256": hashlib.sha256(json.dumps(status_before, sort_keys=True).encode()).hexdigest(),
            "retro_existing_canonical_sha256": hashlib.sha256(json.dumps(retro_before, sort_keys=True).encode()).hexdigest()}


def measure(argv, cwd, env=ENV):
    # wait4 returns this child's own CPU/RSS instead of a cumulative high-water
    # mark for all previous children. File-backed pipes cannot block on output.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        start = time.perf_counter_ns()
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out, stderr=err)
        _, status, usage = os.wait4(process.pid, 0)
        elapsed = time.perf_counter_ns() - start
        process.returncode = os.waitstatus_to_exitcode(status)
        out.seek(0)
        output = out.read()
        err.seek(0)
        errors = err.read()
    if process.returncode:
        raise RuntimeError(f"Benchmark child failed: {errors.decode()[-2000:]}")
    rss = usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024
    return {"wall_ms": elapsed / 1e6, "cpu_ms": (usage.ru_utime + usage.ru_stime) * 1000,
            "max_rss_bytes": rss, "stdout_bytes": len(output),
            "stdout_sha256": hashlib.sha256(output).hexdigest()}


def summary(samples):
    output = {}
    for key in ("wall_ms", "cpu_ms", "max_rss_bytes", "stdout_bytes"):
        values = sorted(sample[key] for sample in samples)
        output[key] = {"median": statistics.median(values),
                       "p95": values[max(0, math.ceil(len(values) * .95) - 1)],
                       "min": min(values), "max": max(values)}
    return output


def benchmark(trials):
    assert trials >= 7
    verified = correctness()
    cases = []
    for name, arguments in [("status", ["status", "--json"]),
                            ("retro", ["retro", "--all", "--json"])]:
        samples = {"before": [], "after": []}
        for _ in range(2):
            for arm in ("before", "after"):
                measure([str(BIN[arm]), "--language", "en", *arguments], HERE / "fixture")
        orders = []
        for trial in range(trials):
            order = ("before", "after") if trial % 2 == 0 else ("after", "before")
            orders.append(order)
            for arm in order:
                samples[arm].append(measure([str(BIN[arm]), "--language", "en", *arguments], HERE / "fixture"))
        cases.append({"name": name, "comparison": "exact before/after source CLI", "orders": orders,
                      "samples": samples, "summary": {arm: summary(values) for arm, values in samples.items()}})
    samples = {"direct_shell": [], "recorded_replay": []}
    orders = []
    for index in range(trials + 2):
        order = ("direct_shell", "recorded_replay") if index % 2 == 0 else ("recorded_replay", "direct_shell")
        for arm in order:
            if arm == "direct_shell":
                sample = measure(["/bin/bash", "-c", 'cmp fixtures/input.txt "$GDM_REGRESSION_PROJECT/actual.txt"'],
                                 HERE / "direct-fixture", dict(ENV, GDM_REGRESSION_PROJECT=str(HERE / "direct-fixture")))
            else:
                sample = measure([str(BIN["after"]), "--language", "en", "regression", "replay", "--slug",
                                  "sample-00", "--case", "diagnostic-v1"], HERE / "replay-fixtures" / f"run-{index:02d}")
            if index >= 2:
                samples[arm].append(sample)
        if index >= 2:
            orders.append(order)
    cases.append({"name": "regression_replay_cost", "comparison": "new feature overhead, NOT equivalent before/after",
                  "orders": orders, "samples": samples, "summary": {arm: summary(values) for arm, values in samples.items()}})
    provenance = json.loads((HERE / "provenance.json").read_text())
    binaries = {arm: hashlib.sha256(path.read_bytes()).hexdigest() for arm, path in BIN.items()}
    assert binaries["before"] != binaries["after"], "different features must not reuse stale cached binary"
    result = {"schema": "gdm-adoption-performance/v1", "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "trials": trials, "warmup_per_arm": 2, "timing": "perf_counter_ns wall and wait4 per-child CPU/RSS",
              "platform": sys.platform, "binary_sha256": binaries, "provenance": provenance,
              "correctness": verified, "cases": cases,
              "limitations": ["Shared active Mac; paired trials reduce but cannot eliminate background load.",
                              "p95 is an empirical order statistic from a small sample, not a population tail estimate.",
                              "status/retro are CLI process timings; no LLM calls, UI, network or user repositories.",
                              "replay adds frozen-input validation, process-group execution and durable result recording; direct shell does not."]}
    (HERE / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    validate()
    print(json.dumps({"cases": [{"name": c["name"], "summary": c["summary"]} for c in cases]}, indent=2))


def validate():
    result = json.loads((HERE / "results.json").read_text())
    assert result["schema"] == "gdm-adoption-performance/v1"
    assert result["trials"] >= 7 and result["correctness"]["regression_candidates"] == 200
    assert result["correctness"]["status_equal"] and result["correctness"]["existing_retro_fields_equal"]
    assert {case["name"] for case in result["cases"]} == {"status", "retro", "regression_replay_cost"}
    assert result["binary_sha256"]["before"] != result["binary_sha256"]["after"]
    for arm, path in BIN.items():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == result["binary_sha256"][arm]
        for name, expected in result["provenance"]["source_hashes"][arm].items():
            assert hashlib.sha256((HERE / arm / name).read_bytes()).hexdigest() == expected
    for case in result["cases"]:
        assert len(case["orders"]) == result["trials"]
        assert all(case["orders"][i] == list(reversed(case["orders"][i - 1]))
                   for i in range(1, result["trials"]))
        for arm, samples in case["samples"].items():
            assert len(samples) == result["trials"]
            assert summary(samples) == case["summary"][arm]
            assert all(s["wall_ms"] > 0 and s["cpu_ms"] >= 0 and s["max_rss_bytes"] > 0 for s in samples)
    print("gdm benchmark artifacts and source hashes validated")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["setup", "smoke", "run", "validate"])
    parser.add_argument("--trials", type=int, default=9)
    args = parser.parse_args()
    if args.action == "setup":
        setup(args.trials)
        print(json.dumps(correctness()))
    elif args.action == "smoke":
        print(json.dumps(correctness()))
    elif args.action == "run":
        benchmark(args.trials)
    else:
        validate()
