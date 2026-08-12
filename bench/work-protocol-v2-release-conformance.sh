#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for command_name in bun cmp curl git grep jq mktemp python3 rg sed shasum zsh; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "missing release conformance dependency: $command_name" >&2
    exit 1
  }
done

GDM_V2_TMP_ROOT="${TMPDIR:-/tmp}"
GDM_V2_TMP="$(mktemp -d "$GDM_V2_TMP_ROOT/gdm-protocol-v2-release.XXXXXX")"
cleanup() {
  case "$GDM_V2_TMP" in
    "$GDM_V2_TMP_ROOT"/gdm-protocol-v2-release.*) rm -rf -- "$GDM_V2_TMP" ;;
    *) echo "refusing to clean unexpected path: $GDM_V2_TMP" >&2 ;;
  esac
}
trap cleanup EXIT

NATIVE_DIR="$GDM_V2_TMP/native"
RELEASE_DIR="$GDM_V2_TMP/release"
mkdir -p "$NATIVE_DIR"
(
  cd "$REPO_ROOT/cli"
  bun build src/cli.ts --compile --outfile "$NATIVE_DIR/gdm-host" >/dev/null
)
for asset in \
  gdm-darwin-arm64 gdm-darwin-x64 gdm-linux-arm64 gdm-linux-x64; do
  cp "$NATIVE_DIR/gdm-host" "$NATIVE_DIR/$asset"
  chmod 755 "$NATIVE_DIR/$asset"
done
PACKAGE_VERSION="$(jq -r .version "$REPO_ROOT/cli/package.json")"
SOURCE_DATE_EPOCH=0 "$REPO_ROOT/script/release/gdm-package.zsh" \
  --bin-dir "$NATIVE_DIR" --out "$RELEASE_DIR" --version "$PACKAGE_VERSION" >/dev/null

INSTALL_HOME="$GDM_V2_TMP/install-home"
INSTALL_CODEX_HOME="$INSTALL_HOME/.codex"
mkdir -p "$INSTALL_HOME"
HOME="$INSTALL_HOME" CODEX_HOME="$INSTALL_CODEX_HOME" \
  GDM_BASE_URL="file://$RELEASE_DIR" GDM_VERSION="$PACKAGE_VERSION" \
  "$REPO_ROOT/install.sh" >"$GDM_V2_TMP/install.out" 2>"$GDM_V2_TMP/install.err"
INSTALLED_GDM="$INSTALL_HOME/.local/bin/gdm"
test -x "$INSTALLED_GDM"

CODEX_MANIFEST="$INSTALL_CODEX_HOME/skills/gdm-target-manifest.json"
CLAUDE_MANIFEST="$INSTALL_HOME/.claude/skills/gdm-target-manifest.json"
jq -e '
  .schemaVersion == "gdm-target-skill-manifest/v1" and
  .target == "codex" and
  .adapterVersion == "gdm-target-adapter/v1" and
  .capabilityProfile.id == "gdm-read-only-specialist/v1" and
  .hook == {id:"gdm-agent-gate-v1",status:"supported",requiredForTarget:true}
' "$CODEX_MANIFEST" >/dev/null
jq -e '
  .schemaVersion == "gdm-target-skill-manifest/v1" and
  .target == "claude" and
  .adapterVersion == "gdm-target-adapter/v1" and
  .capabilityProfile.id == "gdm-read-only-specialist/v1" and
  .hook == {id:null,status:"not-required",requiredForTarget:false}
' "$CLAUDE_MANIFEST" >/dev/null
test "$(jq -r .canonicalSourceSha256 "$CODEX_MANIFEST")" = \
  "$(jq -r .canonicalSourceSha256 "$CLAUDE_MANIFEST")"
test "$(jq -r .sourceSha256 "$CODEX_MANIFEST")" = \
  "$(jq -r .sourceSha256 "$CLAUDE_MANIFEST")"
for installed_root in "$INSTALL_CODEX_HOME/skills" "$INSTALL_HOME/.claude/skills"; do
  test -x "$installed_root/gdm-agents/run-role.sh"
  test -x "$installed_root/gdm-agents/providers/codex.sh"
  test -x "$installed_root/gdm-agents/providers/claude.sh"
  cmp "$REPO_ROOT/agents/run-role.sh" "$installed_root/gdm-agents/run-role.sh"
  cmp "$REPO_ROOT/agents/providers/codex.sh" "$installed_root/gdm-agents/providers/codex.sh"
  cmp "$REPO_ROOT/agents/providers/claude.sh" "$installed_root/gdm-agents/providers/claude.sh"
  test "$(jq -r .runner.sha256 "$installed_root/gdm-target-manifest.json")" = \
    "$(shasum -a 256 "$installed_root/gdm-agents/run-role.sh" | awk '{print $1}')"
  test "$(jq -r .runner.adapters.codex.sha256 "$installed_root/gdm-target-manifest.json")" = \
    "$(shasum -a 256 "$installed_root/gdm-agents/providers/codex.sh" | awk '{print $1}')"
  test "$(jq -r .runner.adapters.claude.sha256 "$installed_root/gdm-target-manifest.json")" = \
    "$(shasum -a 256 "$installed_root/gdm-agents/providers/claude.sh" | awk '{print $1}')"
done
grep -Fq -- '--disable shell_tool' "$INSTALL_CODEX_HOME/skills/gdm-agents/providers/codex.sh"
grep -Fq -- '--tools ""' "$INSTALL_CODEX_HOME/skills/gdm-agents/providers/claude.sh"
if find "$INSTALL_CODEX_HOME/skills" "$INSTALL_HOME/.claude/skills" -type l -print -quit | grep -q .; then
  echo "generated installed skills contain a symlink" >&2
  exit 1
fi
if rg -n -i '\b(claude[[:space:]]+-p|codex[[:space:]]+exec)\b' \
  "$INSTALL_CODEX_HOME"/skills/gdm-*/SKILL.md \
  "$INSTALL_HOME"/.claude/skills/gdm-*/SKILL.md; then
  echo "generated skill bypasses the common role runner" >&2
  exit 1
fi

FIXTURE="$GDM_V2_TMP/protocol-fixture"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q
printf 'stable source\n' >"$FIXTURE/source.txt"
run_source() {
  (
    cd "$FIXTURE"
    bun "$REPO_ROOT/cli/src/cli.ts" "$@"
  )
}
run_installed() {
  (
    cd "$FIXTURE"
    HOME="$INSTALL_HOME" CODEX_HOME="$INSTALL_CODEX_HOME" "$INSTALLED_GDM" "$@"
  )
}

run_source plan init \
  --slug release-parity \
  --brief "v1 source와 installed parity" \
  --require "v1 wire compatibility" \
  --forbid "automatic delivery" >/dev/null
run_source plan add \
  --slug release-parity \
  --desc "fixture exists" \
  --cmd "test -f source.txt" \
  --expect "exit 0" >/dev/null

ANCHOR="$FIXTURE/.gdm/release-parity/journal.anchor"
FORMAT_MARKER="$FIXTURE/.gdm/release-parity/journal.format"
if [ -f "$ANCHOR" ]; then
  mv "$ANCHOR" "$GDM_V2_TMP/legacy-anchor.saved"
fi
if [ -f "$FORMAT_MARKER" ]; then
  mv "$FORMAT_MARKER" "$GDM_V2_TMP/legacy-format.saved"
fi
run_source protocol export --slug release-parity >"$GDM_V2_TMP/source-v1-snapshot.json"
run_installed protocol export --slug release-parity >"$GDM_V2_TMP/installed-v1-snapshot.json"
cmp "$GDM_V2_TMP/source-v1-snapshot.json" "$GDM_V2_TMP/installed-v1-snapshot.json"
jq -e '.schemaVersion == "gdm-work-snapshot/v1" and .latestHandoff == null' \
  "$GDM_V2_TMP/source-v1-snapshot.json" >/dev/null

run_source protocol handoff \
  --slug release-parity \
  --handoff-id v1-release-replay \
  --from-role producer \
  --to-role receiver \
  --intent "v1 migration replay" >"$GDM_V2_TMP/source-v1-handoff.json"
run_installed protocol handoff \
  --slug release-parity \
  --handoff-id v1-release-replay \
  --from-role producer \
  --to-role receiver \
  --intent "v1 migration replay" >"$GDM_V2_TMP/installed-v1-handoff.json"
cmp "$GDM_V2_TMP/source-v1-handoff.json" "$GDM_V2_TMP/installed-v1-handoff.json"
jq -e '.schemaVersion == "gdm-handoff/v1" and .revision == 1' \
  "$GDM_V2_TMP/source-v1-handoff.json" >/dev/null
test -f "$ANCHOR"
test -f "$FORMAT_MARKER"
run_source protocol status --slug release-parity >"$GDM_V2_TMP/source-status.json"
run_installed protocol status --slug release-parity >"$GDM_V2_TMP/installed-status.json"
cmp "$GDM_V2_TMP/source-status.json" "$GDM_V2_TMP/installed-status.json"

mkdir -p "$FIXTURE/.gdm/release-parity/in" "$FIXTURE/.gdm/release-parity/out/protocol"
printf 'bounded review context\n' >"$FIXTURE/.gdm/release-parity/in/review.txt"
run_source protocol export --slug release-parity >"$GDM_V2_TMP/v2-snapshot.json"
PLAN_FINGERPRINT="$(jq -r .work.planFingerprint "$GDM_V2_TMP/v2-snapshot.json")"
STATE_FINGERPRINT="$(jq -r .work.stateFingerprint "$GDM_V2_TMP/v2-snapshot.json")"
SOURCE_FINGERPRINT="$(jq -r .work.sourceFingerprint.sha256 "$GDM_V2_TMP/v2-snapshot.json")"
V2_OFFER_ARGS=(
  protocol offer --slug release-parity --handoff-id release-v2-offer
  --from-role coordinator --from-provider codex --to-role review --to-provider claude
  --intent "review only the bound artifact"
  --artifact .gdm/release-parity/in/review.txt
  --expected-plan-fingerprint "$PLAN_FINGERPRINT"
  --expected-state-fingerprint "$STATE_FINGERPRINT"
  --expected-source-fingerprint "$SOURCE_FINGERPRINT"
)
run_source "${V2_OFFER_ARGS[@]}" >"$GDM_V2_TMP/source-v2-offer.json"
run_installed "${V2_OFFER_ARGS[@]}" >"$GDM_V2_TMP/installed-v2-offer.json"
cmp "$GDM_V2_TMP/source-v2-offer.json" "$GDM_V2_TMP/installed-v2-offer.json"
V2_HANDOFF_EVENT_ID="$(jq -r .eventId "$GDM_V2_TMP/source-v2-offer.json")"
V2_CLAIM_ARGS=(
  protocol claim --slug release-parity --handoff-event-id "$V2_HANDOFF_EVENT_ID"
  --claim-id release-v2-claim --receiver-role review --receiver-provider claude
  --capability-profile gdm-read-only-specialist/v1 --model-requested release-model
)
run_source "${V2_CLAIM_ARGS[@]}" >"$GDM_V2_TMP/source-v2-bundle.json"
run_installed "${V2_CLAIM_ARGS[@]}" >"$GDM_V2_TMP/installed-v2-bundle.json"
cmp "$GDM_V2_TMP/source-v2-bundle.json" "$GDM_V2_TMP/installed-v2-bundle.json"
jq -e '.schemaVersion == "gdm-dispatch-bundle/v1" and
  .receiver == {role:"review"} and .capabilityProfile == "gdm-read-only-specialist/v1" and
  .artifact.path == ".gdm/release-parity/in/review.txt" and
  .artifact.text == "bounded review context\n" and
  .artifact.bytesBase64 == "Ym91bmRlZCByZXZpZXcgY29udGV4dAo="' \
  "$GDM_V2_TMP/source-v2-bundle.json" >/dev/null
V2_BUNDLE_SHA="$(jq -r .bundleSha256 "$GDM_V2_TMP/source-v2-bundle.json")"

# The provider-visible projection is a separate release wire surface. It must be
# byte-identical across source and packaged CLIs, retain the canonical bundle
# identity used by ACK/receipt, and never duplicate bytesBase64 into model input.
run_source "${V2_CLAIM_ARGS[@]}" --model-view >"$GDM_V2_TMP/source-v2-model-view.json"
run_installed "${V2_CLAIM_ARGS[@]}" --model-view >"$GDM_V2_TMP/installed-v2-model-view.json"
cmp "$GDM_V2_TMP/source-v2-model-view.json" "$GDM_V2_TMP/installed-v2-model-view.json"
jq -e --arg bundleSha256 "$V2_BUNDLE_SHA" '
  .schemaVersion == "gdm-dispatch-model-view/v1" and
  .receiver == {role:"review"} and
  .capabilityProfile == "gdm-read-only-specialist/v1" and
  .artifact == {
    path:".gdm/release-parity/in/review.txt",
    sha256:.artifact.sha256,
    text:"bounded review context\n"
  } and
  .bundleSha256 == $bundleSha256 and
  (tostring | contains("bytesBase64") | not)
' "$GDM_V2_TMP/source-v2-model-view.json" >/dev/null
V2_OUTPUT="$FIXTURE/.gdm/release-parity/out/protocol/release-v2-claim.out"
jq -cn \
  --arg claimId release-v2-claim \
  --arg handoffEventId "$V2_HANDOFF_EVENT_ID" \
  --arg bundleSha256 "$V2_BUNDLE_SHA" \
  '{schemaVersion:"gdm-receiver-ack/v1",claimId:$claimId,handoffEventId:$handoffEventId,bundleSha256:$bundleSha256,disposition:"completed"}' |
  sed 's/^/GDM_RECEIVER_ACK_V1=/' >"$V2_OUTPUT"
V2_FINISH_ARGS=(
  protocol finish --slug release-parity --claim-id release-v2-claim --exit-code 0
  --output-artifact .gdm/release-parity/out/protocol/release-v2-claim.out
  --provider-target claude --adapter-version gdm-provider-adapter-v1
  --executable /usr/bin/true --executable-sha256 "$(shasum -a 256 /usr/bin/true | awk '{print $1}')"
  --executable-version release-fixture --argv-policy-id gdm-claude-read-only-v1
  --model-requested release-model
)
run_source "${V2_FINISH_ARGS[@]}" >"$GDM_V2_TMP/source-v2-receipt.json"
run_installed "${V2_FINISH_ARGS[@]}" >"$GDM_V2_TMP/installed-v2-receipt.json"
cmp "$GDM_V2_TMP/source-v2-receipt.json" "$GDM_V2_TMP/installed-v2-receipt.json"
jq -e '.schemaVersion == "gdm-protocol-receipt/v1" and .stage == "exited" and
  .runnerObserved.status == "succeeded"' "$GDM_V2_TMP/source-v2-receipt.json" >/dev/null
run_source protocol adopt --slug release-parity --claim-id release-v2-claim \
  >"$GDM_V2_TMP/source-v2-adopted.json"
run_installed protocol adopt --slug release-parity --claim-id release-v2-claim \
  >"$GDM_V2_TMP/installed-v2-adopted.json"
cmp "$GDM_V2_TMP/source-v2-adopted.json" "$GDM_V2_TMP/installed-v2-adopted.json"
run_source protocol status --slug release-parity >"$GDM_V2_TMP/source-v2-status.json"
run_installed protocol status --slug release-parity >"$GDM_V2_TMP/installed-v2-status.json"
cmp "$GDM_V2_TMP/source-v2-status.json" "$GDM_V2_TMP/installed-v2-status.json"
jq -e '.lifecycles[] | select(.claimId == "release-v2-claim") |
  .stage == "adopted" and .runnerObserved.status == "succeeded"' \
  "$GDM_V2_TMP/source-v2-status.json" >/dev/null

ROLLBACK_HOME="$GDM_V2_TMP/rollback-home"
mkdir -p \
  "$ROLLBACK_HOME/.local/bin" \
  "$ROLLBACK_HOME/.claude/skills/gdm-go" \
  "$ROLLBACK_HOME/.codex/skills/gdm-go"
printf '#!/bin/sh\nprintf old-gdm\\n\n' >"$ROLLBACK_HOME/.local/bin/gdm"
chmod 755 "$ROLLBACK_HOME/.local/bin/gdm"
printf 'old claude skill\n' >"$ROLLBACK_HOME/.claude/skills/gdm-go/SKILL.md"
printf 'old codex skill\n' >"$ROLLBACK_HOME/.codex/skills/gdm-go/SKILL.md"
printf '%s-aaaaaaaaaaaaaaaaaaaaaaaa\n' "$$" >"$ROLLBACK_HOME/.codex/hooks.json.gdm-lock"
shasum -a 256 \
  "$ROLLBACK_HOME/.local/bin/gdm" \
  "$ROLLBACK_HOME/.claude/skills/gdm-go/SKILL.md" \
  "$ROLLBACK_HOME/.codex/skills/gdm-go/SKILL.md" >"$GDM_V2_TMP/rollback-before.sha"
if HOME="$ROLLBACK_HOME" CODEX_HOME="$ROLLBACK_HOME/.codex" \
  GDM_BASE_URL="file://$RELEASE_DIR" GDM_VERSION="$PACKAGE_VERSION" \
  "$REPO_ROOT/install.sh" >"$GDM_V2_TMP/rollback.out" 2>"$GDM_V2_TMP/rollback.err"; then
  echo "installer unexpectedly committed while the hook target was locked" >&2
  exit 1
fi
shasum -a 256 \
  "$ROLLBACK_HOME/.local/bin/gdm" \
  "$ROLLBACK_HOME/.claude/skills/gdm-go/SKILL.md" \
  "$ROLLBACK_HOME/.codex/skills/gdm-go/SKILL.md" >"$GDM_V2_TMP/rollback-after.sha"
cmp "$GDM_V2_TMP/rollback-before.sha" "$GDM_V2_TMP/rollback-after.sha"
if find "$ROLLBACK_HOME" \( -name '.gdm-stage.*' -o -name '.gdm-rollback.*' -o -name '.gdm.tmp.*' \) \
  -print -quit | grep -q .; then
  echo "installer rollback left a transaction artifact" >&2
  exit 1
fi

jq -n \
  --arg sourceTemplateSha256 "$(jq -r .canonicalSourceSha256 "$CODEX_MANIFEST")" \
  --arg sourceSha256 "$(jq -r .sourceSha256 "$CODEX_MANIFEST")" \
  --arg binarySha256 "$(shasum -a 256 "$INSTALLED_GDM" | awk '{print $1}')" \
  --arg skillsArchiveSha256 "$(shasum -a 256 "$RELEASE_DIR/gdm-skills.tar.gz" | awk '{print $1}')" \
  '{
    schemaVersion: "gdm-protocol-v2-release-conformance/v1",
    generatedTargets: ["codex", "claude"],
    canonicalSourceSha256: $sourceTemplateSha256,
    sourceSha256: $sourceSha256,
    packagedBinarySha256: $binarySha256,
    packagedSkillsArchiveSha256: $skillsArchiveSha256,
    v1SourceInstalledParity: true,
    v2BundleReceiptStatusParity: true,
    v2ModelViewParity: true,
    installedRunnerAdapterParity: true,
    legacyAnchorMigration: true,
    rollbackParity: true
  }'
