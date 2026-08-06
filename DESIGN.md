# gdm — 개인 증거 루프 설계

> v0.9 설계 · 대상: Claude Code + Codex
> 목적: 실제 작업의 증거와 반복 실수가 다음 작업의 검증 가능한 습관으로 이어지게 한다.

## 0. 한눈에 보는 흐름

gdm은 `약속 → 증명 → 관찰 → 습관 → 비교`의 한 바퀴를 관리한다.

1. **약속**: 작업을 시작할 때 필수 조건·금지 조건과 재현 가능한 확인 항목을 기록한다.
2. **증명**: CLI가 검증 명령을 실행하고 출력·종료 코드·해시를 증거로 남긴다.
3. **관찰**: 거부된 시도, 재검증 실패, 완료 뒤 발견된 결함을 구조화한다.
4. **습관**: 서로 다른 근거에서 반복된 패턴만 후보로 만들고 사람이 채택한다.
5. **비교**: 후속 작업에서 채택한 습관의 적용 여부와 재발 여부를 기록한다.

## 1. 설계 원칙

1. **주장보다 재현**: "통과했다"는 문장 대신 명령·기대 결과·실제 출력으로 판정한다.
2. **같은 실패는 그대로 반복하지 않기**: 확인 재시도 한 번 뒤에는 달라진 전제와 증거가 있어야 한다.
3. **반복된 것만 기억하기**: 한 번의 사건이나 자동 수집 메모를 곧바로 규칙으로 승격하지 않는다.
4. **사람이 습관을 채택하기**: 후보 생성과 규칙 적용을 분리한다. gdm은 규칙 파일을 자동 편집하지 않는다.
5. **완료와 전달을 분리하기**: 검증 완료는 커밋·push·PR 권한을 뜻하지 않는다.
6. **필요한 컨텍스트만 읽기**: 계획은 파일로 남기고, 세부 지식은 해당 작업에서만 점진적으로 불러온다.
7. **판정 근거를 보존하기**: 상태는 원자적으로 저장하고 사건은 append-only로 기록한다.
8. **구현 전에 경계를 고정하기**: 가정·불확실성·허용/금지 경로·중단 조건·위험도·검증 가능성을
   preflight 계약으로 저장한다. 질문이 필요 없는 기본값은 명시하고, 범위 확장은 사유를 남긴다.
9. **회귀 수정은 실패부터 증명하기**: regression check는 동일 명령의 non-zero red 증거가
   green보다 먼저 있어야 한다. 테스트를 구현 뒤에 맞춰 쓰는 자기확증을 줄인다.
10. **위험과 판정 한계를 완료 조건에 반영하기**: high risk는 독립 검수를 요구하고,
    high+opaque는 실제 reviewer와 판단 근거가 있는 expert manual 증거를 추가로 요구한다.

이 원칙은 실제 사용 중 나타난 환각, 과잉 구현, 같은 오류의 무변화 재시도, 자동 기억의 잡음,
커밋 시점 오해에서 도출했다. 문서는 결론을 먼저 쓰고 재실행에 필요한 정보는 생략하지 않는다.

## 2. 목표 / 비목표

### 목표

1. Claude Code와 Codex에서 같은 개인 작업 계약과 증거 형식을 사용한다.
2. 완료 판정은 결정적 CLI 게이트가 한다. 검증 안 된 항목이 남으면 완료할 수 없다.
3. 실제 실수와 검수 결과를 원문 없이 구조화해 다음 습관 후보로 환류한다.
4. 습관은 사람이 채택하고, 적용 가능한 작업에서 효과를 관찰한 뒤 유지·수정·폐기한다.
5. 작업 문서와 검수보고는 다시 읽고 실행할 수 있는 위키 자산 품질로 남긴다.

### 비목표

- 사용자 전역 학습 데이터베이스, 백그라운드 데몬, 스케줄러, 텔레메트리
- 세션 전문·Obsidian 노트 원문·코드 diff를 습관 원장에 저장하는 기능
- 자동 규칙 편집, 자동 습관 채택, 자동 커밋·push·PR
- 모델 호출을 내장한 범용 에이전트 프레임워크

## 3. gdm의 작업 모델 (자체 설계의 핵심)

gdm은 작업을 **검증 항목(check) 중심**으로 표현한다.

> 작업이란 "확인 항목들을 전부 초록으로 만드는 일"이다.
> 확인 항목은 처음부터 재현 가능한 형태(명령 + 기대 결과)로 적는다.

### 상태 파일 (`.gdm/<작업슬러그>/`)

| 파일 | 성격 | 내용 |
|---|---|---|
| `work.md` | 사람용, 역피라미드 | 결론(현재 상태) → 목표 → 진행 기록. 세션이 갱신 |
| `checks.json` | 기계용 | `[{id, 설명, cmd(재현 명령), expect(기대 관찰), observed(출력 파일 경로), status}]` |
| `journal.jsonl` | append-only | 모든 CLI 호출 이벤트 (감사·재개·회고용) |

check의 상태 전이는 CLI만 할 수 있다:
`open → red(regression만, non-zero 증거) → proven(gdm pass가 exit 0 + 출력 sha256 기록) → audited(P2)`

work 계약에는 필수·금지 조건 외에 `assumptions`, `uncertainties`, `allowedPaths`,
`forbiddenPaths`, `stopConditions`, `risk`, `verification`, `simplificationRequired`가 들어간다.
새 작업은 init 시점의 Git 파일별 내용 지문을 baseline으로 저장한다. `done`은 baseline 이후
바뀐 파일만 계산하므로 init 전에 존재한 로컬 수정은 범위 위반으로 오인하지 않는다.
경로는 glob이 아니라 저장소 상대 prefix이며 금지 prefix가 허용 prefix보다 우선한다.
기존 상태에는 `low`, `deterministic`, 전체 경로 허용, 간소화 선택의 기본값을 적용한다.

### 증거의 정의 (환각 방지 규칙의 기계화)

증거 = **재현 명령 + 기대 + 실제 출력 파일(sha256 해시 포함)**. "테스트 통과했음"이라는
문장은 증거가 아니다. 자동 항목의 증거는 **CLI가 직접 생산한다**: `gdm pass`가
cmd를 실행해 출력을 `.gdm/<슬러그>/out/`에 저장·해시하고, exit 0일 때만 통과시킨다
(cmd는 "기대 충족 시에만 성공"하도록 작성하는 것이 계약). `gdm done`은 증거 파일의
현존과 해시 일치를 재검증한다 — pass 이후 삭제·변조된 증거로는 완료할 수 없다.
수동 확인만 가능한 항목(UI 등)은 `--manual` + 확인 기록 파일 제출로만 허용.
check는 `regression|behavior|edge|static|manual`로 분류한다. `--simplify` 계약은 proven
`static` check를 요구하되, 라인 수 감소 같은 휴리스틱은 품질 증거로 인정하지 않는다.
`high+opaque`의 `--expert` manual check는 reviewer와 note가 모두 있어야 하며 AI가 스스로
전문가를 자칭해 채울 수 없다.
거부된 시도(실패한 pass/done)도 journal에 기록되어 회고(retro)의 입력이 된다.

## 4. 전체 아키텍처

```
┌─ L1. 스킬팩 (마크다운, 양 CLI 공용) ─────────────────────┐
│  실행:  gdm:go (경량)   gdm:full (검수 포함 중량)         │
│  전달:  gdm:pr (이슈→PR→CI)                              │
│  보조:  gdm:plan  gdm:review  gdm:analyze  gdm:research  │
│  화면:  gdm:ui  gdm:design      DB:  gdm:db              │
│  회고:  gdm:reflect (습관 후보)                          │
└──────────────┬───────────────────────────────────────────┘
               │ 스킬이 bash로 호출
┌─ L2. gdm CLI (TypeScript, 결정적 상태 머신) ──────────────┐
│  gdm plan|pass|recheck|done             ← 작업 상태·게이트│
│  gdm status|resume|retro                ← 현황·재개·회고  │
│  gdm audit|delivery                     ← 검수·전달 게이트│
│  모델 호출·네트워크 없음, JSON 입출력 + exit code           │
└──────────────┬───────────────────────────────────────────┘
               │ P5+
┌─ L3. 오케스트레이터 ───────────────────────────────────────┐
│  gdm run -p <프로젝트> "<작업>" / ps / log / watch / notify│
└───────────────────────────────────────────────────────────┘
```

### gdm:go와 gdm:full

| | gdm:go | gdm:full |
|---|---|---|
| 용도 | 중소 작업 일상 루프 | 배포 수준 중량 작업 |
| 완료 조건 | 모든 check가 proven | proven + 검수 통과 + 마무리 절차 |
| 검수 | 없음 (CLI 게이트만) | 새 컨텍스트의 독립 검수자 1명 |
| 전달 | 계약의 커밋 상태 확인 | 계약 확인 + 검수보고 + 사용자가 요청한 전달 산출물 |

같은 상태 파일을 공유한다. full은 go의 상위 호환.

### 검수(audit) 설계 — 역할 1명, 산출물은 문서

- 새 컨텍스트의 읽기 전용 검수자. 실행자의 문장을 믿지 않고
  checks.json의 observed 파일과 diff를 직접 열어 확인한다.
- 판정 어휘: **통과 / 반려** (반려 시 반려 사유가 새 check로 환원된다)
- 산출물: `검수보고` — 토스 라이팅 역피라미드로 작성 (결론 → 근거 → 세부).
  그대로 wiki-ingest 가능한 포맷이다. 작업 뒤에도 판단 근거를 재사용할 수 있다.
- 판정에는 보고서 해시, 구현·검수 모델, 실제 워크트리 내용 지문을 함께 묶는다. 보고서나
  소스가 바뀌면 판정은 무효이며, 같은 내용을 커밋해 HEAD 표현만 바뀐 경우에는 유지된다.
- 역할을 늘리지 않는 근거: 독립 검수의 가치는 새 컨텍스트에서 나오고,
  세부 관점(리뷰/QA/슬롭)은 검수 체크리스트로 흡수한다. 실사용에서 반복적으로
  놓치는 유형이 `gdm retro`로 확인되면 그때만 역할 분리를 검토한다.
- 검수자는 pass당 정확히 1개의 leaf 프로세스이며 하위 에이전트를 만들 수 없다.
  `gdm-agents/run-auditor.sh`가 Codex multi-agent와 사용자 MCP를 끄고 Claude 도구를
  읽기 전용으로 제한한다. 시간·프로세스 수·RSS를 넘으면 실행기가 자신이 만든 PID 트리만
  종료하며, 이름 기반 Node/Gradle/Vite 전역 정리는 금지한다.

### 역할 실행과 독립 검수 (v0.7)

현재 대화를 맡은 **진행자**가 사용자 상호작용·gdm 게이트·종합을 소유한다. 실제 실행은
진행자 고정이 아니라 작업의 독립 경계, 필요한 전문성, 컨텍스트 분리 이득에 따라 현재
세션과 서브에이전트 사이에 배정한다. 다른 모델이 더 적합한 역할은 비대화형 CLI로 위임한다.

| 역할 | 기본 실행 주체 | 상황별 위임 기준 |
|---|---|---|
| 계획·조사·리뷰 | 진행자 + 필요한 서브에이전트 | 독립 축이나 새 컨텍스트가 결과 품질을 높일 때 |
| 경량·중량 구현 | 실제 구현 모델의 진행자 또는 워커 | 파일·모듈 소유권을 겹치지 않게 나눌 수 있을 때 |
| 최종 검수 | **실제 구현 주체와 다른 모델** | 항상 새 컨텍스트의 단일 leaf |

불변식: **검수 모델 ≠ 실제 구현 모델**. 구현 주체와 다른 맹점을 확보하기 위한 규칙이며
역할 선호보다 우선한다.
계약 정본은 `skills/_shared/routing.md`이고, 각 스킬은 자기 역할 규칙을 인라인으로 갖는다
(install.sh가 `_shared`를 설치하지 않으므로 런타임 자립이 필요). 범위는 역할별 라우팅까지 —
세션 밖 실행 관리와 모델별 성능 비교는 실제 회고 데이터가 쌓인 뒤 판단한다.

탐색·조사·리뷰뿐 아니라 구현과 검증도 독립 경계가 있으면 서브에이전트로 위임한다. 일반
서브에이전트는 leaf가 아니며, 작업 중 새 독립 경계를 발견하면 같은 기준으로 하위 위임할 수
있다. 여러 구현 워커는 겹치지 않는 파일·모듈을 소유하고 진행자가 통합한다. 독립 검수의
모델 판정이 필요한 gdm-full 작업은 실제 구현 모델을 하나로 유지하되, 그 모델의 에이전트
수를 한 명으로 제한하지 않는다.

폭증 방지는 위임 깊이를 0으로 만드는 대신 두 개의 독립 퓨즈로 한다. 경계 단위는 하나의
네이티브 Codex 루트 세션 트리다. 그 안에서 gdm 훅은 모든 descendant가 공유하는 hook
`session_id`에서 spawn 시도를 초기 16회까지 허용한다. 16회를 다 쓴 뒤에는 pending/running
역할이 하나도 없을 때만 다음 spawn에서 4회분을 자동으로 열고, 생애 누적 32회에서 완전히
차단한다. primary를 제외한 열린
spawned-agent thread의 동시 4는 현재 세션의 유효
`[agents] max_concurrent_threads_per_session = 4`일 때 Codex가 강제하는 네이티브 상한이다.
사용자 `config.toml` 값은 CLI·프로필·프로젝트 계층이 덮을 수 있으므로 doctor는 사용자 설정과
현재 세션 유효값을 구분하고 `/debug-config` 확인을 안내한다.
실패·취소도 예산을 돌려주지 않아 무한 재시도형 팬아웃을 막고, 활성 역할이 남은 동안에는
다음 예산 파동을 열지 않는다. 첫 Pre 뒤 같은
`tool_use_id`가 다시 들어오면 실제 handler가 이미 실행됐는지 훅이 증명할 수 없으므로, 동일한
`tool_input`·protocol·caller라도 즉시 거부한다. 이 재전달은 새 attempt로 세지 않으며, 같은
id의 입력·caller가 바뀌는 경우도 충돌로 거부한다. Pre보다 먼저 온 unmatched Post 기록도
세션당 32개로 제한하고, 동일 Post replay만 상태 변경 없이 허용한다.
비대화형 CLI나 별도 Codex 세션까지 합친 논리 작업 전체에는 이 원장을 공유할 수 없으므로,
진행자가 동시 4·초기 16·4회 자동 확장·절대 누적 32를 지키는 협력적 운영 규칙을 적용한다.

gdm 워크플로의 각 spawn 메시지 첫 줄에는
`GDM_AGENT_ENVELOPE_V1=<단일행 JSON>` 계약을 넣는다. 역할·범위·읽기/쓰기 소유권·산출물·
검증법·종료조건·의존성·위임 가능 여부·자식 quota·깊이를 명시하고, PreToolUse 훅이 형식,
중복 task id, 활성 structured 역할의 중복 scope, 경로 별칭을 정규화한 쓰기 소유권 충돌,
누적 예산을 검사한 뒤 원자적으로 예약한다. 첫 줄 marker의 들여쓰기나 필드의 앞뒤 공백은
일반 spawn으로 강등하지 않고 잘못된 계약으로 거부한다. user hook을 쓰더라도 gdm을 사용하지
않는 일반 Codex spawn은 envelope가
없다는 이유로 막지 않는다. 이런 unmarked spawn도 같은 세션 절대 누적 32에는 포함하되 구조
정책만 적용하지 않는다.

PostToolUse와 SubagentStart/Stop은 실행 결과와 관찰된 turn 상태를 원장에 조정한다. Codex V1은
성공 Post가 주는 최상위 agent id를 쓰고, 하위 hook의 caller agent id는 structured와
unstructured 예약 모두에 결속한다. lifecycle 순서만으로 추정한 V1 연결은 provisional이며
소유권 해제나 `blockedBy` 충족에 쓰지 않는다.

Codex V2는 `tool_input.task_name` 존재로 구분한다. V2 성공 Post의 `task_name`은 입력 leaf가
아니라 `/root/child/grandchild` 같은 canonical AgentPath일 수 있고 agent id가 없으므로 신원
근거로 쓰지 않는다. 대신 unresolved V2가 포함된 identity-ambiguous 구간에는 다른 unresolved
V1/V2 handshake가 함께 생기지 않게 직렬화하고, 유일한 Start·Stop 또는 caller 결속으로 id가
정해진 뒤 병렬 spawn을 다시 허용한다. 이미 id가 연결된 active V1/V2는 이 직렬화 대상이 아니다.
structured V2 자식의 실제 caller는 active이지만 아직 id가 없는 선언 부모가 V1이어도 V2여도
한 트랜잭션 안에서 부모를 먼저 결속할 수 있다. 이후 정책이 거부되면 이 결속도 기록하지 않는다.

Pre/Post 설치 matcher는 정확한 내장 이름과, 공식 namespace 문자 집합
`[A-Za-z0-9_-]{1,64}` 뒤에 `spawn_agent`가 붙은 flat tool 이름을 전달한다. 내장 이름이 아닌
suffix 도구는 공백 없는 `task_name`과 비어 있지 않은 문자열 `message`가 모두 있을 때만 V2
spawn으로 원장에 기록한다. 단, Codex가 custom V2 namespace로 금지하는 `mcp`, `mcp__*`,
Responses 예약 namespace는 같은 suffix와 shape를 가져도 통과시키고 예산에 세지 않는다.
그 밖의 suffix 도구도 shape가 없으면 통과시킨다. Codex가 전달하는 flat tool 이름만으로는
실제 namespace 출처를 증명할 수 없으므로 이 검사는 provenance 인증이 아니라 보수적인
wire-shape 분류다.

Pre 예약은 60초 acknowledgement 유예를 가진다. Post·Start로 running이 확인되면 30분
lifecycle lease로 바뀌며, lease expiry는 내부 Stop 장벽과 선언 소유권을 풀기 위한 정리일 뿐
실제 thread 종료나 성공 증명이 아니다. 실제 Start가 관찰된 뒤 실패 Post가 와도 그 agent는
Stop 또는 lease expiry까지 running으로 남겨 숨기지 않는다. 반대로 failed 또는 expired
예약에 이미 연결된 pending/running agent의 실제 Start가 뒤늦게 오면 running lease를 다시
열고 Stop 장벽을 복구한다. 실패 Post의 outcome·reason은 보존하고 일반 lease-expiry reason만
지운다. 이미 stopped로 관찰된 agent의 순서 뒤집힌 Start는 stop 신호를 바꾸지 않는다. 예약과
연결하지 못한 lifecycle 관찰도 30분 뒤 Stop 계산에서 제거하고 세션당 32개로 제한해 rogue
event가 영구 장벽이나 무제한 원장이 되지 않게 한다. 상태 요약은 파일을 다시 쓰지 않아도
만료 시각이 지난 active 예약을 effective `expired`로 집계한다. 원장 쓰기는 임시 파일 fsync와
rename 뒤 가능한 파일시스템에서 디렉터리 fsync를 best effort로 수행한다. stale lock은 PID뿐
아니라 Linux `/proc` 또는 macOS 고정 `/bin/ps`에서 얻은 process-start identity가 정확히
일치할 때만 유지해 PID 재사용으로 인한 영구 고착을 피한다.

하위 hook에 caller agent id가 있고 원장의 structured 부모와 일대일로 결속되면
`parentId`, `childQuota`, `canDelegate`, `depth`를 기계적으로 검사한다. root 호출은
`parentId=root`, `depth=1`이어야 한다. caller id를 제공하지 않는 호환 런타임에서는 원장에
선언한 부모가 있을 때만 그 부모의 nonterminal/quota/depth/canDelegate를 검사하는
degraded fallback을 쓴다. 이 fallback을 부모 신원 하드 경계라고 주장하지 않는다. 훅이
실행되면 같은 세션의 초기 16·4회 자동 확장·절대 누적 32가 계속 강제되고, 동시 4는 현재
세션의 유효 Codex 상한이 4일 때 강제된다.
훅 sequencing에서 `blockedBy`를 만족하는 내부 상태는 id와 연결된 `stopped`뿐이다.
여기서 `SubagentStop`은 한 turn의 stop 시도 관찰이자 순서 힌트이며, thread의 영구 종료나
성공을 뜻하지 않는다. `failed|expired`는 활성 소유권과 Stop 장벽에서는 빠지지만 의존성을
충족하지 않는다. follow-up·agent 재사용·interrupt의 실제 처리와 이후 재개는 이 훅 집합에서
관찰할 수 없으므로, `blockedBy`와 ownership release를 hard safety나 작업 완료 판정으로 쓰지
않는다. 진행자가 `deliverable`과 `verify`를 직접 확인하고 workflow 결과를
`completed|failed|cancelled|inconclusive` 중 하나로 판정해 통합해야 한다. Stop 반환도 다른
훅보다 우선하는 절대 차단이 아니라 한 번의 continuation guardrail이다. 설치기는 기존 `~/.codex/hooks.json`과
`config.toml`을 보존해 gdm handler만 병합하며, 설치와 실행 신뢰는 구분한다. 새 command
hook은 사용자가 Codex `/hooks` 화면에서 신뢰 상태를 확인해야 한다.

빈 슬롯이 없으면 기다리거나 기존 역할을 재사용한다. 같은 범위를 다시 넘기는 자기복제형
재귀와 끝이 정해지지 않은 팬아웃은 금지한다. 최종 검수자만 독립성·판정 일관성을 위해 항상
1명의 leaf이며, gdm doctor는 동시성 상한과 훅 설치·활성·신뢰 미확인 상태를 구분해
보고한다.

## 5. 실사용 신호와 기능 우선순위

기능은 추측이 아니라 개인 작업 기록에서 반복된 수요를 기준으로 추가한다.

| 관찰된 작업 | 누적 빈도 | gdm 반영 |
|---|---:|---|
| 스크린샷 기반 화면 확인 | 498회 | gdm-ui의 시각 증거 루프 |
| DB 스키마·쿼리 작업 | 230회 | gdm-db의 구조·데이터 검증 |
| PR 생성·CI 감시 | 179회 | gdm-pr의 전달 파이프라인 |
| 원인 진단 | 122회 | gdm-analyze의 증거·추론 분리 |
| 프로젝트 명령 재입력 | 반복 | gdm preset과 `@` 참조 |
| 완료 뒤 발견된 결함·재검증 실패 | 반복 | miss·retro와 습관 후보 원장 |

새 역할이나 규칙은 반복 사건이 확인될 때만 추가한다. 일회성 해결 절차와 미완성 아이디어는
지속 컨텍스트로 승격하지 않는다.

## 6. 저장소 구조

```
~/projects/gdm/
├── DESIGN.md
├── skills/                  # 소스 오브 트루스
│   ├── go/SKILL.md
│   ├── full/SKILL.md
│   ├── plan/SKILL.md  review/SKILL.md  analyze/SKILL.md  research/SKILL.md
│   └── _shared/             # 검수 체크리스트, 문서 포맷 규칙
├── agents/                  # 검수자 프롬프트(auditor.md/design-auditor.md) — install이 스킬 옆 gdm-agents/로 설치
├── cli/                     # gdm 바이너리 (TypeScript)
│   ├── src/{state,store,contract,attempt}.ts
│   ├── src/{audit-integrity,delivery,repository-lock}.ts
│   ├── src/{cli,cli-args,delivery-cli,version}.ts
│   ├── src/{codex-agent-hook,codex-agent-hooks-config,agent-cli}.ts
│   └── test/
├── install/install.sh       # 심링크 설치 + PATH
└── README.md
```

- 스킬 포맷은 양 CLI 동일(SKILL.md + front-matter) — 확인 완료.
- 배포: 개발 중 install.sh, 안정화 후 nix home-manager 번들 승격.
- 버전 정본은 `cli/package.json` 하나이며 CLI와 릴리스 태그 검증이 이를 읽는다.
- 상태 변경 명령은 저장소 단위 PID 잠금으로 직렬화해 병렬 실행의 갱신 유실을 막는다.

## 7. 스킬 개요

공통 계약: 상태 기록은 gdm CLI 경유만 / 완료 주장 전 증거 3요소 /
프롬프트는 prompt-patterns.md 준수(제약이 능력보다 먼저) / 프롬프트는 전부 자작.

- **gdm:go** (P1): brief → preflight가 포함된 `gdm plan init` → 종류별 check 등록 → regression red →
  구현·`gdm pass` 반복(CLI가 cmd 실행·판정) →
  전 check proven 시 `gdm done`(증거 재검증 포함). 막히면 `gdm plan edit --reason`을 journal에 남기고 계속.
  재개: `$gdm:go --resume`.
- **gdm:full** (P2): go 흐름 + 제한 실행기로 단일 leaf 검수자 실행 → 통과/반려 →
  반려는 check로 환원 → 통과 시 마무리 절차(커밋 규칙 검사, PR 본문, 검수보고).
- **gdm:plan / review / analyze** (P3), **gdm:research** (P4): 계획·리뷰·원인 분석·최대 4개 축 제한 병렬 조사.
- **gdm:pr**: 이슈→브랜치→커밋→PR→CI 감시 파이프라인. 계약 게이트와 `delivery`의
  HEAD·PR·명시적 머지 승인 기록이 맞고 현재 HEAD에 알려진 CI 실패가 없을 때만 전달한다.
  CI 체크가 없는 저장소는 통과 기록을 요구하지 않는다.
- **gdm:ui / gdm:design**: 화면 수정(스크린샷 피드백)과 0→1 화면 디자인 루프. 시각 검수자는 구현자와 다른 벤더.
- **gdm:db**: 스키마·쿼리·마이그레이션·데이터 검증.
- **gdm:reflect**: 게이트 증거와 사용자 노트에서 반복 패턴을 찾아 습관 후보를 만든다(사람이 채택).

## 8. 로드맵

| Phase | 내용 | 완료 기준 |
|---|---|---|
| P1 | work 상태 머신·증거 게이트·gdm-go | 실제 작업 1건을 증거로 완료 |
| P2 | 독립 검수·audit·retro | 중량 작업에서 실제 결함을 반려·보완 |
| P3 | plan·review·analyze·research | 주요 작업 유형을 1주간 재사용 |
| P4 | 작업 계약·재시도 게이트·습관 원장 | 관찰부터 후속 작업 평가까지 한 바퀴 완주 |
| P5 | 프로젝트 밖 실행 관리·알림 | 장시간 작업의 상태와 결과를 원격 확인 |
| P6 | 위키 연동과 장기 지표 점검 | 원문 노출 없이 개인 습관을 정기 검토 |

각 단계는 실제 사용 증거가 다음 단계의 필요성을 보여줄 때 확장한다.

## 9. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 검수 1명이 결함을 놓침 | retro로 놓친 유형 추적, 반복 유형만 역할 분리 승격 |
| check 선정 자체가 부실 (검증 항목 누락) | start 단계에서 check 목록을 사용자에게 확인받는 옵션(중량 작업 기본 on) |
| 구현이 테스트에 정답을 맞춤 | regression check는 수정 전 동일 명령의 red 실패 증거를 의무화 |
| 요청 밖 동반 변경·기존 dirty 오인 | init 파일별 baseline과 상대 prefix 계약으로 이후 delta만 판정 |
| high risk를 자동 검사만으로 과신 | 독립 audit 자동 요구, high+opaque는 출처가 있는 expert manual 증거 추가 |
| "간소화"를 라인 수로 추측 | `--simplify`가 프로젝트별 proven static check를 요구하고 크기 휴리스틱은 금지 |
| 게이트 과잉 엄격 → 우회 | plan edit --reason으로 정식 완화 경로, journal 기록으로 사후 조정 |
| CLI 포맷 변경 | 소스는 repo, 설치는 어댑터로 격리 |
| 규칙이 쌓여 컨텍스트가 다시 오염됨 | 반복 사건 2개 이상만 후보화, 적용 결과가 없으면 폐기 검토 |
| 자동 기억이 잘못된 규칙으로 승격됨 | 원문과 후보를 분리하고 사람의 명시적 채택을 필수화 |
| 완료를 커밋 허가로 오해 | 작업 계약의 커밋 상태를 별도 필드와 읽기 전용 게이트로 관리 |
| 서브에이전트 재귀 팬아웃으로 로컬 자원 고갈 | hook root session 초기 16·idle 시 4회 자동 확장·절대 누적 32 + effective Codex 동시 상한이 4일 때 네이티브 제한 + 자기복제형 위임 금지 |
| 훅 설치를 곧 실행 강제로 오해 | 설치·feature 활성·사용자 신뢰를 doctor에서 별도 상태로 표시하고 `/hooks` 확인 안내 |

## 10. 미결 사항

- [ ] 두 CLI에서 gdm 호출 시 권한 프롬프트 처리 확인
- [ ] 스킬 이름 최종 확정 — go/full은 자리표시자. 실사용 후 입에 붙는 말로 rename
- [ ] Telegram 연동 방식 (P5)

## 11. 결정 로그

- 2026-08-04: **AI 작업 preflight·proof·scope 게이트 추가.** init에 가정·불확실성·허용/금지
  경로·중단 조건·위험도·검증 가능성·간소화 계약을 기록하고 파일별 baseline 이후 delta만
  범위 판정한다. regression은 동일 명령의 red→green을 강제한다. high risk는 audit을 자동
  요구하고 high+opaque는 출처와 근거가 있는 expert manual 증거를 추가로 요구한다. 기존
  상태는 안전한 legacy 기본값으로 정규화하며, 에이전트 동시 상한 4와 전달 승인 정책은 유지한다.
- 2026-07-30: **고정 누적 한도를 유휴 시 자동 확장되는 예산 파동으로 교체.** 초기 16회가
  소진되면 pending/running 역할이 0일 때만 다음 spawn에서 4회분을 자동으로 열고, 활성
  fanout 중에는 확장하지 않는다. root session 생애 누적 32와 effective 동시 4는 하드
  퓨즈로 남겨 과거 1,688개 프로세스 폭증 유형을 막는다. 사용자는 예산 숫자를 지정하지 않는다.
- 2026-07-28: **재귀 위임 계약을 런타임 원장으로 연결.** `GDM_AGENT_ENVELOPE_V1`으로
  역할·소유권·종료조건·의존성을 전달하고, Pre/PostToolUse와 SubagentStart/Stop 훅이
  예약·실행 결과·관찰된 turn-stop을 세션 원장에 기록한다. 훅이 실행되는 root session 누적 16은 하드
  퓨즈이고, 동시 4는 현재 세션의 effective Codex 설정이 4일 때 네이티브 하드 퓨즈다.
  호출자 신원이 없는 호환 경로에서 부모별 quota를 완전 강제한다고 주장하지 않는다. Stop
  장벽과 command hook 신뢰도 각각 continuation guardrail과 사용자 확인 상태로 명시한다.
- 2026-07-28: **안전 제한과 위임 판단을 분리.** 일반 서브에이전트의 재귀 위임과 구현
  위임을 금지하지 않는다. 독립 경계·전문성·컨텍스트 분리가 유리하면 어느 세대든 다음
  역할을 만들 수 있다. 폭증은 root session 누적 16과 운영 상한 4로 막고, 현재 세션의
  effective Codex 동시 상한이 4이면 네이티브 퓨즈도 함께 적용한다. 같은 범위를 다시 넘기는
  자기복제형 재귀만 금지한다. 단일 leaf는 최종 검수자에만 적용한다.
- 2026-07-23: **서브에이전트 전면 차단을 동시성 안전 퓨즈로 교체.** 16GB Mac에서 Codex 상한
  `1000`이 MCP·Node 자식 1,688개와 swap 46GB를 만든 실측 사고를 근거로 전역 상한을
  사용자 `[agents] max_concurrent_threads_per_session = 4`로 낮췄다. gdm doctor는 사용자
  설정의 상한 누락, 구형 `multi_agent_v2`, 8개 초과를 경고하고 현재 세션 effective 값은
  `/debug-config`로 구분해 확인하도록 안내한다.
- 2026-07-02: CLI 어휘 확정 — `plan / pass / done / audit / resume / retro`. 기준: CLI는 모델이
  치고 사람은 읽으므로 역할 가독성 우선. 스킬 이름은 `go`/`full` **자리표시자** —
  실사용 후 입에 붙는 말로 rename (사용자 합의)
- 2026-07-02: 런타임 bun 확정 (1.3.14 설치 확인) — 개발·테스트는 bun 직접 실행,
  배포는 `bun build --compile` 단일 바이너리 → `~/.local/bin/gdm`

- 2026-07-10: **gdm-design 스킬 — 0→1 화면 디자인 루프.** 화면을 0에서 만드는 품질이
  실행 모델의 내장 취향에 좌우되는 문제를 구조로 해소: (1) 방향 기본 2안 선매(레이아웃
  갈림은 ASCII 와이어프레임 비교) (2) 계약 두 층 — 프로젝트 층(코드 토큰 파일 정본 +
  30줄 이내 의도 문서, 화면 간·세션 간 일관성 담당)과 작업 층(spec.md, 구조/스타일 채널
  분리) (3) 렌더 스크린샷 9항목 채점표 + 라이브 점검(Tab·hover — 정적으로 판정 불가 항목
  구분) (4) 기계 게이트 — 하드코딩 색 검사, axe 바닥선, 콘솔 클린을 자동 check로
  (5) 시각 검수자(agents/design-auditor.md)는 구현자 반대 벤더, 스크린샷 직접 재채점.
  설계 근거는 외부 워크플로우 실측 조사: 상용·오픈소스 도구 전반이 "디자인 시스템
  단계와 화면 생성 단계 분리 + 파일이 일관성 캐리어"였고, 반박 검증에서 (a) 지침
  문서만으로는 준수가 보장되지 않음(세션 진행마다 준수율 하락 실측 — 그래서 정본은
  코드 토큰 + 기계 검사) (b) axe exit 0은 접근성 보장이 아님(독립 측정 탐지율
  29~40%, 이미지·그라데이션 위 텍스트는 무검사 통과 — 그래서 "자동 검출 위반
  0건"까지만 주장하고 채점표가 커버)이 확인됨. 기존 화면 부분 수정(gdm-ui)과 역할
  분리 — 이 스킬은 0→1·전면 리디자인 전용. 실전 데모(로그인 리디자인)에서 밟은
  함정을 즉시 환류: 프리플라이트 0단계(게이트 가용성 사전 선언), 대비 게이트를
  node 스니펫으로 기계화(암산 금지), Chrome headless 모바일 폭 클램프 함정과
  iframe 하니스 레시피, 멀티 화면 프로토콜(대표 화면으로 시스템 확정 후 전개),
  구현 미세 규칙은 CRAFT.md로 점진 공개
- 2026-07-09: **v0.7.0 — 역할 실행과 독립 검수.** 현재 대화의 진행자가 사용자 문답과 gdm
  게이트를 소유하고, 계획 초안·중량 구현·리뷰는 역할에 맞는 실행 주체에게 맡긴다. 비대화형
  CLI 위임을 사용해도 실제 구현 주체를 기록한다. 최종 검수 모델은 현재 대화가 아니라
  **실제 구현 모델의 반대편**에서 고른다. 경량 구현은 진행자가 직접 수행한다. 계약 정본
  `skills/_shared/routing.md`를 신설하고 각 스킬의 자립 규칙과 동기화했다.
- 2026-07-05: **v0.6.0 — 성능 차별화 라운드.** (1) 자기 튜닝 루프: `gdm miss`(게이트 통과 후
  발견 결함 기록)·`retro --all`(전 작업 횡단 집계 + 규칙 기반 개선 제안) — 게이트 구멍이 측정·
  환류되는 구조. (2) gdm-full 검수자를 실제 구현 모델과 다른 CLI의 새 컨텍스트로 실행 — 동일 모델 맹점
  상쇄. (3) 프롬프트 개선: auditor에 실측 탈출 결함 6유형 시드 체크리스트+통과 판정 few-shot,
  실행 계열 스킬 탈처방화(절차 나열→계약+판단 위임, go 프로세스 6→4단계)
- 2026-07-03: **v0.5.0 — 실사용 데이터 기반 개인화.** history.jsonl 3,448건 실측:
  스크린샷 확인 498회 / DB 작업 230회 / PR·CI 179회 / 원인 진단 122회. 반영:
  gdm-pr 스킬 신설(이슈→브랜치→커밋→PR→CI 감시, 실패 로그 진단), `gdm preset`
  (프로젝트 표준 명령 등록, check에서 @이름 참조 — 등록 시점에 실제 명령으로
  치환해 증거 재현성 유지), go/full에 UI 증거·DB 검증 관행, analyze에 로그-우선 절차
- 2026-07-02: **v0.4.0 — P2~P4 스킬팩 완성.** 검수(audit) 게이트를 상태 머신에 내장:
  `plan init --audit` 작업은 done이 검수 통과를 요구하고, 판정 시점 checks 스냅샷
  해시(stateHash)로 검수 후 상태 변경 시 자동 무효화. 검수자는 이중 포맷(md/toml)
  대신 프롬프트 파일(agents/auditor.md)을 별도 컨텍스트에 전달하는 방식으로 단순화.
  현재는 제한 실행기가 단일 leaf와 자원 한도를 구조적으로 적용한다. 스킬 6종 완성:
  go/full/plan/review/analyze/research
- 2026-07-02: **v0.3.0 기능 추가** — `recheck`(통과 항목 재실행으로 회귀 검출, done의 해시
  검사가 못 잡는 코드 회귀 보완), `status`(전 작업 현황), `retro`(journal 회고 — P2에서 조기
  구현, 거부·수정·재검증 이력 집계), 알 수 없는 플래그 감지(오타 조용한 무시 차단)
- 2026-07-02: **셀프 리뷰(8관점) 반영, 게이트 재설계** — 자동 항목의 증거는 gdm이 직접
  생산(pass가 cmd 실행·저장·sha256), done이 증거 현존·해시 재검증, 거부 시도 journal 기록,
  상태 파일 손상 방어(validateWork)·원자적 쓰기·슬러그 경로 순회 차단. **증거의 위협
  모델(정직한 한계):** gdm이 cmd를 직접 실행해 증거를 만들므로 "테스트 통과했다"는 *환각·
  부주의*한 완료 주장은 게이트를 통과하지 못한다. 다만 실행 모델이 `.gdm/` 상태 파일을
  직접 편집(파일과 해시를 함께 위조)하는 *능동적 조작*까지 막지는 못한다 — 이 잔여 위험은
  "상태는 gdm CLI로만 수정한다"는 프롬프트 규칙에 의존하며, 완전한 구조적 봉쇄는 gdm 프로세스
  밖의 신뢰 앵커(별도 권한·서버) 없이는 불가능하다.
- 2026-07-02: **개인 설계 원칙 채택** — 작업 모델을 검증 항목(check) 중심으로 설계하고,
  기능과 문체의 근거를 실제 사용 기록과 개인 규칙 문서에 둔다.
