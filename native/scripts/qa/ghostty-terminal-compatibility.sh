#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK_FILE="$NATIVE_DIR/ghostty.lock.json"
COMMIT="$(/usr/bin/plutil -extract commit raw -o - "$LOCK_FILE")"
TARGET="$(/usr/bin/plutil -extract xcframeworkTarget raw -o - "$LOCK_FILE")"
RESOURCES="$NATIVE_DIR/.build/ghostty/artifacts/$COMMIT/$TARGET/Resources"

"$NATIVE_DIR/scripts/verify-ghostty-build.sh"
/usr/bin/infocmp -A "$RESOURCES/terminfo" xterm-ghostty >/dev/null

(
  cd "$NATIVE_DIR"
  GIDEM_ENABLE_GHOSTTY=1 swift build
  BIN_DIR="$(GIDEM_ENABLE_GHOSTTY=1 swift build --show-bin-path)"
  env -u GHOSTTY_RESOURCES_DIR "$BIN_DIR/gdm-native" --terminal-smoke
  GIDEM_ENABLE_GHOSTTY=1 env -u GHOSTTY_RESOURCES_DIR \
    swift test --filter TerminalBackendContractTests
  GIDEM_ENABLE_GHOSTTY=1 env -u GHOSTTY_RESOURCES_DIR \
    swift test --filter GhosttyTerminalCompatibilityTests
  GIDEM_ENABLE_GHOSTTY=1 env -u GHOSTTY_RESOURCES_DIR \
    swift test --filter SessionLaneTests/testTwoRealPTYLanesRunConcurrentlyAndStopCleanly
)

printf '%s\n' \
  'Ghostty terminal compatibility passed:' \
  '- real vim, nvim, less, fzf, top, tmux and SSH fixture' \
  '- IME, Unicode, dragged paths, selection, bracketed paste and OSC 52 policy' \
  '- OSC 8/file links, mouse reporting, scrollback search/clear and true color' \
  '- Ctrl-C/D/Z, fg/bg, SIGWINCH, rapid Retina resize, exit status and forced cleanup' \
  '- bundled terminfo and concurrent lanes'
