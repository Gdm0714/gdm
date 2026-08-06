---
name: gdm-full
description: |
  gdm 하네스의 중량 실행 루프. gdm-go의 검증 항목 흐름에 독립 검수(fresh-context
  검수자의 통과/반려 판정)와 전달 승인 검사를 더한다. 승인된 경우에만 gdm-pr로 넘긴다.
  사용자가 "$gdm-full", "gdm full", "제대로/검수까지 해줘"라고 하거나, 배포·머지
  수준의 완성도가 필요한 작업을 맡길 때 사용한다.
---

# gdm:full — 검수 포함 중량 실행 루프

## 역할

배포 수준 작업의 **루트 조율자**. 한 작업의 실제 구현 모델을 하나로 기록하되, 그 모델의
여러 구현 에이전트가 겹치지 않는 파일·모듈을 나눠 맡길 수 있다. 루트 조율자가 산출물과
gdm 게이트를 통합하며, **실제 구현 모델과 다른 모델**의 새 컨텍스트 검수자가 통과 판정을
내린 상태로만 작업을 끝낸다. 라우팅 계약: `skills/_shared/routing.md`.

## 제약

- gdm-go의 모든 제약이 그대로 적용된다 (상태는 CLI로만, done 전 완료 보고 금지,
  기준 몰래 완화 금지).
- CRITICAL: 한 작업의 **실제 구현 모델은 하나**이며 실제 구현 모델과 검수 모델은 달라야 한다.
  같은 구현 모델의 에이전트는 여러 명이어도 된다. 역할 이름이나 조율자 정체성이 아니라
  실제 diff를 만든 주체를 기준으로 기록한다.
- IMPORTANT: 구현·탐색·로그 분석·테스트 실행은 독립 경계, 필요한 전문성·fresh context,
  주 컨텍스트의 노이즈를 기준으로 위임한다. 여러 구현 워커에는 겹치지 않는 파일·모듈
  소유권과 종료 조건을 주고 루트 조율자가 통합한다. 조율자가 제품 파일을 직접 고치면
  조율자도 기록된 동일 구현 모델이어야 한다.
- IMPORTANT: 일반 역할은 새로 발견한 독립 경계를 하위 역할에 맡길 수 있다. 같은 네이티브
  Codex 루트 세션에서 조율자를 제외한 모든 세대의 활성 spawned agent를 합쳐 동시에 최대
  4명이며 자식이 만든 자식도 같은 세션 상한에 포함된다. 같은 전체 범위를 다시 넘기는
  자기복제형 재위임과 끝이 정해지지 않은 팬아웃만 금지한다.
- IMPORTANT: 모든 spawn 메시지 첫 줄에 `GDM_AGENT_ENVELOPE_V1=` 단일행 JSON과 역할·scope·
  ownership·산출물·검증·종료 조건·`blockedBy`를 넣는다. 위임 lease는
  `INITIAL_SPAWN_ATTEMPT_BUDGET: 16`, `SPAWN_ATTEMPT_EXTENSION: 4`,
  `MAX_TOTAL_SPAWNS_PER_ROOT: 32`, `DEFAULT_CHILD_QUOTA: 1`, `MAX_CHILD_QUOTA: 2`,
  `MAX_AGENT_DEPTH: 3`이다. 일반 역할의 기본 quota는 1이며 일괄 leaf로 만들지 않는다.
  허용된 시도는 누적 예산을 소비하고 실패·취소된 spawn도 예산을 돌려주지 않는다. 초기 16을
  다 쓰면 pending/running 역할이 하나도 없을 때만 다음 spawn에서 4개 예산을 자동으로 열며,
  활성 역할이 남은 동안에는 확장하지 않는다. timeout은
  대기 호출의 종료일 뿐 workflow 결과 확정이 아니다. structured 역할의 scope와
  ownership resource는 cwd 기준 `.`·`..`·상대/절대 별칭을 정규화한다. 활성 역할과 같은
  canonical scope 또는 겹치는 write resource는 거부하지만, 이는 선언 guardrail이며
  symlink·대소문자까지 잠그는 운영체제 파일 lock은 아니다.
  `SubagentStop`은 child turn의 stop 관찰이자 sequencing hint일 뿐 영구 thread 종료나 성공
  증명이 아니다. 다른 Stop handler가 continuation을 요청할 수 있고, idle thread는
  `followup_task`로 재사용될 수 있으며, interrupt는 Stop 관찰을 남기지 않을 수 있다. 원장에서
  해당 identity에 연결된 `stopped` 관찰은 active/ownership lease를 협력적으로 해제하고
  `blockedBy`를 열 수 있지만 hard runtime proof가 아니다. 루트 조율자는 deliverable/verify와
  실제 작업 겹침 부재를 확인해야 한다. `failed|expired`는 active/ownership lease에서는
  빠져도 `blockedBy`를 만족하지 않으며, 30분 lease expiry도 완료가 아니다. 의존 단계와 최종 응답은 산출물 결과를
  `completed|failed|cancelled|inconclusive` 중 하나로 별도 판정한다. 이 workflow 결과는
  lifecycle 관찰과 분리한다.
- IMPORTANT: 훅이 실행되는 하나의 네이티브 Codex 루트 세션 트리에서 절대 누적 32는 하드
  상한이고, 동시 4는 현재 세션의 유효 Codex 설정이 4일 때 네이티브 하드 상한이다. 하위
  hook caller agent id가 structured 부모와 일대일로 결속될 때 부모별
  quota/depth/canDelegate를 기계적으로 검사한다. caller id가 없는 호환 런타임은 원장에
  선언한 부모가 있을 때만 nonterminal/quota/depth/canDelegate를 검사하는 degraded
  fallback을 쓰며, 이를 부모 신원 하드 경계라고 주장하지 않는다. `multi_agent_v2` spawn
  응답에는 agent id가 없으므로 unresolved V2가 포함된 identity-ambiguous 구간만 직렬화한다.
  unresolved V1끼리는 병렬 가능하고, identity가 연결된 뒤 active agent 실행도 병렬 가능하다.
  same-axis 후속 작업으로 idle thread를 재사용할 수 있지만 훅은 이전 ownership/delegation을
  기계적으로 갱신하지 못한다. 루트 조율자는 실제 작업 겹침을 피하고 새 bounded delegation이
  필요하면 새 lease를 선언해 생성한다. 비대화형 CLI·별도 세션을 합친 논리 작업 전체의 동시
  4·초기 16·4개 자동 확장·절대 누적 32는 협력적 운영 규칙이다.

아래 한 줄은 형식 예시일 뿐이다. 복사하기 전에 `taskId`, `parentId`, `role`, `scope`,
`ownership.mode/resources`, `deliverable`, `verify`, `stopWhen`, `canDelegate`,
`childQuota`(quota), `depth`, `blockedBy` 값을 작업에 맞게 모두 바꾼다.

```text
GDM_AGENT_ENVELOPE_V1={"taskId":"example-task","parentId":"root","role":"bounded-worker","scope":"docs/example","ownership":{"mode":"read","resources":["docs/example.md"]},"deliverable":"Evidence-backed result","verify":"Confirm cited file and result","stopWhen":"Deliverable and verification are complete","canDelegate":false,"childQuota":0,"depth":1,"blockedBy":[]}
```

- NEVER: 검수보고(audit-report.md)를 직접 작성하지 않는다. 검수보고는 제한 실행기로 띄운
  외부 leaf 검수자만 작성한다 — 실행자가 쓰면 자기 채점이다.
- NEVER: 검수자에게 작업 요약을 대신 판단 근거로 주지 않는다. 검수자는 브리핑
  원문과 diff, 증거 파일 경로를 받아 직접 확인한다.
- CRITICAL: 검수 pass당 검수자는 정확히 1명이다. `MAX_AUDITORS_PER_PASS: 1`,
  `AUDITOR_MAX_AGENT_DEPTH: 0`, `AUDITOR_MAX_CHILD_AGENTS: 0`이다. 검수자를
  collaboration 서브에이전트로 스폰하지 않고 `gdm-agents/run-auditor.sh`로만 실행한다.
- NEVER: 검수 실패나 지연을 이유로 추가 검수자를 병렬 실행하지 않는다. 실행기가 자원 한도로
  중단되면 `AUDITOR_RESOURCE_LIMIT`을 보고하고 해당 pass를 중단한다.
- NEVER: 프로세스 이름으로 Node, Gradle, Vite, Codex, Claude를 일괄 종료하지 않는다.
  실행기가 기록한 단일 검수 루트 PID와 그 하위 트리만 실행기가 회수한다.
- NEVER: 반려 사유를 무시하고 verdict --pass를 기록하지 않는다.
- NEVER: `gdm plan contract --check-commit --slug <슬러그>`가 exit 0이 아니면 stage,
  commit, push, PR을 하지 않는다. `done`이나 audit pass는 전달 승인이 아니다.
- IMPORTANT: 커밋 메시지에 AI 관련 표기를 넣지 않는다 (사용자 커밋 규칙).

## 도구

gdm-go의 도구 전부 + 검수:

| 명령 | 용도 |
|---|---|
| `gdm plan init --audit --require <보존> --forbid <금지> --risk <low\|medium\|high> --verification <deterministic\|inspectable\|opaque> [preflight·scope 플래그] [--simplify]` | preflight 계약·baseline과 함께 검수 필수 작업 시작 |
| `gdm audit brief` | 검수자에게 줄 브리핑 패키지 출력 |
| `gdm audit verdict (--pass\|--fail) --report <파일> --implementation-model <모델> --audit-model <모델>` | 검수자 판정과 독립성·보고서·워크트리 지문 기록 |
| `gdm-agents/run-auditor.sh <codex\|claude> <prompt> <report> [workspace]` | 에이전트·MCP를 차단하고 단일 검수 PID 트리를 자원 한도 안에서 실행 |

## 프로세스

1. 새 기술 설계 판단이 있으면 `gdm-plan`으로 Claude CLI 설계안을 먼저 받고 Codex가 실제
   코드 근거를 검증한 최종 계획을 brief로 쓴다. 0→1·전면 리디자인·개방형 시각 변경은
   `gdm-design`으로 Claude Design용 프롬프트를 사용자에게 전달하고, 사용자가
   claude.ai/design에서 생성 완료를 확인한 뒤 DesignSync로 pull한다. Chrome 제어로 생성을
   대신하지 않는다. 국소 버그·기계적 리팩터·구체적 UI 결함은 호출을 생략한다.
   `HTTP 429`, `rate_limit`, `quota exceeded`, 사용량 한도일 때만
   `codex-fallback`을 기록하고 Codex가 대신하며, 인증·권한·도구·프로젝트 문제나 timeout은
   대체하지 않는다. Claude의 설계·시각 산출물은 구현 모델이 아니며 로컬 제품 코드는 기록된
   Codex 구현 모델만 작성한다.
2. 구현 전 가정·불확실성·허용/금지 경로·중단 조건·risk·verification을 분류하고
   `gdm plan init --slug <슬러그> --brief "<요약>" --audit --require "<보존 조건>"
   --forbid "자동 커밋" ...`에 모두 기록한다. 소스·설정 동작 변경은 `--simplify`를 붙인다.
   high risk는 `--audit`을 생략해도 CLI가 독립 검수를 요구하지만 full은 의도를 드러내기 위해
   명시한다. init 기준선 전에 있던 로컬 변경은 보존 대상이며 이후 delta만 범위 판정한다.
3. check 설계: gdm-go의 `regression|behavior|edge|static|manual` 분류에
   **adversarial 항목을 추가**한다 — 악의적/경계 입력에서 무너지지 않는지 검증하는 check 1개 이상.
   regression은 구현 전에 `gdm pass <id> --red`로 동일 명령의 non-zero 실패를 기록한다.
   `--simplify` 작업에는 라인 수가 아니라 dead code·중복·불필요한 추상화를 겨냥한 proven
   static check가 필요하다. high+opaque이면 실제 도메인 reviewer가 확인할
   `--manual --expert` check를 추가하고 pass에 `--reviewer`와 `--note`를 기록한다.
   실행 모델은 reviewer를 자칭하거나 전문가 판단 근거를 대신 작성하지 않는다.
   인터랙티브 표면(HTTP·CLI·화면)이 있는 작업이면 그 표면을 **실제로 구동한
   증거** check도 1개 이상 둔다 (curl 응답, 실행 기록, 스크린샷) — 코드 검증은
   표면 구동을 대신하지 못한다.
   등록 후 목록을 사용자에게 보여주고, 중량 작업이므로 이견 없는지 확인한다.
4. 구현 시작 전에 실제 구현 모델 하나를 지정한다. 검수 입력의 첫 필드에
   `implementationModel: <실제 모델>`을 기록하고 작업 기록에도 남긴다. 구현은 독립 경계와
   컨텍스트 이득에 따라 조율자가 맡거나, 같은 실제 구현 모델의 여러 워커에게 겹치지 않는
   파일·모듈을 배정한다. 루트 조율자는 산출물을 통합하고, 제품 파일 충돌을 직접 고치면
   기록된 실제 구현 모델과 동일해야 한다. 조율자는 gdm-go와 동일한 pass 게이트를 소유하고
   (위임 산출물도 문장이 아니라 증거로만 판정한다), 전 항목 통과 후 `gdm recheck`로 회귀를
   확인한다.
5. 검수:
   a. `gdm audit brief` 출력과 `git diff`를 준비한다. brief에는 preflight·경로 계약,
      red→green·static·expert 증거가 포함되어야 한다.
   b. **실제 구현 모델과 다른 모델의 검수자 정확히 1명을 새 컨텍스트로 실행한다.** 프롬프트는
      검수자 프롬프트(`auditor.md`) 전문 + 브리핑 + diff이며 현재 대화 요약은 주지
      않는다. `auditor.md`는 설치 시 스킬 옆 `gdm-agents/`에 배치된다(소스:
      저장소 `agents/auditor.md`). 실행은 반드시 같은 디렉토리의 `run-auditor.sh`를
      사용한다. 이 실행기는 Codex multi-agent와 사용자 MCP를 끄고, Claude에는 읽기 전용
      도구만 허용하며, 시간·프로세스 수·RSS 한도를 넘으면 자신이 시작한 트리만 종료한다.
      다른 모델을 사용할 수 없으면 임의로 같은 모델 검수로 낮추지 말고 사용자에게
      차단 상태를 보고한다.
   c. 검수자가 보고서에 `implementationModel`과 `auditModel`을 기록하고
      `.gdm/<슬러그>/audit-report.md`를 저장한 뒤 통과/반려를 반환한다.
   d. `gdm audit verdict --pass|--fail --report .gdm/<슬러그>/audit-report.md
      --implementation-model <실제 구현 모델> --audit-model <검수 모델>`.
      CLI는 보고서 해시와 현재 Git 워크트리의 실제 파일 내용 지문을 함께 묶는다. 이후 코드나
      보고서가 바뀌면 검수가 무효가 되고, 같은 내용을 커밋해 HEAD만 바뀐 경우에는 유지된다.
      Git 지문이 유효한 경우 `done`은 같은 검증 명령을 다시 실행하지 않는다.
6. 반려면: 반려 사유를 check로 반영(`gdm plan add`/`edit --reason`)하고 4로.
   (check가 바뀌면 기존 검수는 자동 무효 — 재검수가 필요해진다. 정상 동작이다.)
7. 통과면 `gdm done` 뒤 gdm-go의 단일 habit feedback checkpoint를 수행한다.
8. 전달은 별도 gate다. `gdm plan contract --check-commit --slug <슬러그>`를 실행한다.
   - exit 4(기본값 커밋 금지)이고 사용자가 전달을 **명시적으로 승인하지 않았으면**:
     검증 결과만 보고하고 멈춘다. `done`이나 이 스킬 호출은 승인이 아니다.
   - 사용자가 전달을 명시적으로 승인했으면: `gdm plan contract --slug <슬러그>
     --commit explicitly-approved --reason "<승인 근거>"`로 승인을 기록한 뒤
     `--check-commit`를 재실행한다. exit 0이 되면 gdm-pr로 넘긴다.
   - 검수보고는 위키 자산이다 — 사용자가 원하면 wiki-ingest로 넘긴다.

## 엣지 케이스

- 실제 구현 모델과 다른 검수자를 실행할 수 없으면 `INDEPENDENCE_BLOCKED`를 보고하고
  full의 검수 통과·done·전달을 중단한다. 같은 모델 검수나 사용자 동의로 full 게이트를
  낮추지 않는다. 사용자가 경량 루프로 범위를 다시 정하면 별도 gdm-go 작업으로 시작한다.
- 재검수가 2회 이상 반복되면: 반려 사유들을 정리해 사용자에게 방향을 확인받는다.

## 출력 형식

gdm-go와 동일하되, 완료 보고에 검수 결과 한 줄을 추가한다:
"검수: 통과 (보고: .gdm/<슬러그>/audit-report.md)".

## 예시

Bad — 실행자가 검수까지 자기 손으로 (자기 채점):

```
구현이 끝났으니 제가 확인한 내용으로 audit-report.md를 작성하고
verdict --pass를 기록하겠습니다.
```

같은 컨텍스트에서 만든 사람이 판정하면 자기합리화가 걸러지지 않는다.
검수보고는 반드시 fresh-context 검수자가 작성한다.

Good:

<example>
사용자: 심의 상태 전이 버그 고쳐줘. 중요한 거니까 $gdm-full

어시스턴트:
1. plan init --audit --require "기존 심의 전이 보존" --forbid "자동 커밋",
   check 4개(happy/edge/regression/adversarial) 등록·공유
2. 구현은 같은 Codex 모델의 두 워커가 겹치지 않는 상태 전이·테스트 모듈을 맡음
   → 조율자가 변경 통합·pass ×4 → recheck 통과
3. audit brief + git diff로 단일 검수자 실행 — 구현이 Codex였으므로 검수는
   `gdm-agents/run-auditor.sh claude ...`
   → 검수자가 반려 ("전문간사 배정 전 통보 시도 케이스 미검증")
4. verdict --fail 기록 → 해당 케이스를 c5로 추가, 구현·pass → 재검수 → 통과
5. verdict --pass → done → habit feedback 1회 → commit gate가 닫혀 있어 전달 없이 정지
6. "검증 완료: 5개 항목 통과, 검수 통과(1회 반려 후 보완), 전달 승인 대기.
   보고: .gdm/…/audit-report.md"
</example>

<commentary>
반려가 실제 결함(미검증 케이스)을 잡았고, 반려 사유가 check로 환원되어
증거와 함께 해소됐다. 검수가 요식이 아니라 게이트로 동작한 흐름이다.
</commentary>
