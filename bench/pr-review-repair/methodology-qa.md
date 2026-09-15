# Reporting QA recorded during execution

The model inputs, case contracts, schedule, known defect targets and frozen analyzer remain unchanged. A separate read-only methodology review inspected runner/scoring code and fixture receipts without reading model outputs.

Four reporting clarifications are implemented in `supplement.py`:

1. The frozen `functionalPass` combines test outcomes and edit-policy compliance. Report hidden/public behavior as `testsPass` separately. Adding tests to a protected file is a policy violation; it is not automatically a new product defect. The evaluator restores the original public tests before grading every final source.
2. Pi usage may be incomplete. Retain every observed amount but label incomplete totals as partial lower bounds; infer paired API estimates only from complete matched observations with a positive denominator.
3. Exit code 0 alone is insufficient. Compare the multiset of passed + failed hidden/public test identities with the reference. Missing, duplicated or extra grading groups make coverage incomplete. No-test exits cannot become behavioral success. Newly failing groups are compared with the same candidate's pre-repair grade.
4. A scheduled folder is an attempted observation, not proof of an actual model response. Report process launches, assistant/model response observations and successful transports separately for the review and repair roles.

These clarify output interpretation without changing model execution or the preregistered known-defect denominator. The original `analysis.json` and its strict combined flags will be retained alongside `supplement.json`.

Additional findings and changes require source-grounded assessment. C03 is an unmutated historical reference, not an assertion that all historical code is defect-free. Count an edit as unnecessary only with evidence; use unresolved where the contract or trigger is unclear. Line count alone is not a quality grade. AI assessment is not independent human review or measured human repair time.

## Contract ambiguity found in secondary assessment

The frozen C02 contract says the CLI binds operations to the prepared Git branch and current HEAD. It does not distinguish the pre-merge execution gate from `delivery merged`, which records the remote merge result after merging. The historical reference checks current Git position in pre-merge operations but omits that check in the final recording handler; historical `skills/pr/SKILL.md` step 10 records the merge SHA after the merge.

Adding the same check to `merged` fits a broad reading of the replay contract. It also changes previously accepted recording after a local branch/HEAD change into rejection. Uniform exploratory probes observe that behavior change, but the intended post-merge recording semantics are not sufficiently specified to count it as a confirmed defect fix, false positive, or unnecessary change. This is an ambiguity in the evaluation contract, not proof that a model misunderstood a clear requirement. It does not affect the explicit D03/D04 downstream invalidation checks.

## Additional recovery observation

A leading UTF-8 BOM is removed by the default TextDecoder during validation but preserved in the bytes written by repair. Normal loadWork reads those bytes directly and JSON.parse rejects the retained BOM. This is a real additional defect in the unmutated recovery reference. The C01 injected candidate's Buffer.toString already rejects it, so replacing that decoder can introduce this defect as a new regression. Both before/after source and whole-CLI behavior are assessed uniformly, outside the four preregistered target defects.

## Final evidence-integrity observation

A label-free assessor identified refresh-before-verify in B07 as a candidate-relative regression under the historical DESIGN evidence-integrity requirement, even though it restores parent behavior. After all 18 assessments were locked and the map was opened, a uniform whole-CLI probe ran against all 24 reference/candidate/final snapshots. Only P16 accepted deleted or tampered saved automatic evidence and completed. All snapshots passed intact-evidence and ordinary-output-change scenarios. This is a posthoc result, excluded from the preregistered target denominator and the common cohort because C03 repetition 2 lacks complete reviewer arms.

The final aggregate is generated from the locked packet-to-run mapping and probe receipts, not inferred from completion order. For the common cohort the BOM outcomes are self 1/3, Terra review 2/3, Astra review 3/3. AI packet assessment provides source-grounded secondary evidence; it is not independent human review or measured human repair time.
