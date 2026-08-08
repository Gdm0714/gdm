# gdm native

`gdm native`는 하나의 검증 가능한 작업에 gdm 계약, 명령 세션, Git diff, check evidence,
audit과 delivery 상태를 묶는 개인용 macOS 워크스페이스다.

## 실행

macOS 14 이상과 Xcode Command Line Tools가 필요하다.

```bash
cd native
swift run gdm-native --repo ..
```

다른 저장소를 열려면 해당 저장소의 절대 경로를 `--repo`에 준다. 저장소에는 gdm이 만든
`.gdm` 디렉터리가 있어야 실제 작업이 나타난다.

## 현재 동작

- root의 legacy `.gdm/*/checks.json`과 native workspace registry를 함께 읽는다.
- `New Task`가 `gdm/<slug>` branch와 sibling `gdm-worktrees/<slug>` worktree를 만들고,
  그 worktree 안에서 `gdm plan init`을 실행한다.
- Proof Rail이 open check와 audit 조건을 완료 blocker로 계산한다.
- `Run verification`과 `done`은 항상 선택된 task worktree에서 실행한다. 증거도 그곳의
  실제 `.gdm/<slug>`에 남으며 root 상태로 폴백하거나 복사하지 않는다.
- 모든 조건이 충족된 작업은 `gdm done`으로 닫을 수 있다.
- 중앙에서 Shell, Codex, Claude, Gemini를 task별 interactive PTY로 실행한다. ANSI 렌더링,
  키 입력, 붙여넣기, Ctrl-C와 창 크기 변경은 SwiftTerm이 담당한다.
- toolbar의 Agent Activity는 여러 task의 세션을 agent별로 집계한다. 넓은 화면에서는
  Codex·Claude·Gemini를 바로 보여주고, 좁은 화면에서는 현재 agent와 전체 상태 popover로
  접는다. 상태 행에는 task·branch·worktree·경과 시간만 표시하며 prompt, 전체 command, PID는
  표시하거나 저장하지 않는다.
- Codex·Claude·Gemini 아이콘은 설치된 각 vendor의 공식 macOS 앱에서 원본 이미지를 런타임에
  읽는다. 앱이나 asset이 없으면 text monogram으로 폴백하며 vendor asset을 저장소에 복제하거나
  재착색하지 않는다.
- 상태 handoff, pane, tab만 짧게 움직인다. terminal transcript와 evidence text는 animate하지
  않으며 macOS의 Reduce Motion이 켜져 있으면 반복 pulse와 transition을 모두 즉시 전환으로 바꾼다.
- drawer에서 Git diff, 선택 작업 journal, evidence를 전환한다.
- 1024px 폭에서는 Proof Rail과 drawer가 명시적 탭으로 접힌다.

workspace 매핑은 root `.gdm/native/workspace.json`에 원자적으로 저장한다. 선택 agent와 마지막
세션의 종류·시작/종료 시각·결과만 남기며 PID, 환경변수, 터미널 transcript는 저장하지 않는다.
앱이 비정상 종료된 뒤 남은 `active` 기록은 다음 실행에서 `interrupted`로 바뀐다. 이전 PID에
재접속하거나 신호를 보내지 않는다. 종료 시각도 알 수 없으므로 재실행 시각으로 채우지 않고,
이 경우 경과 시간은 표시하지 않는다.

root legacy 작업은 registry record가 없어서 선택 agent와 마지막 session을 앱 재시작 뒤에는 복원할
수 없다. 다만 현재 앱 프로세스 안에서는 task별 선택 agent와 session 메타데이터를 메모리에 유지해
task 전환과 Refresh 뒤에도 실제 live session의 agent를 selector와 Activity에 일치시킨다.

범용 PTY 출력만으로 agent가 사용자 입력을 기다리는지 신뢰성 있게 판별할 수 없으므로 live session의
`waiting for input` 상태를 출력 휴리스틱으로 추론하지 않는다. 이 상태는 향후 agent가 명시적 신호를
제공할 때를 위해 예약되어 있으며, 현재 demo에서는 상태 표현 검증에만 사용한다.

명시적 Stop·quit에서는 확인된 live PTY process group에 TERM을 한 번 보낸다. direct PTY leader가
grace period 뒤에도 `waitpid`로 소유한 live child임이 확인된 경우에만 group KILL로 올리고, 그
direct leader를 회수한다. leader가 먼저 natural exit 또는 grace exit로 회수된 뒤 TERM을 무시하고
남은 same-PGID descendant와 별도 session의 detached descendant는 종료 보장의 범위 밖이다.
이후 group signal은 PID/PGID 재사용 안전을 위해 fail-closed로 금지한다.

## 의도적으로 미룬 범위

- 기존 세션 재접속과 transcript 복원
- worktree·branch 자동 삭제/rollback UI
- direct leader가 먼저 종료된 뒤 남은 same-PGID descendant 강제 정리
- PTY process group에서 스스로 분리된 descendant 정리
- GitHub PR 공급자 연동
- 서명·notarization을 포함한 `.app` 배포

agent 실행 실패는 다른 도구로 폴백하지 않고 터미널 상태와 오류로 드러낸다. Gemini도 선택한
worktree를 cwd로 삼아 `gemini`를 shell 보간이나 기본 prompt 없이 실행한다. 에이전트의 설명은
완료 증거로 승격하지 않으며, 완료 판단은 계속 선택 worktree의 gdm 상태 파일이 담당한다.

## 검증

```bash
swift test
./scripts/check-contrast.sh
./scripts/check-hardcoded-colors.sh
./scripts/render.sh
```

렌더 스크린샷은 `../.gdm/native-agent-loop/ui/`에 생성된다. `--demo` 렌더는 UI 배치만
검사하며 실제 PTY나 agent 프로세스를 시작하지 않는다.
