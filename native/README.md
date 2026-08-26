# gdm native

`Gidem`은 Ghostty 기반 interactive terminal, 멀티 에이전트 제어, 파일·편집기, Git diff,
check evidence, audit과 delivery 상태를 한 창에 묶는 개인용 macOS 개발 워크스페이스다.
별도 터미널 앱을 열지 않고 개발을 끝내는 것이 목표이며 터미널 명령과 조작은 제품의 중심으로
그대로 남는다. 제품 계약과 완료 기준은 [REQUIREMENTS.md](./REQUIREMENTS.md)에 정리했다.

## 실행

macOS 14 이상, Apple Silicon, Xcode Command Line Tools가 필요하다. 실행 가능한 앱을 만드는
권장 경로는 다음과 같다.

```bash
cd native
./scripts/build-app.sh
open .build/app/Gidem.app
```

첫 Ghostty build에는 pinned Zig 0.16.0과 Xcode Metal Toolchain이 필요하다. 정확한 source commit,
ABI hash, runtime resource hash는 `ghostty.lock.json`이 고정한다. Nix가 설치되어 있으면 build script가
고정된 Zig overlay를 사용한다.

SwiftTerm fallback만으로 빠르게 개발하려면 다음처럼 실행할 수 있다.

```bash
cd native
swift run gdm-native --repo ..
```

Ghostty 개발 빌드는 먼저 `./scripts/build-ghostty.sh`를 실행한 뒤
`GIDEM_ENABLE_GHOSTTY=1 swift run gdm-native --repo ..`로 시작한다.

다른 저장소를 열려면 해당 저장소의 절대 경로를 `--repo`에 준다. 저장소에는 gdm이 만든
`.gdm` 디렉터리가 있어야 실제 작업이 나타난다.

## 현재 동작

- root의 legacy `.gdm/*/checks.json`과 native workspace registry를 함께 읽는다.
- `New Task`가 현재 선택한 저장소에 `gdm/<slug>` branch를 만들고, 저장소 옆
  `<repository-name>-worktrees/<slug>`에 전용 worktree를 만든 뒤,
  그 worktree 안에서 `gdm plan init`을 실행한다. 새 작업은 곧바로 구현 상태가 아니라
  `PLAN NEEDED`에서 시작한다.
- packaged 앱은 서명된 `Gidem.app/Contents/Helpers/gdm`만 사용한다. SwiftPM 개발 빌드는 이
  source tree의 `cli/dist/gdm`만 사용한다. 선택한 저장소의 `cli/`, Bun source 실행, shell `PATH`의
  동명 명령으로 폴백하지 않으므로 InsightEx 같은 임의 Git 저장소에도 GDM 설치를 요구하지 않는다.
- `검증 계획 만들기` 또는 빈 Terminal pane의 `⌘↩`를 누르면 선택 AI agent가 소스 수정 없이
  저장소를 분석하고 주입된 `GIDEM_GDM_EXECUTABLE`로 자동·수동 검증 항목만 등록한다. Gidem은 checks.json 변경을
  자동 감지해 `REVIEW PLAN`으로 전환한다.
- 사용자가 Proof Rail에서 항목의 범위·명령·기대 결과를 승인해야 `READY 0/N`이 된다. 승인한
  fingerprint는 brief, audit 요구, contract와 check 정의를 versioned canonical binary 형식으로 묶고
  evidence/status와 optional source fingerprint는 제외한다. 생략 필드는 CLI 기본값으로 정규화하며
  정의가 바뀌면 다시 승인을 요구한다. 승인 전에는 일반 구현 시작, `Run verification`, 완료 처리를 허용하지 않는다.
- planning 시작 전에 working tree 내용·파일 타입/모드·symlink·Git index/status의 source fingerprint를
  저장한다. 승인할 때 같은 상태인지 확인하고, 승인 저장 뒤 한 번 더 확인한다. 두 확인 사이에 소스나
  index가 바뀌면 승인을 원복하며 구현 prompt를 보내지 않는다.
- Proof Rail이 open check와 audit 조건을 완료 blocker로 계산한다.
- `Run verification`과 `done`은 항상 선택된 task worktree에서 실행한다. 증거도 그곳의
  실제 `.gdm/<slug>`에 남으며 root 상태로 폴백하거나 복사하지 않는다.
- 모든 조건이 충족된 작업은 `gdm done`으로 닫을 수 있다.
- 중앙 workbench는 재귀 분할 pane을 제공한다. divider를 드래그해 크기를 바꾸고 각 pane을
  Files, Editor, Terminal, Diff, Logs, Evidence, Proof로 전환할 수 있다. `⌘D`/`⇧⌘D`로
  오른쪽/아래 분할, `⌥⌘←`/`⌥⌘→`로 focus 이동, `⇧⌘K`로 안전하게 닫는다.
- Ghostty terminal에서는 사용자의 Ghostty leader 설정을 그대로 사용한다. 기본 로컬 설정 기준으로
  `⌃G` 뒤 `H/J/K/L`은 방향 focus, `S` 뒤 `H/J/K/L`은 방향 분할, `W` 뒤 `H/J/U/L`은 divider 이동,
  `S E`는 크기 균등화, `X`는 안전한 pane 닫기다. `C`/`N`/`P`와 `G 1…5`의 tab 동작은 각각
  새 terminal pane, 다음/이전 pane, 번호 pane으로 대응한다. 실행 중 agent와 dirty editor 보호 규칙은
  mouse·menu 조작과 동일하게 유지된다.
- 각 Terminal pane에서 Shell, Codex, Claude, Gemini를 독립 interactive PTY lane으로 실행한다.
  빈 Terminal pane에 focus한 뒤 `⌘↩`를 누르면 선택 agent를 바로 시작한다.
  release 앱은 pinned GhosttyKit이 ANSI 렌더링, 키보드·IME, 붙여넣기, selection, mouse report,
  scroll, search, URL, focus와 Retina resize를 담당한다. Ghostty가 포함되지 않은 개발 빌드는
  SwiftTerm으로 안전하게 fallback한다.
- Files pane은 선택 task의 실제 worktree를 읽고 `.git`, `.gdm`, `.omo`, `.omx`, `.build`,
  `node_modules`를 제외한다. UTF-8 2 MiB 이하 일반 파일만 열며 symlink와 root 경로 탈출을
  거부한다. Editor는 다중 탭, dirty 표시, `⌘S`, 디스크 변경 충돌의 Reload/Overwrite를 제공하고
  권한을 보존한 원자 저장을 사용한다.
- `⌘K` 팔레트에서 명령과 실제 worktree 파일을 함께 검색한다. toolbar의 폴더 버튼이나 `⌘O`로
  다른 Git repository를 열며 마지막으로 연 repository는 다음 실행에 복원한다.
- pane layout은 task별 registry에 복원되지만 PID, 환경변수, 명령, terminal transcript와
  저장하지 않은 editor buffer는 저장하지 않는다. 실행 중 lane이나 dirty editor를 잃을 수 있는
  pane 닫기, task 전환, repository 전환은 fail-closed로 거부한다.
- toolbar의 Agent Activity는 여러 task의 세션을 agent별로 집계한다. 넓은 화면에서는
  Codex·Claude·Gemini를 바로 보여주고, 좁은 화면에서는 현재 agent와 전체 상태 popover로
  접는다. 상태 행에는 task·branch·worktree·경과 시간만 표시하며 prompt, 전체 command, PID는
  표시하거나 저장하지 않는다.
- agent는 주입된 `GIDEM_AGENT_*` 연결 정보와 `gdm-native --agent-event`를 사용해
  `Needs You`, working, verifying, handoff, completed 같은 semantic state를 보낼 수 있다. Gidem은
  terminal 출력 문자열을 파싱하지 않는다. 같은 worktree에서는 한 lane을 advisory `PRIMARY`,
  나머지를 `SECONDARY` coordination 역할로 표시하며 keyboard focus를 가진 lane 하나만 `INPUT`으로
  표시한다. `Handoff`는 이 advisory 역할만 넘기며 파일 시스템 쓰기 권한을 부여하거나 차단하지 않는다.
- Codex·Claude·Gemini 아이콘은 설치된 각 vendor의 공식 macOS 앱에서 원본 이미지를 런타임에
  읽는다. 앱이나 asset이 없으면 text monogram으로 폴백하며 vendor asset을 저장소에 복제하거나
  재착색하지 않는다.
- 상태 handoff, pane, tab만 짧게 움직인다. terminal transcript와 evidence text는 animate하지
  않으며 macOS의 Reduce Motion이 켜져 있으면 반복 pulse와 transition을 모두 즉시 전환으로 바꾼다.
- drawer에서 Git diff, 선택 작업 journal, evidence를 전환한다.
- 1024px 폭에서는 Proof Rail과 drawer가 명시적 탭으로 접힌다.

workspace 매핑은 root `.gdm/native/workspace.json`에 원자적으로 저장한다. 선택 agent와 lane별
세션의 종류·시작/종료 시각·결과만 남기며 PID, 환경변수, 터미널 transcript는 저장하지 않는다.
`sessionsByLane`이 있으면 그 map이 canonical이고 `lastSession`은 이전 앱을 위한 호환 projection이다.
map이 없는 기존 registry만 legacy `lastSession`을 읽는다. 앱이 비정상 종료된 뒤 map에 남은 모든
`active` 기록은 다음 실행에서 `interrupted`로 바뀐다. 이전 PID에
재접속하거나 신호를 보내지 않는다. 종료 시각도 알 수 없으므로 재실행 시각으로 채우지 않고,
이 경우 경과 시간은 표시하지 않는다.

root legacy 작업은 registry record가 없어서 선택 agent와 마지막 session을 앱 재시작 뒤에는 복원할
수 없다. 다만 현재 앱 프로세스 안에서는 task별 선택 agent와 session 메타데이터를 메모리에 유지해
task 전환과 Refresh 뒤에도 실제 live session의 agent를 selector와 Activity에 일치시킨다.

범용 PTY 출력만으로 agent가 사용자 입력을 기다리는지 신뢰성 있게 판별할 수 없으므로
`Needs You`를 출력 휴리스틱으로 추론하지 않는다. child가 private Unix socket으로 전달한 versioned
event만 반영하며 current UID, unguessable run token, task/lane/generation, monotonic sequence와 payload
경계를 검증한다. `PRIMARY`/`SECONDARY`는 협업 안내 역할이지 OS 수준 파일 잠금이나 권한 경계가 아니다.

Ghostty lane의 명시적 Stop·quit와 natural exit lifecycle은 Ghostty가 소유한다. Gidem은 관찰한
foreground PID/PGID에 별도로 signal하거나 `waitpid`하지 않는다. SwiftTerm fallback에서는 확인된
live PTY process group에 TERM을 한 번 보내고, direct PTY leader가 grace period 뒤에도 소유한
live child임이 증명된 경우에만 KILL로 올려 직접 회수한다. leader가 회수된 이후 group signal은
PID/PGID 재사용 안전을 위해 fail-closed로 금지한다. TERM을 무시하고 남은 same-PGID descendant와
별도 session으로 분리된 descendant는 fallback 종료 보장의 범위 밖이다.

## 의도적으로 미룬 범위

- 기존 세션 재접속과 transcript 복원
- worktree·branch 자동 삭제/rollback UI
- direct leader가 먼저 종료된 뒤 남은 same-PGID descendant 강제 정리
- PTY process group에서 스스로 분리된 descendant 정리
- GitHub PR 공급자 연동
- 언어 서버(LSP), debugger, extension/plugin 호스트
- 내장 web preview/browser와 Git staging·commit 전용 UI
- Developer ID 서명·notarization을 포함한 공개 배포

agent 실행 실패는 다른 도구로 폴백하지 않고 터미널 상태와 오류로 드러낸다. Gemini도 선택한
worktree를 cwd로 삼아 `gemini`를 shell 보간이나 기본 prompt 없이 실행한다. 에이전트의 설명은
완료 증거로 승격하지 않으며, 완료 판단은 계속 선택 worktree의 gdm 상태 파일이 담당한다.

## 검증

```bash
swift test
GIDEM_ENABLE_GHOSTTY=1 env -u GHOSTTY_RESOURCES_DIR swift test
./scripts/qa/ghostty-terminal-compatibility.sh
./scripts/check-contrast.sh
./scripts/check-hardcoded-colors.sh
./scripts/render.sh
./scripts/verify-native-release.sh
```

실제 설치·로그인된 Codex와 네트워크를 사용하는 smoke는 비용과 외부 상태에 의존하므로 기본
release 검증에 포함하지 않는다. packaged app을 만든 뒤 다음처럼 명시적으로 실행한다.

```bash
GIDEM_RUN_CODEX_SMOKE=1 ./scripts/qa/codex-smoke.sh
```

이 경로는 창과 focus를 만들지 않고 임시 Git repository에서 packaged Ghostty PTY로
`codex --sandbox read-only exec --ephemeral`을 한 번 실행한다. 마지막 응답이 고정 marker와 정확히
일치하고 process가 정상 종료했으며 repository 전체 snapshot이 바뀌지 않았을 때만 통과한다.
임시 repository와 응답 파일만 정리하며 process 이름 검색이나 광범위한 signal은 사용하지 않는다.
기본 제한 시간은 180초이고 필요할 때만 `GIDEM_CODEX_SMOKE_TIMEOUT_SECONDS`로 15~600초 안에서
조정한다.

렌더 스크린샷은 `.build/ui-qa/`에 생성된다. `agent-operations` demo는 1024에서 네 lane 탭,
1440/1728에서 네 lane 2×2와 multi-agent 상태를 검사한다. 모든 `--demo` 렌더는 UI 배치만 검사하며
실제 PTY나 agent 프로세스를 시작하지 않는다. 실제 terminal 입력·terminfo·종료·동시 lane은
`ghostty-terminal-compatibility.sh`와 packaged app smoke가 별도로 검증한다.
