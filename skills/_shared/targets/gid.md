## 설치 대상 어댑터

이 대상은 gid에서 선택한 공급자와 실행 엔진을 유지한다. 모델 이름만으로 위임·훅·권한
기능을 추정하지 않는다. 현재 세션에 노출된 도구와 실행 정책을 먼저 확인한다.

- target ID: `gid`
- 스킬 설치 경로는 `GID_CONFIG_DIR/skills`이며, 미설정 시
  `${XDG_CONFIG_HOME:-~/.config}/gid/skills`다. 다른 실행 환경의 스킬 변형으로 대체하지 않는다.
- gid native에서 `delegate_tasks`가 제공되면 `team auto --from-request`가 생성한
  next·route·prompt를 그 도구로 실행한다. host가 Work의 역할·module·worker 모델을 다시 정하지 않는다.
  도구 응답은 배정된 작업의 종료와 결과 수집을 기다린 뒤 반환된다. 작업자는 부모의 모델과
  권한을 상속하며 현재 구현에서는 다시 위임하지 않는다. 이 도구가 없으면 capability 한계를
  기록한다. 작은 작업의 single은 유지하지만 복잡한 자동 배정은 `executor: unavailable`로
  차단하며 필수 역할을 없애지 않는다. 기본 Codex 백엔드의 자체 Agent·Stop 훅을 가정하지 않는다.
- Claude ACP에서는 현재 세션이 실제 제공하는 Agent 도구와 추적 가능한 대기·상태 조회를
  사용한다. 공급자 이벤트가 보인다는 이유만으로 쓰기 권한이나 자동 재개를 가정하지 않는다.
  결과가 모이기 전에 최종 응답으로 끝내지 않는다. 예약 도구만 남긴 후 종료하지 않는다.
- 현재 루트 세션 ID를 host가 제공하거나 신뢰할 수 있는 경로로 확인한 경우만
  `gdm team configure --session`에 쓴다. 임의 ID를 만들지 않는다. 세션 결속만으로
  없는 종료 훅이나 백그라운드 데몬이 생기지는 않는다.
- 읽기 전용 전문 역할을 별도 호출할 때만 아래 `run-role.sh` 계약을 사용한다. 이 계약의
  tool-0 제한은 gid 진행자나 `delegate_tasks` 구현 작업자의 도구 권한을 축소하지 않는다.
- Work 역할 실행 계약: `gdm-agents/run-role.sh --mode work --provider <codex|claude> --role <role> --slug <slug> --handoff-event-id <event-id> --claim-id <claim-id> --receiver-role <receiver-role> [--model <model>]`
- Work 없는 사전 설계 계약: `gdm-agents/run-role.sh --mode preflight --provider <codex|claude> --role <role> --prompt <path> --output <path> [--model <model>]`
- provider는 현재 선택한 공급자와 필요한 독립성을 기준으로 명시한다. `gid`는 실행 대상이지
  별도 모델 공급자가 아니다. 다른 공급자 로그인이나 실행 파일을 묵시적으로 요구하지 않는다.
- capability profile: `gdm-read-only-specialist/v1`. 전문 역할에는 provider tool·쓰기·shell·
  browser·MCP·하위 위임을 제공하지 않는다. 모델 transport의 backend 연결은 허용된다.
  canonical bundle은 artifact `{path,sha256,text,bytesBase64}`를 보존하지만 provider에는
  `gdm-dispatch-model-view/v1`의 `{path,sha256,text}`만 전달한다. model-view의 `bundleSha256`는
  full canonical bundle의 digest이며 ACK도 그 값에 결속한다. 실제 실행 영수증과 결과를
  확인한 뒤 `protocol adopt`한다.
- target hook: gid가 제공하는 실제 실행·종료 기능을 사용한다. Codex hook 설치 여부를
  gid native의 완료 보장으로 대신하지 않는다.

## 자동 진입 호스트 계약

- trusted `gdm-entry-v1` native extension의 `input`은 원문을 보존하고
  `GDM_AUTOMATIC_ENTRY_V1` 문맥을 추가한다. `before_turn`은 결속된 Work의 이어가기 안내다.
  현재 모델이 분류하고 설치된 `gdm-go`/`gdm-full`을 수행한다. `input_suggestion`으로 요청을
  덮어쓰지 않는다. executable만 복사되므로 hook 안내는 인접 스킬 파일에 의존하지 않는다.
- native `delegate_tasks`는 `tasks: [{id, prompt, paths, access, deliverable, acceptance}]`로
  한 번에 1–3개를 실행하고 결과를 수집한다. task는 먼저 claim하며 현재 도구의 작업자는
  부모 모델·권한을 상속하는 leaf다. 추가 독립 작업은 실제 남은 슬롯 안에서 다음 묶음으로 실행한다.
- entry는 context-only 안내이며 일반 변경을 결정적으로 차단한다고 주장하지 않는다.
  `block_reason`은 안내를 읽기 전에 전체 작업을 중단하므로 복구 가능한 tool denial로 쓰지 않는다.
  기존 native team completion guard는 실제 세션에 결속된 coordinated Work에만 적용된다.
- manifest는 `gid extension add <manifest> --trust`로 등록하고 binary 변경 후 재등록한다.
  새 native 세션과 기존 permission mode를 사용하며 ask 승인이 필요할 수 있다. 설치·등록과
  실제 event 관찰은 다르다. Claude ACP에 native extension 실행을 가정하지 않는다.
