#!/usr/bin/env bash
# Legacy assertions and schema validation remain independent; only hook policy
# execution is substituted. Native process concurrency has a separate test.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
cargo build --lib --locked
DRIVER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gdm-hook-parity.XXXXXX")"
trap 'rm -rf "$DRIVER_DIR"' EXIT
rustc --edition 2024 tests/integrations/hook_driver.rs --extern gdm=target/debug/libgdm.rlib \
  -L dependency=target/debug/deps -o "$DRIVER_DIR/hook-driver"
export GDM_HOOK_TEST_DRIVER="$DRIVER_DIR/hook-driver"
bun test --preload ./tests/integrations/hook_native_preload.ts ./cli/test/codex-agent-runtime-precision.test.ts
bun test --preload ./tests/integrations/hook_native_preload.ts \
  --test-name-pattern 'Codex delegated-agent hook runtime' ./cli/test/codex-agent-hook.test.ts
