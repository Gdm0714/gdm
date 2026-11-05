# Automatic role allocation

## Ordinary requests enter through the current host

With `gdm-entry-v1` installed and effective, an ordinary request such as “fix the login error” receives
`GDM_AUTOMATIC_ENTRY_V1` context. The current conversation model classifies the original request;
the hook performs no provider call and does not use keyword heuristics to decide meaning. Work follows
installed `gdm-go`, or the existing `gdm-full` criteria when appropriate. Questions remain lightweight,
and an explicit “without GDM for this request” is recorded as request-scoped opt-out. Existing Work
is preserved for resume.

```sh
gdm entry status --target codex --session <actual-session-id> --json
gdm entry decide --target codex --session <actual-session-id> --request <hook-token> --kind work --json
# Follow go/full: preserve the original brief, initialize Work and register real checks.
gdm entry decide --target codex --session <actual-session-id> --request <hook-token> --kind work --slug <existing-work> --json
# Then use the existing team auto / next / claim / native execution / report / pass / review / done loop.
```

Use the exact target, session and request token from the observed hook; do not invent them. The same
`decide` command accepts `--kind question` or `--kind optout` without creating Work. `decide` records a
model declaration; it neither proves classification accuracy nor allocates tasks. Read `slug` and
`activeWorkSlug` before initializing. Resume existing Work through `protocol export` and `team next`;
reminders and repeated events must not trigger another planner. A stale request token cannot replace
the current decision, and an unfinished Work binding cannot be silently replaced.

| Host | Entry and continuation | Enforcement limits |
|---|---|---|
| Codex | `UserPromptSubmit` adds context; the current model uses actual native spawn/wait/result tools. | Supported edit-tool gates and bounded Stop correction; arbitrary shell/MCP mutations remain outside coverage. Requires effective hook support/trust. |
| Claude Code | `UserPromptSubmit` adds context; the current model uses exposed `Agent` and result tools. | Supported edit-tool gates and bounded Stop correction; shell/MCP blind spots. Missing stable turn identity cannot guarantee exactly-once delivery of identical prompts. |
| gid native | Trusted extension `input` adds context; `before_turn` reminds the root. Native `delegate_tasks` executes claimed tasks and collects results. | Entry is context-only. Existing native completion guard covers session-bound coordinated Work, not every mutation or single Work. A new native session and existing permission approvals may be required. |

Hooks skip trustworthy host-identified workers and `GDM_ENTRY_DISABLED=1` provider children. Hosts
without reliable worker identity cannot promise complete root/worker detection; parents must tell
native workers to execute only their assignment and never initialize another root Work. gid's
`block_reason` aborts before context insertion, so it is not used as a recoverable generic edit denial.
No hook grants permissions, invokes a nested model, replaces user input or creates an execution daemon.
Installation is distinct from observed activation. Use `gdm entry install --target <codex|claude|gid>
--binary <absolute-executable> --dry-run --json` to inspect a managed registration. Preserve existing
settings, feature flags and permission modes. gid registration hash-pins the executable and must be
refreshed after binary upgrades; do not edit its registry by hand. `GDM_ENTRY_DISABLED=1` suppresses
entry for a process; request opt-out does not uninstall or persistently disable the integration.


## Adaptive allocation

`gdm team auto --from-request` interprets the Work's original user request and registered checks, then generates durable knowledge, implementation and independent verification tasks. For a new input GDM collects repository paths, invokes one bounded tool-0 planner through an automatically selected provider, model and effort, validates the result and records its provenance. This is actual model use and can incur provider usage, including with `--dry-run`. An unchanged input reuses the stored result with `plannerReused: true`.

The host supplies its real capacity, executor availability, allowed capability catalogue and any necessary explicit context. It does not assign roles, choose module boundaries or author a modules JSON plan in the normal workflow. GDM chooses those assignments and their execution routes from the supplied inputs.

Planning and execution are separate: the request result reports `automaticPlanning: true` and `automaticExecution: false`. The CLI does not launch native subagents. The active host executes the generated `gdm team next` route and prompt, claims each task before launching it, collects its report, runs linked checks and records acceptance. The prompt carries the original brief and contract, exact task ownership, dependencies and check definitions; the host adds execution identity and preserves those instructions. It does not reinterpret the allocation or silently substitute a worker model. A generated plan is not evidence that workers ran.

## Request-driven workflow

Preserve the original user request in the Work brief and register at least one meaningful check before planning. The planner uses the brief, requirements, risk, scope, uncertainties, registered check definitions and repository path inventory. Existing paths must appear in that inventory; new paths must be explicitly declared by the planner in `createPaths` beneath an existing parent. Only add relevant, credential-free context files that are authorized for the selected provider. Do not send secrets or private code to external tools.

```sh
gdm team auto --slug feature --from-request --max-active <available-worker-slots> --executor native --json
gdm team next --slug feature --json
```

The default omits both `--provider` and `--model`: GDM selects an authorized planner from the operator catalog described below. This planner catalog is separate from the native worker capability catalog. Append `--context <repository-relative-file>` for each necessary context file. At most 16 explicit context files are allowed; their text and accepted knowledge together must fit in 32 KiB, and the full planner input must fit in 48 KiB. Narrow the Work's allowed paths or supplied context when these bounds are exceeded. Repository inventory includes paths and hashes, not source file text. Use `--capabilities-file <repository-relative-file>` only to describe execution routes the host can actually perform. When host tool metadata exposes multiple permitted models and efforts, construct a v2 catalogue automatically from those callable capabilities. Otherwise the default is the inherited native worker route:

```json
{
  "schemaVersion": "gdm-team-capabilities/v1",
  "routes": [
    {
      "id": "native-inherit",
      "provider": "native",
      "model": "inherit",
      "roles": ["knowledge", "implementation", "verification"],
      "access": ["read", "write"]
    }
  ]
}
```

A v2 route adds `execution` (`native` or `tool-free`), supported `efforts` (strings or null), `strengths` and `limitations` arrays, and optional advisory `costClass` and `maxInvocations`. A tool-free Claude planner is not a writable worker. Do not infer availability, authorization or prices from names. The catalogue describes available capabilities; it is not a task-to-model or role-to-worker assignment. The planner may select only a supplied route ID that supports the role and access mode. `native-inherit` preserves the host's current worker model. The planner model does not override it. If a selected route is unavailable at execution time, report the blocker and replan with truthful capabilities instead of substituting a model.

## Configure the automatic planner once

The operator approves actual callable Claude or Codex candidates, their supported efforts, capability levels and resource preferences once. Preserve an existing configuration; do not overwrite it during workflow setup or invent candidates, entitlement or prices. GDM does not infer CLI availability from the host's native worker model list. A missing or invalid catalog fails explicitly rather than assuming a model.

Without `--planner-catalog`, resolution uses the first configured location: `$GDM_CONFIG_DIR/planner-catalog.json`, otherwise `$XDG_CONFIG_HOME/gdm/planner-catalog.json`, otherwise `$HOME/.config/gdm/planner-catalog.json`. `--planner-catalog <repository-relative-file>` selects a repository-contained catalog for this input. It does not replace `--capabilities-file`, which describes worker execution routes.

The exact schema is `gdm-planner-catalog/v1`, with 1–16 routes. This illustrative placeholder must be replaced with operator-approved model IDs and declarations before use; it is not a built-in model policy:

```json
{
  "schemaVersion": "gdm-planner-catalog/v1",
  "routes": [
    {
      "id": "approved-planner",
      "provider": "claude",
      "model": "operator-approved-model-id",
      "efforts": [{ "level": "high", "capability": "frontier", "costRank": 1 }],
      "limits": { "maxSeconds": 120, "maxOutputBytes": 262144, "maxBudgetUsd": 0.50 }
    }
  ]
}
```

Each route has a unique `id` and provider/model pair, `provider` (`claude` or `codex`), `model`, 1–6 unique effort entries and `limits`. Each effort has exactly `level`, `capability` (`standard`, `advanced` or `frontier`) and integer `costRank` (0–1000000). Claude supports `low`, `medium`, `high`, `xhigh`, `max`; Codex supports `minimal`, `low`, `medium`, `high`, `xhigh`. These adapter-supported values do not establish that a particular model or account supports them; only configure authorized pairs. `costRank` is an operator's advisory resource preference, not a measured token price or subscription charge.

`limits` requires integer `maxSeconds` (1–120) and `maxOutputBytes` (1–262144). Optional positive `maxBudgetUsd` is Claude-only and is passed to its CLI; omission retains the 0.50 per-invocation default. Codex monetary caps are rejected. Time/output limits tighten the existing runtime environment bounds. A CLI budget flag does not measure subscription balance or impose a cumulative Work spending cap.

`gdm-planner-policy/v1` uses declared Work facts with a conservative `standard` floor. Each of medium risk, unresolved uncertainties, integration, any expert check, and large scope (more than eight checks or more than eight allowed paths) adds one escalator. One or two require `advanced`; three or more, or high risk, require `frontier`. Feasible route/effort pairs sort by `costRank`, capability, effort order (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), then route ID. If no feasible pair exists, selection fails explicitly. This is deterministic demand selection, not keyword semantic analysis, a quality benchmark or proof of the optimal model.

The selector itself makes no provider call. Each new-input command invokes the selected planner at most once, with no automatic retries or fallback. Identical accepted inputs reuse their plan. Selection reason, catalog source/hash, policy facts and requested effort/effective limits are bound to cache input and provenance; v2 receipts bind the actual invocation options. Changed or missing current catalogs block claims until replanning, while historical validation replays the persisted snapshot. Legacy provenance remains valid. Requested model and process evidence are observable; they do not attest the remote backend's identity.

For an explicit manual override, add `--provider <claude|codex> --model <planner-model>` and optionally `--effort <level>` to the request command. Both provider and model are required together. Omitting effort preserves legacy manual behavior; supplying it uses exact effort transport and v2 receipts. A partial override, `--effort` without the complete override, or combining manual routing with `--planner-catalog` fails. Manual planner selection does not select worker models.

For new input, `--dry-run` invokes the planner and validates a proposal without applying it to durable Work. The `allocation.request` provenance summary identifies the request-driven origin. Applied provenance is archived at `.gdm/<slug>/out/team-request-<sha256>.json`, binding the planner input, response and receipt. Planner failure, unavailable provider, malformed output or invalid assignments fail explicitly; there is no keyword-based fallback and the host must not fabricate a successful plan. `--from-request` and `--file` are mutually exclusive.

## Native host planner bridge

A native gid host can use its existing model transport while every GDM workspace command stays inside the host sandbox. GDM prepares the exact prompt and response schema; gid makes one tool-free inference and returns its bound response. GDM remains responsible for source collection, freshness, proposal validation, ownership, durable allocation and worker claim limits. Neither bridge command invokes a provider CLI, executes a check or dispatches workers.

```sh
gdm team configure --slug feature --mode coordinated --session <actual-gid-session> --max-active <available-worker-slots>
gdm team auto --slug feature --from-request --prepare-native --provider codex --model <actual-host-model> --effort high --max-active <available-worker-slots> --executor native --json
# gid invokes its existing model transport with the returned prompt/schema and limits.
gdm team auto --slug feature --from-request --complete-native .gdm/feature/out/native-completion.json --json
```

Preparation requires explicit provider/model and `--executor native`, supports the normal context/capabilities/replan flags, and rejects `--file`, `--dry-run`, `--planner-catalog` and simultaneous completion. Completion accepts only `--slug`, `--from-request`, `--complete-native` and optional `--json`. The host must first bind the actual session with `team configure`; the bridge does not invent a session or change GDM permissions.

The preparation schema is `gdm-native-plan-preparation/v1`. It returns an opaque `requestId`, `slug`, `sessionId`, canonical entire-Work `stateFingerprint`, `inputDigest`, `provider`, `model`, nullable `effort`, `maxInvocations: 1`, `maxSeconds` (at most 120), `maxOutputBytes` (at most 262144), exact `prompt`, object `responseSchema`, `promptSha256`, `schemaSha256`, `automaticPlanning: true` and `automaticExecution: false`. The prompt hash covers its UTF-8 bytes; schema and response hashes cover compact canonical JSON, recursively sorting object keys. An immutable pending artifact also binds the exact input and original preparation arguments. Preparation does not apply allocation or alter canonical Work. Repeating identical preparation returns the same identity. If an equivalent allocation already exists, the result is a team summary with `plannerReused: true`; the host must skip inference.

The completion file must be repository-relative, regular, contained and free of symlinks. Store it under `.gdm/<slug>/out/` so writing the result does not change source inventory. The envelope has exactly these fields:

```json
{
  "schemaVersion": "gdm-native-plan-completion/v1",
  "requestId": "<preparation-requestId>",
  "response": { "plan": {}, "rationale": "<model rationale>" },
  "receipt": {
    "schemaVersion": "gdm-native-planner-receipt/v1",
    "attestation": "host-asserted",
    "host": "gid",
    "requestId": "<preparation-requestId>",
    "sessionId": "<preparation-sessionId>",
    "invocationId": "<actual-host-inference-id>",
    "providerTarget": "codex",
    "modelRequested": "<preparation-model>",
    "effortRequested": "high",
    "promptSha256": "<preparation-promptSha256>",
    "schemaSha256": "<preparation-schemaSha256>",
    "outputSha256": "<canonical-response-sha256>",
    "providerInvocations": 1,
    "elapsedMs": 100,
    "status": "succeeded"
  }
}
```

The sample's empty plan is a placeholder: `response` must satisfy the exact returned schema and all semantic plan rules. Every receipt field shown is required, including nullable `effortRequested`; an optional object `usage` of at most 16 KiB may contain observed usage. The full envelope must fit in 1 MiB; its canonical response must fit the preparation's output bound. No executable, executable hash/version, argv policy or invented billing fields are accepted. The receipt truthfully records a **host assertion**, not proof of remote model identity or cryptographic proof of inference. A bare manually authored plan or an unbound receipt fails validation. gid must record inference intent/result and must not silently retry an invocation whose outcome is unknown after interruption.

Before first application, completion compares the entire Work and recomputed inventory, contexts, capabilities and invocation reservations to the prepared snapshot. It validates all receipt/hash bindings, output size, status, one-invocation limit, elapsed bound, strict plan shape, grounding, coverage, dependencies, scope and ownership. It previews the ordinary allocation lifecycle guards, binds one immutable consumed completion to the request, then archives and applies. Interruption before the Work commit can resume only that identical completion. Validation rejection leaves allocation unchanged. A storage error or interruption can occur after canonical Work has committed; the host must reconcile using the identical completion, which returns unchanged if already applied, rather than launch another inference. Native provenance is archived with the exact preparation, response and receipt; existing CLI v1/v2 receipts and historical plans retain their validation semantics.

Replaying the identical current completion returns `unchanged: true` and `plannerReused: true` without reapplying, including after worker progress. Changing the response or receipt for an already completed request rejects. A superseded request cannot restore an older allocation. Missing or corrupt applied provenance fails closed. A fresh proposal is required after a changed Work, session, source, context or capabilities snapshot; use the ordinary explicit replan lifecycle after worker attempts.

## Decide the necessary roles

- Knowledge is required when the Work has unresolved `contract.uncertainties`, an integration verification marker/profile, or an explicit knowledge assignment. Its deliverable should distinguish source facts, assumptions, conflicting policies and missing facts.
- Independent verification is required for knowledge-dependent work, medium/high-risk Work, multiple modules, an explicit verification assignment or `independentVerification: true`. The verification task depends on accepted knowledge and all implementation tasks. Its assignee must not have implemented this Work, including earlier attempts.
- A single low-risk module without unknown knowledge or an independent verification request stays in reasoned single mode. The coordinator executes its normal checks directly; no unnecessary worker is created.
- Domain implementation waits for knowledge by default. A module may set `knowledgeIndependentReason` to explain why its foundation work is independent. This permits parallel scheduling only when actual path ownership does not conflict.

The model interprets the natural-language request; deterministic validation then enforces these role and coverage rules. The host still registers meaningful checks and reviews whether the result satisfies the user. A different assignee ID does not prove a different human or model; hosts must use a fresh execution context. The independent verifier does not replace the different-model audit required by `gdm full`.

## Accept knowledge before implementation

Request-driven plans with v2 catalogues use planner semantic contract version 3 (`input.promptVersion: 3` and `plannerContract.version: 3`). Assignments include `effort` and `selectionReason`, chosen for the task’s difficulty, risk, execution needs and cost constraints. The same role can use different routes and efforts; there is no fixed role-to-model table. A v1 catalogue continues to use semantic version 2. Prior v1/v2 provenance and manual plans remain supported. The plan schema remains `gdm-team-plan/v1`. GDM generates knowledge assignments with `acceptanceMode: "artifact-review"` and `checks: []`; these values are preserved on the knowledge task. This mode is reserved for the generated semantic plan and cannot be enabled by a manual `--file` import.

The knowledge worker submits a completed, source-backed report that distinguishes observed facts, source references, unresolved questions and implications for implementation. The coordinator reads the actual report, verifies its unchanged artifact hash and acceptance criteria, then records `team review`. A future behavior check may still fail because implementation has not started; that is not a prerequisite for accepting this knowledge report. An exit code or unsupported completion claim alone is not sufficient. The dispatch prompt includes all Work check definitions even though knowledge has no linked checks.

Every registered check must still be covered by implementation or verification. Those roles retain linked-check acceptance gates, and `gdm done` retains its all-checks completion gate. A knowledge report neither marks a check passed nor resolves a verification-contract uncertainty whose required evidence is still absent. Manual plans and earlier request semantics keep their existing acceptance behavior.

The planner must also avoid implementation acceptance cycles: if a module's linked check cannot pass until a later dependent module is implemented, keep that implementation together or attach final checks to verification. Do not weaken checks or report a failing check as passed to advance the scheduler.

Implementation ownership must include the test files that need to be written or changed. The final verifier remains read-only and sends missing tests or fixes back to implementation. Workers do not broaden their own ownership or model routes to repair an incomplete allocation. Nested delegation remains host/GDM-coordinated, using generated tasks, claims, available capacity and the target's supported tools; a child quota is not permission for ad hoc scope or model expansion.

## Manual import compatibility

`--file` remains an explicit manual import compatibility path, not the normal workflow or a workaround for a failed planner. Use it when a manually authored plan was expressly selected. This path imports a `gdm-team-plan/v1` spec without invoking a planner. Register the Work and checks first: each assignment references existing check IDs, and every registered check must be assigned to at least one role. The following example documents the legacy format.

```json
{
  "schemaVersion": "gdm-team-plan/v1",
  "executor": "native",
  "maxActive": 3,
  "knowledge": {
    "paths": ["docs/integration"],
    "checks": ["c1"],
    "deliverable": "Source-backed input format and policy table with unresolved facts",
    "acceptance": "Original input, policy conflicts and required outcomes are documented"
  },
  "modules": [
    {
      "id": "transport",
      "paths": ["src/transport"],
      "checks": ["c2"],
      "knowledgeIndependentReason": "Transport retry and timeout handling do not depend on unresolved business policies",
      "deliverable": "Transport implementation and failure handling",
      "acceptance": "Timeout and retry tests confirm expected behavior"
    },
    {
      "id": "service",
      "paths": ["src/service"],
      "checks": ["c3"],
      "deliverable": "Business behavior based on accepted knowledge",
      "acceptance": "Valid customer actions succeed and forbidden actions are denied"
    }
  ],
  "verification": {
    "paths": ["src/transport", "src/service", "tests"],
    "checks": ["c4"],
    "deliverable": "Independent scenario results and observed limitations",
    "acceptance": "Original inputs, expected state changes, denial cases and continuity pass"
  }
}
```

```sh
gdm team auto --slug feature --file .gdm/plans/roles.json --dry-run
gdm team auto --slug feature --file .gdm/plans/roles.json
gdm team next --slug feature --json
```

The generated task IDs are `knowledge`, `implement-<module-id>` and `verify`. Knowledge and verification have read ownership; implementation has write ownership. Workers write their review reports through the existing artifact flow, without modifying source outside ownership. Verification needing changes to test source should report findings to a scoped implementation task or be represented as an implementation module before the final read-only verification.

For manual import, `--dry-run` describes the exact supplied proposal without mutating durable Work or invoking a planner. Applying identical spec and requirements is idempotent and never resets an active worker. `team status` includes the allocation strategy, required roles, executor capability, digests and blockers. Existing `team next` action kinds are preserved; an automatic plan can additionally return `blocked` with the allocation blockers.

## Scheduling, execution and budget

`--max-active` supplies an explicit budget of 1–32 active workers, excluding the coordinator. The host reports a truthful cap within its currently available slots, resource pressure and the user's cost constraints; GDM chooses useful roles and dependencies within that cap. The upper bound is not a target worker count. Count nested workers and other active work against the same host budget; do not invent capacity from this CLI range. Reassess inputs when results reveal dependency waits, duplicate investigation or integration costs. Keep heavy builds and integration tests serialized. The existing scheduler enforces the declared cap, path conflicts, unique active assignees and accepted prerequisite artifacts. A cap of one serializes required roles; it does not remove independent verification.

The automatic spec requires an explicit `maxActive`; it has no preferred two- or three-worker default. The older manual `team configure` command retains its omitted-value default of three for compatibility. Native host limits remain authoritative: for example, the current gid `delegate_tasks` accepts at most three tasks per call, so additional useful work runs in later batches. Changing a Work budget does not raise an active host session's limit.

Execute the GDM-selected route and effort exactly within the host’s allowed capabilities. Before spawn, adaptive claims declare `--execution-route`, `--execution-provider`, `--execution-model` and `--execution-effort` (use `inherit` for null effort; a literal string effort named `inherit` is not permitted). These are host declarations, not remote identity attestation. The host passes the selected model and effort through supported native controls; if context inheritance prevents overrides, use a supported fresh context with the complete generated prompt. The default native route inherits the current implementation model; verification uses a fresh session. Full audit must differ from every actual implementation model, including coordinator edits and prior attempts whose changes remain. Run `gdm audit verdict --report <report> --pass --implementation-model <model> --implementation-model <other-model> --audit-model <audit-model>`, repeating `--implementation-model` for every actual implementation model. The audit report must contain a separate exact `implementationModel: <model>` line for each and an `auditModel: <audit-model>` line. Validation compares the audit model with every supplied model and requires coverage of recorded current and historical write attempts; the host must include coordinator and otherwise untracked edits. New v3 work with unknown attribution is rejected. For legacy attempts without execution declarations, attribution is supplied by the host and is not machine-attested remote identity. Protocol export preserves `implementationModels`; the legacy `implementationModel` scalar retains the first value, and done and audit-state recheck the array. This version does not invent token prices, spend limits, model availability or utilization figures. Provider spending and catalogue changes remain subject to the user's existing constraints. The v3 planner input `invocationReservations` summarizes claimed and remaining reservations by provider and model, including history. Optional invocation caps count claimed attempts rather than dollars or subscription balance; a reserved claim can consume a slot even if launch fails. Fewer active workers bound concurrency, not cumulative token consumption.

The host must inspect its actual executor capability. Set `--executor unavailable` if it cannot spawn native workers. Complex plans then remain visibly blocked: `next` does not dispatch and `claim` rejects. Before any task is claimed, replan with `--executor native` after capability is restored. Small single-mode work can proceed through the coordinator without a worker executor.

Knowledge collection does not grant new authority. For example, a chat-interview role may send messages only when the user has authorized those interviews. Desktop, privacy, tool routing and source restrictions apply equally to all roles. No user-visible window is opened by this CLI.

## Coverage and freshness

Generated task definitions cannot be individually overwritten or withdrawn. A missing or altered required role invalidates the persisted allocation. Update the request, checks or explicit context when source evidence changes the necessary work. Before any claims, reapply the request-driven command. After historical attempts, use the same `--from-request` command with `--replan --reason "New source evidence changed the required behavior"`; do not hand-edit generated modules. Explicit replan requires no active or unreviewed (`reported`) task; collect and review those reports first. The old task plan, attempts and reports are preserved through hash-bound history artifacts, the new tasks start pending, and completion/audit acceptance is cleared. Historical attempt IDs remain reserved and historical implementation assignees cannot become the independent verifier. At most 16 revisions are retained per Work. Existing manually authored team tasks are never overwritten by `team auto`. The explicit manual import path also retains `--file ... --replan --reason ...` compatibility.

Changes to the brief, declared requirements, uncertainty, scope, risk or check definitions make the allocation stale. Dispatch, claims and completion then block until the revised plan is applied. `--replan` and a substantive `--reason` are required together for changes after historical attempts. Check evidence and task progress do not alter this input fingerprint. Accepted prerequisite artifacts and check evidence are re-read at claim/review time; changed source findings cannot silently flow into downstream implementation. The existing acceptance and completion gates remain authoritative.

The allocator enforces declared coverage. Neither a model-generated plan nor deterministic validation proves that every requirement was discovered, that a declared knowledge-independent module is truly independent, or that a check asserts the correct business outcome. Those concerns require source review, executable scenarios and the full audit.
