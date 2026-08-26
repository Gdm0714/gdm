#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXECUTABLE="${1:-$NATIVE_DIR/.build/app/Gidem.app/Contents/MacOS/Gidem}"

exec /usr/bin/xcrun swift "$SCRIPT_DIR/accessibility-smoke.swift" "$EXECUTABLE" "$NATIVE_DIR/.."
