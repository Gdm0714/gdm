---
name: gdm-research
description: |
  질문을 축으로 분해해 필요한 경우 공유 상한 안에서 서브에이전트로 제한 병렬 조사하고,
  핵심 주장을 교차 검증한 뒤 출처 있는 보고로 종합한다. 사용자가 "$gdm-research",
  "리서치해줘", "조사해서 정리해줘", "뭐가 좋을지 비교해줘"라고 할 때 사용한다.
---

# gdm:research — 제한 병렬 리서치

## 역할

질문을 받아 다각도로 조사하고 검증된 종합 보고를 산출하는 리서처.

## 제약

- CRITICAL: 하나의 네이티브 Codex 루트 세션 트리에서 진행자를 제외한 모든 종류·모든 세대의
  활성 spawned agent를 합쳐 동시에 최대 4명이다 (`MAX_ACTIVE_SUBAGENTS: 4`). 조사
  에이전트와 에이전트가 `하위 위임`으로 만든 자식도 같은 세션 상한을 공유한다. 빈 슬롯이
  없으면 새로 만들지 말고 완료를 기다리거나 기존 에이전트에 후속 작업을 보낸다.
- IMPORTANT: 위임 여부는 조사 맥락으로 정한다. 서로 독립된 축을 깊게 읽어야 하거나 전문성·
  fresh context가 품질을 높이고, 대량 추출 결과가 주 컨텍스트를 흐리거나 병렬 조사가 속도·
  검증 독립성을 높이면 위임한다. 단일 축, 짧은 조회, 결과가 강하게 결합된 작업은 현재 세션의
  배치 호출로 처리한다.
- CRITICAL: 조사 서브에이전트가 진행 중 새롭고 받은 범위와 겹치지 않는 독립 하위 축을 발견하면,
  남은 전역 슬롯 안에서 그 축을 하위 위임할 수 있다. 새 작업에도 겹치지 않는 축과 종료 조건을
  하나씩 준다.
- CRITICAL: 위임에서 금지하는 것은 받은 전체 범위를 그대로 다시 맡기는 재위임, 동일 역할의
  자기 복제, 출처·파일마다 에이전트를 만드는 폭주성·무제한 팬아웃뿐이다.
- IMPORTANT: 일반 조사 역할은 leaf로 고정하지 않는다.
- CRITICAL: 모든 spawn 메시지 첫 줄에 `GDM_AGENT_ENVELOPE_V1=` 단일행 JSON과 역할·scope·
  ownership·산출물·검증·종료 조건·`blockedBy`를 넣는다. 위임 lease는
  `MAX_TOTAL_SPAWNS_PER_ROOT: 12`, `DEFAULT_CHILD_QUOTA: 1`, `MAX_CHILD_QUOTA: 2`,
  `MAX_AGENT_DEPTH: 3`이다. 일반 조사 역할의 기본 quota는 1이며 일괄 leaf로 만들지 않는다.
  허용된 시도는 누적 예산을 소비하고 실패·취소된 spawn도 예산을 돌려주지 않는다. timeout은
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
  빠져도 `blockedBy`를 만족하지 않으며, 30분 lease expiry도 완료가 아니다. 의존 조사와 최종 종합은 산출물 결과를
  `completed|failed|cancelled|inconclusive` 중 하나로 별도 판정한다. 이 workflow 결과는
  lifecycle 관찰과 분리한다.
- CRITICAL: 훅이 실행되는 하나의 네이티브 Codex 루트 세션 트리에서 누적 12는 하드 상한이고,
  동시 4는 현재 세션의 유효 Codex 설정이 4일 때 네이티브 하드 상한이다. 하위 hook caller
  agent id가 structured 부모와 일대일로 결속될 때 부모별 quota/depth/canDelegate를
  기계적으로 검사한다. caller id가 없는 호환 런타임은 원장에 선언한 부모가 있을 때만
  nonterminal/quota/depth/canDelegate를 검사하는 degraded fallback을 쓰며, 이를 부모
  신원 하드 경계라고 주장하지 않는다. `multi_agent_v2` spawn 응답에는 agent id가 없으므로
  unresolved V2가 포함된 identity-ambiguous 구간만 직렬화한다. unresolved V1끼리는 병렬
  가능하고, identity가 연결된 뒤 active agent 실행도 병렬 가능하다. same-axis 후속 작업으로
  idle thread를 재사용할 수 있지만 훅은 이전 ownership/delegation을 기계적으로 갱신하지
  못한다. 루트 진행자는 실제 작업 겹침을 피하고 새 bounded delegation이 필요하면 새 lease를
  선언해 생성한다. 비대화형 CLI·별도 세션을 합친 논리 작업 전체의 동시 4·누적 12는 협력적
  운영 규칙이다.

아래 한 줄은 형식 예시일 뿐이다. 복사하기 전에 `taskId`, `parentId`, `role`, `scope`,
`ownership.mode/resources`, `deliverable`, `verify`, `stopWhen`, `canDelegate`,
`childQuota`(quota), `depth`, `blockedBy` 값을 작업에 맞게 모두 바꾼다.

```text
GDM_AGENT_ENVELOPE_V1={"taskId":"example-task","parentId":"root","role":"bounded-worker","scope":"docs/example","ownership":{"mode":"read","resources":["docs/example.md"]},"deliverable":"Evidence-backed result","verify":"Confirm cited file and result","stopWhen":"Deliverable and verification are complete","canDelegate":false,"childQuota":0,"depth":1,"blockedBy":[]}
```

- IMPORTANT: 같은 도구의 여러 요청은 배치 입력이 더 싸고 명확하면 현재 세션에서 묶는다.
  서로 다른 맥락을 깊게 읽어야 하는 독립 축은 서브에이전트로 병렬화한다.
- NEVER: Node, Gradle, Vite, Codex, Claude 같은 이름으로 프로세스를 일괄 종료하지 않는다.
  자원 이상이 생기면 새 호출을 중단하고 사용자에게 보고한다. 현재 세션이 직접 시작해 PID를
  기록한 명령만 그 PID 트리 범위에서 종료할 수 있다.
- NEVER: 출처 없는 주장을 보고에 넣지 않는다. 모든 핵심 주장은 출처(URL,
  파일:라인, 실측 데이터)를 단다.
- NEVER: 검색 스니펫만 보고 인용하지 않는다. 결론을 좌우하는 출처는 본문을 연다.
- IMPORTANT: 결론을 좌우하는 핵심 주장은 최소 1회 반박 시도를 거친다 — 반대
  증거를 찾아보고, 못 찾았으면 그 사실을 신뢰도에 반영한다.
- IMPORTANT: 조사 도구 라우팅은 사용자 규칙을 따른다 (공식 문서 우선,
  Context7/Exa/Firecrawl 용도 구분).

## 프로세스

1. 질문을 서로 겹치지 않는 축 2~4개로 분해한다 (예: 공식 스펙 / 실사용 사례 /
   대안 비교 / 제약·비용). 축 목록을 사용자에게 한 줄로 보여주고 시작한다.
2. 위임 조건에 맞는 축에는 서브에이전트를 배정해 동시에 조사하고, 가벼운 조회는 현재 세션의
   배치 호출로 처리한다. 조사 중 새 독립 하위 축이 발견되면 전역 4명 상한의 빈 슬롯 안에서
   하위 위임한다. 각 결과에는 출처, 핵심 주장, 불확실성을 요구하고 진행자는 모든 결과를 기다려
   수합한다.
3. 결론을 좌우하는 중요한 출처의 본문은 진행자가 직접 열어 확인하고, 핵심 주장 상위 2개에
   반박 검색을 한 번씩 수행한다.
4. 종합 보고를 작성한다 (역피라미드): 결론/권고 → 근거 요약(출처) →
   반박 검증 결과 → 남은 불확실성.
5. 보고가 자산 가치가 있으면 wiki-ingest로 위키에 넣을지 제안한다.

## 엣지 케이스

- 축 분해가 안 될 만큼 질문이 넓으면: 조사 전에 범위를 좁히는 질문 1~2개를 한다.
- 출처끼리 충돌하면: 충돌 자체를 보고에 명시하고 어느 쪽이 더 신뢰할 만한지
  근거를 단다 (임의로 한쪽을 채택하지 않는다).

## 출력 형식

결론 먼저 한 문단 → 축별 발견(각 항목에 출처) → 반박 검증 결과 → 불확실성.
비교형 질문이면 결론 직후에 비교표 하나.

## 예시

Bad — 한 축만 파고 결론 (하지 말 것):

```
공식 문서에 A가 권장이라고 하니 A를 쓰세요.
```

실사용 이슈, 대안, 비용 축이 빠졌고 반박 시도가 없다. 공식 권장이 실제
환경에서 뒤집히는 경우는 흔하다.

Good:

<example>
사용자: 토스 Open API로 실시간 시세 받는 최선의 방법 조사해줘. $gdm-research

어시스턴트:
"축 4개로 조사합니다: 공식 스펙 / 레이트리밋·비용 / 실사용 사례(이슈) / 대안(웹소켓 vs 폴링)"
(공유 활성 상한 4명 안에서 병렬 조사 → 진행자 교차 검증 → 보고)
"결론: 웹소켓 구독이 권장 (신뢰도 높음). 폴링은 분당 한도에 걸림 [출처: 공식 rate-limit 문서].
반박 검증: 웹소켓 끊김 이슈 보고 2건 확인 — 재연결 백오프 필수 [출처: GitHub 이슈 #…].
불확실성: 장 마감 후 재연결 정책은 문서화 안 됨 (실측 필요)"
</example>

<commentary>
축 분해를 먼저 공유했고, 결론을 좌우하는 주장(웹소켓 권장)에 반박 검증을
돌려 운영 리스크(끊김)까지 보고에 실렸다.
</commentary>
