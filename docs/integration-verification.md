# Integration verification v1

The optional integration profile binds registered outcome requirements, critical unknowns and actual local file observations to GDM completion. It does not add a readiness state or prove that the requirements or validators are complete.

Use the profile for new work that connects external systems or changes business state. Legacy work without the feature remains unclassified. It is not retrospectively production verified.

```sh
gdm plan init --slug example --brief 'Example integration' --require 'Normal request succeeds and forbidden request is denied' --uncertain 'Example input shape' --profile integration
gdm plan add --slug example --desc 'Normal operation' --cmd 'sh fixtures/verification-v1/validator.sh positive' --expect 'booking-created'
gdm plan add --slug example --desc 'Forbidden operation' --cmd 'sh fixtures/verification-v1/validator.sh denied' --expect 'denied'
gdm plan verification import --slug example --file fixtures/verification-v1/contract.json
gdm pass c1 --slug example
gdm pass c2 --slug example
gdm plan verification resolve --slug example --id input-envelope
gdm done --slug example
gdm plan verification show --slug example --json
gdm plan list --slug example --json
gdm status --json --checks
gdm protocol export --slug example
```

The canonical authoring fixture is [contract.json](../fixtures/verification-v1/contract.json). Copy it and replace the check references, declarations, conditions, review and actual SHA-256 file digests. Its adjacent input, target and validator files make its references inspectable; it is a small example, not a production evaluator. Run these example commands from the GDM repository root. The fixture deliberately declares synthetic input and mock execution.

`import` is also the explicit update operation. It can activate an existing Work. It invalidates its current completion and audit and marks registered checks open and requires newly bound evidence (run `gdm pass` again). Previous evidence remains inspectable until replaced. Imported unknowns must all be `open`; resolved/waived records are authored by CLI transitions. Existing completion receipts move to bounded `verificationHistory` when GDM invalidates them.

The v1 object has these required members:

| Field | Meaning |
|---|---|
| `schemaVersion` | `gdm-verification-contract/v1` |
| `profile` | `integration` |
| `review` | Nonempty `note`; `classifications` maps every legacy uncertainty index to its own nonempty list of unknown IDs. One ID cannot classify multiple legacy uncertainties. The author must also register critical unknowns absent from the old text. |
| `requirements` | Exactly `input`, `positiveOutcome`, `deniedAction`, `stateContinuity`; each has `checkIds`, or an empty list and a nonempty `notApplicableReason`. At least one required check is necessary. |
| `checks` | Unique registered `checkId`; `inputOrigin` (`captured`, `synthetic`, `unknown`), `environment` (`mock`, `staging`, `production`, `unknown`), `targetKind` (`workspace`, `remote`, `trace`, `unknown`), `fixture`, `target`, `validator`. |
| `unknowns` | Unique opaque `id`, `description`, linked `checkId`, `conditions`, `status`. Conditions specify input origin, environment, target kind, and Boolean `fixtureRequired`/`targetRequired`. |

File references contain `artifactRef` and lowercase SHA-256 `sha256`. Fixture/target can be null; a validator reference is required. References are regular files, at most 64 MiB each; absolute external paths and `.gdm` evaluation input are explicitly hashed separately from the workspace fingerprint. The runner checks actual bytes before and after execution. Missing or changed references block verification. Do not reference secrets; target manifests should contain only nonsecret identifiers/configuration summaries.

`captured`, environment and target kind are declarations. Hashing a manifest proves local bytes, not a remote deployment identity or historical trace provenance. Only automatic checks against a declared workspace target with a matching target file receive a locally observed target binding. Remote, trace, missing target and manual evidence remain unverified. Submodule contents are unsupported for the enhanced profile and produce `source_coverage_unsupported`; the legacy workspace fingerprint API is unchanged.

An open unknown blocks completion even when every check passes. Before resolving any unknown, `resolve` requires current source and artifact bindings for every check listed in the verification contract, and checks stored evidence files for drift. The linked check must additionally be proven and satisfy that unknown's declared scope/conditions; resolution preserves its evidence digest. Establish current evidence across the contract before resolving individual unknowns. A changed/refresh execution reopens affected resolved unknowns. Resolution cannot promote an unrelated proven check or a trace manifest into remote execution proof.

An authorized limitation can be accepted explicitly:

```sh
gdm plan verification waive --slug example --id input-envelope --reason 'Captured production input is not available; completion is limited to the mock fixture' --policy 'Existing project policy permits mock-only acceptance' --accept-unknown-scope
```

The reason and policy are recorded with the contract digest. Policy text does not authenticate an approver. Waiver is not proof; `--accept-unknown-scope` additionally accepts the linked check's unknown scope. It does not bypass missing/failed evidence, missing files, source drift or invalid bindings. Waivers remain visible in work.md, full local queries, audit packets and safe consumer limitations. Completion does not create waivers. To revise an existing disposition, import the reviewed contract again with open unknowns.

`gdm recheck` refreshes stored evidence, invalidates the current completion and reopens linked resolutions. `gdm done` either reexecutes automatic checks without overwriting evidence and writes a separate `validate` receipt, or uses a current contract/source/artifact-bound audit and writes `audit_bound`. Manual checks remain marked manual. Audit-bound mode has no execution entries and must never be displayed as a rerun. Receipts bind required check IDs, contract and state digests, source observations, artifact hashes, execution result hashes and (when applicable) the audit binding. Validation never hashes its own receipt, doneAt or journal into the bound state.

Source and file changes during execution deny completion. Changes after completion make `verificationSummary.completionValid` false; a read does not rewrite historical Work state. Reimport or recheck performs an explicit invalidation before renewed completion. GDM state remains the authority; consumers must check the summary rather than inferring validity from check counts.

Integration `done` reports existing completion blockers, including the IDs of unproven checks, before attempting completion validation. Once those blockers are cleared, source, artifact, audit and execution-time drift checks still apply. A commit-permission transition (`plan contract --commit ...`) changes delivery authorization only: it preserves the completion receipt, audit and accepted limitations. Changes to actual requirements, scope or verification checks continue to invalidate affected verification state.

The public optional `verificationSummary` is `gdm-verification-summary/v1`: profile, contract/state/completion digests, completion validity/mode, required/proven/open/waived/unknown counts and bounded code/opaque-ID blockers/limitations. Scope codes such as `input_synthetic`, `environment_mock`, `environment_staging`, `target_remote` and `target_trace` preserve declared limitations even when completion is valid. No command, raw evidence, endpoint, external path or waiver reason is included. Full local plan/protocol snapshots retain explicit artifact paths for inspection; their credential screening still applies. Remote consumers must forward the safe summary rather than the full local contract. It appears in plan list, status and protocol export. Missing means legacy, not passing integration verification.

Compatibility: new Work has top-level `verificationFeature: "gdm-integration/v1"` and nested `contract.integrationVerification`. Existing writers preserve unknown top-level fields but strip unknown contract members; the new reader rejects that mismatch (`verification_feature_lost`). This detects the tested old writer's round trip, not arbitrary local editing or every historical binary. Unsupported schema versions fail closed. All participating writers/consumers must support this feature before rollout. Legacy normalized state and oracle hashes remain unchanged when the extension is absent.
