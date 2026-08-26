#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo 'usage: idle-performance-smoke.sh <Gidem executable>' >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXECUTABLE="$1"

[[ -x "$EXECUTABLE" ]]

"$EXECUTABLE" \
  --repo "$NATIVE_DIR/.." \
  --demo \
  --demo-state agent-operations-popover \
  --reduce-motion \
  --width 1440 \
  --height 900 \
  >/dev/null 2>&1 &
APP_PID=$!

cleanup() {
  if /bin/kill -0 "$APP_PID" 2>/dev/null; then
    /bin/kill -TERM "$APP_PID" 2>/dev/null || true
  fi
  wait "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Exclude launch and first-render work. The gate measures the settled Agent
# Operations surface where runaway animation or render loops would remain hot.
/bin/sleep 2.5

SAMPLES=''
for _ in 1 2 3 4 5 6 7 8; do
  /bin/kill -0 "$APP_PID"
  SAMPLE="$(/bin/ps -p "$APP_PID" -o %cpu=,rss= | /usr/bin/xargs)"
  [[ -n "$SAMPLE" ]]
  SAMPLES+="$SAMPLE"$'\n'
  /bin/sleep 0.25
done

read -r AVERAGE_CPU MAX_CPU MAX_RSS <<< "$(
  /usr/bin/printf '%s' "$SAMPLES" | /usr/bin/awk '
    NF == 2 {
      count += 1
      sum += $1
      if ($1 > max_cpu) max_cpu = $1
      if ($2 > max_rss) max_rss = $2
    }
    END {
      if (count != 8) exit 1
      printf "%.2f %.2f %d", sum / count, max_cpu, max_rss
    }
  '
)"

/usr/bin/awk -v value="$AVERAGE_CPU" 'BEGIN { exit !(value <= 10.0) }'
/usr/bin/awk -v value="$MAX_CPU" 'BEGIN { exit !(value <= 25.0) }'
(( MAX_RSS <= 524288 ))

printf 'Idle performance smoke passed: samples=8 averageCPU=%s%% maxCPU=%s%% maxRSS=%sKB\n' \
  "$AVERAGE_CPU" "$MAX_CPU" "$MAX_RSS"
