#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  happy|adversarial) ;;
  *)
    echo "usage: $0 <happy|adversarial>" >&2
    exit 2
    ;;
esac

GDM_TEST_BIN="${GDM_TEST_BIN:-$(command -v gdm)}"
if [ ! -x "$GDM_TEST_BIN" ]; then
  echo "installed gdm executable was not found" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

GDM_TEST_TMP_ROOT="${TMPDIR:-/tmp}"
GDM_TEST_TMP="$(mktemp -d "$GDM_TEST_TMP_ROOT/gdm-protocol-live.XXXXXX")"
cleanup() {
  case "$GDM_TEST_TMP" in
    "$GDM_TEST_TMP_ROOT"/gdm-protocol-live.*) rm -rf -- "$GDM_TEST_TMP" ;;
    *) echo "refusing to clean unexpected path: $GDM_TEST_TMP" >&2 ;;
  esac
}
trap cleanup EXIT

git -C "$GDM_TEST_TMP" init -q

run_gdm() {
  (
    cd "$GDM_TEST_TMP"
    "$GDM_TEST_BIN" "$@"
  )
}

run_gdm plan init \
  --slug live-smoke \
  --brief "격리된 로컬 Work Protocol smoke test" \
  --risk low \
  --verification deterministic \
  --require "protocol 상태 전이를 검증한다" \
  --forbid "외부 저장소를 변경한다" >/dev/null
run_gdm plan add \
  --slug live-smoke \
  --desc "격리 fixture 확인" \
  --cmd "test -n protocol" \
  --expect "검증 명령이 성공한다" \
  --kind behavior >/dev/null

SNAPSHOT="$(run_gdm protocol export --slug live-smoke)"
PLAN_FINGERPRINT="$(jq -r '.work.planFingerprint' <<<"$SNAPSHOT")"
STATE_FINGERPRINT="$(jq -r '.work.stateFingerprint' <<<"$SNAPSHOT")"
SOURCE_FINGERPRINT="$(jq -r '.work.sourceFingerprint.sha256' <<<"$SNAPSHOT")"

jq -e '
  .schemaVersion == "gdm-work-snapshot/v1" and
  .work.slug == "live-smoke" and
  .work.phase == "executing" and
  .completion.state == "blocked"
' <<<"$SNAPSHOT" >/dev/null

HANDOFF="$(run_gdm protocol handoff \
  --slug live-smoke \
  --handoff-id smoke-handoff-v1 \
  --from-role producer \
  --to-role receiver \
  --from-provider codex \
  --to-provider codex \
  --intent "격리된 작업 상태를 검증한다" \
  --expected-plan-fingerprint "$PLAN_FINGERPRINT" \
  --expected-state-fingerprint "$STATE_FINGERPRINT" \
  --expected-source-fingerprint "$SOURCE_FINGERPRINT")"
jq -e '
  .schemaVersion == "gdm-handoff/v1" and
  .handoffId == "smoke-handoff-v1" and
  .revision == 1
' <<<"$HANDOFF" >/dev/null

if [ "$MODE" = "happy" ]; then
  AFTER_HANDOFF="$(run_gdm protocol export --slug live-smoke)"
  jq -e '
    .latestHandoff.handoffId == "smoke-handoff-v1" and
    .latestHandoff.stale == false and
    (.latestHandoff.staleReasons | length) == 0
  ' <<<"$AFTER_HANDOFF" >/dev/null

  if PREMATURE_DONE="$(run_gdm "done" --slug live-smoke 2>&1)"; then
    echo "handoff unexpectedly granted completion authority" >&2
    exit 1
  fi
  case "$PREMATURE_DONE" in
    *"오류(unproven)"*) ;;
    *)
      echo "premature done failed for an unexpected reason" >&2
      echo "$PREMATURE_DONE" >&2
      exit 1
      ;;
  esac

  run_gdm pass c1 --slug live-smoke >/dev/null
  run_gdm "done" --slug live-smoke >/dev/null
  COMPLETED="$(run_gdm protocol export --slug live-smoke)"
  jq -e '
    .work.phase == "completed" and
    .completion.state == "completed" and
    .completion.validationCommand == null and
    ([.checks[].status] == ["proven"])
  ' <<<"$COMPLETED" >/dev/null

  jq -n '{mode: "happy", schemaVersion: "gdm-work-snapshot/v1", handoffFresh: true, prematureDoneRejected: true, completedAfterEvidence: true}'
  exit 0
fi

touch "$GDM_TEST_TMP/source-only-change.txt"
SOURCE_ONLY_STALE="$(run_gdm protocol export --slug live-smoke)"
jq -e '
  .latestHandoff.handoffId == "smoke-handoff-v1" and
  .latestHandoff.stale == true and
  .latestHandoff.staleReasons == ["source_changed"]
' <<<"$SOURCE_ONLY_STALE" >/dev/null
CURRENT_SOURCE_FINGERPRINT="$(jq -r '.work.sourceFingerprint.sha256' <<<"$SOURCE_ONLY_STALE")"

if SOURCE_ONLY_WRITE="$(run_gdm protocol handoff \
  --slug live-smoke \
  --handoff-id source-stale-write-v1 \
  --from-role producer \
  --to-role receiver \
  --intent "오래된 source 상태로 인계한다" \
  --expected-source-fingerprint "$SOURCE_FINGERPRINT" 2>&1)"; then
  echo "stale expected-source fingerprint was accepted" >&2
  exit 1
fi
case "$SOURCE_ONLY_WRITE" in
  *source_fingerprint_mismatch*) ;;
  *)
    echo "source-only stale write failed for an unexpected reason" >&2
    echo "$SOURCE_ONLY_WRITE" >&2
    exit 1
    ;;
esac

run_gdm protocol handoff \
  --slug live-smoke \
  --handoff-id source-baseline-v2 \
  --from-role producer \
  --to-role receiver \
  --intent "변경된 source 기준으로 상태 인계를 갱신한다" \
  --expected-plan-fingerprint "$PLAN_FINGERPRINT" \
  --expected-state-fingerprint "$STATE_FINGERPRINT" \
  --expected-source-fingerprint "$CURRENT_SOURCE_FINGERPRINT" >/dev/null

run_gdm pass c1 --slug live-smoke >/dev/null
STALE="$(run_gdm protocol export --slug live-smoke)"
jq -e '
  .latestHandoff.handoffId == "source-baseline-v2" and
  .latestHandoff.stale == true and
  .latestHandoff.staleReasons == ["state_changed"]
' <<<"$STALE" >/dev/null

if STALE_WRITE="$(run_gdm protocol handoff \
  --slug live-smoke \
  --handoff-id stale-write-v1 \
  --from-role producer \
  --to-role receiver \
  --intent "오래된 상태로 인계한다" \
  --expected-state-fingerprint "$STATE_FINGERPRINT" 2>&1)"; then
  echo "stale expected-state fingerprint was accepted" >&2
  exit 1
fi
case "$STALE_WRITE" in
  *state_fingerprint_mismatch*) ;;
  *)
    echo "stale write failed for an unexpected reason" >&2
    echo "$STALE_WRITE" >&2
    exit 1
    ;;
esac

if PRIVATE_WRITE="$(run_gdm protocol handoff \
  --slug live-smoke \
  --handoff-id private-write-v1 \
  --from-role producer \
  --to-role receiver \
  --intent "Bearer definitely-secret-value" 2>&1)"; then
  echo "credential-like handoff intent was accepted" >&2
  exit 1
fi
case "$PRIVATE_WRITE" in
  *privacy_rejected*) ;;
  *)
    echo "private handoff failed for an unexpected reason" >&2
    echo "$PRIVATE_WRITE" >&2
    exit 1
    ;;
esac

if ESCAPING_ARTIFACT="$(run_gdm protocol handoff \
  --slug live-smoke \
  --handoff-id escaping-artifact-v1 \
  --from-role producer \
  --to-role receiver \
  --intent "저장소 밖 artifact를 거부한다" \
  --artifact ../escape.md 2>&1)"; then
  echo "repository-escaping artifact was accepted" >&2
  exit 1
fi
case "$ESCAPING_ARTIFACT" in
  *path_rejected*|*privacy_rejected*) ;;
  *)
    echo "escaping artifact failed for an unexpected reason" >&2
    echo "$ESCAPING_ARTIFACT" >&2
    exit 1
    ;;
esac

AFTER_REJECTIONS="$(run_gdm protocol export --slug live-smoke)"
jq -e '.latestHandoff.handoffId == "source-baseline-v2"' <<<"$AFTER_REJECTIONS" >/dev/null

jq -n '{mode: "adversarial", sourceOnlyStaleDetected: true, sourceOnlyWriteRejected: true, stateStaleDetected: true, staleWriteRejected: true, credentialRejected: true, escapingArtifactRejected: true, journalUnchangedByRejections: true}'
