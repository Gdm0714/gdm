#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP="$NATIVE_DIR/.build/app/Gidem.app"
EXECUTABLE="$APP/Contents/MacOS/Gidem"
GDM_HELPER="$APP/Contents/Helpers/gdm"
RESOURCES="$APP/Contents/Resources"

"$SCRIPT_DIR/build-app.sh"

(
  cd "$NATIVE_DIR"
  GIDEM_ENABLE_GHOSTTY=1 env -u GHOSTTY_RESOURCES_DIR swift test
  "$SCRIPT_DIR/check-contrast.sh"
  "$SCRIPT_DIR/check-hardcoded-colors.sh"
  "$SCRIPT_DIR/qa/readme-sanity.sh"
)

if /usr/bin/grep -RniE '(import|#include)[[:space:]].*cmux|cmux/' \
  "$NATIVE_DIR/Sources" "$NATIVE_DIR/Tests" "$NATIVE_DIR/Package.swift"; then
  echo "Release source must not import or copy cmux GPL code." >&2
  exit 1
fi
[[ "$(/usr/bin/plutil -extract license raw -o - "$NATIVE_DIR/ghostty.lock.json")" == "MIT" ]]
/usr/bin/grep -Fq 'bb876a0d286b661089b7f40dd3a6488d629beffe' \
  "$NATIVE_DIR/THIRD_PARTY_NOTICES.md"

[[ -x "$EXECUTABLE" ]]
[[ -x "$GDM_HELPER" ]]
[[ -f "$RESOURCES/Gidem.icns" ]]
[[ -f "$RESOURCES/terminfo/78/xterm-ghostty" ]]
[[ -f "$RESOURCES/ghostty/shell-integration/zsh/ghostty-integration" ]]
[[ -f "$RESOURCES/GDMNative_GDMNative.bundle/design-tokens.css" ]]
[[ -f "$RESOURCES/SwiftTerm_SwiftTerm.bundle/Shaders.metal" ]]
/usr/bin/plutil -lint "$APP/Contents/Info.plist" >/dev/null
[[ "$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$APP/Contents/Info.plist")" == "Gidem" ]]
[[ "$(/usr/bin/plutil -extract LSMinimumSystemVersion raw -o - "$APP/Contents/Info.plist")" == "14.0" ]]
/usr/bin/codesign --verify --strict "$GDM_HELPER"
/usr/bin/codesign --verify --deep --strict "$APP"

FILE_OUTPUT="$(/usr/bin/file "$EXECUTABLE")"
/usr/bin/grep -q 'Mach-O 64-bit executable arm64' <<< "$FILE_OUTPUT"
GDM_FILE_OUTPUT="$(/usr/bin/file "$GDM_HELPER")"
/usr/bin/grep -q 'Mach-O 64-bit executable arm64' <<< "$GDM_FILE_OUTPUT"
GDM_VERSION="$("$GDM_HELPER" --version)"
/usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' <<< "$GDM_VERSION"
OTOOL_OUTPUT="$(/usr/bin/otool -L "$EXECUTABLE")"
if /usr/bin/grep -Eq 'Ghostty\.app|libghostty[^[:space:]]*\.dylib' <<< "$OTOOL_OUTPUT"; then
  echo "Release app must not depend on an installed Ghostty application or dylib." >&2
  exit 1
fi
NM_OUTPUT="$(/usr/bin/nm -gU "$EXECUTABLE")"
/usr/bin/grep -q ' _ghostty_surface_new$' <<< "$NM_OUTPUT"
/usr/bin/grep -q ' _ghostty_surface_free$' <<< "$NM_OUTPUT"

HELP_OUTPUT="$(env -u GHOSTTY_RESOURCES_DIR "$EXECUTABLE" --agent-event-help)"
/usr/bin/grep -q 'Gidem agent event client' <<< "$HELP_OUTPUT"
TERMINAL_OUTPUT="$(env -u GHOSTTY_RESOURCES_DIR "$EXECUTABLE" --terminal-smoke)"
/usr/bin/grep -Fq "resources=$RESOURCES/ghostty" <<< "$TERMINAL_OUTPUT"

TOOLCHAIN_SMOKE_ROOT="$(/usr/bin/mktemp -d "$NATIVE_DIR/.build/app/.toolchain-smoke.XXXXXX")"
cleanup_toolchain_smoke() {
  if [[ -d "$TOOLCHAIN_SMOKE_ROOT" ]]; then
    /bin/rm -rf -- "$TOOLCHAIN_SMOKE_ROOT"
  fi
}
trap cleanup_toolchain_smoke EXIT
TOOLCHAIN_SMOKE_REPOSITORY="$TOOLCHAIN_SMOKE_ROOT/repository"
/bin/mkdir -p "$TOOLCHAIN_SMOKE_REPOSITORY"
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  /usr/bin/git init --quiet --initial-branch=main --template= "$TOOLCHAIN_SMOKE_REPOSITORY"
/usr/bin/printf '%s\n' '# Gidem packaged toolchain smoke' > "$TOOLCHAIN_SMOKE_REPOSITORY/README.md"
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  /usr/bin/git -C "$TOOLCHAIN_SMOKE_REPOSITORY" add README.md
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  /usr/bin/git -C "$TOOLCHAIN_SMOKE_REPOSITORY" \
    -c user.name='Gidem Release Smoke' \
    -c user.email='gidem-release-smoke@example.invalid' \
    commit --quiet -m 'fixture base'
TOOLCHAIN_OUTPUT="$(
  env -u GHOSTTY_RESOURCES_DIR "$EXECUTABLE" \
    --toolchain-smoke --repo "$TOOLCHAIN_SMOKE_REPOSITORY"
)"
EXPECTED_TOOLCHAIN_WORKTREE="$TOOLCHAIN_SMOKE_ROOT/repository-worktrees/toolchain-smoke"
/usr/bin/grep -Fq \
  "GIDEM_TOOLCHAIN_SMOKE_OK toolchain=$GDM_HELPER worktree=$EXPECTED_TOOLCHAIN_WORKTREE approval_required=true" \
  <<< "$TOOLCHAIN_OUTPUT"
[[ -f "$EXPECTED_TOOLCHAIN_WORKTREE/.gdm/toolchain-smoke/checks.json" ]]

SMOKE_IMAGE="$NATIVE_DIR/.build/app/release-smoke.png"
env -u GHOSTTY_RESOURCES_DIR "$EXECUTABLE" \
  --repo "$NATIVE_DIR/.." --demo --demo-state verifying --background-qa \
  --width 1024 --height 700 \
  --screenshot "$SMOKE_IMAGE" >/dev/null
[[ -s "$SMOKE_IMAGE" ]]

NEW_TASK_IMAGE="$NATIVE_DIR/.build/app/new-task-provisioning-1280.png"
env -u GHOSTTY_RESOURCES_DIR "$EXECUTABLE" \
  --repo "$NATIVE_DIR/.." --demo --demo-state new-task-provisioning --reduce-motion \
  --background-qa --width 1280 --height 800 --screenshot "$NEW_TASK_IMAGE" >/dev/null
[[ -s "$NEW_TASK_IMAGE" ]]

if [[ "${GIDEM_RUN_INTERACTIVE_UI_QA:-0}" == "1" ]]; then
  "$NATIVE_DIR/scripts/qa/accessibility-smoke.sh" "$EXECUTABLE"
  "$NATIVE_DIR/scripts/qa/idle-performance-smoke.sh" "$EXECUTABLE"
else
  printf '%s\n' \
    'Interactive UI QA skipped to preserve desktop focus.' \
    'Run with GIDEM_RUN_INTERACTIVE_UI_QA=1 only when foreground app control is acceptable.'
fi

printf 'Native release verification passed: %s\n' "$APP"
