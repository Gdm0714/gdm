#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$NATIVE_DIR/ghostty.lock.json"

read_lock() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK_FILE"
}

"$SCRIPT_DIR/build-ghostty.sh"

COMMIT="$(read_lock commit)"
TARGET="$(read_lock xcframeworkTarget)"
EXPECTED_HEADER_SHA256="$(read_lock apiHeaderSha256)"
EXPECTED_MODULE_MAP_SHA256="$(read_lock moduleMapSha256)"
EXPECTED_SYMBOLS_SHA256="$(read_lock exportedSymbolsSha256)"
EXPECTED_RESOURCES_SHA256="$(read_lock resourcesSha256)"
LICENSE="$(read_lock license)"
ARTIFACT="$NATIVE_DIR/.build/ghostty/artifacts/$COMMIT/$TARGET/GhosttyKit.xcframework"
RESOURCES="$NATIVE_DIR/.build/ghostty/artifacts/$COMMIT/$TARGET/Resources"
LIBRARY="$ARTIFACT/macos-arm64/libghostty-internal.a"
ACTUAL_SHA256="$(/usr/bin/shasum -a 256 "$LIBRARY" | /usr/bin/awk '{print $1}')"
HEADER_SHA256="$(/usr/bin/shasum -a 256 "$ARTIFACT/macos-arm64/Headers/ghostty.h" | /usr/bin/awk '{print $1}')"
MODULE_MAP_SHA256="$(/usr/bin/shasum -a 256 "$ARTIFACT/macos-arm64/Headers/module.modulemap" | /usr/bin/awk '{print $1}')"
SYMBOLS_SHA256="$(/usr/bin/nm -gU "$LIBRARY" | /usr/bin/sed -E 's/^[0-9a-fA-F]+ //' | /usr/bin/sort -u | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
MANIFEST="$NATIVE_DIR/.build/ghostty/GhosttyKit.manifest"

manifest_value() {
  /usr/bin/awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$MANIFEST"
}

resources_sha256() {
  (
    cd "$1"
    find ghostty terminfo -type f -print \
      | LC_ALL=C /usr/bin/sort \
      | while IFS= read -r resource_file; do
          digest="$(/usr/bin/shasum -a 256 "$resource_file" | /usr/bin/awk '{print $1}')"
          /usr/bin/printf '%s  %s\n' "$digest" "$resource_file"
        done
  ) | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}'
}

RESOURCES_SHA256="$(resources_sha256 "$RESOURCES")"

[[ "$LICENSE" == "MIT" ]]
[[ "$(read_lock repository)" == "https://github.com/ghostty-org/ghostty.git" ]]
[[ "$(manifest_value raw_sha256)" == "$ACTUAL_SHA256" ]]
[[ "$HEADER_SHA256" == "$EXPECTED_HEADER_SHA256" ]]
[[ "$MODULE_MAP_SHA256" == "$EXPECTED_MODULE_MAP_SHA256" ]]
[[ "$SYMBOLS_SHA256" == "$EXPECTED_SYMBOLS_SHA256" ]]
[[ "$RESOURCES_SHA256" == "$EXPECTED_RESOURCES_SHA256" ]]
[[ "$(manifest_value resources_sha256)" == "$EXPECTED_RESOURCES_SHA256" ]]
[[ -f "$RESOURCES/terminfo/78/xterm-ghostty" ]]
[[ -f "$RESOURCES/ghostty/shell-integration/zsh/ghostty-integration" ]]
/usr/bin/plutil -lint "$ARTIFACT/Info.plist" >/dev/null
PLIST_OUTPUT="$(/usr/bin/plutil -p "$ARTIFACT/Info.plist")"
/usr/bin/grep -q '"macos-arm64"' <<< "$PLIST_OUTPUT"

NM_OUTPUT="$(/usr/bin/nm -gU "$LIBRARY")"
for symbol in app_new surface_new surface_free surface_foreground_pid surface_process_exited; do
  /usr/bin/grep -q " _ghostty_${symbol}$" <<< "$NM_OUTPUT"
done

if rg -n --glob '*.swift' --glob '*.m' --glob '*.mm' --glob '*.c' --glob '*.h' \
  'manaflow-ai/cmux|Copyright.*cmux|GPL-3\.0' "$NATIVE_DIR/Sources"; then
  echo "GPL/cmux source must not be imported into Gidem." >&2
  exit 1
fi

if rg -n 'ghostty-org/ghostty\.git' "$NATIVE_DIR/Package.swift"; then
  echo "Ghostty must be consumed through the pinned local XCFramework, not a floating package." >&2
  exit 1
fi

printf 'Ghostty verification passed: %s raw=%s abi=%s resources=%s\n' \
  "$COMMIT" "$ACTUAL_SHA256" "$SYMBOLS_SHA256" "$RESOURCES_SHA256"
