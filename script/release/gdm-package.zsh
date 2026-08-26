#!/usr/bin/env zsh
set -euo pipefail

ROOT=${0:A:h:h:h}
BIN_DIR=""
OUT=""
VERSION=""

while (( $# > 0 )); do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) print -u2 -- "unknown argument: $1"; exit 2 ;;
  esac
done

[[ -n "$BIN_DIR" && -n "$OUT" && "$VERSION" == <->.<->.<-> ]] || {
  print -u2 -- "usage: $0 --bin-dir DIR --out DIR --version X.Y.Z"
  exit 2
}
for command_name in bun install mktemp python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    print -u2 -- "missing release dependency: $command_name"
    exit 1
  }
done

BIN_DIR=${BIN_DIR:A}
OUT=${OUT:A}
epoch=${SOURCE_DATE_EPOCH:-0}
[[ "$epoch" == <-> ]] || {
  print -u2 -- "SOURCE_DATE_EPOCH must be a non-negative integer"
  exit 2
}

assets=(
  gdm-darwin-arm64
  gdm-darwin-x64
  gdm-linux-arm64
  gdm-linux-x64
)
for asset in $assets; do
  [[ -f "$BIN_DIR/$asset" && -x "$BIN_DIR/$asset" ]] || {
    print -u2 -- "missing executable release input: $BIN_DIR/$asset"
    exit 1
  }
done

[[ ! -e "$OUT" && ! -L "$OUT" ]] || {
  print -u2 -- "release output already exists: $OUT"
  exit 1
}
mkdir -p "${OUT:h}"
stage=$(mktemp -d "${OUT:h}/.gdm-release.XXXXXX")
render_root=$(mktemp -d "${OUT:h}/.gdm-targets.XXXXXX")
cleanup() {
  [[ -z "$stage" ]] || rm -rf "$stage"
  [[ -z "$render_root" ]] || rm -rf "$render_root"
}
trap cleanup EXIT INT TERM

for asset in $assets; do
  install -m 0755 "$BIN_DIR/$asset" "$stage/$asset"
done

mkdir -p "$render_root/targets"
for target in codex claude pi; do
  bun "$ROOT/install/render-skills.ts" \
    --target "$target" \
    --source-root "$ROOT/skills" \
    --agents-root "$ROOT/agents" \
    --output "$render_root/targets/$target" >/dev/null
done
python3 - "$render_root/targets/codex/gdm-target-manifest.json" \
  "$render_root/targets/claude/gdm-target-manifest.json" \
  "$render_root/targets/pi/gdm-target-manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    codex = json.load(source)
with open(sys.argv[2], encoding="utf-8") as source:
    claude = json.load(source)
with open(sys.argv[3], encoding="utf-8") as source:
    pi = json.load(source)
if (codex.get("target") != "codex" or claude.get("target") != "claude" or
        pi.get("target") != "pi"):
    raise SystemExit("generated target manifest identity mismatch")
for field in ("canonicalSourceSha256", "sourceSha256", "capabilityProfile", "runner"):
    if codex.get(field) != claude.get(field) or codex.get(field) != pi.get(field):
        raise SystemExit(f"generated target manifest parity mismatch: {field}")
PY

python3 - "$render_root" "$stage/gdm-skills.tar.gz" "$epoch" <<'PY'
from pathlib import Path
import gzip
import os
import sys
import tarfile

root = Path(sys.argv[1])
output = Path(sys.argv[2])
epoch = int(sys.argv[3])
base = root / "targets"
paths = [base]
paths.extend(sorted(base.rglob("*")))

with output.open("xb") as raw:
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=epoch) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive:
            for path in paths:
                if path.is_symlink():
                    raise SystemExit(f"release input may not contain symlinks: {path}")
                relative = path.relative_to(root).as_posix()
                info = tarfile.TarInfo(relative + ("/" if path.is_dir() else ""))
                info.uid = 0
                info.gid = 0
                info.uname = "root"
                info.gname = "root"
                info.mtime = epoch
                if path.is_dir():
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    archive.addfile(info)
                elif path.is_file():
                    contents = path.read_bytes()
                    info.size = len(contents)
                    info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
                    from io import BytesIO
                    archive.addfile(info, BytesIO(contents))
                else:
                    raise SystemExit(f"unsupported release input: {path}")
PY

checksum_file="$stage/SHASUMS256.txt"
: > "$checksum_file"
for asset in $assets gdm-skills.tar.gz; do
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$stage" && sha256sum "$asset") >> "$checksum_file"
  else
    (cd "$stage" && shasum -a 256 "$asset") >> "$checksum_file"
  fi
done

python3 - "$stage" "$OUT" <<'PY'
import os
import sys

source, destination = sys.argv[1:]
if os.path.lexists(destination):
    raise SystemExit(f"release output appeared concurrently: {destination}")
os.rename(source, destination)
PY
stage=""
rm -rf "$render_root"
render_root=""

print -- "packaged GDM $VERSION release assets in $OUT"
