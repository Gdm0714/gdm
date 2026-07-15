# gdm

작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우다. AI의 말이 아니라 재현 가능한 결과로 작업을 닫고, 반복된 실수만 사람이 검토할 습관 후보로 되돌린다.

gdm의 흐름은 `약속 → 증명 → 관찰 → 습관 → 비교`다.

- 약속: 이번 작업의 필수 조건·금지 조건과 확인 항목을 먼저 기록한다.
- 증명: gdm이 검증 명령을 직접 실행하고 출력·종료 코드·해시를 남긴다.
- 관찰: 실패한 시도, 재검증 실패, 완료 뒤 발견된 결함을 구조화한다.
- 습관: 서로 다른 근거에서 반복된 패턴만 후보로 만들고 사람이 채택한다.
- 비교: 다음 작업에서 습관을 실제로 적용했는지와 같은 문제가 재발했는지 본다.

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
- 설치: `./install/install.sh` (Bun 필요)
- 사용: Claude Code / Codex에서 `$gdm-go <작업>`, 터미널에서 `gdm --help`

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
bun test
bunx --bun tsc --noEmit
bun run build
```
