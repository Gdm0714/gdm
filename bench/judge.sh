#!/usr/bin/env bash
# 하네스 벤치 채점: judge.sh <t1|t2|t3> <arm>  → results.csv에 한 줄 추가
set -uo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <t1|t2|t3> <bare|gdm|omx|lazycodex|workbook>" >&2
  exit 2
fi
TASK=$1; ARM=$2
BENCH="$HOME/projects/harness-bench"
HIDDEN="$HOME/projects/harness-bench-hidden"
RUNS="$HOME/projects/harness-bench-runs"
RUN="$TASK-$ARM"; DIR="$RUNS/$RUN"; LOGS="$RUNS/logs"

case $TASK in
  t1) BRANCH=t1-bugs ;;
  t2) BRANCH=t2-feature ;;
  t3) BRANCH=t3-hardening ;;
  *) echo "bad task: $TASK" >&2; exit 2 ;;
esac
case $ARM in
  bare|gdm|omx|lazycodex|workbook) ;;
  *) echo "bad arm: $ARM" >&2; exit 2 ;;
esac

[ -d "$DIR" ] || { echo "$RUN: 런 디렉토리 없음" >&2; exit 2; }
mkdir -p "$LOGS"

# 1) 히든 수용 테스트
[ ! -e "$DIR/hidden.test.ts" ] || {
  echo "$RUN: 기존 hidden.test.ts가 있어 덮어쓰지 않습니다" >&2
  exit 2
}
cleanup() { rm -f "$DIR/hidden.test.ts"; }
trap cleanup EXIT INT TERM
cp "$HIDDEN/$TASK.hidden.test.ts" "$DIR/hidden.test.ts"
HIDDEN_OUT=$(cd "$DIR" && bun test hidden 2>&1 | tail -20)
HP=$(echo "$HIDDEN_OUT" | grep -Eo '[0-9]+ pass' | grep -Eo '[0-9]+' | head -1); HP=${HP:-0}
HF=$(echo "$HIDDEN_OUT" | grep -Eo '[0-9]+ fail' | grep -Eo '[0-9]+' | head -1); HF=${HF:-0}
echo "$HIDDEN_OUT" > "$LOGS/$RUN.hidden.txt"
cleanup
trap - EXIT INT TERM

# 2) 가시 테스트 (회귀)
VIS_OUT=$(cd "$DIR" && bun test test/ 2>&1 | tail -20)
VP=$(echo "$VIS_OUT" | grep -Eo '[0-9]+ pass' | grep -Eo '[0-9]+' | head -1); VP=${VP:-0}
VF=$(echo "$VIS_OUT" | grep -Eo '[0-9]+ fail' | grep -Eo '[0-9]+' | head -1); VF=${VF:-0}

# 3) diff (커밋 여부 무관하게 브랜치 기준)
git -C "$DIR" add -A -N 2>/dev/null
git -C "$DIR" diff "$BRANCH" -- ':!node_modules' ':!bun.lock*' > "$LOGS/$RUN.diff" 2>/dev/null
DIFF_LINES=$(wc -l < "$LOGS/$RUN.diff" | tr -d ' ')

# 4) 완료 마커·토큰·시간
DONE_MARK=$(grep -c 'HARNESS_DONE' "$LOGS/$RUN.last.md" 2>/dev/null || echo 0)
TOKENS=$(grep -A1 -i 'tokens used' "$LOGS/$RUN.log" 2>/dev/null | grep -Eo '[0-9][0-9,]*' | tail -1 | tr -d ',')
SECS=$(grep "^$RUN," "$LOGS/timings.csv" 2>/dev/null | tail -1 | cut -d, -f2)

[ -f "$RUNS/results.csv" ] || echo "run,hidden_pass,hidden_fail,visible_pass,visible_fail,done_marker,tokens,seconds,diff_lines" > "$RUNS/results.csv"
sed -i '' "/^$RUN,/d" "$RUNS/results.csv" 2>/dev/null
echo "$RUN,$HP,$HF,$VP,$VF,$DONE_MARK,${TOKENS:-},${SECS:-},$DIFF_LINES" >> "$RUNS/results.csv"
echo "$RUN → hidden $HP/$((HP + HF)) pass, visible $VP/$((VP + VF)) pass, done=$DONE_MARK, ${SECS:-?}s, tokens=${TOKENS:-?}"
