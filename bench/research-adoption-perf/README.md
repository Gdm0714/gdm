# gdm adoption performance comparison

This benchmark runs two real optimized CLI binaries: the exact source from the
pre-adoption Work baseline and a frozen copy of the current source. Source hashes,
baseline HEAD and binary hashes are recorded. The two binaries use the same
Cargo.lock, compiler and release profile. No installed binary is replaced.

```sh
python3 bench/research-adoption-perf/prepare.py --build
python3 bench/research-adoption-perf/run.py setup --trials 9
python3 bench/research-adoption-perf/run.py smoke
# Run only when other benchmarks and builds are idle:
python3 bench/research-adoption-perf/run.py run --trials 9
# Verify saved data and recompute statistics, without repeating timed runs:
python3 bench/research-adoption-perf/run.py validate
```

The preparation script checks the old source against the adoption Work's exact
path/mode/content fingerprint when that local ledger exists. A clean checkout
instead uses the published baseline commit and content hashes in `provenance.json`.
It creates private source and build directories. Run preparation from a fresh
checkout so generated source directories cannot contain files from a prior run.
Preparation replaces `provenance.json` with hashes for the new comparison; preserve
the committed measurements and provenance together when starting a new run.
The saved results describe the 2026-10-29 source snapshot, not later changes.
On this Mac it clones cached release dependencies with APFS copy-on-write to avoid
rebuilding unrelated libraries. Source mtimes are refreshed for each arm so Cargo
cannot mistakenly reuse the other arm's same-package artifact.

The read-only workloads use one shared synthetic fixture: 10 Works, each with 10
bad-feedback events and 10 misses. Fixture state is created only through the CLI,
inside a private empty Git repository. No real conversations or credentials are
included. `status --json` must be identical. `retro --all --json` must keep every
existing field identical; the new output adds 200 `regressionCandidates`.

There are two warm-up runs per arm, then nine measured pairs with alternating
before/after order. Wall time includes process launch and execution. `wait4`
provides CPU time and peak resident memory for each individual child process;
RSS is not the cumulative maximum from earlier trials. Raw measurements and
median, empirical p95, minimum and maximum are saved in `results.json`.

The separate `regression_replay_cost` workload compares a direct shell `cmp`
against the new recorded replay of the same comparison. This is **new feature
overhead, not an equivalent before/after optimization**: replay additionally
validates frozen inputs and provenance, manages a process group, and writes a
durable result. Each replay uses a separate prepared fixture with the same event
count so earlier measured runs do not grow later runs' journals. This feature is
for reproducibility, with no expectation of beating a direct shell command.

Benchmarks run serially with the user's desktop undisturbed. Other applications
on the active Mac can still affect timing. Paired ordering and process CPU time
help interpret that noise but do not remove it. Nine-run p95 is the observed upper
tail of this small sample, not a reliable population percentile. These are local
CLI measurements, not model-token, task-quality or interactive UI results.

Generated source snapshots, binaries, fixture states and build output are ignored
by Git; scripts, provenance and measured JSON remain reviewable. No source product
code, installed applications, commits or user sessions are changed by the runner.

`validate_report.py` checks the aggregate report against the saved results in all
three sibling checkouts (`gdm`, `gid`, and `gdmux`). It does not build or time code.
Those checkouts are required only for the aggregate report; the local `validate`
command checks this repository's measurements independently.
