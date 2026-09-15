# Historical PR review → Terra repair pilot

Preregistered 2026-09-09. This follows the excerpt-only review pilot with full repository context and a final repair stage.

- GDM historical PR #14 (`732177b`) and #15 (`95d07d3`), complete source trees and parent-to-candidate diffs. Candidates are reconstructed replays with four injected defects; they are not unmodified live PRs.
- C01: PR #14 with UTF-8 and slug-validation defects in explicit state recovery. C02: PR #15 with stale downstream delivery evidence after PR/CI re-recording. C03: unmutated PR #14 reference, a preservation control rather than proof the historical code has no other defects.
- Three arms: Terra high self-check/repair; Terra medium review → fresh Terra high repair; Astra medium review → fresh Terra high repair. Same repair prompt, external review metadata omitted, original substantive findings preserved.
- Two repetitions, rotated sequential order: 18 final repairs and 12 actual reviewer calls, 30 Pi calls total. No design role, no nested model calls, no automatic rerun. Frozen source, prompts, manifest, raw JSONL, tool calls, complete snapshots, final diffs and usage retained.
- Reviews can read complete files, imports, call sites, tests and the actual diff. Repairers can edit source and add tests. Original tests and other files are protected. The evaluator restores original tests when grading.
- Public tests: all original functional runtime tests, except one slug-mismatch parameter held out from C01/C03. CI/release, installation, installed binary and documentation policy tests are excluded. All exclusions are disclosed before execution. Eight hidden groups per case; fixed reference, candidate and each isolated mutation must validate before model calls.
- Primary: remaining known defects (four distinct faults), final hidden groups, original functional tests and newly introduced failures. Secondary: evidence-backed finding dispositions and changes, review + repair latency, tokens and API list estimates. Source line count is descriptive, never an unnecessary-change metric. Human repair time and real billing are not measured.
- Single pass: one reviewer result then one repair, with no re-review and no hidden feedback during a call. This isolates reviewer input contribution; it does not evaluate the production requirement for final-source re-review.
- Case scopes/contracts are frozen before calls. Same-HEAD delivery invalidation explicitly states the historical reference behavior, since old prose is not fully specific. The normal reference may contain legitimate additional defects; findings there require individual adjudication rather than automatic false-positive labels.
- Review/repair reads stay within their repository by explicit contract, not an OS sandbox. No future Git history or expected patch is available in the workspace. Pi model identity and costs are reported metadata, not remote attestation or OAuth billing.

Reproduce locally:

```sh
python3 bench/pr-review-repair/prepare.py
python3 bench/pr-review-repair/verify.py --build-fixtures
python3 bench/pr-review-repair/run.py
python3 bench/pr-review-repair/analyze.py
# Independently assess each saved review/final diff and write change-assessment.json.
python3 bench/pr-review-repair/verify.py --fixtures --results
```

Do not rerun prepare or execute to improve recorded scores. `active-run.json` identifies the preserved run. The final report must include transport/format failures, incomplete usage, protected-file violations, and unresolved findings separately from quality.
