## Pi bounded delegation contract

Pi 조율자는 유일한 writer이며 전문 역할은 `gdm_delegate`로 호출한다. 런타임 동작을 바꾸는 구현은 완료 전에 `reviewer` 검토를 받고,
구조·모듈 간 상태 계약·권한·트랜잭션·동시성 변경은 구현 전에 `design` 자문도 받는다.
문서·서식만 바꾸는 작업은 제외하며 `scout` 조사는 선택한다. 사용자가 명시적으로 요청한
전문 역할은 실제 성공한 호출로 수행한다. 한 호출에는 구체적인 `role`, `scope`, `task`,
`deliverable`, `verify`를 가진 작업을 1~3개 넣고, 같은 전체 범위를 다시 넘기거나 끝이 정해지지
않은 fan-out을 만들지 않는다.

하나의 `gdm-pi` 루트 실행에서 활성 child는 최대 3개, 누적 child는 최대 8개이며 깊이는 1이다.
child 역할은 `scout|design|reviewer`만 허용되고, child에는 `read`, `grep`, `find`, `ls`만 제공한다.
session, extension, skill, project context, shell, edit, write와 재위임은 제공하지 않는다.
credential 형태의 값이나 불필요한 저장소 원문을 task에 넣지 않는다.

모든 역할에 선택적으로 `thinking: "medium"` 또는 `"high"`를 지정할 수 있다.
거부된 요청·실패한 child·빈 응답은 해당 역할의 완료가 아니다. 오류를 수정하거나 해결되지 않은
전문 역할 실패로 보고한다. 검토에는 실제 변경과 수용 조건을 포함하고 지적의 반영 또는
기각 이유를 남긴다. 이후 동작 변경으로 검토가 낡아지면 바뀐 범위를 다시 검토받는다.

child 결과는 탐색 힌트이지 GDM evidence나 완료 판정이 아니다. 조율자가 관련 파일을 직접 열고,
변경을 통합하며, 등록된 모든 명령은 `gdm pass`가 직접 실행하게 한다. child의 성공 문장만으로
check, audit, `gdm done`을 통과시키지 않는다. 독립 검수는 `gdm-full`의 별도 provider/model
경계와 설치된 `gdm-agents/run-role.sh --mode work --role audit` 계약을 그대로 따른다.
