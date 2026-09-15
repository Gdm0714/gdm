## Codex native delegation contract

일반 역할은 leaf가 아니다. 독립 코드 경계, 별도 전문성, fresh context가 결과 품질을 높일 때
하위 역할을 만들 수 있다. 같은 전체 범위를 다시 넘기는 자기복제형 재위임과 끝이 정해지지
않은 팬아웃은 금지한다. 루트 진행자가 산출물의 `deliverable`과 `verify`, 실제 작업 겹침 부재를
직접 확인하고 최종 결과를 통합한다.

하나의 hook-enabled native root session에서 진행자를 제외한 모든 세대의 활성 spawned agent를
합쳐 동시에 최대 4명이다 (`MAX_ACTIVE_SUBAGENTS: 4`). 모든 native spawn 메시지 첫 줄에는
`GDM_AGENT_ENVELOPE_V1=` 뒤에 역할·scope·ownership·산출물·검증·종료 조건·의존성을 담은
단일행 JSON을 둔다. 훅의 실행 제한은 `MAX_IN_FLIGHT_SPAWNS_PER_ROOT: 32`이며,
`DEFAULT_CHILD_QUOTA: 1`, `MAX_CHILD_QUOTA: 2`, `MAX_AGENT_DEPTH: 3`이다.
일반 역할의 기본 quota는 1이며 일괄 leaf로 만들지 않는다. 부모별 childQuota는 해당 부모가
만들 수 있는 누적 자식 수이며 세션 실행 제한과 별개다.
실행 제한은 현재 pending/running 예약과 연결되지 않은 활성 관찰만 계산한다.
`stopped|failed|expired` 이력은 실행 제한에서 제외한다. 누적 호출 횟수와 과거 기록은
감사와 중복 호출 방지를 위해 보존하며 누적 횟수 때문에 새 실행을 차단하지 않는다.
초기 예산과 단계별 확장은 없다. 취소 요청만으로 자리를 반환하지 않고 관찰된 상태를 따른다.

structured 역할의 canonical scope와 write resource는 cwd 기준 별칭을 정규화해 충돌을
거부하지만 운영체제 파일 lock은 아니다. timeout은 대기 호출의 종료일 뿐 workflow 결과
확정이 아니다. `SubagentStop`은 child turn의 stop 관찰이자 sequencing hint일 뿐 영구 thread
종료나 성공 증명이 아니다. 다른 Stop handler가 continuation을 요청할 수 있고, idle thread는
`followup_task`로 재사용될 수 있으며, interrupt는 Stop 관찰을 남기지 않을 수 있다. 원장에서
해당 identity에 연결된 `stopped` 관찰은 active/ownership lease를 협력적으로 해제하고
`blockedBy`를 열 수 있지만 hard runtime proof가 아니다. `failed|expired`는
active/ownership lease에서는 빠져도 `blockedBy`를 만족하지 않으며, 30분 lease expiry도
완료가 아니다. 산출물 결과는 `completed|failed|cancelled|inconclusive` 중 하나로 별도
판정한다. 이 workflow 결과는 lifecycle 관찰과 분리한다.
루트 진행자는 deliverable/verify와 실제 작업 겹침 부재를 확인해야 한다.

훅이 실행되는 하나의 native root session tree에서 활성 실행 예약 32는 새 spawn의 입장 상한이고, 동시 4는
해당 target runtime의 유효 설정이 4일 때 native hard 상한이다. hook caller agent id가
structured 부모와 일대일로 결속될 때 부모별 quota/depth/canDelegate를 기계적으로 검사한다.
caller id가 없는 호환 런타임에서는 선언한 부모가 있을 때만 그 부모의
nonterminal/quota/depth/canDelegate를 검사하는 degraded fallback을 쓰며, 이를 부모 신원
하드 경계라고 주장하지 않는다. `multi_agent_v2` spawn 응답에는 agent id가 없으므로
unresolved V2가 포함된 identity-ambiguous 구간만 직렬화한다. unresolved V1끼리는 병렬
가능하고, identity가 연결된 뒤 active agent 실행도 병렬 가능하다. same-axis 후속 작업으로
idle thread를 재사용할 수 있지만 훅은 이전 ownership/delegation을 기계적으로 갱신하지
못한다.
루트 진행자는 실제 작업 겹침을 피하고 새 bounded delegation이 필요하면 새 lease를 선언해 생성한다.
비대화형 CLI·별도 세션을 합친 논리 작업 전체의 동시 4는 협력적 운영 규칙이다.
늦은 lifecycle 관찰로 실행 예약이 상한을 넘더라도 이력을 버리거나 실행을 강제 종료하지 않는다.

아래 한 줄은 형식 예시일 뿐이다. 복사하기 전에 `taskId`, `parentId`, `role`, `scope`,
`ownership.mode/resources`, `deliverable`, `verify`, `stopWhen`, `canDelegate`,
`childQuota`(quota), `depth`, `blockedBy` 값을 작업에 맞게 모두 바꾼다.

```text
GDM_AGENT_ENVELOPE_V1={"taskId":"example-task","parentId":"root","role":"bounded-worker","scope":"docs/example","ownership":{"mode":"read","resources":["docs/example.md"]},"deliverable":"Evidence-backed result","verify":"Confirm cited file and result","stopWhen":"Deliverable and verification are complete","canDelegate":false,"childQuota":0,"depth":1,"blockedBy":[]}
```
