#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"

echo "[1/3] gdm 바이너리 빌드 (bun compile)"
cd "$REPO/cli"
mkdir -p "$BIN_DIR"
bun build src/cli.ts --compile --outfile "$BIN_DIR/gdm" >/dev/null

echo "[2/3] 스킬 심링크 (Claude Code / Codex)"
mkdir -p "$HOME/.claude/skills" "$HOME/.codex/skills"
for dir in "$REPO"/skills/*/; do
  name="$(basename "$dir")"
  [ "$name" = "_shared" ] && continue
  ln -sfn "${dir%/}" "$HOME/.claude/skills/gdm-$name"
  ln -sfn "${dir%/}" "$HOME/.codex/skills/gdm-$name"
  echo "  gdm-$name"
done

echo "[3/3] 점검"
"$BIN_DIR/gdm" doctor

echo
echo "설치 완료. 사용: 프로젝트 디렉토리에서 \$gdm-go / \$gdm-full 스킬 또는 gdm --help"
