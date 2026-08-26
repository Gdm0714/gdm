# Gidem Native 제품 요구사항

## 1. 제품 약속

Gidem Native는 macOS에서 별도 터미널 앱을 열지 않고도 개발 작업을 끝낼 수 있는
terminal-first agent workbench다. 터미널 조작을 숨기거나 제거하지 않는다. Ghostty 기반의 실제
interactive PTY를 제품 중심에 두고, 파일·편집기·diff·검증 증거·멀티 에이전트 제어를 같은 창에
결합한다.

핵심 문장은 다음과 같다.

> 터미널은 그대로 강력하게, 여러 에이전트의 소유권과 검증 상태는 사람이 한눈에 통제한다.

## 2. 핵심 사용자 흐름

1. 사용자는 Git repository를 열고 목표·필수 조건·금지 조건을 적어 작업별 worktree를 만든다.
2. 새 작업은 `PLAN NEEDED`에서 시작하며 AI agent가 구현 없이 자동·수동 검증 항목을 제안한다.
3. 사용자는 Proof Rail에서 항목의 범위·재현 명령·기대 결과를 검토하고 한 번 승인한다.
4. 승인된 작업만 `READY 0/N`이 되며 그 뒤에 구현·검증을 시작한다.
5. 한 작업 안에서 Shell, Codex, Claude, Gemini terminal lane을 원하는 만큼 분할한다.
6. 각 lane은 실제 키보드 입력, IME, 붙여넣기, 마우스, 스크롤, 검색, resize가 가능한 PTY다.
7. Activity에서 `Needs You`, 실행 중, 검증 중, handoff 중 상태와 입력 소유자 및 advisory coordination 역할을 확인한다.
8. `Focus`, `Stop`, `Handoff`, `Diff`, `Proof`로 터미널과 검증 화면을 오간다.
9. 사용자는 승인된 재현 가능한 check가 통과한 경우에만 작업을 완료한다.

## 3. 터미널 요구사항

### 필수

- GhosttyKit을 기본 backend로 사용한다.
- Ghostty source, ABI 표면, runtime resources, Zig toolchain은 `ghostty.lock.json`으로 고정한다.
- 앱 안에 Ghostty shell integration과 `xterm-ghostty` terminfo를 함께 넣는다.
- 설치된 Ghostty.app이나 외부 Ghostty dylib·resources에 의존하지 않는다.
- UTF-8·한글 입력, IME marked text, command key equivalent, clipboard, URL 열기, selection,
  mouse report, scroll, search, focus, Retina scale, resize를 지원한다.
- vim/nvim, less, fzf, top, tmux와 ordinary SSH가 실제 alternate-screen PTY에서 동작한다.
- Ctrl-C/D/Z, fg/bg, SIGWINCH, bracketed paste, OSC 8/file link와 drag-and-drop 경로 입력을 지원한다.
- lane마다 독립 PTY와 working directory를 가진다.
- Start 직후 새 terminal surface가 키보드 focus를 받는다.
- child lifecycle은 backend 소유권에 따라 정확히 한 곳에서만 종료·회수한다.
- Ghostty를 빌드할 수 없거나 runtime 초기화가 실패한 개발 빌드에서는 SwiftTerm으로 안전하게
  복구한다. release acceptance는 Ghostty backend를 실제로 실행해야 통과한다.

### 보안 경계

- 터미널 transcript, PID, 전체 command, prompt, token, environment를 workspace 상태에 저장하지 않는다.
- OSC 52 clipboard write처럼 terminal이 시작한 민감 동작은 명시적 확인 UI가 없으면 거부한다.
- URL은 사용자가 열 수 있는 scheme만 macOS를 통해 연다.
- 종료 시 소유권이 입증되지 않은 PID/PGID에는 신호를 보내지 않는다.

## 4. 멀티 에이전트 요구사항

- Shell, Codex, Claude, Gemini를 동일한 terminal primitive로 다룬다.
- 한 작업에서 여러 agent lane을 동시에 실행할 수 있다.
- 상태는 terminal 출력 문자열을 파싱해 추측하지 않는다. agent가 로컬 Unix socket으로 보내는
  versioned semantic event만 신뢰한다.
- 각 event는 run token, task, lane, generation, sequence와 payload 제한을 검증한다.
- socket은 현재 사용자만 접근할 수 있는 임시 디렉터리와 권한으로 만든다.
- 같은 worktree에는 한 번에 하나의 advisory `PRIMARY` coordination 역할만 둔다. 나머지는 `SECONDARY`다.
- 키보드 입력 대상은 한 번에 하나의 `INPUT` owner만 가진다.
- coordination 역할 변경은 `Handoff`라는 명시적 사용자 동작으로만 수행한다.
- `PRIMARY`/`SECONDARY`는 agent 협업을 위한 안내 계약이며 OS 수준 파일 잠금이나 쓰기 권한이 아니다. Git 충돌 방지의
  최종 책임은 독립 worktree와 사용자 검토에 있다.
- stale generation, replayed sequence, path traversal, 과도한 payload는 거부한다.

## 5. Workbench 요구사항

- Files, Editor, Terminal, Diff, Logs, Evidence, Proof pane을 재귀적으로 분할할 수 있다.
- `⌘D`/`⇧⌘D`로 분할하고 `⌥⌘←`/`⌥⌘→`로 focus를 이동하며 `⇧⌘K`로 닫는다.
- Ghostty terminal의 사용자 key sequence를 그대로 해석해 방향 분할·방향 focus·resize·equalize·close를
  native workbench에 전달한다. 현재 로컬 `⌃G` leader 설정은 별도 전역 key monitor 없이 동작해야 하며,
  terminal 밖의 editor·palette 입력을 가로채지 않는다.
- 각 terminal pane의 agent와 lane은 서로 독립적이다.
- task별 pane layout은 복원하되 live process나 저장하지 않은 terminal content는 복원하지 않는다.
- 실행 중 lane 또는 dirty editor를 잃는 pane/task/repository 전환은 fail-closed로 막는다.
- Files와 Editor는 worktree root를 벗어나는 symlink·경로를 거부한다.
- 파일 저장은 권한을 보존하는 원자 교체를 사용하고 외부 변경 충돌을 사용자에게 보여준다.
- `PLAN NEEDED`, `REVIEW PLAN`, `READY`, `WORKING`, `PROVEN`을 서로 다른 상태로 표시한다.
- 검증 계획 생성 agent는 저장소를 읽고 `gdm plan add/edit`만 수행하며 사용자 승인 전 구현·검증·commit을 시작하지 않는다.
- Gidem은 planning session 동안 checks.json 변경을 자동 감지하고 새 항목을 즉시 Proof Rail에 반영한다.
- 승인 fingerprint는 versioned canonical binary 형식으로 brief, audit 요구, 전체 contract와 check 정의를
  포함하고 runtime status/evidence 및 optional source fingerprint는 제외한다. 생략 가능한 contract/check
  필드는 CLI 기본값으로 정규화하므로 Swift와 CLI가 같은 SHA-256을 계산해야 한다.
- 승인 뒤 check 정의가 바뀌면 `REVIEW PLAN`으로 되돌리고 검증 실행·완료를 다시 잠근다.
- planning 직전 working tree와 Git index의 fingerprint를 저장하고, 승인 전후 두 번 같은지 확인한다.
  하나라도 다르면 승인을 저장하지 않거나 즉시 원복하며 구현 prompt를 보내지 않는다.
- `pass`, `recheck`, `done`은 승인한 plan fingerprint를 CLI에 전달하고 CLI는 repository lock 안에서
  현재 plan과 일치할 때만 상태를 변경한다.

## 6. UI·UX 요구사항

- 현재의 짙고 조밀한 terminal/flight-operations 시각 언어를 유지한다.
- 상태는 색만으로 구분하지 않고 glyph와 정확한 문구를 함께 사용한다.
- `Needs You`는 실패나 완료와 분리된 주의 상태로 가장 먼저 발견할 수 있어야 한다.
- agent selector와 Activity는 실제 lane 상태를 같은 vocabulary로 표시한다.
- pane 폭이 좁으면 selector는 glyph 중심으로 축약하고 접근성 label에는 전체 상태를 남긴다.
- 1024pt에서는 한 lane에 집중하는 탭형 구성을, 1440pt 이상에서는 네 lane 2×2 구성을
  읽을 수 있어야 한다.
- popover는 화면 높이에 맞춰 확장하고 남는 항목은 명시적으로 scroll한다.
- 모든 주요 동작은 키보드와 VoiceOver label을 제공한다.
- macOS Reduce Motion에서는 반복 pulse와 panel/overlay transition을 즉시 전환으로 바꾼다.
- terminal transcript와 evidence는 애니메이션하지 않는다.
- Retina 2× 렌더에서 1024×700, 1440×900, 1728×1117 모두 잘림·겹침·과도한 축소가 없어야 한다.

## 7. 앱·배포 요구사항

- macOS 14 이상, Apple Silicon을 지원한다.
- `Gidem.app` 안에 실행 파일, app icon, Swift package resources, Ghostty resources, terminfo,
  third-party notice와 직접 서명된 `Contents/Helpers/gdm`을 포함한다.
- packaged 앱은 bundled helper만, SwiftPM 개발은 같은 source tree의 빌드된 helper만 사용한다.
  선택 저장소의 `cli/`, Bun source, `PATH`의 gdm으로 폴백하지 않는다.
- 개발 산출물은 local ad-hoc sign으로 즉시 실행 가능해야 한다.
- release 검증은 bundle 구조, signature, architecture, Ghostty symbols, 외부 Ghostty 비의존성,
  terminal smoke, screenshot을 검사한다.
- Developer ID 서명과 notarization은 공개 배포 전 별도 release 단계다.

## 8. 완료 기준

다음 항목이 모두 통과해야 이 요구사항 구현이 완료된 것으로 본다.

- Ghostty가 없는 빌드에서 SwiftTerm fallback 회귀 테스트가 통과한다.
- pinned Ghostty framework·headers·symbols·resources hash가 일치한다.
- Ghostty backend로 실제 PTY를 열어 UTF-8 한글 입력, bundled terminfo, 비정상 exit status와 정상 종료를 검증한다.
- 실제 surface에서 vim/nvim/less/fzf/top/tmux, SSH protocol fixture, Ctrl-C/D/Z와 fg/bg를 검증한다.
- 실제 surface에서 mouse report, selection, bracketed paste, OSC 52 차단, OSC 8/file link,
  scrollback 검색·이동·삭제, drag-and-drop, SIGWINCH와 rapid Retina resize를 검증한다.
- 두 개 이상의 실제 lane을 동시에 실행하고 독립적으로 종료한다.
- semantic event 인증, replay/stale/payload 방어, 단일 advisory primary/input, 명시적 handoff가 통과한다.
- 여러 lane의 session metadata가 lane별로 복원되고 모든 active lane이 재시작 시 interrupted로 전환된다.
- `Gidem.app`을 만들고 외부 Ghostty 설치 없이 terminal smoke를 통과한다.
- GDM이 없는 임의 Git 저장소에서 bundled helper로 worktree·계약을 만드는 headless smoke를 통과한다.
- Agent Operations 화면을 1024/1440/1728 Retina와 Reduce Motion에서 렌더해 검수한다.
- 전체 Swift test, contrast check, hard-coded color check, release verifier가 통과한다.
- 고위험 변경은 다른 모델의 fresh-context 독립 검수를 통과한다.

## 9. 명시적 비목표

- terminal 명령이나 조작을 GUI 버튼만으로 대체하는 것
- agent 출력 문구를 완료 증거로 간주하는 것
- terminal transcript나 비밀값을 영구 보관하는 것
- OS 수준 공동 편집·파일 잠금
- 살아 있는 외부 terminal session 재접속
- LSP, debugger, extension marketplace, GitHub PR provider 전체 구현
- 사용자 승인 없는 staging, commit, push, merge, worktree 삭제
