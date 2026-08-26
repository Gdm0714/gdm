#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$NATIVE_DIR/ghostty.lock.json"
BUILD_ROOT="$NATIVE_DIR/.build/ghostty"

read_lock() {
  /usr/bin/plutil -extract "$1" raw -o - "$LOCK_FILE"
}

REPOSITORY="$(read_lock repository)"
COMMIT="$(read_lock commit)"
ZIG_VERSION="$(read_lock zigVersion)"
ZIG_OVERLAY="$(read_lock zigOverlay)"
XCFRAMEWORK_TARGET="$(read_lock xcframeworkTarget)"
OPTIMIZE="$(read_lock optimize)"
EXPECTED_HEADER_SHA256="$(read_lock apiHeaderSha256)"
EXPECTED_MODULE_MAP_SHA256="$(read_lock moduleMapSha256)"
EXPECTED_SYMBOLS_SHA256="$(read_lock exportedSymbolsSha256)"
EXPECTED_RESOURCES_SHA256="$(read_lock resourcesSha256)"
SOURCE_DIR="$BUILD_ROOT/source-$COMMIT"
ARTIFACT_DIR="$BUILD_ROOT/artifacts/$COMMIT/$XCFRAMEWORK_TARGET"
ARTIFACT="$ARTIFACT_DIR/GhosttyKit.xcframework"
LIBRARY="$ARTIFACT/macos-arm64/libghostty-internal.a"
RESOURCES="$ARTIFACT_DIR/Resources"
MANIFEST="$BUILD_ROOT/GhosttyKit.manifest"

sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

manifest_value() {
  /usr/bin/awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$MANIFEST"
}

symbols_sha256() {
  /usr/bin/nm -gU "$1" \
    | /usr/bin/sed -E 's/^[0-9a-fA-F]+ //' \
    | /usr/bin/sort -u \
    | /usr/bin/shasum -a 256 \
    | /usr/bin/awk '{print $1}'
}

resources_sha256() {
  local root="$1"
  (
    cd "$root"
    find ghostty terminfo -type f -print \
      | LC_ALL=C /usr/bin/sort \
      | while IFS= read -r resource_file; do
          local digest
          digest="$(/usr/bin/shasum -a 256 "$resource_file" | /usr/bin/awk '{print $1}')"
          /usr/bin/printf '%s  %s\n' "$digest" "$resource_file"
        done
  ) | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}'
}

artifact_is_current() {
  [[ -f "$LIBRARY" ]] || return 1
  [[ -f "$MANIFEST" ]] || return 1
  [[ "$(manifest_value commit)" == "$COMMIT" ]] || return 1
  [[ "$(manifest_value zig)" == "$ZIG_VERSION" ]] || return 1
  [[ "$(manifest_value xcframework_target)" == "$XCFRAMEWORK_TARGET" ]] || return 1
  [[ "$(manifest_value optimize)" == "$OPTIMIZE" ]] || return 1
  [[ "$(manifest_value raw_sha256)" == "$(sha256 "$LIBRARY")" ]] || return 1
  [[ "$(sha256 "$ARTIFACT/macos-arm64/Headers/ghostty.h")" == "$EXPECTED_HEADER_SHA256" ]] || return 1
  [[ "$(sha256 "$ARTIFACT/macos-arm64/Headers/module.modulemap")" == "$EXPECTED_MODULE_MAP_SHA256" ]] || return 1
  [[ "$(symbols_sha256 "$LIBRARY")" == "$EXPECTED_SYMBOLS_SHA256" ]] || return 1
  [[ -f "$RESOURCES/terminfo/78/xterm-ghostty" ]] || return 1
  [[ -f "$RESOURCES/ghostty/shell-integration/zsh/ghostty-integration" ]] || return 1
  [[ "$(resources_sha256 "$RESOURCES")" == "$EXPECTED_RESOURCES_SHA256" ]] || return 1
  [[ "$(manifest_value resources_sha256)" == "$EXPECTED_RESOURCES_SHA256" ]] || return 1
  [[ -f "$SOURCE_DIR/.git/HEAD" ]] || return 1
  [[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" == "$COMMIT" ]] || return 1
}

resolve_zig() {
  if command -v zig >/dev/null 2>&1 && [[ "$(zig version)" == "$ZIG_VERSION" ]]; then
    command -v zig
    return
  fi

  if ! command -v nix >/dev/null 2>&1; then
    echo "Ghostty requires Zig $ZIG_VERSION. Install Nix or provide that exact Zig version." >&2
    return 1
  fi

  local store_path
  store_path="$(nix --extra-experimental-features 'nix-command flakes' \
    build --no-link --print-out-paths "$ZIG_OVERLAY")"
  printf '%s/bin/zig\n' "$store_path"
}

prepare_source() {
  if [[ -d "$SOURCE_DIR/.git" ]]; then
    [[ "$(git -C "$SOURCE_DIR" remote get-url origin)" == "$REPOSITORY" ]] || {
      echo "Ghostty cache origin does not match the lock file." >&2
      return 1
    }
    [[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" == "$COMMIT" ]] || {
      echo "Ghostty cache commit does not match the lock file." >&2
      return 1
    }
    return
  fi

  mkdir -p "$BUILD_ROOT"
  git clone --filter=blob:none --no-checkout "$REPOSITORY" "$SOURCE_DIR"
  git -C "$SOURCE_DIR" fetch --depth 1 origin "$COMMIT"
  git -C "$SOURCE_DIR" -c advice.detachedHead=false checkout --detach "$COMMIT"
  [[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" == "$COMMIT" ]]
}

if artifact_is_current; then
  printf 'GhosttyKit ready: %s\n' "$ARTIFACT"
  exit 0
fi

prepare_source
ZIG="$(resolve_zig)"
[[ "$($ZIG version)" == "$ZIG_VERSION" ]]

if ! /usr/bin/xcrun --find metal >/dev/null 2>&1; then
  echo "The Xcode Metal Toolchain is required. Run: xcodebuild -downloadComponent MetalToolchain" >&2
  exit 1
fi

(
  cd "$SOURCE_DIR"
  "$ZIG" build \
    -Demit-xcframework=true \
    -Dxcframework-target="$XCFRAMEWORK_TARGET" \
    -Demit-macos-app=false \
    -Doptimize="$OPTIMIZE"
)

SOURCE_ARTIFACT="$SOURCE_DIR/macos/GhosttyKit.xcframework"
SOURCE_LIBRARY="$SOURCE_ARTIFACT/macos-arm64/libghostty-internal.a"
SOURCE_RESOURCES="$SOURCE_DIR/zig-out/share"
[[ -f "$SOURCE_LIBRARY" ]] || {
  echo "Ghostty build did not produce the expected macOS arm64 library." >&2
  exit 1
}
[[ -f "$SOURCE_RESOURCES/terminfo/78/xterm-ghostty" \
  && -f "$SOURCE_RESOURCES/ghostty/shell-integration/zsh/ghostty-integration" ]] || {
  echo "Ghostty build did not produce its required runtime resources." >&2
  exit 1
}

ACTUAL_SHA256="$(sha256 "$SOURCE_LIBRARY")"
ACTUAL_HEADER_SHA256="$(sha256 "$SOURCE_ARTIFACT/macos-arm64/Headers/ghostty.h")"
ACTUAL_MODULE_MAP_SHA256="$(sha256 "$SOURCE_ARTIFACT/macos-arm64/Headers/module.modulemap")"
ACTUAL_SYMBOLS_SHA256="$(symbols_sha256 "$SOURCE_LIBRARY")"
ACTUAL_RESOURCES_SHA256="$(resources_sha256 "$SOURCE_RESOURCES")"
[[ "$ACTUAL_HEADER_SHA256" == "$EXPECTED_HEADER_SHA256" \
  && "$ACTUAL_MODULE_MAP_SHA256" == "$EXPECTED_MODULE_MAP_SHA256" \
  && "$ACTUAL_SYMBOLS_SHA256" == "$EXPECTED_SYMBOLS_SHA256" \
  && "$ACTUAL_RESOURCES_SHA256" == "$EXPECTED_RESOURCES_SHA256" ]] || {
  echo "GhosttyKit normalized library or resource identity mismatch." >&2
  exit 1
}

mkdir -p "$ARTIFACT_DIR"
STAGED_ARTIFACT="$ARTIFACT_DIR/GhosttyKit.xcframework.staged"
/usr/bin/ditto "$SOURCE_ARTIFACT" "$STAGED_ARTIFACT"
if [[ -d "$ARTIFACT" ]]; then
  /bin/rm -rf "$ARTIFACT"
fi
/bin/mv "$STAGED_ARTIFACT" "$ARTIFACT"

STAGED_RESOURCES="$ARTIFACT_DIR/Resources.staged"
if [[ -d "$STAGED_RESOURCES" ]]; then
  /bin/rm -rf "$STAGED_RESOURCES"
fi
/bin/mkdir -p "$STAGED_RESOURCES"
/usr/bin/ditto "$SOURCE_RESOURCES/ghostty" "$STAGED_RESOURCES/ghostty"
/usr/bin/ditto "$SOURCE_RESOURCES/terminfo" "$STAGED_RESOURCES/terminfo"
[[ "$(resources_sha256 "$STAGED_RESOURCES")" == "$EXPECTED_RESOURCES_SHA256" ]]
if [[ -d "$RESOURCES" ]]; then
  /bin/rm -rf "$RESOURCES"
fi
/bin/mv "$STAGED_RESOURCES" "$RESOURCES"

mkdir -p "$BUILD_ROOT"
{
  printf 'repository=%s\n' "$REPOSITORY"
  printf 'commit=%s\n' "$COMMIT"
  printf 'zig=%s\n' "$ZIG_VERSION"
  printf 'xcframework_target=%s\n' "$XCFRAMEWORK_TARGET"
  printf 'optimize=%s\n' "$OPTIMIZE"
  printf 'raw_sha256=%s\n' "$ACTUAL_SHA256"
  printf 'api_header_sha256=%s\n' "$ACTUAL_HEADER_SHA256"
  printf 'module_map_sha256=%s\n' "$ACTUAL_MODULE_MAP_SHA256"
  printf 'exported_symbols_sha256=%s\n' "$ACTUAL_SYMBOLS_SHA256"
  printf 'resources_sha256=%s\n' "$ACTUAL_RESOURCES_SHA256"
  printf 'artifact=%s\n' "$ARTIFACT"
  printf 'resources=%s\n' "$RESOURCES"
} > "$MANIFEST"

printf 'GhosttyKit and resources built: %s\n' "$ARTIFACT_DIR"
