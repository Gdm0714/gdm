<!-- GDM_AUTOMATIC_ENTRY_BODY_V1_BEGIN -->
## 일반 요청의 자동 진입과 이어가기

`GDM_AUTOMATIC_ENTRY_V1` 문맥을 받으면 현재 대화 모델이 원문·대화 맥락으로 요청을
분류한다. 키워드 규칙이나 별도 유료 분류기를 의미 판단으로 쓰지 않는다. 명시적 스킬 이름
없이 맡긴 구현·수정도 기본 `gdm-go` 흐름으로 진행한다. 사용자 요청·위험에 따른 기존
`gdm-full` 기준은 유지하며 자동 진입만으로 full을 강제하지 않는다.

1. hook이 제공한 실제 target·session·request token을 그대로 사용해 먼저 상태를 읽는다:
   `gdm entry status --target <target> --session <session> --json`.
   hook token이 없으면 임의 세션이나 token을 만들지 않는다. 명시적 스킬 절차는 계속
   사용할 수 있지만 자동 진입이 관찰됐다고 주장하지 않는다.
2. 현재 모델이 질문·설명 요청으로 판단하면
   `gdm entry decide --target <target> --session <session> --request <token> --kind question --json`을
   기록하고 바로 답한다. Work·check·team planner는 만들지 않는다. “이번에는 GDM 없이” 같은
   명시적 제외는 같은 명령의 `--kind optout`으로 기록하고 이번 요청에 적용한다.
   기존 Work는 보존하며 취소·완료 처리하지 않는다. 다음 요청은 다시 판단한다.
3. 구현·수정 요청이면 `gdm entry decide --target <target> --session <session> --request <token> --kind work --json`을
   기록한다. `activeWorkSlug` 또는 이미 결속된 `slug`가 있으면 `gdm protocol export --slug <s>`로
   완료 여부와 실제 산출물을 확인한다. 미완료 Work를 이어갈 때는 `gdm team next --slug <s> --json`을
   읽고 현재 token의 decide 명령에 `--kind work --slug <s>`를 지정해 다시 결속한 뒤 수정한다.
   이전 Work가 완료됐다면 완료된 slug를 재결속하지 않고 아래 새 Work 절차로 진행한다.
   무관한 새 요청을 이전 Work에 섞거나 미완료 결속을 조용히 교체하지 않는다.
4. 새 Work는 원문·사용자 제한을 보존해 `gdm plan init`하고 실제 재현 check를 등록한다.
   이어 같은 decide 명령에 `--slug <s>`를 더해 존재하는 Work를 결속한다. 그 뒤 기존
   `gdm team auto --slug <s> --from-request --max-active <available-worker-slots> --executor <native|unavailable> --json`을
   실행한다. `decide` 자체는 Work 생성·계획·도구 실행·수용 판정이 아니다. 반복 hook이나
   Stop 알림만으로 새 Work·새 planner를 호출하지 않는다.
5. GDM의 single/coordinated 판단과 이유를 유지한다. single은 진행자가 수행하고 coordinated는
   `gdm team next --slug <s> --json`의 의존성·경로·route·effort·prompt대로 실제 호스트 도구로
   실행한다. 실제 가용 슬롯·진행 중인 다른 작업·자원·사용자 비용 한도가 상한이며 고정
   워커 수는 없다. 지원되는 모델 선택만 catalogue에 넣고 상속만 가능한 도구에는 상속 route를 쓴다.
   실행 불가능한 route나 executor는 blocked로 보고하며 모델을 몰래 바꾸거나 필수 역할을 없애지 않는다.
6. native spawn **전에** `gdm team claim`으로 유일한 assignee·attempt와 선택된 실행 선언을
   기록한다. adaptive claim에는 `--execution-route`, `--execution-provider`, `--execution-model`,
   `--execution-effort`를 정확히 쓰며 null effort는 `inherit`로 선언한다. 생성된 전체 prompt와
   같은 Work·task·assignee·attempt를 실제 도구에 전달한다.
   도구 반환·mailbox·상태 조회로 결과를 수집하고 실제 변경과 artifact를 확인한 뒤
   `gdm team report`, 연결 check의 `gdm pass`, 현재 `--attempt`의 `gdm team review` 순으로
   수용한다. artifact-review knowledge의 기존 예외를 유지한다. spawn 실패·timeout·중단은
   성공이 아니며 실패 artifact와 report를 남기고 명시적 retry를 사용한다.
7. `team next`를 다시 읽어 의존 작업과 독립 verification을 끝내고 모든 task·check를 수용한다.
   full의 독립 audit를 포함한 기존 게이트를 통과한 뒤 `gdm done --slug <s>`을 실행한다.
   생성된 배정이나 종료 이벤트만 보고 “위임 완료”·“검증 완료”라 하지 않는다.
   검증 환경이 지원되지 않거나 완료 검사가 실패하면 원인을 해결하거나 미완료로 보고한다.
   완료 판정을 얻기 위해 사용자 제한·소유 경로·필수 검증을 삭제하거나 약화하지 않는다.

자동 진입은 호스트가 추가한 안내와 제한된 이벤트 게이트다. `decide`는 모델 판단의 선언이며
그 의미가 맞다는 기계적 증명이 아니다. 원문·권한·비용 제한을 바꾸지 않는다. 신뢰할 수 있는
worker 신원이 있는 하위 에이전트와 `GDM_ENTRY_DISABLED=1`인 GDM 전문 역할 호출은 진입을
건너뛴다. native 작업자는 새 루트 Work를 만들지 않고 배정된 작업만 수행한다. worker 신원이
없는 호스트에서는 완전한 자동 구분을 보장하지 않으며 부모가 leaf 지시를 전달한다.
<!-- GDM_AUTOMATIC_ENTRY_BODY_V1_END -->
