#!/usr/bin/env bash
# gdm 원격 설치 — 릴리스 바이너리와 스킬을 받아 설치한다 (Bun·클론 불필요).
#
#   curl -fsSL https://raw.githubusercontent.com/Gdm0714/gdm/main/install.sh | bash
#
# 환경변수:
#   GDM_VERSION   특정 버전 태그 (기본: latest)
#   GDM_BIN_DIR   바이너리 설치 경로 (기본: ~/.local/bin)
#   GDM_BASE_URL  다운로드 베이스 URL 재정의 (미러·오프라인 설치용)
#   GDM_SKIP_VERIFY=1 체크섬 검증 생략 (신뢰할 수 있는 오프라인 소스에서만 사용)
#   CODEX_HOME    Codex 설정·스킬 경로 (상대 경로는 설치 실행 디렉터리 기준)
#
# 저장소 클론에서 개발용으로 설치하려면 install/install.sh 를 쓴다.
set -euo pipefail

INSTALL_CWD="$(pwd)"
REPO="Gdm0714/gdm"
BIN_DIR="${GDM_BIN_DIR:-$HOME/.local/bin}"
VERSION="${GDM_VERSION:-latest}"
case "$BIN_DIR" in
  /*) : ;;
  *) BIN_DIR="$INSTALL_CWD/$BIN_DIR" ;;
esac
case "${CODEX_HOME:-}" in
  "") CODEX_HOME_DIR="$HOME/.codex" ;;
  /*) CODEX_HOME_DIR="$CODEX_HOME" ;;
  *) CODEX_HOME_DIR="$INSTALL_CWD/$CODEX_HOME" ;;
esac

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
ROLLBACK_DIR=""
INSTALL_TMP=""
CLAUDE_STAGE=""
CODEX_STAGE=""
CLAUDE_SKILL_ROLLBACK=""
CODEX_SKILL_ROLLBACK=""
BINARY_OLD_MOVED=0
BINARY_NEW_INSTALLED=0
INSTALL_COMMITTED=0

# Called by cleanup(), which itself is invoked through the EXIT trap.
# shellcheck disable=SC2329
rollback_skill_swap() {
  local root="$1"
  local stage="$2"
  local rollback="$3"
  local name
  [ -n "$rollback" ] && [ -f "$rollback/.names" ] || return 0
  while IFS= read -r name; do
    if [ -e "$rollback/$name" ] || [ -L "$rollback/$name" ]; then
      if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then
        rm -rf -- "${root:?}/${name:?}"
      fi
      mv "$rollback/$name" "$root/$name"
    elif [ ! -e "$stage/$name" ] && [ ! -L "$stage/$name" ]; then
      rm -rf -- "${root:?}/${name:?}"
    fi
  done <"$rollback/.names"
}

# shellcheck disable=SC2329
cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [ "$INSTALL_COMMITTED" = "0" ]; then
    # Skill roots may coincide, so unwind in the reverse order of installation.
    rollback_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" "$CODEX_SKILL_ROLLBACK"
    rollback_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" "$CLAUDE_SKILL_ROLLBACK"
    if [ "$BINARY_NEW_INSTALLED" = "1" ]; then
      [ ! -e "$BIN_DIR/gdm" ] && [ ! -L "$BIN_DIR/gdm" ] || rm -f "$BIN_DIR/gdm"
    fi
    if [ "$BINARY_OLD_MOVED" = "1" ] && [ -n "$ROLLBACK_DIR" ] &&
      { [ -e "$ROLLBACK_DIR/gdm" ] || [ -L "$ROLLBACK_DIR/gdm" ]; }; then
      mv "$ROLLBACK_DIR/gdm" "$BIN_DIR/gdm"
    fi
  fi
  [ -z "$CLAUDE_STAGE" ] || rm -rf "$CLAUDE_STAGE"
  [ -z "$CODEX_STAGE" ] || rm -rf "$CODEX_STAGE"
  [ -z "$CLAUDE_SKILL_ROLLBACK" ] || rm -rf "$CLAUDE_SKILL_ROLLBACK"
  [ -z "$CODEX_SKILL_ROLLBACK" ] || rm -rf "$CODEX_SKILL_ROLLBACK"
  [ -z "$INSTALL_TMP" ] || rm -f "$INSTALL_TMP"
  [ -z "$ROLLBACK_DIR" ] || rm -rf "$ROLLBACK_DIR"
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT

stage_remote_skills() {
  local root="$1"
  local output_variable="$2"
  local stage dir name
  mkdir -p "$root"
  [ -d "$root" ] || err "skill 경로가 디렉터리가 아닙니다: $root"
  stage="$(mktemp -d "$root/.gdm-stage.XXXXXX")"
  for dir in "$tmp"/pkg/skills/*/; do
    name="$(basename "$dir")"
    [ "$name" = "_shared" ] && continue
    cp -R "${dir%/}" "$stage/gdm-$name"
  done
  cp -R "$tmp/pkg/agents" "$stage/gdm-agents"
  printf -v "$output_variable" '%s' "$stage"
}

prepare_skill_swap() {
  local root="$1"
  local stage="$2"
  local output_variable="$3"
  local rollback staged name
  rollback="$(mktemp -d "$root/.gdm-rollback.XXXXXX")"
  : >"$rollback/.names"
  for staged in "$stage"/gdm-*; do
    [ -e "$staged" ] || [ -L "$staged" ] || return 1
    name="$(basename "$staged")"
    printf '%s\n' "$name" >>"$rollback/.names"
  done
  printf -v "$output_variable" '%s' "$rollback"
}

apply_skill_swap() {
  local root="$1"
  local stage="$2"
  local rollback="$3"
  local name
  while IFS= read -r name; do
    if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then
      mv "$root/$name" "$rollback/$name"
    fi
  done <"$rollback/.names"
  while IFS= read -r name; do
    mv "$stage/$name" "$root/$name"
  done <"$rollback/.names"
}

echo "[1/7] 릴리스 다운로드: $asset ($VERSION)"
curl -fSL "$base/$asset" -o "$tmp/gdm" \
  || err "바이너리를 받지 못했습니다 ($base/$asset). 레포 공개 여부·릴리스 존재를 확인하세요."
curl -fSL "$base/gdm-skills.tar.gz" -o "$tmp/skills.tar.gz" || err "스킬 번들을 받지 못했습니다"

echo "[2/7] 체크섬 검증"
if [ "${GDM_SKIP_VERIFY:-0}" = "1" ]; then
  echo "  건너뜀 (GDM_SKIP_VERIFY=1)"
else
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    || err "SHASUMS256.txt가 없어 설치를 중단합니다 (의도적 생략은 GDM_SKIP_VERIFY=1)"
  verify_asset() {
    file="$1"
    path="$2"
    want="$(awk -v f="$file" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")"
    [ -n "$want" ] || err "체크섬 목록에 $file 항목이 없습니다"
    if command -v sha256sum >/dev/null; then
      got="$(sha256sum "$path" | awk '{print $1}')"
    elif command -v shasum >/dev/null; then
      got="$(shasum -a 256 "$path" | awk '{print $1}')"
    else
      err "sha256sum 또는 shasum이 필요합니다"
    fi
    [ "$want" = "$got" ] || err "$file 체크섬 불일치 (기대 $want, 실제 $got)"
  }
  verify_asset "$asset" "$tmp/gdm"
  verify_asset "gdm-skills.tar.gz" "$tmp/skills.tar.gz"
  echo "  OK"
fi

chmod +x "$tmp/gdm"

echo "[3/7] 번들 구조·Codex 게이트 사전검증"
mkdir -p "$tmp/pkg"
tar -xzf "$tmp/skills.tar.gz" -C "$tmp/pkg"
[ -d "$tmp/pkg/skills" ] && [ -d "$tmp/pkg/agents" ] || err "스킬 번들 구조가 올바르지 않습니다"
CODEX_HOME="$CODEX_HOME_DIR" "$tmp/gdm" agent hook-install \
  --binary "$tmp/gdm" --dry-run

echo "[4/7] 스킬 대상 사전검증·staging"
stage_remote_skills "$HOME/.claude/skills" CLAUDE_STAGE
stage_remote_skills "$CODEX_HOME_DIR/skills" CODEX_STAGE

echo "[5/7] 바이너리·스킬 transactional 교체"
mkdir -p "$BIN_DIR"
if { [ -e "$BIN_DIR/gdm" ] || [ -L "$BIN_DIR/gdm" ]; } &&
  [ ! -f "$BIN_DIR/gdm" ] && [ ! -L "$BIN_DIR/gdm" ]; then
  err "기존 바이너리 경로가 일반 파일이 아닙니다: $BIN_DIR/gdm"
fi
INSTALL_TMP="$(mktemp "$BIN_DIR/.gdm.tmp.XXXXXX")"
cp "$tmp/gdm" "$INSTALL_TMP"
chmod 755 "$INSTALL_TMP"
ROLLBACK_DIR="$(mktemp -d "$BIN_DIR/.gdm-rollback.XXXXXX")"
prepare_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" CLAUDE_SKILL_ROLLBACK
prepare_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" CODEX_SKILL_ROLLBACK
if [ -e "$BIN_DIR/gdm" ] || [ -L "$BIN_DIR/gdm" ]; then
  mv "$BIN_DIR/gdm" "$ROLLBACK_DIR/gdm"
  BINARY_OLD_MOVED=1
fi
mv "$INSTALL_TMP" "$BIN_DIR/gdm"
BINARY_NEW_INSTALLED=1
echo "  → $BIN_DIR/gdm"
apply_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" "$CLAUDE_SKILL_ROLLBACK"
apply_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" "$CODEX_SKILL_ROLLBACK"
echo "  → $HOME/.claude/skills, $CODEX_HOME_DIR/skills"

echo "[6/7] Codex 에이전트 게이트 commit"
CODEX_HOME="$CODEX_HOME_DIR" "$BIN_DIR/gdm" agent hook-install \
  --binary "$BIN_DIR/gdm" >/dev/null
INSTALL_COMMITTED=1

# PATH setup and doctor are advisory after the atomic install commit.
set +e
echo "[7/7] PATH 점검·doctor"
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
      if printf '\n# gdm\n%s\n' "$line" >>"$rc"; then
        echo "  $rc 에 PATH 추가 — 새 셸을 열거나 'source $rc' 실행"
      else
        echo "  경고: ${rc}에 PATH를 추가하지 못했습니다. 직접 추가하세요: $line" >&2
      fi
    else
      echo "  PATH에 추가하세요: $line"
    fi
    ;;
esac
if ! CODEX_HOME="$CODEX_HOME_DIR" "$BIN_DIR/gdm" doctor; then
  echo "경고: 설치는 완료됐지만 gdm doctor 점검에 실패했습니다" >&2
fi

echo
echo "설치 완료. 사용: 프로젝트에서 \$gdm-go / \$gdm-full 스킬, 또는 gdm --help"
exit 0
