## gid 작업 분담 계약

루트 진행자는 원문 요청·check 등록·결과 회수·검증·통합을 소유한다. 중간 이상 작업에서
현재 엔진에 쓰기 가능한 위임 도구가 있으면 GDM이 생성한 구현 경계대로 배정한다.
분석·계획·리뷰 스킬은 읽기 전용이라는 본래 계약을 유지한다.

Work의 역할·소유 경로·의존성·실행 route는 `gdm team auto --from-request`가 생성한다.
진행자가 역할을 미리 매핑하거나 modules JSON을 작성하지 않는다. 호스트는 실제 capacity·
capability catalogue·명시적 context만 제공하고 생성된 `team next`의 route·prompt를 그대로
현재 도구에 전달한다. 기본 worker route는 `native-inherit`이며 planner의 `--model`과
worker 모델은 별개다. route가 실행 불가능하면 blocked로 남기고 임의의 모델로 바꾸지 않는다.
`--file`은 명시적 수동 import 호환 경로다. Work의 새 경계나 변경 요구는 context와 check를
갱신해 `--from-request --replan --reason`으로 반영한다.
Work의 하위 위임도 호스트와 GDM이 조율한다. 작업자는 임의로 범위·모델을 확장하지 않고
새 경계를 보고하며 생성된 task·route와 호스트의 claim·가용 예산 안에서만 위임한다.
gid native가 재위임을 지원하지 않으면 작업자가 직접 하위 작업을 실행하지 않고 호스트로 돌려보낸다.

gid native는 현재 세션에 노출된 `delegate_tasks`를 사용한다. 도구 스키마의 필수 필드로
`tasks: [{id, prompt, paths, access, deliverable, acceptance}]`를 사용한다. `paths`는 저장소
상대 소유 경로이며 `access`는 `read` 또는 `write`다. 산출물과 수용 기준을 명확하게 전달한다. 파일을 함께 수정하는
다른 작업자가 있음을 알리고 기존 변경을 보존하게 한다. 현재 도구는 한 번에 최대 3개를
배정한다. 이는 작업 전체의 역할 수 제한이 아니며, 생성된 next·route에 따라
추가 묶음을 배정한다. 결과를 수집한 뒤 실제 호스트 가용 슬롯·자원·사용자 비용 한도와
통합 부담을 다시 확인한다. 쓰기 범위가 겹치거나 선행 결과가 필요한 작업은 같은 묶음에 넣지
않는다. 작업자는 부모가 선택한 공급자·모델·추론 강도·실행 정책을 상속하며 현재 버전에서는
다시 위임하지 않는다.

Work task는 실행 전에 `gdm team claim`한다. 도구 입력과 결과 산출물에 Work slug, task ID,
assignee, attempt를 함께 남긴다. `delegate_tasks`는 각 작업의 결과가 수집될 때까지 기다린다.
도구가 반환한 종료 상태만으로 성공 처리하지 않고 실제 산출물과 검증 결과를 확인한다.
작업이 실패·취소·중단됐으면 그 사실을 보고하고 같은 효과를 자동으로 다시 실행하지 않는다.
프로세스 중단 후에는 저장된 결과와 실제 파일 변경을 확인한 뒤 명시적으로 새 시도를 만든다.

루트가 결과를 `team report`로 저장하고 implementation·verification의 연결 check를 `gdm pass`로
증명한 뒤 현재 `--attempt`를 지정하여 `team review`한다. planner semantic v2 knowledge의
`acceptanceMode: artifact-review`, `checks: []`는 출처 근거가 담긴 completed 보고서의 불변 해시와
수용 기준을 review하며 미래의 동작 check 통과를 요구하지 않는다. 최종 done의 전체 check 게이트와
수동·이전 계획의 동작은 유지한다. 작업자는 자신의 check나 task를 수락하지 않는다.
모든 작업을 수용하고 사용자 목표와 `gdm done`을 확인하기 전에 완료를 선언하지 않는다.
`gdm team auto`가 작은 작업으로 판단한 single과 사유는 유지한다. 실행 도구가 없는 복잡한
작업은 `executor: unavailable`의 blocked로 보고하며 필수 역할을 없애 single로 낮추지 않는다.

Claude ACP는 실제 제공되는 Agent 도구로 배정하고 현재 foreground turn에서 task ID나 결과
경로에 결속된 대기·상태 조회로 완료를 추적한다. 추적 가능한 background 결과도 수집할 수
있지만 자동 깨우기·턴 재개·쓰기 권한을 이벤트 표시만으로 추정하지 않는다. 결과를 기다리는
중임을 짧게 알리고, 받은 결과를 루트가 사용자의 언어로 종합한다. 실제 사용 가능한 기능이
없으면 해당 자동 실행을 blocked로 남기고 이유를 기록한다.

이 계약은 실행 권한을 넓히거나 새로운 데몬을 설치하지 않는다. GDM 장부는 협력적인 작업
소유권이며 gid 작업자는 실제 도구 정책에 따라 명시된 작업 경로 안에서 실행한다.
