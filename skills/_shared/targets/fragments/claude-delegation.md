## Claude Code coordinator contract

현재 Claude Code 세션이 진행자다. 사용자 문답, 로컬 조사, 계획 저장, 구현 배정·결과 수집·통합과
`gdm pass`·`gdm done`을 세션의 허용된 도구로 수행한다. 분석·리뷰처럼 원래 읽기
전용인 스킬은 해당 스킬의 수정 금지를 지킨다. Claude Code의 프로젝트 지침과 사용자가
선택한 모델·권한을 유지하며 GDM을 위해 다른 공급자로 이동하지 않는다.

`gdm-go`·`gdm-full`의 중간 이상 구현은 현재 세션이 제공하는 쓰기 가능한 Claude Code 하위
에이전트에 배정한다. 루트는 원문 요청·check 등록·검증·통합을 맡고 제한된 연결·충돌 수정 외의 통상
구현을 직접 모두 수행하지 않는다. `gdm team auto`의 작은 작업 single 판단과 사유를 유지한다.
쓰기 위임 기능이 없는 복잡한 작업은 `executor: unavailable`의 blocked로 보고하며 필수 역할을
없애는 single 폴백을 만들지 않는다.
분석·계획·리뷰 스킬의 읽기 전용 범위를 쓰기 권한으로 넓히지 않는다.

Work의 역할·소유 경로·의존성·실행 route는 `gdm team auto --from-request`가 생성한다.
진행자가 역할을 미리 매핑하거나 modules JSON을 작성하지 않는다. 호스트는 실제 capacity·
capability catalogue·명시적 context만 제공하고 생성된 `team next`의 route·prompt를 그대로
현재 도구에 전달한다. 기본 worker route는 `native-inherit`이며 planner의 `--model`과
worker 모델은 별개다. route가 실행 불가능하면 blocked로 남기고 임의의 모델로 바꾸지 않는다.
호스트 도구 메타데이터가 여러 허용 모델·effort를 지원하면 실제 실행 가능한 catalogue를 자동 구성한다.
GDM은 난도·위험·실행 능력·비용 제약에 따라 배정별 route·effort와 이유를 고른다. 같은 역할도
달라질 수 있다. 선택된 route·provider·model·effort를 claim에 host-declared로 기록하고 정확히
전달한다. 메타데이터가 선택을 지원하지 않으면 상속 route만 사용한다. tool-0 Claude는 쓰기 워커가 아니다.
`--file`은 명시적 수동 import 호환 경로다. Work의 새 경계나 변경 요구는 context와 check를
갱신해 `--from-request --replan --reason`으로 반영한다.
Work의 하위 위임도 호스트와 GDM이 조율한다. 작업자는 임의로 범위·모델을 확장하지 않고
새 경계를 보고하며 생성된 task·route와 호스트의 claim·가용 예산 안에서만 위임한다.

역할·범위·소유 파일·산출물·수용 기준·검증·종료 조건을 명시하고 겹치는 파일을 동시에 쓰게 하지
않는다. Work에서는 생성된 역할 수와 경계를 유지하며 Work의 `max-active`,
실제 호스트 가용 슬롯·자원·사용자 비용 한도를 지킨다. 결과가 모이면 의존성·중복·통합 부담을
보고 다음 배정 수를 조절하며 무거운 빌드·통합 테스트는 직렬화한다. 제공되지 않는 위임 도구나
기계적 동시 실행 상한을 가정하지
않는다. Work task로 등록한 위임은 spawn 전에 `gdm team claim`으로 논리 assignee와 attempt를 기록하고 위임 입력에 같은
Work slug·task·assignee·attempt를 전달한다. spawn 실패는 실패 artifact와 report로 닫는다.
하위 역할의 응답은 검증 증거가 아니며 진행자가 실제 변경·artifact를 확인하고 pass·review로
수락한다. planner semantic v3 knowledge의 `acceptanceMode: artifact-review`, `checks: []`는 출처 근거가
담긴 completed 보고서의 불변 해시와 수용 기준을 review하며 미래의 동작 check 통과를 요구하지 않는다.
implementation·verification은 연결 check를 증명하고 최종 done의 전체 check 게이트와 수동·이전 계획의
동작은 유지한다. review와 retry는 현재 `--attempt`를 반드시 지정하고 과거 attempt 요청은 거부한다.
stop·timeout을 성공으로 세지 않는다. `gdm team next --json`에 따라 미수락 작업을
계속 수집·검토하고, wait이면 제공되는 mailbox/event를 기다린 뒤 다시 상태를 읽는다.
세션 종료 후 자동 깨우기나 별도 실행 데몬을 가정하지 않는다.

별도 프로세스의 제한된 설계·분석·리뷰·검수는 설치된 `gdm-agents/run-role.sh`와
`--provider claude`를 사용한다. 이 전문 역할만 제공된 bundle을 읽는 tool-0 leaf이며,
도구·MCP·쓰기·재위임을 허용하지 않는다. 입력에는 필요한 소스·diff·증거를 포함하고
runner의 ACK·receipt·adoption을 확인한다. 실패·빈 응답·단순 프로세스 시작을 성공으로
세지 않는다. 사용자 요청이 없는 다른 공급자 호출을 폴백으로 사용하지 않는다.

`gdm-full` 검수는 일반 하위 에이전트가 대신하지 않는다. 모든 실제 구현 모델과 다른 Claude
모델을 `run-role.sh --mode work --role audit --model <모델 ID>`로 호출하고 같은 모델의
이름·역할만 바꾼 검수를 거부한다. 사용할 수 있는 다른 모델이 없으면 full의 독립성 조건을
유지하고 차단 이유를 알린다. 스킬을 실행했다는 사실은 commit·push·PR 승인도 아니다.
