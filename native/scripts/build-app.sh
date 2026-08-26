#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_DIR="$(cd "$NATIVE_DIR/../cli" && pwd)"
GDM_HELPER_SOURCE="$CLI_DIR/dist/gdm"
LOCK_FILE="$NATIVE_DIR/ghostty.lock.json"
COMMIT="$(/usr/bin/plutil -extract commit raw -o - "$LOCK_FILE")"
TARGET="$(/usr/bin/plutil -extract xcframeworkTarget raw -o - "$LOCK_FILE")"
GHOSTTY_RESOURCES="$NATIVE_DIR/.build/ghostty/artifacts/$COMMIT/$TARGET/Resources"
OUTPUT_ROOT="$NATIVE_DIR/.build/app"
FINAL_APP="$OUTPUT_ROOT/Gidem.app"
APP_VERSION="${GIDEM_APP_VERSION:-0.1.0}"
BUILD_VERSION="${GIDEM_APP_BUILD:-1}"
SIGNING_IDENTITY="${GIDEM_CODESIGN_IDENTITY:--}"

(
  cd "$CLI_DIR"
  /usr/bin/env bun run build
)
[[ -x "$GDM_HELPER_SOURCE" ]]

"$SCRIPT_DIR/verify-ghostty-build.sh"

(
  cd "$NATIVE_DIR"
  GIDEM_ENABLE_GHOSTTY=1 swift build -c release --product gdm-native
)
BIN_DIR="$(cd "$NATIVE_DIR" && GIDEM_ENABLE_GHOSTTY=1 swift build -c release --show-bin-path)"
EXECUTABLE="$BIN_DIR/gdm-native"
GIDEM_BUNDLE="$BIN_DIR/GDMNative_GDMNative.bundle"
SWIFTTERM_BUNDLE="$BIN_DIR/SwiftTerm_SwiftTerm.bundle"

[[ -x "$EXECUTABLE" ]]
[[ -d "$GIDEM_BUNDLE" ]]
[[ -d "$SWIFTTERM_BUNDLE" ]]
[[ -f "$GHOSTTY_RESOURCES/terminfo/78/xterm-ghostty" ]]

/bin/mkdir -p "$OUTPUT_ROOT"
STAGE_ROOT="$(/usr/bin/mktemp -d "$OUTPUT_ROOT/.gidem-stage.XXXXXX")"
trap '/bin/rm -rf "$STAGE_ROOT"' EXIT
STAGED_APP="$STAGE_ROOT/Gidem.app"
CONTENTS="$STAGED_APP/Contents"
MACOS="$CONTENTS/MacOS"
HELPERS="$CONTENTS/Helpers"
RESOURCES="$CONTENTS/Resources"
/bin/mkdir -p "$MACOS" "$HELPERS" "$RESOURCES"

/usr/bin/ditto "$EXECUTABLE" "$MACOS/Gidem"
/bin/chmod 0755 "$MACOS/Gidem"
/usr/bin/ditto "$GDM_HELPER_SOURCE" "$HELPERS/gdm"
/bin/chmod 0755 "$HELPERS/gdm"
# Gidem and the SwiftTerm fallback probe the signed-app resource location.
/usr/bin/ditto "$GIDEM_BUNDLE" "$RESOURCES/GDMNative_GDMNative.bundle"
/usr/bin/ditto "$SWIFTTERM_BUNDLE" "$RESOURCES/SwiftTerm_SwiftTerm.bundle"

/usr/bin/ditto "$GHOSTTY_RESOURCES/ghostty" "$RESOURCES/ghostty"
/usr/bin/ditto "$GHOSTTY_RESOURCES/terminfo" "$RESOURCES/terminfo"
/usr/bin/ditto "$NATIVE_DIR/THIRD_PARTY_NOTICES.md" "$RESOURCES/THIRD_PARTY_NOTICES.md"

ICONSET="$STAGE_ROOT/Gidem.iconset"
/bin/mkdir -p "$ICONSET"
ICON_SOURCE="$NATIVE_DIR/Sources/GDMNative/Resources/gidem-icon-1024.svg"
for entry in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  size="${entry%% *}"
  name="${entry#* }"
  /usr/bin/sips -s format png -z "$size" "$size" "$ICON_SOURCE" \
    --out "$ICONSET/$name" >/dev/null
done
/usr/bin/iconutil -c icns "$ICONSET" -o "$RESOURCES/Gidem.icns"

INFO_PLIST="$CONTENTS/Info.plist"
/usr/bin/plutil -create xml1 "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleDevelopmentRegion -string en "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleDisplayName -string Gidem "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleExecutable -string Gidem "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleIconFile -string Gidem.icns "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleIdentifier -string dev.gidem.app "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleInfoDictionaryVersion -string 6.0 "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleName -string Gidem "$INFO_PLIST"
/usr/bin/plutil -insert CFBundlePackageType -string APPL "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleShortVersionString -string "$APP_VERSION" "$INFO_PLIST"
/usr/bin/plutil -insert CFBundleVersion -string "$BUILD_VERSION" "$INFO_PLIST"
/usr/bin/plutil -insert LSApplicationCategoryType -string public.app-category.developer-tools "$INFO_PLIST"
/usr/bin/plutil -insert LSMinimumSystemVersion -string 14.0 "$INFO_PLIST"
/usr/bin/plutil -insert NSHighResolutionCapable -bool true "$INFO_PLIST"
/usr/bin/plutil -lint "$INFO_PLIST" >/dev/null

/usr/bin/codesign --force --sign "$SIGNING_IDENTITY" --timestamp=none "$HELPERS/gdm"
/usr/bin/codesign --force --sign "$SIGNING_IDENTITY" --timestamp=none "$STAGED_APP"
/usr/bin/codesign --verify --strict "$HELPERS/gdm"
/usr/bin/codesign --verify --deep --strict "$STAGED_APP"

if [[ -d "$FINAL_APP" ]]; then
  /bin/rm -rf "$FINAL_APP"
fi
/bin/mv "$STAGED_APP" "$FINAL_APP"

printf 'Gidem app built: %s\n' "$FINAL_APP"
