# GDM Rust runtime

GDM 0.13의 실행 코드는 저장소 루트의 Cargo 프로젝트다. 기존 Work 디렉터리,
JSON schema, journal, 증거 파일과 CLI 명령을 그대로 읽고 쓴다.
전환 과정의 테스트 비교 기준은 `cli/src`, `install/render-skills.ts`,
`tests/legacy`에 남겼으며 설치하거나 실행 경로에서 호출하지 않는다.

## 실행

```sh
cargo build --locked
./target/debug/gdm --help
cargo test --locked
python3 script/qa/rust-parity.py
python3 script/qa/rust-native-check.py
```

`rust-parity.py`는 기존 Bun 테스트의 CLI 실행 대상만 Rust 바이너리로 바꾼다.
저장 형식·해시 검증 함수는 독립된 기존 구현을 사용한다. 직접 TypeScript 함수만
검사하는 테스트는 Rust 검증 개수에 섞어서 해석하면 안 된다. 별도의
`tests/runtime/state_oracle.json`과 Rust 테스트가 같은 입력의 상태 검증·해시를 비교한다.
Bun은 이 전환 검증에서만 필요하다. 배포 바이너리는 Bun·Node 없이 실행된다.

`rust-integration-parity.py`는 네이티브 훅, 메모리 RPC, Codex·Claude 역할 실행기와
Codex·Claude·gid 스킬 렌더링을 격리된 fixture로 확인한다.

`install/install.sh`는 Cargo release 빌드, Rust 스킬 렌더러, 매니페스트 검증을 거쳐
기존 설치를 교체한다. 중간 실패 시 이전 바이너리와 스킬을 복구한다.
macOS/Linux 배포 파일은 해당 Rust target의 linker/SDK가 준비된 빌드 환경에서
생성해야 한다. Bun의 단일 머신 cross-compile 옵션은 사용하지 않는다.

## 배포 호환성

원격 main에 추가된 `gdm device list|doctor|build|install|test|capture`도 Rust에서 실행한다.
실기기 설정·대상 확인·격리 테스트·증거 저장과 실패 후 앱 복원은 기존 명령 계약을 유지한다.
릴리스 검증은 가짜 프로세스와 합성 결과 파일을 사용하며 실제 기기 설치나 테스트를 수행하지 않는다.

완료된 Work에서 `recheck`로 증거를 갱신하면 Work를 다시 진행 상태로 열고 이전 완료 시각을
제거한다. 재검증 실패도 같은 방식으로 처리해 상태를 계속 읽을 수 있으며, 검수가 필요한 Work는
새 증거에 대한 검수와 `done`을 다시 거쳐야 한다.

## 코드를 읽는 순서

1. `src/main.rs`: 명령을 받아 해당 모듈로 전달한다.
2. `src/support.rs`: `Result<T>`는 성공 값 또는 명시적인 오류다. `?`는 오류를
   호출자에게 전달한다. CLI 경계에서 오류를 기존 종료 코드로 변환한다.
3. `src/runtime`: 계약, 상태 저장, 증거, 프로토콜과 완료 판정을 담당한다.
4. `src/integrations`: 에이전트 훅, 메모리, 스킬 렌더링, 공급자 연결을 담당한다.
5. `src/computer_use`: VM과 키보드·마우스 전송, Jev 선택, 실측을 담당한다.

Rust의 소유권은 이 프로젝트에서 프로세스 수명 관리에 유용하다.
`Owned`가 자신이 시작한 프로세스를 소유하고, `Drop`이 종료·회수를 수행한다.
중간 단계에서 `?`로 빠져나와도 정리 경로가 실행된다. 종료 상태는 PID를 먼저
회수하지 않는 `waitid(NOWAIT)`로 확인해 종료 신호가 재사용된 PID에 가지 않게 한다.
VM 경계 감시는 PID와 시작 시각을 함께 추적한다.

`Action`은 허용된 행동만 나열한 enum이다. `serde`가 JSON을 이 타입으로 바꾸고,
알 수 없는 필드·행동을 거절한다. 실제 입력 전 좌표 범위와 필드 관계를 추가로
검사한다. Jev가 문자열로 임의 명령을 만들 수 있는 실행 경로는 없다.

Pi 호스트 확장과 TS 어댑터는 제거했다. 저장·선택·실행 제한·프로세스 관리는
Rust 바이너리가 담당한다. 공급자 셸 어댑터는 네이티브 명령으로 전달하며,
Markdown 스킬은 실행 코드가 아닌 입력 데이터다.

이 Mac의 패키징 경로만 검증하려면 `GDM_RELEASE_HOST_ONLY=1 zsh script/qa/gdm-release-qa.zsh`를 실행한다. 실제 호스트 바이너리와 스킬의 바이트·권한·체크섬·재현성과 출력 덮어쓰기 거부를 확인한다. 기본 모드는 여전히 네 플랫폼 산출물을 요구하며, 호스트 검증만으로 다른 플랫폼의 빌드 성공을 주장하지 않는다.
