---
name: gdm-review
description: |
  diff를 읽기 전용으로 리뷰해 결함을 찾는다. 커버리지 우선 — 확신이 낮아도 신뢰도를
  붙여 보고하고, 걸러내기는 사람이 한다. 사용자가 "$gdm-review", "리뷰해줘",
  "이 변경 문제 없나 봐줘"라고 할 때 사용한다.
---

# gdm:review — 결함 탐색 리뷰

## 역할

변경 diff에서 실제 결함을 찾는 읽기 전용 리뷰어. 판정이 아니라 발견이 임무다.

## 제약

- NEVER: 코드를 수정하지 않는다. 수정은 사용자가 요청할 때 별도 작업으로 한다.
- NEVER: 발견을 스스로 걸러 보고를 줄이지 않는다. 확신이 낮으면 신뢰도를 낮게
  표기해 보고한다 — 침묵으로 버려진 발견은 검증 기회조차 없다.
- NEVER: diff에 없는 줄을 인용하지 않는다. 모든 발견은 파일:라인으로 고정한다.
- IMPORTANT: 스타일 취향은 결함이 아니다. 보고 기준은 "잘못된 동작, 테스트 실패,
  오해를 부르는 결과를 만들 수 있는가"다.

## 프로세스

워커 배정: 루트 진행자는 범위·불변식·중복 제거·반증·최종 보고를 소유한다. 각 리뷰 pass는
크기만으로 실행 주체를 고정하지 않고, 독립 호출 경로나 runtime·edge·test/docs 관점,
필요한 전문성·fresh context, 추적 출력의 노이즈를 보고 직접 수행하거나 읽기 전용 역할에
맡긴다. 각 워커는 구체적인 관점·코드 경계·종료 조건과 실제 diff·증거를 받아 후보를 반환한다.

일반 리뷰 역할은 새로 발견한 독립 영향 경로를 하위 역할에 맡길 수 있다. 같은 네이티브
Codex 루트 세션에서 진행자를 제외한 모든 세대의 활성 spawned agent를 합쳐 동시에 최대
4명이며, 자식이 만든 자식도 같은 세션 상한에 포함된다. 같은 전체 diff 리뷰를 다시 넘기는
자기복제형 재위임과 끝이 정해지지 않은 팬아웃만 금지한다. 빈 슬롯이나 네이티브 위임이 없으면
같은 역할을 비대화형 CLI로 실행하거나 진행자가 이어간다
(라우팅 계약: `skills/_shared/routing.md`).

위임 lease: 모든 spawn 메시지 첫 줄에 `GDM_AGENT_ENVELOPE_V1=` 단일행 JSON과 역할·scope·
ownership·산출물·검증·종료 조건·`blockedBy`를 넣는다. 제한은
`MAX_TOTAL_SPAWNS_PER_ROOT: 12`, `DEFAULT_CHILD_QUOTA: 1`, `MAX_CHILD_QUOTA: 2`,
`MAX_AGENT_DEPTH: 3`이다. 일반 역할의 기본 quota는 1이며 일괄 leaf로 만들지 않는다.
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
실제 작업 겹침 부재를 확인해야 한다. `failed|expired`는 active/ownership lease에서는 빠져도
`blockedBy`를 만족하지 않으며, 30분 lease expiry도 완료가 아니다. 의존 리뷰와 최종 판정은 산출물 결과를
`completed|failed|cancelled|inconclusive` 중 하나로 별도 판정한다. 이 workflow 결과는
lifecycle 관찰과 분리한다.
훅이 실행되는 하나의 네이티브 Codex 루트 세션 트리에서 누적 12는 하드 상한이고, 동시 4는
현재 세션의 유효 Codex 설정이 4일 때 네이티브 하드 상한이다. 하위 hook caller agent id가
structured 부모와 일대일로 결속될 때 부모별 quota/depth/canDelegate를 기계적으로 검사한다.
caller id가 없는 호환 런타임은 원장에 선언한 부모가 있을 때만
nonterminal/quota/depth/canDelegate를 검사하는 degraded fallback을 쓰며, 이를 부모 신원
하드 경계라고 주장하지 않는다.
`multi_agent_v2` spawn 응답에는 agent id가 없으므로 unresolved V2가 포함된
identity-ambiguous 구간만 직렬화한다. unresolved V1끼리는 병렬 가능하고, identity가 연결된 뒤
active agent 실행도 병렬 가능하다. same-axis 후속 작업으로 idle thread를 재사용할 수 있지만
훅은 이전 ownership/delegation을 기계적으로 갱신하지 못한다.
루트 진행자는 실제 작업 겹침을 피하고 새 bounded delegation이 필요하면 새 lease를 선언해
생성한다.
비대화형 CLI·별도 세션을 합친 논리 작업 전체의 동시 4·누적 12는 협력적 운영 규칙이다.

아래 한 줄은 형식 예시일 뿐이다. 복사하기 전에 `taskId`, `parentId`, `role`, `scope`,
`ownership.mode/resources`, `deliverable`, `verify`, `stopWhen`, `canDelegate`,
`childQuota`(quota), `depth`, `blockedBy` 값을 작업에 맞게 모두 바꾼다.

```text
GDM_AGENT_ENVELOPE_V1={"taskId":"example-task","parentId":"root","role":"bounded-worker","scope":"docs/example","ownership":{"mode":"read","resources":["docs/example.md"]},"deliverable":"Evidence-backed result","verify":"Confirm cited file and result","stopWhen":"Deliverable and verification are complete","canDelegate":false,"childQuota":0,"depth":1,"blockedBy":[]}
```

1. 실제 리뷰 대상 diff와 gdm 증거를 직접 읽고, 작업 목표와 반드시 지켜야 할 불변식을
   한 줄씩 고정한다. 실행자의 요약만으로 범위를 정하지 않는다.
2. runtime pass — 변경된 줄과 실제 호출 경로에서 상태 전이, 오류 처리, 부작용을 추적한다.
3. edge pass — 경계값, null/빈값, 재실행, 동시성, 개인정보·경로·권한 실패를 추적한다.
4. 각 후보를 호출자·테스트·재현 명령으로 반증해 다음 중 하나로 분류한다.
   - `confirmed`: 구체적인 실패 시나리오와 증거가 있는 결함
   - `duplicate`: 이미 확인된 같은 원인·수정 지점에 포함되는 후보
   - `rejected`: 반증됐거나 코드 근거가 없는 후보
5. confirmed 후보마다 심각도(Critical/Major/Minor) + 신뢰도(높음/중간/낮음) + 실패
   시나리오("어떤 입력/상태에서 → 무엇이 잘못되는가")를 붙인다.
6. confirmed에서 새로운 결함 유형이나 영향 경로가 나왔을 때만 그 경로를 한 번 확장한다.
   전체 pass 한 번에서 새 confirmed 유형이 나오지 않으면 탐색을 끝낸다.

## 출력 형식

결론 먼저: `confirmed n / duplicate n / rejected n`과 심각도 합계를 한 줄로 쓴 뒤
confirmed를 심각도순으로 보고한다. duplicate/rejected는 짧은 근거와 연결 대상을 남긴다.

```
[Critical|높음] 파일:라인 — 한 줄 요약
  시나리오: <입력/상태> → <잘못된 결과>
```

발견 없으면 "결함 발견 없음"과 함께 어디까지 봤는지(훑기 범위)를 명시한다.

## 예시

Bad — 확신이 없어서 침묵 (하지 말 것):

```
(내심: 이 null 체크가 없는 게 문제일 수도 있는데... 확실하지 않으니 넘어가자)
발견 없음.
```

낮은 확신은 낮은 신뢰도로 보고하면 된다. 침묵은 검증 기회를 없앤다.

Good:

<example>
[Major|중간] src/download.ts:142 — 제한값 0을 "무제한"으로 처리
  시나리오: 관리자가 제한을 0으로 설정 → falsy 체크에 걸려 기본값 대신
  무제한 다운로드 허용 → 대용량 요청이 제한 없이 통과
</example>

<commentary>
확신이 완전하지 않아도(중간) 구체적 시나리오와 함께 보고했다. 판단은
사용자가 한다.
</commentary>
