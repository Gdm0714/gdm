#!/usr/bin/env bash
# Opus 눈가림 쌍대 품질 심판: graph-quality-judge.sh <t1|t2|t3>
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo "usage: $0 <t1|t2|t3>" >&2
  exit 2
fi
TASK=$1
HIDDEN="$HOME/projects/harness-bench-hidden"
RUNS="$HOME/projects/harness-bench-runs"

case $TASK in
  t1) BRANCH=t1-bugs ;;
  t2) BRANCH=t2-feature ;;
  t3) BRANCH=t3-hardening ;;
  *) echo "bad task: $TASK" >&2; exit 2 ;;
esac

ARMS=(gdm gdm-graph)
if ((RANDOM % 2)); then
  ORDER=(gdm gdm-graph)
else
  ORDER=(gdm-graph gdm)
fi
BUNDLE="$RUNS/logs/$TASK.graph-judge-input.md"
MAP="$RUNS/logs/$TASK.graph-judge-map.txt"

for arm in "${ARMS[@]}"; do
  [ -d "$RUNS/$TASK-$arm" ] || {
    echo "$TASK-$arm: 런 디렉토리 없음" >&2
    exit 2
  }
done
: > "$MAP"

{
  echo "너는 눈가림 코드 심판이다. 같은 브리프를 받은 익명 구현 2개의 diff를 비교 평가하라."
  echo "평가 관점: (1) 정확성 위험 — 명세 위반이나 경계 누락 가능성 (2) 범위 밖 변경 —"
  echo "요청하지 않은 파일·기능·리팩토링 (3) 과잉 구현 — 불필요한 추상화·방어 코드·주석"
  echo "(4) 코드 품질 — 기존 스타일과의 일관성. 후보의 생성 방식은 추측하지 마라."
  echo "출력은 JSON 하나만 (다른 텍스트 금지):"
  echo '{"ranking":["최고 후보부터 R표기"],"scores":{"R1":0,"R2":0},"notes":{"R1":"한 줄","R2":"한 줄"}}'
  echo
  echo "# 브리프"
  cat "$HIDDEN/briefs/$TASK.md"
  i=1
  for arm in "${ORDER[@]}"; do
    echo "R$i=$arm" >> "$MAP"
    echo
    echo "## 후보 R$i"
    echo '```diff'
    git -C "$RUNS/$TASK-$arm" diff "$BRANCH" -- src test | sed -n '1,400p'
    echo '```'
    i=$((i + 1))
  done
} > "$BUNDLE"

claude -p --model opus < "$BUNDLE" > "$RUNS/logs/$TASK.graph-judge-out.json" 2> "$RUNS/logs/$TASK.graph-judge-err.log"
echo "judged $TASK gdm vs gdm-graph (입력 $(wc -l < "$BUNDLE" | tr -d ' ')줄) → logs/$TASK.graph-judge-out.json"
