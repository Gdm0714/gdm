#!/usr/bin/env bash
# gdm 원격 설치 — 릴리스 바이너리와 스킬을 받아 설치한다 (Bun·클론 불필요).
#
#   curl -fsSL https://raw.githubusercontent.com/Gdm0714/gdm/main/install.sh | bash
#
# 환경변수:
#   GDM_VERSION   특정 버전 태그 (기본: latest)
#   GDM_BIN_DIR   바이너리 설치 경로 (기본: ~/.local/bin)
#   GDM_BASE_URL  다운로드 베이스 URL 재정의 (미러·오프라인 설치용)
#
# 저장소 클론에서 개발용으로 설치하려면 install/install.sh 를 쓴다.
set -euo pipefail

REPO="Gdm0714/gdm"
BIN_DIR="${GDM_BIN_DIR:-$HOME/.local/bin}"
VERSION="${GDM_VERSION:-latest}"

err() { echo "gdm 설치 실패: $*" >&2; exit 1; }

command -v curl >/dev/null || err "curl이 필요합니다"
command -v tar >/dev/null || err "tar이 필요합니다"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) err "지원하지 않는 OS: $os (macOS·Linux만 지원)" ;;
esac
case "$arch" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) err "지원하지 않는 아키텍처: $arch" ;;
esac
asset="gdm-$os-$arch"

if [ -n "${GDM_BASE_URL:-}" ]; then
  base="$GDM_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[1/4] 바이너리 다운로드: $asset ($VERSION)"
curl -fSL "$base/$asset" -o "$tmp/gdm" \
  || err "바이너리를 받지 못했습니다 ($base/$asset). 레포 공개 여부·릴리스 존재를 확인하세요."

echo "[2/4] 체크섬 검증"
if curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" 2>/dev/null; then
  want="$(awk -v f="$asset" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")"
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null; then
      got="$(sha256sum "$tmp/gdm" | awk '{print $1}')"
    else
      got="$(shasum -a 256 "$tmp/gdm" | awk '{print $1}')"
    fi
    [ "$want" = "$got" ] || err "체크섬 불일치 (기대 $want, 실제 $got)"
    echo "  OK"
  else
    echo "  건너뜀 (목록에 $asset 없음)"
  fi
else
  echo "  건너뜀 (SHASUMS256.txt 없음)"
fi

chmod +x "$tmp/gdm"
mkdir -p "$BIN_DIR"
mv "$tmp/gdm" "$BIN_DIR/gdm"
echo "  → $BIN_DIR/gdm"

echo "[3/4] 스킬·검수자 설치 (Claude Code / Codex)"
curl -fSL "$base/gdm-skills.tar.gz" -o "$tmp/skills.tar.gz" || err "스킬 번들을 받지 못했습니다"
mkdir -p "$tmp/pkg"
tar -xzf "$tmp/skills.tar.gz" -C "$tmp/pkg"
for root in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  mkdir -p "$root"
  for dir in "$tmp"/pkg/skills/*/; do
    name="$(basename "$dir")"
    [ "$name" = "_shared" ] && continue
    rm -rf "$root/gdm-$name"
    cp -R "${dir%/}" "$root/gdm-$name"
  done
  rm -rf "$root/gdm-agents"
  cp -R "$tmp/pkg/agents" "$root/gdm-agents"
done
echo "  → ~/.claude/skills, ~/.codex/skills"

echo "[4/4] PATH 점검·doctor"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    line="export PATH=\"$BIN_DIR:\$PATH\""
    rc=""
    case "$(basename "${SHELL:-}")" in
      zsh) rc="$HOME/.zshrc" ;;
      bash) rc="$HOME/.bashrc" ;;
    esac
    if [ -n "$rc" ] && ! grep -qsF "$BIN_DIR" "$rc"; then
      printf '\n# gdm\n%s\n' "$line" >>"$rc"
      echo "  $rc 에 PATH 추가 — 새 셸을 열거나 'source $rc' 실행"
    else
      echo "  PATH에 추가하세요: $line"
    fi
    ;;
esac
"$BIN_DIR/gdm" doctor || true

echo
echo "설치 완료. 사용: 프로젝트에서 \$gdm-go / \$gdm-full 스킬, 또는 gdm --help"
