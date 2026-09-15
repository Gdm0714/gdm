# Final regression check follow-up — 2026-09-09

The completion replay found one failure in the existing Computer Use delayed-listener
test (475 passed, 3 skipped, 1 failed). The model-routing and benchmark checks passed.
The complete test file then passed in isolation (7 tests, 29 assertions).

Inspection found a race in the test fixture: the fake listener opened three seconds
after its process started, while the test expected VM startup to finish before the
listener opened. A loaded machine need not satisfy that timing assumption. The
completion journal retains the failure summary; it does not retain the full failed
assertion stack, so this is a plausible cause rather than a proven diagnosis of that
individual failure.

The fixture now waits for an explicit file signal written after `manager.start()`
returns. Its listener PID remains stable, the existing detection and process-cleanup
assertions are unchanged, and `finally` stops owned processes even on assertion failure.
Production Computer Use code and the frozen benchmark inputs are unchanged.
The original source file already had unrelated uncommitted changes; those were retained.

The first fixture revision passed the full suite (476 passed, 3 skipped, 0 failed,
6,287 assertions in 223.14 seconds), but the completion replay failed the same test
again. This disproved treating the startup timing change as a sufficient fix.

Further bounded diagnostics preserved the complete output under
`regression-diagnostics/`. A full-file probe reproduced an immediate-listener test
failure: it expected `exposed a host TCP listener`, but received
`Host TCP listener inspection failed (1)`. Five delayed-only probes passed. The
runtime source permits precisely this second error when lsof returns exit 1 with
nonempty output, and closes owned processes on either error. The exact cause of
each earlier truncated delayed-test failure remains unconfirmed.

The final assertions accept either of those two listener-inspection rejection
messages, and continue rejecting other errors. Both fixtures now also write a
marker only after a real socket has entered listen state, which the tests require
before accepting the result. The delayed fixture must first complete normal startup.
Ownership must become false and no process bearing the fixture token may remain
before the `finally` cleanup. These are checks of the existing fail-closed behavior,
not a change to runtime enforcement or permission to ignore an inspection error.

The full check command now uses `verify-regression.py` to run the identical sequence
of typecheck, unfiltered `bun test`, build, and smoke. It preserves each complete log
so a future completion failure is not reduced to a truncated summary. The registered
completion gate replays that sequence and records the final result in the GDM journal.

The final fixture passed three consecutive full-file probes (7 tests and 31 assertions
each), then the unfiltered full suite passed: 476 passed, 3 skipped, 0 failed, and
6,289 assertions. Typecheck, build, and smoke also passed. Complete logs for this
pass use the prefix `20260908T234036917807Z` in `regression-diagnostics/`.
