# Work Protocol Codex receiver observation

Observed at: 2026-08-12

- Receiver exported `gdm-work-snapshot/v1` before each attempt.
- Revision 1 was rejected as stale with `plan_changed`, `state_changed`, and `source_changed`.
- Revision 2 was rejected as stale with `state_changed` after intervening check evidence changed Work state.
- Neither stale attempt opened `bench/work-protocol-live-smoke.sh` or invoked pass, done, audit, or handoff.
- Revision 3 (`root-to-final-fresh-receiver-v3`) was fresh with `staleReasons: []`.
- Its artifact SHA-256 `861a3a94b325e68ca8cd9d5d4e084dcdc2d68fa8335595882a741d4ecb767526`
  matched the file before inspection.
- Only then did the receiver inspect the artifact and cite its guarded temporary-directory cleanup.

This is a bounded three-attempt observation, not a long-run model-compliance rate.
