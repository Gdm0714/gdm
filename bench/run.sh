#!/usr/bin/env bash
# 하네스 벤치 러너: run.sh <t1|t2|t3> <bare|gdm|omx|lazycodex|workbook>
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <t1|t2|t3> <bare|gdm|omx|lazycodex|workbook>" >&2
  exit 2
fi
TASK=$1; ARM=$2
BENCH="$HOME/projects/harness-bench"
HIDDEN="$HOME/projects/harness-bench-hidden"
RUNS="$HOME/projects/harness-bench-runs"

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

RUN="$TASK-$ARM"; DIR="$RUNS/$RUN"
mkdir -p "$RUNS/logs"
if [ -d "$DIR" ]; then
  if ! git -C "$BENCH" worktree remove --force "$DIR" 2>/dev/null; then
    [ ! -L "$DIR" ] || { echo "refusing symlink run directory: $DIR" >&2; exit 2; }
    mkdir -p "$RUNS/stale"
    stale="$RUNS/stale/$RUN.$(date +%Y%m%d%H%M%S)"
    [ ! -e "$stale" ] || { echo "stale destination exists: $stale" >&2; exit 2; }
    mv "$DIR" "$stale"
    echo "moved unregistered run directory to $stale"
  fi
fi
git -C "$BENCH" worktree add --detach "$DIR" "$BRANCH" >/dev/null

PROMPT_FILE="$RUNS/logs/$RUN.prompt.md"
{
  echo "# 작업 브리프"
  cat "$HIDDEN/briefs/$TASK.md"
  echo
  case $ARM in
    bare) ;;
    gdm)
      echo "# 작업 방식: 아래 스킬 지침을 그대로 따르라 (gdm CLI는 PATH에 있다)"
      echo
      cat "$HOME/projects/gdm/skills/go/SKILL.md"
      ;;
    omx)
      echo "# 작업 방식: 아래 스킬 지침을 그대로 따르라"
      echo
      cat "$HOME/.codex/skills/ralph/SKILL.md"
      ;;
    lazycodex)
      echo "# 작업 방식: 이 작업을 ulw 모드로 수행하라."
      ;;
    workbook)
      echo "# 작업 방식: 이 프로젝트에 설치된 workbook 워크플로우로 이 작업을 완료하라."
      ;;
  esac
  echo
  echo "# 실행 규칙 (공통)"
  echo "- 비대화형 실행이다. 사용자 확인이나 승인 단계가 나오면 스스로 결정하고 그 사실을 기록하라."
  echo "- 이 저장소 밖의 파일은 수정하지 마라."
  echo "- 완료하면 마지막 줄에 'HARNESS_DONE: <한 줄 요약>'을 출력하라."
} > "$PROMPT_FILE"

if [ "$ARM" = workbook ]; then
  workbook install "$DIR" > "$RUNS/logs/$RUN.install.log" 2>&1 \
    || echo "workbook install 실패 (exit $?)" >> "$RUNS/logs/$RUN.install.log"
fi

START=$(date +%s)
codex exec -C "$DIR" -s workspace-write --skip-git-repo-check \
  -o "$RUNS/logs/$RUN.last.md" - < "$PROMPT_FILE" > "$RUNS/logs/$RUN.log" 2>&1 \
  || echo "EXIT_NONZERO" >> "$RUNS/logs/$RUN.log"
END=$(date +%s)
echo "$RUN,$((END - START))" >> "$RUNS/logs/timings.csv"
echo "done $RUN in $((END - START))s"
