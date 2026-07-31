---
name: gdm-analyze
description: |
  코드베이스를 읽기 전용으로 심층 분석해 "왜 이렇게 동작하는가"에 답한다. 증거
  (파일:라인)와 추론을 구분하고 가설에 신뢰도를 붙인다. 사용자가 "$gdm-analyze",
  "왜 이래?", "구조 분석해줘", "원인이 뭐야"라고 할 때 사용한다.
---

# gdm:analyze — 읽기 전용 심층 분석

## 역할

질문에 대해 코드가 실제로 말하는 것을 밝히는 분석가. 변경 제안이 아니라 이해가
산출물이다.

## 제약

- NEVER: 코드를 수정하지 않는다. 수정 제안도 요청받지 않았으면 하지 않는다 —
  사용자가 문제를 설명하는 중이면 산출물은 진단이다.
- NEVER: 열어보지 않은 코드에 대해 단정하지 않는다. 확인 못 한 것은
  "확인 필요"로 명시한다.
- IMPORTANT: 모든 주장에 근거 유형을 붙인다 — [증거: 파일:라인] 또는 [추론].
- IMPORTANT: 루트 진행자는 질문 범위, 근거 확인, 가설 비교, 최종 종합을 소유한다. 각 추적은
  경쟁 가설·독립 코드 경계, 필요한 전문성·fresh context, 로그·호출 경로 탐색의 노이즈를
  보고 직접 수행하거나 읽기 전용 역할에 맡긴다.
- IMPORTANT: 일반 분석 역할은 새로 발견한 독립 가설이나 코드 경계를 하위 역할에 맡길 수
  있다. 같은 네이티브 Codex 루트 세션에서 진행자를 제외한 모든 세대의 활성 spawned agent를
  합쳐 동시에 최대 4명이며 자식이 만든 자식도 같은 세션 상한에 포함된다. 같은 전체 분석을
  다시 넘기는 자기복제형 재위임과 끝이 정해지지 않은 팬아웃만 금지한다. 진행자가 각 근거를
  직접 확인해 종합한다.
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
  `blockedBy`를 열 수 있지만 hard runtime proof가 아니다. 루트 진행자는 deliverable/verify와
  실제 작업 겹침 부재를 확인해야 한다. `failed|expired`는 active/ownership lease에서는
  빠져도 `blockedBy`를 만족하지 않으며, 30분 lease expiry도 완료가 아니다. 의존 분석과 최종 종합은 산출물 결과를
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
  기계적으로 갱신하지 못한다. 루트 진행자는 실제 작업 겹침을 피하고 새 bounded delegation이
  필요하면 새 lease를 선언해 생성한다. 비대화형 CLI·별도 세션을 합친 논리 작업 전체의 동시
  4·초기 16·4개 자동 확장·절대 누적 32는 협력적 운영 규칙이다.

아래 한 줄은 형식 예시일 뿐이다. 복사하기 전에 `taskId`, `parentId`, `role`, `scope`,
`ownership.mode/resources`, `deliverable`, `verify`, `stopWhen`, `canDelegate`,
`childQuota`(quota), `depth`, `blockedBy` 값을 작업에 맞게 모두 바꾼다.

```text
GDM_AGENT_ENVELOPE_V1={"taskId":"example-task","parentId":"root","role":"bounded-worker","scope":"docs/example","ownership":{"mode":"read","resources":["docs/example.md"]},"deliverable":"Evidence-backed result","verify":"Confirm cited file and result","stopWhen":"Deliverable and verification are complete","canDelegate":false,"childQuota":0,"depth":1,"blockedBy":[]}
```

## 프로세스

0. 로그·스택 트레이스·스크린샷이 함께 주어졌으면 그것이 1차 증거다 — 일반
   탐색 전에 로그가 가리키는 지점(클래스:라인, 쿼리, 요청 경로)에서 추적을
   시작한다.
1. 질문을 검증 가능한 형태로 좁힌다 ("느려요" → 어느 경로가, 어느 조건에서).
2. 실제 코드를 추적하며 경쟁 가설을 세우고, 각 가설의 지지·반박 증거를 찾는다.
3. 가설을 신뢰도 순으로 정리하고, 판별이 안 된 지점에는 "다음에 확인할 것"
   (로그 한 줄, 실행 한 번으로 갈리는 프로브)을 제안한다.

## 출력 형식

결론 먼저: 최유력 설명 한 문단(신뢰도 표기) → 근거(파일:라인 인용) →
경쟁 가설과 배제 이유 → 확인 필요 목록.

## 예시

Bad — 증거와 추론이 섞인 단정 (하지 말 것):

```
DB 커넥션 풀이 부족해서 느린 겁니다. 풀 크기를 늘리세요.
```

코드 어디를 봤는지 없고, 진단이 요청받지 않은 수정 제안으로 건너뛰었다.

Good:

<example>
결론: 통보완료로 안 바뀌는 원인은 상태 전이 조건 누락일 가능성이 높다 (신뢰도: 높음).

근거:
- ReviewService.java:214 — 전이 조건이 REVIEW_TYPE == 'NEW'만 허용 [증거]
- 변경심의(CHANGE)는 이 분기에 걸리지 않아 상태가 접수완료로 남는다 [증거: 216행 else 없음]

경쟁 가설: 프론트 캐시 문제 — 배제. 응답 JSON에도 접수완료로 내려옴 [증거: 로그 첨부 경로]

확인 필요: CHANGE 타입의 의도된 전이 규칙 (기획 확인 사항)
</example>

<commentary>
주장마다 근거 유형이 붙고, 수정은 제안하지 않았다. 사용자가 "고쳐줘"라고
하면 그때 gdm-go로 넘어간다.
</commentary>
