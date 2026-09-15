# gdm 역할·역량 배정 계약

> 저장소 정본. `install.sh`는 `_shared`를 설치하지 않으므로 각 스킬은 자기 역할 규칙을
> SKILL.md에 인라인하고 이 문서를 사람이 보는 정본으로 인용한다. 규칙을 바꾸면 관련
> 스킬의 인라인 규칙도 함께 고친다.

## 책임

현재 사용자와 대화하는 루트 세션이 **진행자**다. 진행자는 사용자 문답, 작업 계약,
변경 통합, gdm 게이트, 최종 보고를 소유한다. 역할 실행을 다른 프로세스에 맡기더라도 이
책임은 넘기지 않는다.

사용자의 명시적 지시와 기존 승인은 아래 기본 절차보다 우선한다. 승인된 구현은 계획이나
도구 선택 때문에 다시 승인을 기다리지 않는다. 필요한 결정만 질문하고, 별도 승인이 필요한
행위는 먼저 검토 가능한 결과를 준비한다. 중단할 때는 적용한 파일·문구와 실제 차단 원인을 밝힌다.

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
| 기술 설계 | gdm-plan | 진행자 + 선택형 Claude CLI | 진행자가 코드 근거·계약으로 계획하고 필요할 때 외부 설계안을 검증·통합한다 |
| 시각 디자인 | gdm-design | Claude Design + 진행자 | 진행자가 프롬프트를 전달하고 사용자가 Claude Design에서 생성한 뒤 진행자가 pull·구현·검증한다 |
| 경량 구현 | gdm-go | 진행자 또는 경계가 분리된 구현 워커 | 진행자가 통합하고 gdm 증거가 통과해야만 완료한다 |
| 중량 구현 | gdm-full | 한 실제 구현 모델의 진행자·워커 | 같은 모델의 여러 워커는 허용하고 독립 검수 전 전달하지 않는다 |
| 리뷰 | gdm-review | 진행자 + 필요한 읽기 전용 역할 | 실제 diff·증거를 읽고 후보를 반증·중복 제거한다 |
| 검수 | auditor | 실제 구현 모델과 다른 모델 | 새 컨텍스트에서 직접 증거를 확인한다 |

## 실행 모델 라우팅

대화형 진입점은 Codex, Claude Code, Pi다. `ENTRYPOINT_PROVIDER: current session`,
`TECHNICAL_DESIGN_PROVIDER: coordinator`, `TECHNICAL_DESIGN_ASSIST: optional Claude CLI`,
`VISUAL_DESIGN_PROVIDER: Claude Design`을 기본값으로 쓴다.
진행자가 사용자 문답, 로컬 조사, 작업 계약, 구현, 변경 통합, gdm 게이트와 최종
보고를 소유한다. Claude Code만 사용하는 진행자는 선택한 Claude 모델로 구현하고,
외부 전문 역할도 `--provider claude`로 실행한다. Pi의 Terra·Astra 기본 배분은 Pi 실행
프로필에만 적용하며 Claude 사용자에게 OpenAI 계정을 요구하지 않는다. full의 독립성은
공급자 이름이 아닌 실제 모델 차이로 판단하므로 같은 Claude 공급자에서도 다른 모델로
검수할 수 있다. 사용 가능한 다른 모델이 없으면 full을 차단하고 일상 go와 구분한다.

- 새 아키텍처·API·데이터 모델·상태 흐름·컴포넌트 경계·마이그레이션처럼 구현 전에 기술
  선택은 진행자가 로컬 코드 근거로 판단한다. Claude CLI는 사용자가 요청하거나 로컬 조사
  후에도 남은 독립적인 설계 쟁점에 도움이 될 때 선택한다. 새 기술 선택이라는 이유만으로
  외부 호출을 강제하지 않는다. 직접 설계와 외부 설계 모두 근거·성공 조건을 확인한다.
- 0→1 화면, 전면 리디자인, "이쁘게" 같은 개방형 시각 변경은 진행자가 저장소 맥락을
  정리한 Claude Design용 프롬프트를 사용자에게 전달한다. 사용자가 claude.ai/design에서
  프롬프트를 실행하고 프로젝트 준비를 확인할 때까지 멈춘 뒤 `/design-sync`로 결과를
  pull한다. 진행자가 Chrome 제어 스킬이나 다른 브라우저 자동화를 호출해 대신 생성하지 않는다.
  기존 디자인 시스템 안의 잘림·간격·오타처럼 목표가 구체적인 결함 수정은 진행자가 gdm-ui로
  바로 처리한다.
- Claude 설계안은 코드 수정 권한이 없는 제안이다. 진행자가 인용한 파일·함수를 다시 열고
  요구·기존 변경·검증 가능성과 대조한 뒤 최종 계획에 통합한다. 근거가 틀리면 조용히
  재작성하지 말고 반려 사유와 좁힌 입력으로 한 번만 재요청한다.
- Claude Design은 claude.ai/design 안에서만 새 화면·레이아웃·프로토타입을 만든다.
  DesignSync는 프로젝트·컴포넌트 파일의 읽기·쓰기·동기화 다리이지 디자인 생성기가 아니다.
  진행자는 사용자 확인 뒤 동기화된 산출물을 기준으로 로컬 제품 코드를 작성·통합하고
  렌더·테스트·gdm 증거를 소유한다.
- 선택형 Claude CLI의 인증·권한·도구 부재·일반 오류·timeout은 실패 원인과
  `coordinator-fallback`을 기록하고 확인한 근거로 직접 설계한다. 사용자가 Claude 결과 자체를
  요구했거나 필수 근거가 없으면 해당 의존 작업만 보류하고 나머지 승인된 작업은 진행한다.
- Claude Design의 인증·권한·DesignSync 부재·프로젝트 불명확·일반 오류·timeout은
  gdm-design 계약상 필요한 산출물을 얻을 수 없는 상태다. `HTTP 429`, `rate_limit`,
  `quota exceeded`, 사용량 한도일 때의 대체는 gdm-design 계약을 따른다.
- 외부 모델에는 비밀·토큰·자격증명, 전체 대화, 전체 저장소 원문을 보내지 않는다. tool-0
  전문 역할에는 plan/analyze용 bounded code excerpt(경로·라인·내용)·계약·결정 질문 또는
  review/audit용 실제 diff·관련 source excerpt·evidence를 자동 v2의 credential-free valid
  UTF-8, 최대 1 MiB artifact에 완결적으로 넣는다. Claude CLI와 Claude Design 호출도 아래의 비대화형
  CLI 협력적 예산·PID 회수 규칙에 포함한다.

## 대화형 테스트·리뷰 도구 라우팅

gdm의 결정적 CLI 게이트는 그대로 유지하면서, 사람이 실행 과정을 함께 볼 수 있는 환경에서는
다음 선택형 companion tool을 사용한다.

- `WEB_RUNTIME_PROVIDER: terminal-browser`
- `HUMAN_REVIEW_PROVIDER: tuicr`
- `COMPANION_TOOL_POLICY: optional`

웹 UI의 실제 브라우저 동작을 확인하는 자동 check는 실행 가능한 URL 또는 로컬 HTML이 있고
실행 중인 `terminal-browser`가 있으면 gdm-go 스킬의
`terminal-browser-background-tab.sh open <url>`로 AI 전용 비활성 탭을 만든다. 헬퍼는 현재
터미널 탭 밖의 브라우저를 우선 고르고 새 탭이 `active: false`인지 확인한다. 반환된 key와 id로
`terminal-browser action --browser <key> --tab <id> -- snapshot|click|fill|eval`처럼 매번
대상을 고정하며 `--follow`는 사용하지 않는다. 검증이 끝나면
`terminal-browser-background-tab.sh close <key> <id>`로 AI가 만든 탭만 닫는다.

자동 검증은 `terminal-browser open`이나 `--split`을 호출하지 않으므로 사용자 tmux pane,
브라우저 활성 탭, 현재 화면을 바꾸지 않는다. 사용자가 화면 공유를 명시적으로 원할 때만
terminal-browser 스킬의 대화형 open 절차를 별도로 사용한다. 실행 중인 브라우저가 없거나
백그라운드 탭을 만들 수 없으면 화면을 새로 열지 말고 프로젝트 표준 headless 테스트로 폴백한다.
기계적으로 판정할 수 있는 동작은 action 명령과 assertion을 check의 `cmd`에 넣어 gdm이
출력·exit code를 증거로 저장하게 한다. 시각 판정은 백그라운드 탭의 스크린샷이나 manual
check 근거를 별도로 남긴다.

terminal-browser는 단위·통합 테스트, 프로젝트의 Playwright 같은 자동 브라우저 테스트,
빌드·타입 검사를 대체하지 않는다. 웹 UI가 아닌 check에는 열지 않는다. 명령·지원 터미널·
실행 URL이 없거나 CI 같은 비대화형 환경이면 프로젝트 표준 headless 테스트 또는 기존 manual
증거 흐름으로 폴백한다. 사용자가 terminal-browser 자체를 필수로 지정한 경우에만 부재를
차단으로 취급한다. Claude Design 생성은 이 라우팅의 대상이 아니며 기존 금지 규칙을 유지한다.

사람이 변경을 직접 보고 코멘트하는 리뷰에는 tuicr를 기본 공유 화면으로 쓴다. 관련 활성
세션이 있으면 attach하고, 없고 tmux·Zellij·Herdr가 있으면 설치된 tuicr 스킬의
`tuicr-wrapper.sh`, `tuicr-wrapper-zellij.sh`, `tuicr-wrapper-herdr.sh` 중 환경에 맞는 wrapper로
연다. 사용자 주도 리뷰에서는 `tuicr review comments`로 사용자 코멘트만 회수하며 리뷰어를
사칭하지 않는다. 에이전트 주도 `gdm-review`에서는 기존 읽기 전용 diff 분석을 유지하고,
사용자가 명시적으로 요청한 경우에만 `tuicr review add --username "<실제 검토자>"`로 발견을 공유한다.

tuicr나 multiplexer가 없거나 비대화형 리뷰이면 기존 텍스트 `gdm-review`로 폴백하고 그 사실을
알린다. gdm 설치기는 두 companion tool을 자동 설치하지 않는다. tuicr 세션이나 사용자 코멘트는
구현 모델과 다른 fresh-context auditor가 아니므로 gdm-full의 독립 검수를 대신할 수 없다.

## 선택형 코드 그래프 내비게이션

- `GRAPH_NAV_PROVIDER: env:GDM_GRAPH_PROVIDER`
- `COMPANION_TOOL_POLICY: optional`
- `GRAPH_NAV_SKILLS: gdm-plan,gdm-analyze,gdm-review`

코드 그래프는 plan·analyze·review에서 로컬 검색으로 찾은 한 파일의 의존 관계나 영향 경계를
좁혀야 할 때만 선택적으로 쓴다. `dependencies`는 그 파일이 의존하는 방향, `dependents`는 그
파일에 의존하는 영향 방향이다. 현재 Git root와 repository-relative entry 하나를 고정하고,
질문을 가르는 데 필요한 가장 작은 `maxDepth`를 1부터 5 사이에서 고른다. 전체 저장소를
무경계로 탐색하거나 다른 스킬에서 자동 실행하지 않는다.

`GDM_GRAPH_PROVIDER`는 인자가 섞이지 않은 절대 실행 파일 경로 하나여야 한다. 경로가 유효하면
`"$GDM_GRAPH_PROVIDER" query`에 다음 v1 request object를 JSON stdin으로 전달한다.

```json
{"schemaVersion":"gdm-graph-query/v1","root":"/absolute/git/root","entry":"repo/relative/file.ts","direction":"dependencies","maxDepth":1}
```

`direction`은 `dependencies|dependents`, `maxDepth`는 정수 1..5만 허용한다. 위 표기는 절대 경로를
따옴표로 보호한다는 뜻이다. 호출자는 환경변수 값을 공백으로 나누거나 command string으로 다시
파싱하지 않고 실행 파일 경로 한 개와 `query` 인자를 고정한다. terminal tool이 command string
인터페이스만 제공하면 위처럼 변수를 한 토큰으로 quote한다. `sh -c`, `zsh -lc`, `eval`, command
string parsing은 금지한다. caller-side 제한은 10초이며 terminal tool의 timeout을 사용하고 shell
`timeout` wrapper는 쓰지 않는다.

성공 출력은 `"schemaVersion":"gdm-graph-result/v2"`와 `provider`, `entry`, `direction`,
`nodes[{path,depth}]`, `edges`, `candidateTests`, `unresolved`, `limitations`,
`coverage{scope,requestedMaxDepth,completeWithinRequestedDepth,frontier,incompleteReasons}`,
`freshness{algorithm,consistent,visitedFiles}`, `truncated`를 가진 JSON object여야 한다.
`coverage.scope`는 요청한 root·entry·direction·depth 안의 bounded coverage를 뜻하며 저장소 전체의
완전성을 뜻하지 않는다. provider가 미설정이거나 값이 인자 없는 절대 경로
하나가 아니거나 경로가 missing·실행 불가인 경우, 프로세스가 non-zero로 끝나거나
crash·timeout인 경우, 출력이 malformed JSON·schema mismatch인 경우, 또는 결과가 stale이거나
`freshness.consistent=false`인 경우에는 결과 전체를 버리고 Read/Glob/Grep로 폴백해 실제 소스를
직접 읽는다.

`limitations`의 capability 설명만 있다는 이유로 정상 결과를 실패로 바꾸지는 않는다. 다만
요청 자체가 지원 범위 밖이거나 `coverage.completeWithinRequestedDepth=false`, `truncated=true`,
관련 `unresolved`, parse error처럼 이번 순회가 partial·unsupported임을 알리는 항목이 있으면
반환된 경로는 추가로 열어볼 navigation hint로만 쓸 수 있다. 그 경우 기존 Read/Glob/Grep 탐색도
반드시 수행해 누락을 보완하며, 빈 edge나 알려진 edge만으로 영향 범위를 결론내리지 않는다.

반대로 결과가 fresh이고 `coverage.completeWithinRequestedDepth=true`, `truncated=false`이며 관련
`unresolved`가 없으면 repository-wide Read/Glob/Grep 폴백을 수행하지 않는다. 그래도 반환된
`nodes`·`edges`·`candidateTests`의 후보 소스는 직접 열어 확인한다. `coverage.frontier`는 요청한
`requestedMaxDepth` 경계에서 더 이어질 수 있는 노드다. frontier가 있다는 사실만으로 partial인
것은 아니며 저장소 전체의 complete를 뜻하지도 않는다. 질문에 경계 너머가 필요하면 5 이하로
`maxDepth`를 늘려 다시 조회하거나 Read/Glob/Grep로 폴백한다.

정상 결과도 탐색할 파일·심볼·테스트 후보를 주는 navigation hint일 뿐이다. 실제 소스를 직접
열어 확인하기 전에는 주장이나 증거가 아니다. 그래프 출력만으로 작업 계약의 범위 확장을
정당화하거나 `gdm pass`, `gdm done`, audit 판정을 만들 수 없다. provider 부재·실패는 companion
기능의 부재일 뿐 plan·analyze·review 자체를 차단하지 않으며, gdm은 provider를 설치하거나 상주
프로세스로 시작하지 않는다.

## 검수 독립성

검수 모델은 실제 diff를 만든 구현 모델과 달라야 한다. 조율자나 스킬 이름이 아니라 실제
구현 주체를 기준으로 판단한다. gdm-full 한 작업의 실제 구현 모델은 하나로 유지하되,
그 모델을 쓰는 구현 에이전트 수는 한 명으로 제한하지 않는다.

- 검수자는 현재 대화나 실행자의 결론 요약을 받지 않는다.
- 입력은 지속 brief, 작업 계약, 실제 diff, gdm 증거 경로다.
- 같은 모델만 사용할 수 있으면 독립 검수를 통과로 낮춰 기록하지 않고 차단 상태를 보고한다.
- 검수 반려는 check로 환원하고 재검증한다. 검수 문장만으로 pass를 만들지 않는다.

## 역할 실행과 제한된 병렬 위임

분리 가능한 역할은 설치 target이 제공하는 Codex·Claude·Pi의 제한된 역할 실행기로 위임할 수 있다.
해당 역할 스킬 전문과 필요한 파일·증거 경로만 전달하고, 사용자의 비밀, 전체 대화,
불필요한 저장소 원문은 넘기지 않는다. 결과를 받은 뒤 진행자가 실제 파일과 gdm 게이트로
다시 판정한다.

일반 역할은 leaf가 아니며, 작업 중 새로 발견한 독립 경계가 있거나 전문성·fresh context·
컨텍스트 분리가 유리하면 하위 역할을 만들 수 있다. 운영 규칙은 하나의 hook-enabled native root
session tree에서 루트 진행자를 제외한 모든 세대의 활성 spawned agent를 합쳐 동시에 최대
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

`MAX_TOTAL_SPAWNS_PER_ROOT: 32`에서 ROOT는 하나의 hook-enabled native root session을 뜻한다.
같은 세션 트리의 제한은 `INITIAL_SPAWN_ATTEMPT_BUDGET: 16`,
`SPAWN_ATTEMPT_EXTENSION: 4`, 절대 누적 32, `DEFAULT_CHILD_QUOTA: 1`,
`MAX_CHILD_QUOTA: 2`, `MAX_AGENT_DEPTH: 3`이다.
새 독립 경계가 예상되는 일반 역할의 기본 `childQuota`는 1이며, 실제로 하위 분할 가능성이
없으면 0, 서로 독립인 하위 축이 이미
확인됐으면 최대 2를 준다. 일반 역할을 일괄 leaf로 만들지 않는다. 허용된 spawn 시도는
같은 root session 누적 예산을 하나 소비하며 실패·취소된 spawn도 예산을 돌려주지 않는다.
초기 16을 다 쓰면 pending/running 역할이 하나도 없을 때만 다음 spawn에서 4개 예산을 자동으로
열며, 활성 역할이 남은 동안에는 확장하지 않는다.
첫 Pre 뒤 같은 `tool_use_id`의 재전달은 실제 handler 실행 여부를 훅이 증명할 수 없으므로
동일한 `tool_input`·protocol·caller라도 즉시 거부하고 새 attempt로 세지 않는다. 같은 id의
입력·caller가 바뀌는 경우도 거부한다. Pre보다 먼저 온 unmatched Post는 세션당 32개까지만
보관하고 동일 replay만 상태 변경 없이 허용한다. 예산이 없으면 새 역할 대신 기존 역할에
후속 작업을 보내거나 진행자가 직접 통합한다.
훅이 실행되는 하나의 native root session tree에서 절대 누적 32는 하드 상한이고, 동시 4는
해당 target runtime의 유효 설정이 4일 때 native hard 상한이다. 사용자 설정 파일만으로
유효값을 단정하지 않고 target의 debug config에서 계층을 확인한다. 비대화형 CLI와 별도
세션을 합친 논리 작업 전체의 동시 4·초기 16·4개 자동 확장·절대 누적 32는 원장을 공유하는
하드 경계가 아니라 진행자가
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
있을 때만 V2 spawn으로 센다. 다만 hook input의 custom V2 namespace 규칙상 예약된 `mcp`,
`mcp__*`, Responses namespace는 같은 shape라도 통과시키고 원장에는 넣지 않는다. flat
이름은 namespace provenance를 증명하지 못하므로 이는 보수적인 shape 분류이며, shape가
없는 suffix 호출도 통과시킨다.
Pre acknowledgement는 60초, running lifecycle lease는 30분이다. 실제 Start 뒤 실패 Post가
와도 Stop 또는 lease expiry 전에는 running 관찰을 숨기지 않는다. failed/expired 예약에
연결된 pending/running agent의 실제 Start는 running lease와 Stop 장벽을 다시 열되 실패
Post evidence를 보존하고 일반 expiry reason만 지운다. 이미 stopped인 agent의 순서 뒤집힌
Start는 stop 신호를 바꾸지 않는다. 예약과 연결하지 못한 lifecycle 관찰도 세션당 32개로
제한하고 30분 뒤 Stop 계산에서 제거한다.
진행자는 `deliverable`과 `verify`를 직접 확인해 결과를 통합해야 한다.
user hook은 gdm 계약이 없는 일반 native spawn도 막지 않고 같은 세션 절대 누적 32에만 포함한다.
Stop 장벽은 한 번만 continuation을 요청하고 재진입에서는 경고만 해 무한 루프를 만들지 않는다.

독립 검수는 예외적으로 pass당 정확히 1명의 **leaf 실행**이다. 검수자에는
`MAX_AGENT_DEPTH: 0`, `MAX_CHILD_AGENTS: 0`을 적용하고 병렬 검수자나 하위 검수자를 만들지
않는다. Codex·Claude·Pi 검수는 설치된 `gdm-agents/run-role.sh --mode work --role audit`로만
실행해 동일 capability profile로 하위 위임과 사용자 MCP를 제거하고 자원 한도를 적용한다.

진행자는 외부 역할이 만든 루트 PID를 기록하고 종료 시 회수한다. 자원 한도 초과 시 그 PID의
하위 트리만 종료한다. NEVER: `node`, `gradle`, `vite`, `codex`, `claude` 같은 프로세스
이름으로 전역 종료하거나, 자신이 시작하지 않은 사용자 터미널·개발 서버를 정리하지 않는다.

실행 도구가 없거나 실패하면 원인을 기록하고 현재 세션이 안전하게 소유할 수 있는 역할만
직접 이어간다. 독립 검수는 같은 모델로 대체하지 않는다.
