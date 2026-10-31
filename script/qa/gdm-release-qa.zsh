#!/usr/bin/env zsh
set -euo pipefail

ROOT=${0:A:h:h:h}
RELEASE_DIR=${GDM_RELEASE_DIR:-}
EXPECTED_VERSION=${GDM_EXPECTED_VERSION:-}
HOST_ONLY=${GDM_RELEASE_HOST_ONLY:-0}
[[ "$HOST_ONLY" == 0 || "$HOST_ONLY" == 1 ]] || { print -u2 -- "GDM_RELEASE_HOST_ONLY must be 0 or 1"; exit 2; }
scratch=$(mktemp -d)
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT INT TERM

for command_name in cargo cmp file python3 rg tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    print -u2 -- "missing release QA dependency: $command_name"
    exit 1
  }
done

if [[ -z "$EXPECTED_VERSION" ]]; then
  EXPECTED_VERSION=$(python3 - "$ROOT/Cargo.toml" <<'PY'
import tomllib
import sys

with open(sys.argv[1], "rb") as package_file:
    print(tomllib.load(package_file)["package"]["version"])
PY
  )
fi
EXPECTED_VERSION=${EXPECTED_VERSION#v}
[[ "$EXPECTED_VERSION" == <->.<->.<-> ]] || {
  print -u2 -- "GDM_EXPECTED_VERSION must be a semantic version"
  exit 2
}

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) host_asset=gdm-darwin-arm64; host_target=aarch64-apple-darwin ;;
  Darwin:x86_64) host_asset=gdm-darwin-x64; host_target=x86_64-apple-darwin ;;
  Linux:aarch64) host_asset=gdm-linux-arm64; host_target=aarch64-unknown-linux-gnu ;;
  Linux:x86_64) host_asset=gdm-linux-x64; host_target=x86_64-unknown-linux-gnu ;;
  *) print -u2 -- "unsupported QA host"; exit 1 ;;
esac
assets=(
  gdm-darwin-arm64
  gdm-darwin-x64
  gdm-linux-arm64
  gdm-linux-x64
)

pairs=(
  aarch64-apple-darwin:gdm-darwin-arm64
  x86_64-apple-darwin:gdm-darwin-x64
  aarch64-unknown-linux-gnu:gdm-linux-arm64
  x86_64-unknown-linux-gnu:gdm-linux-x64
)
package_flags=()
if (( HOST_ONLY )); then
  assets=("$host_asset")
  pairs=("$host_target:$host_asset")
  package_flags=(--host-only)
fi

if [[ -z "$RELEASE_DIR" ]]; then
  native="$scratch/native"
  mkdir -p "$native"
  for pair in $pairs; do
    target=${pair%%:*}
    asset=${pair##*:}
    cargo build --manifest-path "$ROOT/Cargo.toml" --locked --release --target "$target"
    cp "${CARGO_TARGET_DIR:-$ROOT/target}/$target/release/gdm" "$native/$asset"
  done
  RELEASE_DIR="$scratch/release-a"
  "$ROOT/script/release/gdm-package.zsh" \
    "${package_flags[@]}" --bin-dir "$native" --out "$RELEASE_DIR" --version "$EXPECTED_VERSION" >/dev/null
else
  RELEASE_DIR=${RELEASE_DIR:A}
  native="$RELEASE_DIR"
fi

repeat="$scratch/release-repeat"
"$ROOT/script/release/gdm-package.zsh" \
  "${package_flags[@]}" --bin-dir "$native" --out "$repeat" --version "$EXPECTED_VERSION" >/dev/null

expected_entries=$(print -rl -- SHASUMS256.txt $assets gdm-skills.tar.gz | LC_ALL=C sort)
actual_entries=$(find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -exec basename {} \; | LC_ALL=C sort)
[[ "$actual_entries" == "$expected_entries" ]] || {
  print -u2 -- "release directory has an unexpected asset set"
  print -u2 -- "$actual_entries"
  exit 1
}

for asset in $assets gdm-skills.tar.gz SHASUMS256.txt; do
  cmp -s "$RELEASE_DIR/$asset" "$repeat/$asset" || {
    print -u2 -- "release packaging is not deterministic: $asset"
    exit 1
  }
done

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$RELEASE_DIR" && sha256sum --check SHASUMS256.txt)
else
  while read -r expected asset; do
    [[ "$(shasum -a 256 "$RELEASE_DIR/$asset" | awk '{print $1}')" == "$expected" ]] || {
      print -u2 -- "checksum mismatch: $asset"
      exit 1
    }
  done < "$RELEASE_DIR/SHASUMS256.txt"
fi

for asset in $assets; do
  [[ -x "$RELEASE_DIR/$asset" ]] || { print -u2 -- "$asset is not executable"; exit 1; }
done
for asset in $assets; do
  architecture=$(file "$RELEASE_DIR/$asset")
  case "$asset" in
    gdm-darwin-arm64) [[ "$architecture" == *Mach-O*arm64* ]] ;;
    gdm-darwin-x64) [[ "$architecture" == *Mach-O*x86_64* ]] ;;
    gdm-linux-arm64) [[ "$architecture" == *ELF*aarch64* ]] ;;
    gdm-linux-x64) [[ "$architecture" == *ELF*x86-64* ]] ;;
  esac
done

# A second publication to the same directory must fail without changing it.
if "$ROOT/script/release/gdm-package.zsh" "${package_flags[@]}" \
    --bin-dir "$native" --out "$repeat" --version "$EXPECTED_VERSION" >"$scratch/overwrite.log" 2>&1; then
  print -u2 -- "packager overwrote an existing release directory"
  exit 1
fi
for asset in $assets gdm-skills.tar.gz SHASUMS256.txt; do
  cmp -s "$RELEASE_DIR/$asset" "$repeat/$asset"
done

[[ "$("$RELEASE_DIR/$host_asset" --version)" == "$EXPECTED_VERSION" ]] || {
  print -u2 -- "$host_asset version smoke failed"
  exit 1
}

archive_entries=$(tar -tzf "$RELEASE_DIR/gdm-skills.tar.gz" | sed 's#/$##' | LC_ALL=C sort)
expected_targets="$scratch/expected-targets"
mkdir -p "$expected_targets/targets"
for target in codex claude gid; do
  "$RELEASE_DIR/$host_asset" render-skills \
    --target "$target" \
    --source-root "$ROOT/skills" \
    --agents-root "$ROOT/agents" \
    --output "$expected_targets/targets/$target" >/dev/null
done
source_entries=$(cd "$expected_targets" && find targets -print | LC_ALL=C sort)
[[ "$archive_entries" == "$source_entries" ]] || {
  print -u2 -- "skills archive does not exactly match deterministic target renders"
  exit 1
}
if print -r -- "$archive_entries" | rg -q '(^/|(^|/)\.\.?(/|$))'; then
  print -u2 -- "skills archive contains an unsafe path"
  exit 1
fi
python3 - "$expected_targets" "$RELEASE_DIR/gdm-skills.tar.gz" <<'PY'
from pathlib import Path
import os
import sys
import tarfile

root = Path(sys.argv[1])
with tarfile.open(sys.argv[2], "r:gz") as archive:
    for member in archive.getmembers():
        relative = member.name.rstrip("/")
        source = root / relative
        if member.isdir():
            if not source.is_dir() or source.is_symlink():
                raise SystemExit(f"skills archive directory mismatch: {member.name}")
            expected_mode = 0o755
        elif member.isfile():
            if not source.is_file() or source.is_symlink():
                raise SystemExit(f"skills archive file mismatch: {member.name}")
            with archive.extractfile(member) as contents:
                if contents.read() != source.read_bytes():
                    raise SystemExit(f"skills archive content mismatch: {member.name}")
            expected_mode = 0o755 if os.access(source, os.X_OK) else 0o644
        else:
            raise SystemExit(f"skills archive contains a non-file entry: {member.name}")
        if member.mode != expected_mode:
            raise SystemExit(
                f"skills archive mode mismatch: {member.name}: "
                f"{member.mode:o} != {expected_mode:o}"
            )
PY

print -- "GDM release QA passed: ${#assets} native target(s), deterministic Codex/Claude/gid skills with exact contents and modes, verified checksums, overwrite refused"
