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
case "${PI_CODING_AGENT_DIR:-}" in
  "") PI_AGENT_DIR="$HOME/.pi/agent" ;;
  /*) PI_AGENT_DIR="$PI_CODING_AGENT_DIR" ;;
  *) PI_AGENT_DIR="$INSTALL_CWD/$PI_CODING_AGENT_DIR" ;;
esac

BUILD_TMP=""
PI_LAUNCHER_TMP=""
ROLLBACK_DIR=""
CLAUDE_STAGE=""
CODEX_STAGE=""
PI_STAGE=""
CLAUDE_SKILL_ROLLBACK=""
CODEX_SKILL_ROLLBACK=""
PI_SKILL_ROLLBACK=""
BINARY_OLD_MOVED=0
BINARY_NEW_INSTALLED=0
PI_BINARY_OLD_MOVED=0
PI_BINARY_NEW_INSTALLED=0
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
    rollback_skill_swap "$PI_AGENT_DIR/skills" "$PI_STAGE" "$PI_SKILL_ROLLBACK"
    rollback_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" "$CODEX_SKILL_ROLLBACK"
    rollback_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" "$CLAUDE_SKILL_ROLLBACK"
    if [ "$PI_BINARY_NEW_INSTALLED" = "1" ]; then
      [ ! -e "$BIN_DIR/gdm-pi" ] && [ ! -L "$BIN_DIR/gdm-pi" ] || rm -f "$BIN_DIR/gdm-pi"
    fi
    if [ "$BINARY_NEW_INSTALLED" = "1" ]; then
      [ ! -e "$BIN_DIR/gdm" ] && [ ! -L "$BIN_DIR/gdm" ] || rm -f "$BIN_DIR/gdm"
    fi
    if [ "$PI_BINARY_OLD_MOVED" = "1" ] && [ -n "$ROLLBACK_DIR" ] &&
      { [ -e "$ROLLBACK_DIR/gdm-pi" ] || [ -L "$ROLLBACK_DIR/gdm-pi" ]; }; then
      mv "$ROLLBACK_DIR/gdm-pi" "$BIN_DIR/gdm-pi"
    fi
    if [ "$BINARY_OLD_MOVED" = "1" ] && [ -n "$ROLLBACK_DIR" ] &&
      { [ -e "$ROLLBACK_DIR/gdm" ] || [ -L "$ROLLBACK_DIR/gdm" ]; }; then
      mv "$ROLLBACK_DIR/gdm" "$BIN_DIR/gdm"
    fi
  fi
  [ -z "$BUILD_TMP" ] || rm -f "$BUILD_TMP"
  [ -z "$PI_LAUNCHER_TMP" ] || rm -f "$PI_LAUNCHER_TMP"
  [ -z "$CLAUDE_STAGE" ] || rm -rf "$CLAUDE_STAGE"
  [ -z "$CODEX_STAGE" ] || rm -rf "$CODEX_STAGE"
  [ -z "$PI_STAGE" ] || rm -rf "$PI_STAGE"
  [ -z "$CLAUDE_SKILL_ROLLBACK" ] || rm -rf "$CLAUDE_SKILL_ROLLBACK"
  [ -z "$CODEX_SKILL_ROLLBACK" ] || rm -rf "$CODEX_SKILL_ROLLBACK"
  [ -z "$PI_SKILL_ROLLBACK" ] || rm -rf "$PI_SKILL_ROLLBACK"
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
  bun "$REPO/install/render-skills.ts" \
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
cd "$REPO/cli"
mkdir -p "$BIN_DIR"
if { [ -e "$BIN_DIR/gdm" ] || [ -L "$BIN_DIR/gdm" ]; } &&
  [ ! -f "$BIN_DIR/gdm" ] && [ ! -L "$BIN_DIR/gdm" ]; then
  echo "gdm 설치 실패: 기존 바이너리 경로가 일반 파일이 아닙니다: $BIN_DIR/gdm" >&2
  exit 1
fi
if { [ -e "$BIN_DIR/gdm-pi" ] || [ -L "$BIN_DIR/gdm-pi" ]; } &&
  [ ! -f "$BIN_DIR/gdm-pi" ] && [ ! -L "$BIN_DIR/gdm-pi" ]; then
  echo "gdm 설치 실패: 기존 Pi 실행기 경로가 일반 파일이 아닙니다: $BIN_DIR/gdm-pi" >&2
  exit 1
fi
BUILD_TMP="$(mktemp "$BIN_DIR/.gdm.tmp.XXXXXX")"
bun build src/cli.ts --compile --outfile "$BUILD_TMP" >/dev/null
chmod 755 "$BUILD_TMP"
CODEX_HOME="$CODEX_HOME_DIR" "$BUILD_TMP" agent hook-install \
  --binary "$BUILD_TMP" --dry-run

echo "[2/5] 스킬 대상 사전검증·staging"
stage_generated_skills "$HOME/.claude/skills" claude CLAUDE_STAGE
stage_generated_skills "$CODEX_HOME_DIR/skills" codex CODEX_STAGE
stage_generated_skills "$PI_AGENT_DIR/skills" pi PI_STAGE
bun -e '
  import { createHash } from "node:crypto";
  import { lstatSync, readFileSync } from "node:fs";
  import { dirname, join } from "node:path";
  const [claudePath, codexPath, piPath] = process.argv.slice(1);
  const claude = JSON.parse(readFileSync(claudePath, "utf8"));
  const codex = JSON.parse(readFileSync(codexPath, "utf8"));
  const pi = JSON.parse(readFileSync(piPath, "utf8"));
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const exactKeys = (value, expected, label) => {
    if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
      throw new Error(`${label} key set mismatch`);
    }
  };
  const validate = (manifestPath, value, target) => {
    exactKeys(value, ["schemaVersion", "target", "adapterVersion", "canonicalSourceSha256", "sourceSha256", "capabilityProfile", "hook", "runner", "skills"], `${target} manifest`);
    exactKeys(value.runner, ["contract", "path", "sha256", "adapters"], `${target} runner`);
    exactKeys(value.runner.adapters, ["codex", "claude", "pi"], `${target} adapters`);
    const expectedProfile = { id: "gdm-read-only-specialist/v1", filesystem: "read-only", delegation: "disabled", mcp: "disabled", shell: "unsupported", browser: "unsupported", network: "unsupported" };
    const expectedHook = target === "codex"
      ? { id: "gdm-agent-gate-v1", status: "supported", requiredForTarget: true }
      : { id: null, status: "not-required", requiredForTarget: false };
    if (JSON.stringify(value.capabilityProfile) !== JSON.stringify(expectedProfile) ||
        JSON.stringify(value.hook) !== JSON.stringify(expectedHook) ||
        value.adapterVersion !== "gdm-target-adapter/v1" ||
        !/^[0-9a-f]{64}$/.test(value.canonicalSourceSha256) ||
        !/^[0-9a-f]{64}$/.test(value.sourceSha256)) {
      throw new Error(`${target} manifest capability/hook/hash mismatch`);
    }
    const root = dirname(manifestPath);
    for (const [label, item] of [["runner", value.runner], ...Object.entries(value.runner.adapters)]) {
      exactKeys(item, label === "runner" ? ["contract", "path", "sha256", "adapters"] : ["path", "sha256"], `${target} ${label}`);
      const path = join(root, item.path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 || hash(path) !== item.sha256) {
        throw new Error(`${target} ${label} bytes/mode mismatch`);
      }
    }
    const names = value.skills.map((skill) => skill.name);
    if (new Set(names).size !== names.length || names.join("\0") !== [...names].sort().join("\0")) {
      throw new Error(`${target} skill manifest order/identity mismatch`);
    }
    for (const skill of value.skills) {
      exactKeys(skill, ["name", "sourcePath", "sourceSha256", "renderedSha256"], `${target} skill`);
      const path = join(root, skill.name, "SKILL.md");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || hash(path) !== skill.renderedSha256) {
        throw new Error(`${target} rendered skill mismatch: ${skill.name}`);
      }
    }
  };
  if (claude.schemaVersion !== "gdm-target-skill-manifest/v1" || claude.target !== "claude" ||
      codex.schemaVersion !== "gdm-target-skill-manifest/v1" || codex.target !== "codex" ||
      pi.schemaVersion !== "gdm-target-skill-manifest/v1" || pi.target !== "pi" ||
      claude.canonicalSourceSha256 !== codex.canonicalSourceSha256 ||
      claude.canonicalSourceSha256 !== pi.canonicalSourceSha256 ||
      claude.sourceSha256 !== codex.sourceSha256 ||
      claude.sourceSha256 !== pi.sourceSha256 ||
      claude.capabilityProfile?.id !== "gdm-read-only-specialist/v1" ||
      codex.capabilityProfile?.id !== "gdm-read-only-specialist/v1" ||
      pi.capabilityProfile?.id !== "gdm-read-only-specialist/v1" ||
      JSON.stringify(claude.runner) !== JSON.stringify(codex.runner) ||
      JSON.stringify(claude.runner) !== JSON.stringify(pi.runner)) {
    throw new Error("generated target skill manifest parity failed");
  }
  validate(claudePath, claude, "claude");
  validate(codexPath, codex, "codex");
  validate(piPath, pi, "pi");
' "$CLAUDE_STAGE/gdm-target-manifest.json" "$CODEX_STAGE/gdm-target-manifest.json" \
  "$PI_STAGE/gdm-target-manifest.json"

PI_LAUNCHER_TMP="$(mktemp "$BIN_DIR/.gdm-pi.tmp.XXXXXX")"
cp "$PI_STAGE/gdm-agents/pi/gdm-pi" "$PI_LAUNCHER_TMP"
chmod 755 "$PI_LAUNCHER_TMP"

echo "[3/5] 바이너리·스킬 transactional 교체"
ROLLBACK_DIR="$(mktemp -d "$BIN_DIR/.gdm-rollback.XXXXXX")"
prepare_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" CLAUDE_SKILL_ROLLBACK
prepare_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" CODEX_SKILL_ROLLBACK
prepare_skill_swap "$PI_AGENT_DIR/skills" "$PI_STAGE" PI_SKILL_ROLLBACK
if [ -e "$BIN_DIR/gdm" ] || [ -L "$BIN_DIR/gdm" ]; then
  mv "$BIN_DIR/gdm" "$ROLLBACK_DIR/gdm"
  BINARY_OLD_MOVED=1
fi
if [ -e "$BIN_DIR/gdm-pi" ] || [ -L "$BIN_DIR/gdm-pi" ]; then
  mv "$BIN_DIR/gdm-pi" "$ROLLBACK_DIR/gdm-pi"
  PI_BINARY_OLD_MOVED=1
fi
mv "$BUILD_TMP" "$BIN_DIR/gdm"
BINARY_NEW_INSTALLED=1
mv "$PI_LAUNCHER_TMP" "$BIN_DIR/gdm-pi"
PI_BINARY_NEW_INSTALLED=1
apply_skill_swap "$HOME/.claude/skills" "$CLAUDE_STAGE" "$CLAUDE_SKILL_ROLLBACK"
apply_skill_swap "$CODEX_HOME_DIR/skills" "$CODEX_STAGE" "$CODEX_SKILL_ROLLBACK"
apply_skill_swap "$PI_AGENT_DIR/skills" "$PI_STAGE" "$PI_SKILL_ROLLBACK"

echo "[4/5] Codex 에이전트 게이트 commit"
CODEX_HOME="$CODEX_HOME_DIR" "$BIN_DIR/gdm" agent hook-install \
  --binary "$BIN_DIR/gdm" >/dev/null
INSTALL_COMMITTED=1

# Everything after the hook commit is diagnostic only. It must not turn a
# complete install into a partial-failure report.
set +e
echo "[5/5] 점검"
if ! CODEX_HOME="$CODEX_HOME_DIR" "$BIN_DIR/gdm" doctor; then
  echo "경고: 설치는 완료됐지만 gdm doctor 점검에 실패했습니다" >&2
fi

echo
echo "설치 완료. 사용: 프로젝트 디렉토리에서 gdm-pi [auto|go|full], \$gdm-go / \$gdm-full 또는 gdm --help"
exit 0
