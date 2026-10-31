# Historical Pi benchmarks

Pi support was removed from GDM. The `model-routing`, `astra-quality`,
`review-quality`, and `feature-value` Pi execution entry points now stop with
an explicit retirement error before discovering a provider, accessing the old
installation, or running a model. The old context-pack E2E installer and installed
Pi verifier are also retired. Their pure evidence readers and transactional
installer helpers remain available for archived-result tests.

Published reports, frozen input references, raw observations, and analysis files
remain unchanged. They describe the historical runtime and are not results for
current gid. New native benchmarks live in `bench/research-adoption-perf`.
