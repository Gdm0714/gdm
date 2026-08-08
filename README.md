# gdm

작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우다. AI의 말이 아니라 재현 가능한 결과로 작업을 닫고, 반복된 실수만 사람이 검토할 습관 후보로 되돌린다.

gdm의 흐름은 `약속 → 증명 → 관찰 → 습관 → 비교`다.

- 약속: 이번 작업의 필수 조건·금지 조건과 확인 항목을 먼저 기록한다.
- 증명: gdm이 검증 명령을 직접 실행하고 출력·종료 코드·해시를 남긴다.
- 관찰: 실패한 시도, 재검증 실패, 완료 뒤 발견된 결함을 구조화한다.
- 습관: 서로 다른 근거에서 반복된 패턴만 후보로 만들고 사람이 채택한다.
- 비교: 다음 작업에서 습관을 실제로 적용했는지와 같은 문제가 재발했는지 본다.

gdm은 두 부분이다: 모델 호출 없이 상태·증거를 판정하는 **결정적 CLI 게이트**와,
Codex가 실행하고 Claude CLI·Claude Design에 전문 역할을 맡기는 **스킬팩**.

## 요구사항

- macOS 또는 Linux (arm64·x64)
- 대화형 실행 주체인 Codex
- 새 기술 설계에는 [Claude Code CLI](https://claude.com/claude-code) 로그인 필요
- 0→1·개방형 시각 디자인에는 claude.ai/design 접근 권한과 최초 1회 `/design-login` 필요
- 소스에서 빌드할 때만 [Bun](https://bun.sh) (한 줄 설치는 불필요)

## 처음 사용하기

```bash
gdm plan init --slug fix-login --brief "로그인 오류 수정" \
  --require "기존 로그인 동작 보존" --forbid "자동 커밋" \
  --assume "기존 세션 형식 유지" --uncertain "외부 인증 응답" \
  --allow-path cli/src --allow-path cli/test --stop-if "인증 계약 불일치" \
  --risk medium --verification deterministic --simplify
gdm plan add --slug fix-login --desc "로그인 회귀 테스트" \
  --cmd "bun test login" --expect "exit 0" --kind regression
gdm pass c1 --red --slug fix-login   # 수정 전에 같은 명령이 실패함을 기록
# 구현
gdm pass c1 --slug fix-login
gdm plan add --slug fix-login --desc "최소 변경 확인" \
  --cmd "bun run lint" --expect "불필요한 복잡성 없음" --kind static
gdm pass c2 --slug fix-login
gdm done --slug fix-login
```

`done`은 검증 완료를 뜻한다. 커밋·push·PR 권한은 별도 계약이며 자동으로 생기지 않는다.
init 시점의 tracked·untracked 파일 지문을 기준선으로 삼기 때문에 이미 있던 로컬 변경은 보존되고,
이후 허용 경로 밖에서 바뀐 파일만 완료를 막는다. 의도한 범위 확장은 검수 전에
`gdm plan contract --allow-path <경로> --reason <사유>`로 기록한다.

위험도 `high`는 독립 검수를 자동 요구한다. `high + opaque`(결과를 기계적으로 직접 판정하기
어려운 작업)는 AI가 전문가를 자칭하지 못하며, `--manual --expert` check에 실제 reviewer와
판단 근거를 제출해야 한다. 기존 상태 파일은 `low + deterministic + 전체 경로 허용`으로
읽히므로 예전 작업의 완료 조건은 바뀌지 않는다.

- 설계: [DESIGN.md](./DESIGN.md)
- 설치 (한 줄 · Bun·클론 불필요):
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Gdm0714/gdm/main/install.sh | bash
  ```
  플랫폼(macOS·Linux)에 맞는 바이너리와 스킬을 받아 `~/.local/bin`과 Claude Code·Codex
  스킬 폴더에 설치한다. Claude Code 쪽 스킬은 Codex가 비대화형 설계 역할을 맡길 때 쓰며,
  사용자가 작업을 시작하는 진입점은 Codex 하나다. Codex에서는 기존 `hooks.json`의 다른 handler를 보존하면서 gdm
  agent gate를 병합하고, 최초 변경 전 파일은 `hooks.json.gdm-backup`으로 남긴다.
  `config.toml`은 수정하지 않으며 실제 command hook 실행은 Codex `/hooks`에서 사용자가
  검토·신뢰한 뒤에만 확인된다. 상태는 `gdm agent hook-status` 또는 `gdm doctor`로 본다.
  특정 버전은 `GDM_VERSION=v<버전>`, 설치 경로는 `GDM_BIN_DIR`로 조정한다.
- 설치 (소스에서 · 개발용): 클론 후 `./install/install.sh` (Bun 필요)
- 사용: Codex에서 `$gdm-go <작업>`, 터미널에서 `gdm --help`

## 선택형 대화형 도구

gdm CLI와 CI에는 필수가 아니지만, 로컬 대화형 작업에서는 다음 도구를 감지해 사용한다.

- [terminal-browser](https://github.com/zenbu-labs/terminal-browser): 웹 UI check를 실제
  브라우저 pane에서 재현하고 `snapshot`, `click`, `fill`, `eval` 결과를 gdm 증거에 연결한다.
  단위·통합 테스트나 프로젝트 표준 Playwright·headless 테스트는 그대로 실행한다.
- [tuicr](https://tuicr.dev/): 사람이 변경 diff를 보고 코멘트하는 리뷰의 기본 공유 화면이다.
  gdm-review는 사용자 주도 리뷰의 저장된 코멘트를 CLI로 읽고, 에이전트 주도 리뷰의 발견은
  사용자가 요청한 경우에만 `Codex` 작성자로 기록한다.

두 도구와 Codex 스킬은 각각의 공식 설치 방법으로 별도 설치한다. 사용할 수 없거나 CI처럼
비대화형인 환경에서는 기존 자동 테스트·텍스트 리뷰로 폴백하며, gdm 설치기가 자동으로
설치하지 않는다. tuicr는 gdm-full의 독립 검수자를 대신하지 않는다.

새 화면·레이아웃·프로토타입 생성은 claude.ai/design에서 한다. gdm은 저장소 맥락을 반영한
Claude Design용 프롬프트를 먼저 전달하고 멈추며, 사용자가 생성 완료와 프로젝트 이름/ID를
알려주면 `/design-sync`의 `list_projects → get_project → list_files → get_file` 순서로
결과를 pull한다. Chrome이나 브라우저를 자동 조작하지 않는다. `finalize_plan →
write_files/delete_files`는 사용자가 양방향 push까지 요청한 경우에만 사용한다. 인증·권한
문제는 중단하고, 사용량 한도나 rate limit이 명확할 때만 Codex가 대신한다.

## 구조

```text
skills/   반복 작업을 위한 gdm 스킬
cli/      모델 호출 없이 상태와 증거를 판정하는 Bun/TypeScript CLI
native/   실제 gdm 작업 상태를 읽는 macOS SwiftUI 워크스페이스
agents/   독립 검수 기준
install/  바이너리 빌드와 스킬 설치
```

## 개발

```bash
cd cli
bun run verify
```

`verify`는 타입 검사, 커버리지 기준, 전체 테스트, 빌드, 바이너리 스모크 테스트를 한 번만 순서대로 실행한다.

네이티브 워크스페이스는 macOS 14 이상과 Xcode Command Line Tools가 필요하다.

```bash
cd native
swift run gdm-native --repo ..
```

`New Task`는 전용 Git worktree와 그 안의 GDM 계약을 만들고, 왼쪽 작업 목록과 오른쪽 Proof
Rail은 root legacy 작업과 worktree별 `.gdm/*/checks.json`을 함께 읽는다. `Run verification`은
선택한 worktree의 open 자동 check를 gdm CLI로 실행한다. 중앙 interactive PTY에서는 task별로
Shell·Codex·Claude·Gemini와 설치된 로컬 agent를 선택해 실행하고, toolbar의 Agent Activity에서 여러 task의
실행 현황을 함께 확인한다. 공식 앱이 설치되어 있으면 vendor 원본 아이콘을 런타임에 사용하며,
아래 drawer는 diff·journal·evidence를 보여준다.
상세 범위와 현재 제약은
[`native/README.md`](./native/README.md)에 정리했다.

## 라이선스

[MIT](./LICENSE)
