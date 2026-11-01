# Automatic role allocation

`gdm team auto --from-request` interprets the Work's original user request and registered checks, then generates durable knowledge, implementation and independent verification tasks. For a new input GDM collects repository paths, invokes one bounded tool-0 planner through the selected provider, validates the result and records its provenance. This is actual model use and can incur provider usage, including with `--dry-run`. An unchanged input reuses the stored result with `plannerReused: true`.

The host supplies its real capacity, executor availability, allowed capability catalogue and any necessary explicit context. It does not assign roles, choose module boundaries or author a modules JSON plan in the normal workflow. GDM chooses those assignments and their execution routes from the supplied inputs.

Planning and execution are separate: the request result reports `automaticPlanning: true` and `automaticExecution: false`. The CLI does not launch native subagents. The active host executes the generated `gdm team next` route and prompt, claims each task before launching it, collects its report, runs linked checks and records acceptance. The prompt carries the original brief and contract, exact task ownership, dependencies and check definitions; the host adds execution identity and preserves those instructions. It does not reinterpret the allocation or silently substitute a worker model. A generated plan is not evidence that workers ran.

## Request-driven workflow

Preserve the original user request in the Work brief and register at least one meaningful check before planning. The planner uses the brief, requirements, risk, scope, uncertainties, registered check definitions and repository path inventory. Existing paths must appear in that inventory; new paths must be explicitly declared by the planner in `createPaths` beneath an existing parent. Only add relevant, credential-free context files that are authorized for the selected provider. Do not send secrets or private code to external tools.

```sh
gdm team auto --slug feature --from-request --provider codex --model <planner-model> --max-active <available-worker-slots> --executor native --json
gdm team next --slug feature --json
```

The provider must be `claude` or `codex`; `--model` selects the planner, not implementation or verification workers. Choose an available planner within the user's established provider and cost constraints. Append `--context <repository-relative-file>` for each necessary context file. At most 16 explicit context files are allowed; their text and accepted knowledge together must fit in 32 KiB, and the full planner input must fit in 48 KiB. Narrow the Work's allowed paths or supplied context when these bounds are exceeded. Repository inventory includes paths and hashes, not source file text. Use `--capabilities-file <repository-relative-file>` only to describe execution routes the host can actually perform. Its default is the inherited native worker route:

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

The catalogue describes available capabilities; it is not a task-to-model or role-to-worker assignment. The planner may select only a supplied route ID that supports the role and access mode. `native-inherit` preserves the host's current worker model. The planner model does not override it. If a selected route is unavailable at execution time, report the blocker and replan with truthful capabilities instead of substituting a model.

For new input, `--dry-run` invokes the planner and validates a proposal without applying it to durable Work. The `allocation.request` provenance summary identifies the request-driven origin. Applied provenance is archived at `.gdm/<slug>/out/team-request-<sha256>.json`, binding the planner input, response and receipt. Planner failure, unavailable provider, malformed output or invalid assignments fail explicitly; there is no keyword-based fallback and the host must not fabricate a successful plan. `--from-request` and `--file` are mutually exclusive.

## Decide the necessary roles

- Knowledge is required when the Work has unresolved `contract.uncertainties`, an integration verification marker/profile, or an explicit knowledge assignment. Its deliverable should distinguish source facts, assumptions, conflicting policies and missing facts.
- Independent verification is required for knowledge-dependent work, medium/high-risk Work, multiple modules, an explicit verification assignment or `independentVerification: true`. The verification task depends on accepted knowledge and all implementation tasks. Its assignee must not have implemented this Work, including earlier attempts.
- A single low-risk module without unknown knowledge or an independent verification request stays in reasoned single mode. The coordinator executes its normal checks directly; no unnecessary worker is created.
- Domain implementation waits for knowledge by default. A module may set `knowledgeIndependentReason` to explain why its foundation work is independent. This permits parallel scheduling only when actual path ownership does not conflict.

The model interprets the natural-language request; deterministic validation then enforces these role and coverage rules. The host still registers meaningful checks and reviews whether the result satisfies the user. A different assignee ID does not prove a different human or model; hosts must use a fresh execution context. The independent verifier does not replace the different-model audit required by `gdm full`.

## Accept knowledge before implementation

New request-driven plans use planner semantic contract version 2 (`input.promptVersion: 2` and `plannerContract.version: 2`). The plan schema remains `gdm-team-plan/v1`. GDM generates knowledge assignments with `acceptanceMode: "artifact-review"` and `checks: []`; these values are preserved on the knowledge task. This mode is reserved for the generated semantic plan and cannot be enabled by a manual `--file` import.

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

Execute the planner-selected routes exactly within the host's allowed capabilities. The default native route inherits the current implementation model; verification uses a fresh session. Follow existing full-audit model separation. This version does not invent token prices, spend limits, model availability or utilization figures. Provider spending and explicit catalogue changes remain subject to the user's existing constraints. Fewer active workers bound concurrency, not cumulative token consumption.

The host must inspect its actual executor capability. Set `--executor unavailable` if it cannot spawn native workers. Complex plans then remain visibly blocked: `next` does not dispatch and `claim` rejects. Before any task is claimed, replan with `--executor native` after capability is restored. Small single-mode work can proceed through the coordinator without a worker executor.

Knowledge collection does not grant new authority. For example, a chat-interview role may send messages only when the user has authorized those interviews. Desktop, privacy, tool routing and source restrictions apply equally to all roles. No user-visible window is opened by this CLI.

## Coverage and freshness

Generated task definitions cannot be individually overwritten or withdrawn. A missing or altered required role invalidates the persisted allocation. Update the request, checks or explicit context when source evidence changes the necessary work. Before any claims, reapply the request-driven command. After historical attempts, use the same `--from-request` command with `--replan --reason "New source evidence changed the required behavior"`; do not hand-edit generated modules. Explicit replan requires no active or unreviewed (`reported`) task; collect and review those reports first. The old task plan, attempts and reports are preserved through hash-bound history artifacts, the new tasks start pending, and completion/audit acceptance is cleared. Historical attempt IDs remain reserved and historical implementation assignees cannot become the independent verifier. At most 16 revisions are retained per Work. Existing manually authored team tasks are never overwritten by `team auto`. The explicit manual import path also retains `--file ... --replan --reason ...` compatibility.

Changes to the brief, declared requirements, uncertainty, scope, risk or check definitions make the allocation stale. Dispatch, claims and completion then block until the revised plan is applied. `--replan` and a substantive `--reason` are required together for changes after historical attempts. Check evidence and task progress do not alter this input fingerprint. Accepted prerequisite artifacts and check evidence are re-read at claim/review time; changed source findings cannot silently flow into downstream implementation. The existing acceptance and completion gates remain authoritative.

The allocator enforces declared coverage. Neither a model-generated plan nor deterministic validation proves that every requirement was discovered, that a declared knowledge-independent module is truly independent, or that a check asserts the correct business outcome. Those concerns require source review, executable scenarios and the full audit.
