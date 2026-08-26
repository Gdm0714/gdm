#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXECUTABLE="${1:-$NATIVE_DIR/.build/app/Gidem.app/Contents/MacOS/Gidem}"

if [[ "${GIDEM_RUN_CODEX_SMOKE:-0}" != "1" ]]; then
  printf '%s\n' \
    'Codex smoke is opt-in because it makes an authenticated model request.' \
    'Run: GIDEM_RUN_CODEX_SMOKE=1 ./scripts/qa/codex-smoke.sh' >&2
  exit 77
fi

if [[ ! -x "$EXECUTABLE" ]]; then
  printf 'Gidem executable is not runnable: %s\n' "$EXECUTABLE" >&2
  exit 66
fi

exec env -u GHOSTTY_RESOURCES_DIR "$EXECUTABLE" --codex-smoke
