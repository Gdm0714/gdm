# gdm 역할·역량 배정 계약

> 저장소 정본. `install.sh`는 `_shared`를 설치하지 않으므로 각 스킬은 자기 역할 규칙을
> SKILL.md에 인라인하고 이 문서를 사람이 보는 정본으로 인용한다. 규칙을 바꾸면 관련
> 스킬의 인라인 규칙도 함께 고친다.

## 책임

현재 사용자와 대화하는 루트 세션이 **진행자**다. 진행자는 사용자 문답, 작업 계약,
변경 통합, gdm 게이트, 최종 보고를 소유한다. 역할 실행을 다른 프로세스에 맡기더라도 이
책임은 넘기지 않는다.

역할은 계획·구현·리뷰·검수로 나누고 다음 기준으로 배정한다.

- 사용자와의 문답·최종 판단처럼 맥락을 공유해야 하는 일은 진행자가 맡는다.
- 파일·모듈·조사 축처럼 소유 경계가 독립적이면 구현을 포함해 위임할 수 있다.
- 전문 역할이나 fresh context가 품질을 높이거나, 넓은 탐색·로그 분석·테스트 출력이 진행자
  컨텍스트를 흐리면 별도 역할에 맡긴다.
- 작고 강하게 결합된 일은 진행자가 이어서 처리할 수 있다. 크기만으로 직접 실행을 기본값으로
  고정하지 않는다.
- 여러 구현 워커는 겹치지 않는 파일·모듈을 소유하고 루트 진행자가 변경을 통합한다.
- 역할 이름이나 위임 보고보다 gdm의 check·증거·journal을 판정 정본으로 삼는다.

## 역할 배정

| 역할 | 스킬 | 소유자 | 필수 불변식 |
|---|---|---|---|
| 계획 | gdm-plan | 진행자 + 필요한 조사 역할 | 진행자가 결정·계약·최종 계획을 소유한다 |
| 경량 구현 | gdm-go | 진행자 또는 경계가 분리된 구현 워커 | 진행자가 통합하고 gdm 증거가 통과해야만 완료한다 |
| 중량 구현 | gdm-full | 한 실제 구현 모델의 진행자·워커 | 같은 모델의 여러 워커는 허용하고 독립 검수 전 전달하지 않는다 |
| 리뷰 | gdm-review | 진행자 + 필요한 읽기 전용 역할 | 실제 diff·증거를 읽고 후보를 반증·중복 제거한다 |
| 검수 | auditor | 실제 구현 모델과 다른 모델 | 새 컨텍스트에서 직접 증거를 확인한다 |

## 검수 독립성

검수 모델은 실제 diff를 만든 구현 모델과 달라야 한다. 조율자나 스킬 이름이 아니라 실제
구현 주체를 기준으로 판단한다. gdm-full 한 작업의 실제 구현 모델은 하나로 유지하되,
그 모델을 쓰는 구현 에이전트 수는 한 명으로 제한하지 않는다.

- 검수자는 현재 대화나 실행자의 결론 요약을 받지 않는다.
- 입력은 지속 brief, 작업 계약, 실제 diff, gdm 증거 경로다.
- 같은 모델만 사용할 수 있으면 독립 검수를 통과로 낮춰 기록하지 않고 차단 상태를 보고한다.
- 검수 반려는 check로 환원하고 재검증한다. 검수 문장만으로 pass를 만들지 않는다.

## 역할 실행과 제한된 병렬 위임

분리 가능한 역할은 Codex/Claude의 네이티브 서브에이전트나 비대화형 CLI로 위임할 수 있다.
해당 역할 스킬 전문과 필요한 파일·증거 경로만 전달하고, 사용자의 비밀, 전체 대화,
불필요한 저장소 원문은 넘기지 않는다. 결과를 받은 뒤 진행자가 실제 파일과 gdm 게이트로
다시 판정한다.

일반 역할은 leaf가 아니며, 작업 중 새로 발견한 독립 경계가 있거나 전문성·fresh context·
컨텍스트 분리가 유리하면 하위 역할을 만들 수 있다. 운영 규칙은 하나의 네이티브 Codex 루트
세션 트리에서 루트 진행자를 제외한 모든 세대의 활성 spawned agent를 합쳐 동시에 최대
4명이다 (`MAX_ACTIVE_SUBAGENTS: 4`). 현재 세션의 유효
`max_concurrent_threads_per_session = 4`이면 Codex도 이를 네이티브 하드 상한으로 강제한다.
새 역할을 만들기 전에 같은 루트 세션 트리의 활성 수를 확인하고, 빈 슬롯이 없으면 완료를
기다리거나 기존 역할에 후속 작업을 보낸다. 자식이 만든 자식도 같은 세션 상한에 포함된다.

모든 네이티브 spawn 메시지 첫 줄에는 `GDM_AGENT_ENVELOPE_V1=` 뒤에 단일행 JSON 계약을 넣는다.
필수 필드는 `taskId`, `parentId`, `role`, `scope`,
`ownership`, `deliverable`, `verify`, `stopWhen`, `canDelegate`, `childQuota`, `depth`,
`blockedBy`다. marker는 공백 없이 첫 글자부터 시작해야 하고 ID·scope·resource 앞뒤 공백은
허용하지 않는다. `ownership.mode`은 `read|write`, `ownership.resources`는 구체적인 파일·
모듈·조사 축 목록이다. 활성 structured 역할끼리 같은 canonical scope를 다시 맡거나, cwd
기준으로 `.`·`..`·상대/절대 별칭을 정규화했을 때 겹치는 write resource를 소유할 수 없다.
이는 선언을 검사하는 guardrail이지 symlink·대소문자까지 잠그는 운영체제 파일 lock은 아니다.
각 메시지는 계약 다음에 실행 지시, 산출물, 검증 방법, `stopWhen`을 자체 완결적으로 적는다.

`MAX_TOTAL_SPAWNS_PER_ROOT: 12`에서 ROOT는 하나의 네이티브 Codex root session을 뜻한다.
같은 세션 트리의 제한은 누적 12, `DEFAULT_CHILD_QUOTA: 1`, `MAX_CHILD_QUOTA: 2`,
`MAX_AGENT_DEPTH: 3`이다.
새 독립 경계가 예상되는 일반 역할의 기본 `childQuota`는 1이며, 실제로 하위 분할 가능성이
없으면 0, 서로 독립인 하위 축이 이미
확인됐으면 최대 2를 준다. 일반 역할을 일괄 leaf로 만들지 않는다. 허용된 spawn 시도는
같은 root session 누적 예산을 하나 소비하며 실패·취소된 spawn도 예산을 돌려주지 않는다.
첫 Pre 뒤 같은 `tool_use_id`의 재전달은 실제 handler 실행 여부를 훅이 증명할 수 없으므로
동일한 `tool_input`·protocol·caller라도 즉시 거부하고 새 attempt로 세지 않는다. 같은 id의
입력·caller가 바뀌는 경우도 거부한다. Pre보다 먼저 온 unmatched Post는 세션당 12개까지만
보관하고 동일 replay만 상태 변경 없이 허용한다. 예산이 없으면 새 역할 대신 기존 역할에
후속 작업을 보내거나 진행자가 직접 통합한다.
훅이 실행되는 하나의 네이티브 Codex 루트 세션 트리에서 누적 12는 하드 상한이고, 동시 4는
현재 세션의 유효 Codex 설정이 4일 때 네이티브 하드 상한이다. 사용자 `config.toml`만으로
유효값을 단정하지 않고 `/debug-config`에서 계층을 확인한다. 비대화형 CLI와 별도 Codex
세션을 합친 논리 작업 전체의 동시 4·누적 12는 원장을 공유하는 하드 경계가 아니라 진행자가
지키는 협력적 운영 규칙이다.

일반 역할의 위임에서 금지하는 것은 "필요한 만큼", "파일마다 하나"처럼 끝이 정해지지 않은
폭증형 팬아웃과 같은 전체 범위를 다시 넘기는 자기복제형 재위임이다. 모든 역할에는 구체적인
소유 경계와 종료 조건을 준다. 여러 구현 워커를 쓰면 파일·모듈 소유권을 겹치지 않게 배정하고,
루트 진행자가 산출물 통합과 충돌 해결을 소유한다.

훅 sequencing에서 `blockedBy`를 만족하는 내부 상태는 agent id와 연결된 `stopped`뿐이다.
`SubagentStop`은 한 turn의 stop 시도 관찰이자 순서 힌트이며 thread의 영구 종료나 성공
증명이 아니다. `failed|expired`는 활성 소유권과 Stop 장벽에서는 빠지지만 `blockedBy`를
만족하지 않는다. 30분 running lease의 expiry도 원장 정리일 뿐 실제 agent 종료를 보장하지
않는다. follow-up·기존 agent 재사용·interrupt와 이후 재개는 이 훅에서 관찰할 수 없으므로
`blockedBy`와 ownership release는 hard safety가 아니다. 의존하는 단계와 최종 응답은
산출물을 `completed|failed|cancelled|inconclusive` 중 하나로 판정하고 진행자가 결과를
검증·통합한 뒤에만 넘어간다. 같은 축의 보완은 새 spawn보다 기존 역할에 후속 작업을 보내는
것을 우선한다.

Codex 런타임 훅은 envelope 형식과 같은 root session의 누적 spawn 예산을 기계적으로 검사한다.
하위 hook caller agent id가 structured 부모와 일대일로 결속될 때 부모별
quota/depth/canDelegate를 기계적으로 검사하고 선언한 `parentId`도 실제 부모와 일치시킨다.
caller id가 없는 호환 런타임에서는 원장에 선언한 부모가 있을 때만 그 부모의
nonterminal/quota/depth/canDelegate를 검사하는 degraded fallback을 쓰며, 이를 부모 신원
하드 경계라고 주장하지 않는다.
폭주 방지 퓨즈의 조건과 범위는 위 세션 경계를 따른다.
lifecycle 순서로만 추정한 V1 연결은 provisional이며 소유권 해제나 의존 충족에 쓰지 않는다.
V2는 `tool_input.task_name`으로 구분하지만, 성공 Post의 `task_name`은 입력 leaf가 아닌
canonical AgentPath이고 agent id가 없으므로 신원 근거로 쓰지 않는다. unresolved V2가 포함된
identity-ambiguous 구간에는 다른 unresolved V1/V2 handshake를 함께 열지 않고, 유일한
Start·Stop 또는 caller 결속으로 id를 정한 뒤 병렬 spawn을 재개한다. 이미 id가 연결된 active
V1/V2는 병렬로 유지한다. structured V2 자식의 caller는 active unresolved 선언 부모가
V1이어도 V2여도 정책 검사와 같은 트랜잭션에서 결속하며, 거부 시 원장을 바꾸지 않는다.
Pre/Post matcher는 정확한 내장 이름 외에 `[A-Za-z0-9_-]{1,64}spawn_agent` flat 이름을
전달한다. suffix 도구는 공백 없는 `task_name`과 비어 있지 않은 문자열 `message`가 모두
있을 때만 V2 spawn으로 센다. 다만 Codex의 custom V2 namespace 규칙상 예약된 `mcp`,
`mcp__*`, Responses namespace는 같은 shape라도 통과시키고 원장에는 넣지 않는다. flat
이름은 namespace provenance를 증명하지 못하므로 이는 보수적인 shape 분류이며, shape가
없는 suffix 호출도 통과시킨다.
Pre acknowledgement는 60초, running lifecycle lease는 30분이다. 실제 Start 뒤 실패 Post가
와도 Stop 또는 lease expiry 전에는 running 관찰을 숨기지 않는다. failed/expired 예약에
연결된 pending/running agent의 실제 Start는 running lease와 Stop 장벽을 다시 열되 실패
Post evidence를 보존하고 일반 expiry reason만 지운다. 이미 stopped인 agent의 순서 뒤집힌
Start는 stop 신호를 바꾸지 않는다. 예약과 연결하지 못한 lifecycle 관찰도 세션당 12개로
제한하고 30분 뒤 Stop 계산에서 제거한다.
진행자는 `deliverable`과 `verify`를 직접 확인해 결과를 통합해야 한다.
user hook은 gdm 계약이 없는 일반 Codex spawn도 막지 않고 같은 세션 누적 12에만 포함한다.
Stop 장벽은 한 번만 continuation을 요청하고 재진입에서는 경고만 해 무한 루프를 만들지 않는다.

독립 검수는 예외적으로 pass당 정확히 1명의 **leaf 실행**이다. 검수자에는
`MAX_AGENT_DEPTH: 0`, `MAX_CHILD_AGENTS: 0`을 적용하고 병렬 검수자나 하위 검수자를 만들지
않는다. Codex/Claude 검수는 설치된 `gdm-agents/run-auditor.sh`로만 실행해 에이전트 도구와
사용자 MCP를 제거하고 자원 한도를 적용한다.

진행자는 외부 역할이 만든 루트 PID를 기록하고 종료 시 회수한다. 자원 한도 초과 시 그 PID의
하위 트리만 종료한다. NEVER: `node`, `gradle`, `vite`, `codex`, `claude` 같은 프로세스
이름으로 전역 종료하거나, 자신이 시작하지 않은 사용자 터미널·개발 서버를 정리하지 않는다.

실행 도구가 없거나 실패하면 원인을 기록하고 현재 세션이 안전하게 소유할 수 있는 역할만
직접 이어간다. 독립 검수는 같은 모델로 대체하지 않는다.
