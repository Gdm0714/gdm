## Pi bounded delegation contract

Pi 조율자는 유일한 writer다. 서로 독립인 읽기 전용 탐색이나 fresh-context 검토가 결과 품질을
실제로 높일 때만 `gdm_delegate`를 사용한다. 한 호출에는 구체적인 `role`, `scope`, `task`,
`deliverable`, `verify`를 가진 작업을 1~3개 넣고, 같은 전체 범위를 다시 넘기거나 끝이 정해지지
않은 fan-out을 만들지 않는다.

하나의 `gdm-pi` 루트 실행에서 활성 child는 최대 3개, 누적 child는 최대 8개이며 깊이는 1이다.
child 역할은 `scout|reviewer`만 허용되고, child에는 `read`, `grep`, `find`, `ls`만 제공한다.
session, extension, skill, project context, shell, edit, write와 재위임은 제공하지 않는다.
credential 형태의 값이나 불필요한 저장소 원문을 task에 넣지 않는다.

child 결과는 탐색 힌트이지 GDM evidence나 완료 판정이 아니다. 조율자가 관련 파일을 직접 열고,
변경을 통합하며, 등록된 모든 명령은 `gdm pass`가 직접 실행하게 한다. child의 성공 문장만으로
check, audit, `gdm done`을 통과시키지 않는다. 독립 검수는 `gdm-full`의 별도 provider/model
경계와 설치된 `gdm-agents/run-role.sh --mode work --role audit` 계약을 그대로 따른다.
