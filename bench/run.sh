#!/usr/bin/env bash
# 하네스 벤치 러너: run.sh <t1|t2|t3> <bare|gdm|gdm-graph|omx|lazycodex|workbook>
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <t1|t2|t3> <bare|gdm|gdm-graph|omx|lazycodex|workbook>" >&2
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
  bare|gdm|gdm-graph|omx|lazycodex|workbook) ;;
  *) echo "bad arm: $ARM" >&2; exit 2 ;;
esac

# Prevent a caller's environment from accidentally enabling graph navigation
# in a control arm. The experiment arm alone receives the absolute executable.
unset GDM_GRAPH_PROVIDER
if [ "$ARM" = gdm-graph ]; then
  REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
  GRAPH_PROVIDER="$REPO_ROOT/cli/src/graph-nav-provider.ts"
  case $GRAPH_PROVIDER in
    /*) ;;
    *) echo "graph provider path is not absolute: $GRAPH_PROVIDER" >&2; exit 2 ;;
  esac
  [ -f "$GRAPH_PROVIDER" ] && [ -x "$GRAPH_PROVIDER" ] || {
    echo "graph provider is not an executable file: $GRAPH_PROVIDER" >&2
    exit 2
  }
  export GDM_GRAPH_PROVIDER="$GRAPH_PROVIDER"
fi

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
    gdm-graph)
      echo "# 작업 방식: 아래 스킬 지침을 그대로 따르라 (gdm CLI는 PATH에 있다)"
      echo
      cat "$HOME/projects/gdm/skills/go/SKILL.md"
      echo
      echo "# 추가 실험 지침: 선택형 code graph navigation"
      echo "- 이 arm은 graph 탐색의 호출 비용과 회귀를 재는 시뮬레이션이다. 실제 gdm-plan/analyze/review 라우팅 통합으로 간주하지 마라."
      echo "- 구체적인 TS/TSX/JS/JSX entry가 있고 관계 조회가 직접 읽을 파일을 좁힐 때만, 작업 전체에서 최대 2회·maxDepth 2 이하로 query하라."
      echo "- provider는 인자 없는 절대 실행 파일이다. shell timeout wrapper나 command-string 분해 없이 \"\$GDM_GRAPH_PROVIDER\" query를 직접 실행하고 caller 쪽에서 10초로 제한하라."
      echo "- stdin은 gdm-graph-query/v1 JSON 하나다. root는 현재 Git top-level 절대경로, entry는 안전한 저장소 상대경로, direction은 dependencies 또는 dependents, maxDepth는 필요한 최소값(최대 2)으로 보내라."
      echo "- 결과는 탐색 후보일 뿐이다. 반환 파일을 직접 읽고 테스트를 실행하라. evidence, allowedPaths 확장, pass/done/audit 판정에 사용하지 마라."
      echo "- provider 부재·실행 실패·timeout·malformed/schema mismatch·partial·stale·unsupported 응답은 전체를 폐기하고 기존 rg와 직접 source read로 폴백하라. 빈 edge도 영향 없음의 증거가 아니다."
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
