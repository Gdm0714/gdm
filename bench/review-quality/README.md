# Paired reviewer quality pilot

Frozen, model-only comparison of Terra medium and Astra medium through the user's
installed Pi transport. This is a reviewer experiment, not an end-to-end coding or
design experiment and not a change to the installed routing policy.

Four real GDM defect families have a defective reconstruction and a repaired
control: explicit scout effort validation, failed-process launch accounting,
audit evidence preservation at completion, and concurrent atomic state writes.
Each of the eight packets is reviewed twice by each model: 32 fresh, tool-free
reviewer processes. A packet contains a reconstructed addition of actual source
excerpts plus dependency contracts; it is not an unmodified historical whole PR.
The controlled change restores a documented historical fault to otherwise fixed
code. Provenance, executable fixtures, contracts, prompts, tests and schedule are
hashed before any model review. The tests are never given to the reviewers.

Protocol amendment during execution, before reading review contents: the extractor
mistook a destructured argument closing brace for the runner function end. Fix the
extractor with a regression test and supply the full supporting function for C01
and C03 before either case's first call. Preserve the original run and all eight
already-completed observations, whose packet and system hashes are unchanged.
Carry them into a new frozen manifest; do not rerun them. Supervisor suspension
contaminated R08 wall latency, so omit R07/R08's matched pair from latency medians
while retaining raw time and token/cost accounting. Quality criteria are unchanged.

Both reviewers receive exactly the same packet and system instructions, medium
effort and a 180-second wall-clock bound. Model selection is the only intentional
arm difference. Equal effort labels are not equal compute; report costs separately.
Use fresh sessions, no skills/extensions/context files/tools, no automatic retry
of recorded or interrupted observations. Run serially with rotated model order.
Provider-internal retries and caching are not controlled or provider-attested.

Primary outcomes: known-defect detection (root cause plus a valid trigger and
impact), and unsupported actionable findings. Report precision, miss rate,
control false-alarm rate, serious defects separately, exact-case repeat agreement,
completed response rate, latency, tokens and Pi-reported API list cost estimates.
Empty findings are valid; raw finding count and successful invocation count are
not quality scores. Do not penalize output formatting as a code defect; malformed
responses and transport failures remain separate and receive no detection credit.

Before arm labels are joined, locally adjudicate every finding against frozen
contracts and source, deduplicating multiple descriptions of one root cause per
response. Record label, reason and concrete reproduction/evidence. Categories:
known_true_positive, additional_confirmed, unsupported, out_of_scope, duplicate,
unresolved. Unsupported and out-of-scope actionable requests count against
precision; duplicates are reported separately. Unresolved findings are not silently
declared false: publish precision lower/upper bounds. Additional discoveries need
an executable reproduction and must be checked uniformly against both variants;
they never rewrite the preregistered known-defect denominator. Controls are
"repaired for the target fault", not proof of globally bug-free software.

A root coordinator performs source-based adjudication with model labels removed;
this is AI adjudication, not independent human expert ground truth. Preserve the
blind packet, adjudications and their hashes before unblinding. No model-based
judge calls are included in the comparison. Important contested findings should
be externally reviewed before a production routing decision.

Report paired family results, not independent test assertions. Four families and
two repetitions are a pilot, not evidence of a general model ranking. The paired
controls and repeats share code; do not claim 32 independent tasks. Clearly
described contracts and extracted context may be easier than normal repository
reviews. Do not select or change tasks after seeing which model wins. Do not
pool with the preceding implementation benchmark. This evaluates finding defects,
not whether an implementer acts on them or whether the final software improves.

Checks: `python3 bench/review-quality/verify.py --fixtures` and `--results`.
Prepare and execute: `python3 bench/review-quality/prepare.py`, then
`python3 bench/review-quality/run.py`. No automatic installation or policy edits.

Methodology reference: [OpenAI official evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices),
read 2026-09-09: task-specific cases, executable checks, explicit rubrics and
human calibration; evaluation of each workflow stage separately.
