---
name: gdm-plan
description: |
  구현에 들어가기 전 계획을 세운다. 요구를 정리하고 검증 항목(check) 초안까지 포함한
  계획 문서를 .gdm/plans/에 산출한다 — 이 문서가 그대로 gdm-go/gdm-full의 brief 입력이
  된다. 사용자가 "$gdm-plan", "계획부터", "설계하고 시작하자"라고 할 때 사용한다.
---

# gdm:plan — 계획 수립

## 역할

작업 요청을 받아 구현 없이 계획만 세우는 설계자. 산출물은 실행 스킬(gdm-go/full)이
바로 받아 쓸 수 있는 계획 문서다.

## 제약

- NEVER: 코드를 수정하지 않는다. 이 스킬의 산출물은 문서 하나뿐이다.
- NEVER: 확인하지 않은 코드 구조를 전제로 계획하지 않는다. 계획에 등장하는
  파일·함수는 실제로 열어 확인한 것만 쓴다.
- IMPORTANT: 질문은 답이 구현 방향을 실제로 가르는 경우에만, 한 번에 2~3개까지만
  한다. 관례적 기본값이 있는 것은 기본값을 택하고 계획에 명시한다.

## 프로세스

워커 배정: 계획의 **소유자는 루트 진행자**다 — 사용자 문답, 작업 계약, 근거 판정, 최종 문서
검토·저장은 진행자가 소유한다 (라우팅 계약: `skills/_shared/routing.md`의 역할 배정 표와 동일).
그 안의 조사·초안 작업은 독립 코드 경계, 필요한 전문성·fresh context, 넓은 탐색이 주
컨텍스트에 만드는 노이즈를 보고 직접 수행하거나 위임한다. 여러 조사 역할에는 겹치지 않는
영역과 종료 조건을 주며, 진행자가 인용할 실제 파일을 다시 확인하고 최종 문서를 저장한다.

일반 조사 역할은 작업 중 새로 발견한 독립 코드 영역을 하위 역할에 맡길 수 있다. 같은
네이티브 Codex 루트 세션에서 진행자를 제외한 모든 세대의 활성 spawned agent를 합쳐 동시에
최대 4명이며, 자식이 만든 자식도 같은 세션 상한에 포함된다. 같은 전체 계획 범위를 다시
넘기는 자기복제형 재위임과 끝이 정해지지 않은 팬아웃만 금지한다. 빈 슬롯이나 위임 수단이
없으면 진행자가 이어서 수행한다.

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
`blockedBy`를 만족하지 않으며, 30분 lease expiry도 완료가 아니다. 의존 조사와 계획 확정은 산출물 결과를
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

1. 요청을 읽고 모호한 지점을 가른다: 방향을 가르는 모호함이면 질문, 아니면
   기본값 선택 후 문서에 "가정"으로 기록.
2. 관련 코드를 읽어 현재 구조를 파악한다 (추측 금지).
3. 계획 문서를 `.gdm/plans/<슬러그>.md`로 저장한다:

```markdown
# 계획: <제목>

## 목표
사용자가 받게 될 결과 한 문단.

## 가정 (질문 대신 택한 기본값)
- ...

## 검증 항목 초안
gdm plan add에 그대로 쓸 수 있는 형태:
- desc: ... / cmd: ... / expect: ...
- desc: ... (manual) / expect: ...

## 작업 계약 초안
- require: <반드시 보존할 사용자 결과·기존 변경>
- forbid: <하면 안 되는 전달·데이터·범위 변경>

## 구현 단계
1. <파일:위치> 무엇을 어떻게
2. ...

## 범위 밖 (하지 않는 것)
- ...
```

4. 대화가 끊겨도 새 컨텍스트가 복원할 수 있도록 목표·가정·검증 항목뿐 아니라
   `require`/`forbid` 작업 계약도 문서에 남긴다. 채팅 요약만 다음 실행에 넘기지 않는다.
5. 문서 경로를 알려주고, 계약을 포함한 실행 연결을 안내한다:
   `gdm plan init --slug <슬러그> --brief-file .gdm/plans/<슬러그>.md --require '<보존 조건>' --forbid '<금지 조건>'`
   (+중량이면 `--audit`). `--forbid '자동 커밋'`이 기본이며 사용자가 별도로 승인하기
   전에는 계획 완료나 `done`을 전달 승인으로 해석하지 않는다.

## 엣지 케이스

- 조사 중 요청 자체가 잘못된 전제 위에 있음을 발견하면: 계획을 멈추고 근거와
  함께 보고한다. 잘못된 전제로 계획을 완성하지 않는다.

## 출력 형식

결론 먼저: 계획 한 줄 요약 → 문서 경로 → 사용자 확인이 필요한 지점(있으면).

## 예시

Bad — 코드를 안 열고 세운 계획 (거부되는 방식):

```
아마 DownloadService에 제한 로직이 있을 테니 거기를 수정하는 계획을 세웁니다.
```

"아마"로 시작하는 계획은 구현 단계에서 전부 다시 조사하게 된다. 파일을 열어
확인한 위치만 계획에 쓴다.

Good:

<example>
사용자: 대용량 다운로드 제한을 관리자가 바꿀 수 있게 하고 싶어. $gdm-plan

어시스턴트: (관련 파일 조사 후)
"계획 완료: 설정 테이블에 제한값 추가 + 관리자 메뉴 노출 + 다운로드 경로에서 참조.
문서: .gdm/plans/download-limit-config.md — 검증 항목 초안 4개 포함.
확인 필요: 상한선을 두시겠어요? (문서에는 100만 건 상한 가정으로 작성)
바로 시작하려면: gdm plan init --slug download-limit-config
--brief-file .gdm/plans/download-limit-config.md --require '기존 다운로드 동작 보존'
--forbid '자동 커밋' --audit"
</example>

<commentary>
조사에 근거한 위치, 실행 스킬로 바로 이어지는 check 초안, 방향을 가르는
질문 하나만 — 계획 문서가 다음 단계의 입력으로 완결된다.
</commentary>
