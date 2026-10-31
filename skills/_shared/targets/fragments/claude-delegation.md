## Claude Code coordinator contract

현재 Claude Code 세션이 진행자다. 사용자 문답, 로컬 조사, 계획 저장, 구현 배정·결과 수집·통합과
`gdm pass`·`gdm done`을 세션의 허용된 도구로 수행한다. 분석·리뷰처럼 원래 읽기
전용인 스킬은 해당 스킬의 수정 금지를 지킨다. Claude Code의 프로젝트 지침과 사용자가
선택한 모델·권한을 유지하며 GDM을 위해 다른 공급자로 이동하지 않는다.

`gdm-go`·`gdm-full`의 중간 이상 구현은 현재 세션이 제공하는 쓰기 가능한 Claude Code 하위
에이전트에 배정한다. 루트는 분해·수용 기준·검증·통합을 맡고 제한된 연결·충돌 수정 외의 통상
구현을 직접 모두 수행하지 않는다. 작은 순차 변경 또는 쓰기 위임 기능이 없는 세션은
`gdm team configure --mode single --reason "<구체적 작업·capability 이유>"`로 기록한다.
분석·계획·리뷰 스킬의 읽기 전용 범위를 쓰기 권한으로 넓히지 않는다.

역할·범위·소유 파일·산출물·수용 기준·검증·종료 조건을 명시하고 겹치는 파일을 동시에 쓰게 하지
않는다. 보통 활성 워커 2~3명을 쓰되 Work의 `max-active`와 실제 세션 한도를 지키며 무거운
빌드·통합 테스트는 직렬화한다. 제공되지 않는 위임 도구나 기계적 동시 실행 상한을 가정하지
않는다. Work task로 등록한 위임은 spawn 전에 `gdm team claim`으로 논리 assignee와 attempt를 기록하고 위임 입력에 같은
Work slug·task·assignee·attempt를 전달한다. spawn 실패는 실패 artifact와 report로 닫는다.
하위 역할의 응답은 검증 증거가 아니며 진행자가 실제 변경·artifact를 확인하고 pass·review로
수락한다. review와 retry는 현재 `--attempt`를 반드시 지정하고 과거 attempt 요청은 거부한다.
stop·timeout을 성공으로 세지 않는다. `gdm team next --json`에 따라 미수락 작업을
계속 수집·검토하고, wait이면 제공되는 mailbox/event를 기다린 뒤 다시 상태를 읽는다.
세션 종료 후 자동 깨우기나 별도 실행 데몬을 가정하지 않는다.

별도 프로세스의 제한된 설계·분석·리뷰·검수는 설치된 `gdm-agents/run-role.sh`와
`--provider claude`를 사용한다. 이 전문 역할만 제공된 bundle을 읽는 tool-0 leaf이며,
도구·MCP·쓰기·재위임을 허용하지 않는다. 입력에는 필요한 소스·diff·증거를 포함하고
runner의 ACK·receipt·adoption을 확인한다. 실패·빈 응답·단순 프로세스 시작을 성공으로
세지 않는다. 사용자 요청이 없는 다른 공급자 호출을 폴백으로 사용하지 않는다.

`gdm-full` 검수는 일반 하위 에이전트가 대신하지 않는다. 실제 구현 모델과 다른 Claude
모델을 `run-role.sh --mode work --role audit --model <모델 ID>`로 호출하고 같은 모델의
이름·역할만 바꾼 검수를 거부한다. 사용할 수 있는 다른 모델이 없으면 full의 독립성 조건을
유지하고 차단 이유를 알린다. 스킬을 실행했다는 사실은 commit·push·PR 승인도 아니다.
