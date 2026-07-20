#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "사용법: run-auditor.sh <codex|claude> <prompt-file> <report-file> [workspace]" >&2
  exit 64
}

[ "$#" -ge 3 ] && [ "$#" -le 4 ] || usage
provider="$1"
prompt_file="$2"
report_file="$3"
workspace="${4:-$PWD}"

[ -f "$prompt_file" ] || { echo "AUDITOR_INPUT_MISSING: $prompt_file" >&2; exit 66; }
[ -d "$workspace" ] || { echo "AUDITOR_WORKSPACE_MISSING: $workspace" >&2; exit 66; }
case "$provider" in codex|claude) ;; *) usage ;; esac

max_seconds="${GDM_AUDITOR_MAX_SECONDS:-900}"
max_processes="${GDM_AUDITOR_MAX_PROCESSES:-16}"
max_rss_kb="${GDM_AUDITOR_MAX_RSS_KB:-2097152}"
case "$max_seconds:$max_processes:$max_rss_kb" in
  *[!0-9:]*) echo "AUDITOR_LIMIT_INVALID" >&2; exit 64 ;;
esac

tmp_report="$(mktemp "${TMPDIR:-/tmp}/gdm-audit-report.XXXXXX")"
tmp_log="$(mktemp "${TMPDIR:-/tmp}/gdm-audit-log.XXXXXX")"
child=""

descendants() {
  root="$1"
  all="$root"
  frontier="$root"
  while [ -n "$frontier" ]; do
    next=""
    for parent in $frontier; do
      children="$(ps -axo pid=,ppid= | awk -v p="$parent" '$2 == p { print $1 }')"
      [ -n "$children" ] && next="$next $children"
    done
    [ -z "$next" ] && break
    all="$all $next"
    frontier="$next"
  done
  printf '%s\n' $all
}

stop_owned_tree() {
  [ -n "$child" ] || return 0
  owned="$(descendants "$child" 2>/dev/null || true)"
  for pid in $(printf '%s\n' $owned | tail -r 2>/dev/null || printf '%s\n' $owned); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(printf '%s\n' $owned | tail -r 2>/dev/null || printf '%s\n' $owned); do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

cleanup() {
  status=$?
  stop_owned_tree
  rm -f "$tmp_report" "$tmp_log"
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

if [ "$provider" = "codex" ]; then
  command -v codex >/dev/null || { echo "AUDITOR_PROVIDER_MISSING: codex" >&2; exit 69; }
  codex exec --ephemeral --ignore-user-config \
    --disable multi_agent --disable multi_agent_v2 --disable enable_fanout \
    --sandbox read-only --cd "$workspace" --output-last-message "$tmp_report" - \
    <"$prompt_file" >"$tmp_log" 2>&1 &
else
  command -v claude >/dev/null || { echo "AUDITOR_PROVIDER_MISSING: claude" >&2; exit 69; }
  (
    cd "$workspace"
    claude -p --safe-mode --no-session-persistence --permission-mode dontAsk \
      --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
      --tools "Read,Glob,Grep" <"$prompt_file" >"$tmp_report" 2>"$tmp_log"
  ) &
fi
child=$!
started="$(date +%s)"

while kill -0 "$child" 2>/dev/null; do
  now="$(date +%s)"
  if [ $((now - started)) -ge "$max_seconds" ]; then
    echo "AUDITOR_RESOURCE_LIMIT: timeout ${max_seconds}s" >&2
    exit 124
  fi
  owned="$(descendants "$child")"
  process_count="$(printf '%s\n' $owned | wc -l | tr -d ' ')"
  rss_kb=0
  for pid in $owned; do
    rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [ -n "$rss" ] && rss_kb=$((rss_kb + rss))
  done
  if [ "$process_count" -gt "$max_processes" ] || [ "$rss_kb" -gt "$max_rss_kb" ]; then
    echo "AUDITOR_RESOURCE_LIMIT: processes=$process_count rss_kb=$rss_kb" >&2
    exit 70
  fi
  sleep 1
done

set +e
wait "$child"
result=$?
set -e
child=""
[ "$result" -eq 0 ] || {
  sed -n '1,80p' "$tmp_log" >&2
  echo "AUDITOR_FAILED: provider=$provider exit=$result" >&2
  exit "$result"
}
[ -s "$tmp_report" ] || { echo "AUDITOR_EMPTY_REPORT" >&2; exit 65; }
mkdir -p "$(dirname "$report_file")"
mv "$tmp_report" "$report_file"
tmp_report=""
trap - EXIT INT TERM HUP
rm -f "$tmp_log"
