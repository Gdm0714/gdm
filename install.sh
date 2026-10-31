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
#   GID_CONFIG_DIR gid 설정·스킬 경로 (기본: ${XDG_CONFIG_HOME:-~/.config}/gid)
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
case "${GID_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gid}" in
  /*) GID_CONFIG_ROOT="${GID_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gid}" ;;
  *) GID_CONFIG_ROOT="$INSTALL_CWD/${GID_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gid}" ;;
esac

# Keep installer messages independent of user content and installation behavior.
gdm_install_language="${GDM_LANGUAGE:-auto}"
if [ "$gdm_install_language" = auto ]; then
  gdm_install_language="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
  if [ -z "$gdm_install_language" ] && [ "$(uname -s)" = Darwin ]; then
    gdm_install_language="$(/usr/bin/defaults read -g AppleLanguages 2>/dev/null | tr -d '\"(), ' | sed '/^$/d' | head -n 1 || true)"
  fi
fi
case "$gdm_install_language" in ko|ko[-_.@]*|KO|KO[-_.@]*) gdm_install_language=ko ;; *) gdm_install_language=en ;; esac
say() { if [ "$gdm_install_language" = ko ]; then printf '%s\n' "$1"; else printf '%s\n' "${2:-$1}"; fi; }
err() { say "gdm 설치 실패: $1" "gdm installation failed: ${2:-$1}" >&2; exit 1; }

command -v curl >/dev/null || err "curl이 필요합니다" "curl is required"
command -v tar >/dev/null || err "tar이 필요합니다" "tar is required"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) err "지원하지 않는 OS: $os (macOS·Linux만 지원)" "Unsupported OS: $os (macOS and Linux only)" ;;
esac
case "$arch" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) err "지원하지 않는 아키텍처: $arch" "Unsupported architecture: $arch" ;;
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
  [ -z "$CLAUDE_STAGE" ] || rm -rf "$CLAUDE_STAGE"
  [ -z "$CODEX_STAGE" ] || rm -rf "$CODEX_STAGE"
  [ -z "$GID_STAGE" ] || rm -rf "$GID_STAGE"
  [ -z "$CLAUDE_SKILL_ROLLBACK" ] || rm -rf "$CLAUDE_SKILL_ROLLBACK"
  [ -z "$CODEX_SKILL_ROLLBACK" ] || rm -rf "$CODEX_SKILL_ROLLBACK"
  [ -z "$GID_SKILL_ROLLBACK" ] || rm -rf "$GID_SKILL_ROLLBACK"
  [ -z "$INSTALL_TMP" ] || rm -f "$INSTALL_TMP"
  [ -z "$ROLLBACK_DIR" ] || rm -rf "$ROLLBACK_DIR"
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT

stage_remote_skills() {
  local root="$1"
  local target="$2"
  local output_variable="$3"
  local stage source staged
  mkdir -p "$root"
  [ -d "$root" ] || err "skill 경로가 디렉터리가 아닙니다: $root" "Skill path is not a directory: $root"
  stage="$(mktemp -d "$root/.gdm-stage.XXXXXX")"
  printf -v "$output_variable" '%s' "$stage"
  source="$tmp/pkg/targets/$target"
  [ -d "$source" ] || err "target skill bundle이 없습니다: $target" "Missing target skill bundle: $target"
  [ -f "$source/gdm-target-manifest.json" ] && [ ! -L "$source/gdm-target-manifest.json" ] || \
    err "target skill manifest가 없습니다: $target" "Missing target skill manifest: $target"
  if find "$source" -type l -print -quit | grep -q .; then
    err "target skill bundle에 symlink가 있습니다: $target" "Target skill bundle contains a symlink: $target"
  fi
  for staged in "$source"/gdm-*; do
    [ -e "$staged" ] && [ ! -L "$staged" ] || err "target skill bundle 항목이 올바르지 않습니다: $staged" "Invalid target skill bundle entry: $staged"
    cp -R "$staged" "$stage/$(basename "$staged")"
  done
}

sha256_path() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    err "sha256sum 또는 shasum이 필요합니다" "sha256sum or shasum is required"
  fi
}

manifest_top_value() {
  awk -F'"' -v key="$2" '$1 == "  " && $2 == key { print $4; found=1; exit } END { if (!found) exit 1 }' "$1"
}

manifest_runner_hash() {
  awk -F'"' '/^  "runner": \{/ { runner=1; next } runner && /^    "sha256":/ { print $4; found=1; exit } END { if (!found) exit 1 }' "$1"
}

manifest_adapter_hash() {
  awk -F'"' -v target="$2" '$0 == "      \"" target "\": {" { adapter=1; next } adapter && /^        "sha256":/ { print $4; found=1; exit } END { if (!found) exit 1 }' "$1"
}

validate_staged_target() {
  local stage="$1" target="$2"
  local manifest="$stage/gdm-target-manifest.json"
  local top_keys runner_hash adapter_target adapter_hash skill_name skill_hash hash_field hash_value
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || err "target manifest가 일반 파일이 아닙니다: $target" "Target manifest is not a regular file: $target"
  top_keys="$(awk -F'"' '/^  "[^"]+":/ { print $2 }' "$manifest" | tr '\n' ' ')"
  [ "$top_keys" = "schemaVersion target adapterVersion canonicalSourceSha256 sourceSha256 capabilityProfile hook runner skills " ] || \
    err "target manifest schema key가 올바르지 않습니다: $target" "Invalid target manifest schema keys: $target"
  [ "$(manifest_top_value "$manifest" schemaVersion)" = "gdm-target-skill-manifest/v1" ] || \
    err "target manifest schema가 올바르지 않습니다: $target" "Invalid target manifest schema: $target"
  [ "$(manifest_top_value "$manifest" target)" = "$target" ] || \
    err "target manifest identity가 올바르지 않습니다: $target" "Invalid target manifest identity: $target"
  [ "$(manifest_top_value "$manifest" adapterVersion)" = "gdm-target-adapter/v1" ] || \
    err "target adapter version이 올바르지 않습니다: $target" "Invalid target adapter version: $target"
  for hash_field in canonicalSourceSha256 sourceSha256; do
    hash_value="$(manifest_top_value "$manifest" "$hash_field")" || err "target manifest hash가 없습니다: $target/$hash_field" "Missing target manifest hash: $target/$hash_field"
    case "$hash_value" in *[!0-9a-f]*) err "target manifest hash가 올바르지 않습니다: $target/$hash_field" "Invalid target manifest hash: $target/$hash_field" ;; esac
    [ "${#hash_value}" -eq 64 ] || err "target manifest hash 길이가 올바르지 않습니다: $target/$hash_field" "Invalid target manifest hash length: $target/$hash_field"
  done
  for expected in \
    '    "id": "gdm-read-only-specialist/v1",' \
    '    "filesystem": "read-only",' \
    '    "delegation": "disabled",' \
    '    "mcp": "disabled",' \
    '    "shell": "unsupported",' \
    '    "browser": "unsupported",' \
    '    "network": "unsupported"' \
    '    "contract": "gdm-role-runner/v1",' \
    '    "path": "gdm-agents/run-role.sh",' \
    '        "path": "gdm-agents/providers/codex.sh",' \
    '        "path": "gdm-agents/providers/claude.sh",'; do
    grep -Fqx "$expected" "$manifest" || err "target manifest capability/runner가 올바르지 않습니다: $target" "Invalid target manifest capability or runner: $target"
  done
  if [ "$target" = "codex" ]; then
    grep -Fqx '    "id": "gdm-agent-gate-v1",' "$manifest" &&
      grep -Fqx '    "status": "supported",' "$manifest" &&
      grep -Fqx '    "requiredForTarget": true' "$manifest" || \
      err "Codex target hook manifest가 올바르지 않습니다" "Invalid Codex target hook manifest"
  else
    grep -Fqx '    "id": null,' "$manifest" &&
      grep -Fqx '    "status": "not-required",' "$manifest" &&
      grep -Fqx '    "requiredForTarget": false' "$manifest" || \
      err "외부 target hook manifest가 올바르지 않습니다: $target" "Invalid external target hook manifest: $target"
  fi
  runner_hash="$(manifest_runner_hash "$manifest")" || err "runner hash가 없습니다: $target" "Missing runner hash: $target"
  [ "$runner_hash" = "$(sha256_path "$stage/gdm-agents/run-role.sh")" ] &&
    [ -x "$stage/gdm-agents/run-role.sh" ] && [ ! -L "$stage/gdm-agents/run-role.sh" ] || \
    err "runner bytes 또는 mode가 manifest와 다릅니다: $target" "Runner bytes or mode do not match the manifest: $target"
  for adapter_target in codex claude; do
    adapter_hash="$(manifest_adapter_hash "$manifest" "$adapter_target")" || \
      err "provider adapter hash가 없습니다: $target/$adapter_target" "Missing provider adapter hash: $target/$adapter_target"
    [ "$adapter_hash" = "$(sha256_path "$stage/gdm-agents/providers/$adapter_target.sh")" ] &&
      [ -x "$stage/gdm-agents/providers/$adapter_target.sh" ] &&
      [ ! -L "$stage/gdm-agents/providers/$adapter_target.sh" ] || \
      err "provider adapter bytes 또는 mode가 manifest와 다릅니다: $target/$adapter_target" "Provider adapter bytes or mode do not match the manifest: $target/$adapter_target"
  done
  while IFS="$(printf '\t')" read -r skill_name skill_hash; do
    case "$skill_name" in gdm-*) ;; *) err "manifest skill name이 올바르지 않습니다: $target" "Invalid manifest skill name: $target" ;; esac
    case "${skill_name#gdm-}" in ""|*[!a-z0-9-]*) err "manifest skill name이 올바르지 않습니다: $target" "Invalid manifest skill name: $target" ;; esac
    [ -f "$stage/$skill_name/SKILL.md" ] && [ ! -L "$stage/$skill_name/SKILL.md" ] || \
      err "manifest skill 파일이 없습니다: $target/$skill_name" "Missing manifest skill file: $target/$skill_name"
    [ "$skill_hash" = "$(sha256_path "$stage/$skill_name/SKILL.md")" ] || \
      err "rendered skill hash가 다릅니다: $target/$skill_name" "Rendered skill hash mismatch: $target/$skill_name"
  done <<EOF
$(awk -F'"' '/^  "skills": \[/ { skills=1; next } skills && /^      "name":/ { name=$4 } skills && /^      "renderedSha256":/ { print name "\t" $4; count++ } END { if (!count) exit 1 }' "$manifest")
EOF
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
  done <"$rollback/.names"
}

say "[1/7] 릴리스 다운로드: $asset ($VERSION)" "[1/7] Downloading release: $asset ($VERSION)"
curl -fSL "$base/$asset" -o "$tmp/gdm" \
  || err "바이너리를 받지 못했습니다 ($base/$asset). 레포 공개 여부·릴리스 존재를 확인하세요." "Could not download the binary ($base/$asset). Check release availability."
curl -fSL "$base/gdm-skills.tar.gz" -o "$tmp/skills.tar.gz" || err "스킬 번들을 받지 못했습니다" "Could not download the skills bundle"

say "[2/7] 체크섬 검증" "[2/7] Verifying checksums"
if [ "${GDM_SKIP_VERIFY:-0}" = "1" ]; then
  say "  건너뜀 (GDM_SKIP_VERIFY=1)" "  Skipped (GDM_SKIP_VERIFY=1)"
else
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    || err "SHASUMS256.txt가 없어 설치를 중단합니다 (의도적 생략은 GDM_SKIP_VERIFY=1)" "Installation stopped: SHASUMS256.txt is unavailable (GDM_SKIP_VERIFY=1 explicitly skips verification)"
  verify_asset() {
    file="$1"
    path="$2"
    want="$(awk -v f="$file" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")"
    [ -n "$want" ] || err "체크섬 목록에 $file 항목이 없습니다" "Missing checksum entry: $file"
    if command -v sha256sum >/dev/null; then
      got="$(sha256sum "$path" | awk '{print $1}')"
    elif command -v shasum >/dev/null; then
      got="$(shasum -a 256 "$path" | awk '{print $1}')"
    else
      err "sha256sum 또는 shasum이 필요합니다" "sha256sum or shasum is required"
    fi
    [ "$want" = "$got" ] || err "$file 체크섬 불일치 (기대 $want, 실제 $got)" "$file checksum mismatch (expected $want, got $got)"
  }
  verify_asset "$asset" "$tmp/gdm"
  verify_asset "gdm-skills.tar.gz" "$tmp/skills.tar.gz"
  echo "  OK"
fi

chmod +x "$tmp/gdm"

say "[3/7] 번들 구조·Codex 게이트 사전검증" "[3/7] Checking bundle structure and the Codex gate"
mkdir -p "$tmp/pkg"
tar -xzf "$tmp/skills.tar.gz" -C "$tmp/pkg"
[ -d "$tmp/pkg/targets/codex" ] && [ -d "$tmp/pkg/targets/claude" ] && \
  [ -d "$tmp/pkg/targets/gid" ] || \
  err "target 스킬 번들 구조가 올바르지 않습니다" "Invalid target skills bundle structure"
CODEX_HOME="$CODEX_HOME_DIR" "$tmp/gdm" agent hook-install \
  --binary "$tmp/gdm" --dry-run

say "[4/7] 스킬 대상 사전검증·staging" "[4/7] Checking and staging skill targets"
stage_remote_skills "$HOME/.claude/skills" claude CLAUDE_STAGE
stage_remote_skills "$CODEX_HOME_DIR/skills" codex CODEX_STAGE
stage_remote_skills "$GID_CONFIG_ROOT/skills" gid GID_STAGE
validate_staged_target "$CLAUDE_STAGE" claude
validate_staged_target "$CODEX_STAGE" codex
validate_staged_target "$GID_STAGE" gid
for parity_field in canonicalSourceSha256 sourceSha256; do
  [ "$(manifest_top_value "$CLAUDE_STAGE/gdm-target-manifest.json" "$parity_field")" = \
    "$(manifest_top_value "$CODEX_STAGE/gdm-target-manifest.json" "$parity_field")" ] && \
    [ "$(manifest_top_value "$CLAUDE_STAGE/gdm-target-manifest.json" "$parity_field")" = \
    "$(manifest_top_value "$GID_STAGE/gdm-target-manifest.json" "$parity_field")" ] || \
    err "target manifest source parity가 다릅니다: $parity_field" "Target manifests disagree on source: $parity_field"
done
[ "$(manifest_runner_hash "$CLAUDE_STAGE/gdm-target-manifest.json")" = \
  "$(manifest_runner_hash "$CODEX_STAGE/gdm-target-manifest.json")" ] && \
  [ "$(manifest_runner_hash "$CLAUDE_STAGE/gdm-target-manifest.json")" = \
  "$(manifest_runner_hash "$GID_STAGE/gdm-target-manifest.json")" ] || \
  err "target manifest runner parity가 다릅니다" "Target manifests disagree on runner"

say "[5/7] 바이너리·스킬 transactional 교체" "[5/7] Replacing binaries and skills transactionally"
mkdir -p "$BIN_DIR"
if { [ -e "$BIN_DIR/gdm" ] || [ -L "$BIN_DIR/gdm" ]; } &&
  [ ! -f "$BIN_DIR/gdm" ] && [ ! -L "$BIN_DIR/gdm" ]; then
  err "기존 바이너리 경로가 일반 파일이 아닙니다: $BIN_DIR/gdm" "Existing binary path is not a regular file: $BIN_DIR/gdm"
fi
INSTALL_TMP="$(mktemp "$BIN_DIR/.gdm.tmp.XXXXXX")"
cp "$tmp/gdm" "$INSTALL_TMP"
chmod 755 "$INSTALL_TMP"
ROLLBACK_DIR="$(mktemp -d "$BIN_DIR/.gdm-rollback.XXXXXX")"
prepare_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" CLAUDE_SKILL_ROLLBACK
prepare_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" CODEX_SKILL_ROLLBACK
prepare_skill_swap "$GID_CONFIG_ROOT/skills" "$GID_STAGE" GID_SKILL_ROLLBACK
if [ -e "$BIN_DIR/gdm" ] || [ -L "$BIN_DIR/gdm" ]; then
  mv "$BIN_DIR/gdm" "$ROLLBACK_DIR/gdm"
  BINARY_OLD_MOVED=1
fi
mv "$INSTALL_TMP" "$BIN_DIR/gdm"
BINARY_NEW_INSTALLED=1
echo "  → $BIN_DIR/gdm"
apply_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" "$CLAUDE_SKILL_ROLLBACK"
apply_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" "$CODEX_SKILL_ROLLBACK"
apply_skill_swap "$GID_CONFIG_ROOT/skills" "$GID_STAGE" "$GID_SKILL_ROLLBACK"
echo "  → $HOME/.claude/skills, $CODEX_HOME_DIR/skills, $GID_CONFIG_ROOT/skills"

say "[6/7] Codex 에이전트 게이트 commit" "[6/7] Committing the Codex agent gate"
CODEX_HOME="$CODEX_HOME_DIR" "$BIN_DIR/gdm" agent hook-install \
  --binary "$BIN_DIR/gdm" >/dev/null
INSTALL_COMMITTED=1

# PATH setup and doctor are advisory after the atomic install commit.
set +e
say "[7/7] PATH 점검·doctor" "[7/7] Checking PATH and running doctor"
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
        say "  $rc 에 PATH 추가 — 새 셸을 열거나 'source $rc' 실행" "  Added PATH to $rc — open a new shell or run 'source $rc'"
      else
        say "  경고: ${rc}에 PATH를 추가하지 못했습니다. 직접 추가하세요: $line" "  Warning: could not add PATH to ${rc}. Add it manually: $line" >&2
      fi
    else
      say "  PATH에 추가하세요: $line" "  Add to PATH: $line"
    fi
    ;;
esac
if ! CODEX_HOME="$CODEX_HOME_DIR" GID_CONFIG_DIR="$GID_CONFIG_ROOT" "$BIN_DIR/gdm" doctor; then
  say "경고: 설치는 완료됐지만 gdm doctor 점검에 실패했습니다" "Warning: installation completed, but gdm doctor reported a problem" >&2
fi

echo
say "설치 완료. 사용: gid에서 /skill gdm-go 또는 /skill gdm-full을 사용하세요. CLI 안내: gdm --help" "Installation complete. In gid, use /skill gdm-go or /skill gdm-full. CLI help: gdm --help"
exit 0
