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
  --require "기존 로그인 동작 보존" --forbid "자동 커밋"
gdm plan add --slug fix-login --desc "로그인 회귀 테스트" \
  --cmd "bun test login" --expect "exit 0"
gdm pass c1 --slug fix-login
gdm done --slug fix-login
```

`done`은 검증 완료를 뜻한다. 커밋·push·PR 권한은 별도 계약이며 자동으로 생기지 않는다.

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
agents/   독립 검수 기준
install/  바이너리 빌드와 스킬 설치
```

## 개발

```bash
cd cli
bun run verify
```

`verify`는 타입 검사, 커버리지 기준, 전체 테스트, 빌드, 바이너리 스모크 테스트를 한 번만 순서대로 실행한다.

## 라이선스

[MIT](./LICENSE)
