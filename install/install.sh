#!/usr/bin/env bash
set -euo pipefail

INSTALL_CWD="$(pwd)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
case "${CODEX_HOME:-}" in
  "") CODEX_HOME_DIR="$HOME/.codex" ;;
  /*) CODEX_HOME_DIR="$CODEX_HOME" ;;
  *) CODEX_HOME_DIR="$INSTALL_CWD/$CODEX_HOME" ;;
esac
case "${GID_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gid}" in
  /*) GID_CONFIG_ROOT="${GID_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gid}" ;;
  *) GID_CONFIG_ROOT="$INSTALL_CWD/${GID_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gid}" ;;
esac

BUILD_TMP=""
ROLLBACK_DIR=""
CLAUDE_STAGE=""
CODEX_STAGE=""
GID_STAGE=""
CLAUDE_SKILL_ROLLBACK=""
CODEX_SKILL_ROLLBACK=""
GID_SKILL_ROLLBACK=""
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
    rollback_skill_swap "$GID_CONFIG_ROOT/skills" "$GID_STAGE" "$GID_SKILL_ROLLBACK"
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
  [ -z "$BUILD_TMP" ] || rm -f "$BUILD_TMP"
  [ -z "$CLAUDE_STAGE" ] || rm -rf "$CLAUDE_STAGE"
  [ -z "$CODEX_STAGE" ] || rm -rf "$CODEX_STAGE"
  [ -z "$GID_STAGE" ] || rm -rf "$GID_STAGE"
  [ -z "$CLAUDE_SKILL_ROLLBACK" ] || rm -rf "$CLAUDE_SKILL_ROLLBACK"
  [ -z "$CODEX_SKILL_ROLLBACK" ] || rm -rf "$CODEX_SKILL_ROLLBACK"
  [ -z "$GID_SKILL_ROLLBACK" ] || rm -rf "$GID_SKILL_ROLLBACK"
  [ -z "$ROLLBACK_DIR" ] || rm -rf "$ROLLBACK_DIR"
  exit "$status"
}

stage_generated_skills() {
  local root="$1"
  local target="$2"
  local output_variable="$3"
  local stage
  mkdir -p "$root"
  [ -d "$root" ] || {
    echo "gdm 설치 실패: skill 경로가 디렉터리가 아닙니다: $root" >&2
    return 1
  }
  stage="$(mktemp -d "$root/.gdm-stage.XXXXXX")"
  printf -v "$output_variable" '%s' "$stage"
  "$BUILD_TMP" render-skills \
    --target "$target" \
    --source-root "$REPO/skills" \
    --agents-root "$REPO/agents" \
    --output "$stage" >/dev/null
}

prepare_skill_swap() {
  local root="$1"
  local stage="$2"
  local output_variable="$3"
  local rollback staged name
  rollback="$(mktemp -d "$root/.gdm-rollback.XXXXXX")"
  printf -v "$output_variable" '%s' "$rollback"
  : >"$rollback/.names"
  for staged in "$stage"/gdm-*; do
    [ -e "$staged" ] || [ -L "$staged" ] || return 1
    name="$(basename "$staged")"
    printf '%s\n' "$name" >>"$rollback/.names"
  done
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
    echo "  $name"
  done <"$rollback/.names"
}

echo "[1/5] gdm 바이너리 빌드·설치 사전검증"
trap cleanup EXIT
cd "$REPO"
mkdir -p "$BIN_DIR"
if { [ -e "$BIN_DIR/gdm" ] || [ -L "$BIN_DIR/gdm" ]; } &&
  [ ! -f "$BIN_DIR/gdm" ] && [ ! -L "$BIN_DIR/gdm" ]; then
  echo "gdm 설치 실패: 기존 바이너리 경로가 일반 파일이 아닙니다: $BIN_DIR/gdm" >&2
  exit 1
fi
BUILD_TMP="$(mktemp "$BIN_DIR/.gdm.tmp.XXXXXX")"
cargo build --manifest-path "$REPO/Cargo.toml" --locked --release
cp "${CARGO_TARGET_DIR:-$REPO/target}/release/gdm" "$BUILD_TMP"
chmod 755 "$BUILD_TMP"
CODEX_HOME="$CODEX_HOME_DIR" "$BUILD_TMP" agent hook-install \
  --binary "$BUILD_TMP" --dry-run

echo "[2/5] 스킬 대상 사전검증·staging"
stage_generated_skills "$HOME/.claude/skills" claude CLAUDE_STAGE
stage_generated_skills "$CODEX_HOME_DIR/skills" codex CODEX_STAGE
stage_generated_skills "$GID_CONFIG_ROOT/skills" gid GID_STAGE
"$BUILD_TMP" verify-manifests "$CLAUDE_STAGE/gdm-target-manifest.json" \
  "$CODEX_STAGE/gdm-target-manifest.json" "$GID_STAGE/gdm-target-manifest.json"


echo "[3/5] 바이너리·스킬 transactional 교체"
ROLLBACK_DIR="$(mktemp -d "$BIN_DIR/.gdm-rollback.XXXXXX")"
prepare_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" CLAUDE_SKILL_ROLLBACK
prepare_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" CODEX_SKILL_ROLLBACK
prepare_skill_swap "$GID_CONFIG_ROOT/skills" "$GID_STAGE" GID_SKILL_ROLLBACK
if [ -e "$BIN_DIR/gdm" ] || [ -L "$BIN_DIR/gdm" ]; then
  mv "$BIN_DIR/gdm" "$ROLLBACK_DIR/gdm"
  BINARY_OLD_MOVED=1
fi
mv "$BUILD_TMP" "$BIN_DIR/gdm"
BINARY_NEW_INSTALLED=1
apply_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" "$CLAUDE_SKILL_ROLLBACK"
apply_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" "$CODEX_SKILL_ROLLBACK"
apply_skill_swap "$GID_CONFIG_ROOT/skills" "$GID_STAGE" "$GID_SKILL_ROLLBACK"

echo "[4/5] Codex 에이전트 게이트 commit"
CODEX_HOME="$CODEX_HOME_DIR" "$BIN_DIR/gdm" agent hook-install \
  --binary "$BIN_DIR/gdm" >/dev/null
INSTALL_COMMITTED=1

# Everything after the hook commit is diagnostic only. It must not turn a
# complete install into a partial-failure report.
set +e
echo "[5/5] 점검"
if ! CODEX_HOME="$CODEX_HOME_DIR" GID_CONFIG_DIR="$GID_CONFIG_ROOT" "$BIN_DIR/gdm" doctor; then
  echo "경고: 설치는 완료됐지만 gdm doctor 점검에 실패했습니다" >&2
fi

echo
echo "설치 완료. 사용: gid에서 /skill gdm-go 또는 /skill gdm-full을 사용하세요. CLI 안내: gdm --help"
exit 0
