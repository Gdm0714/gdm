# Gidem

<p align="center">
  <picture>
    <source media="(max-width: 480px)" srcset="assets/readme-hero-compact.svg">
    <img src="assets/readme-hero.svg" width="920" alt="Gidem — Agents run. Evidence decides.">
  </picture>
</p>

<p align="center"><strong>Agents run. Evidence decides.</strong></p>

Gidem은 여러 코딩 에이전트의 작업 공간과 검증 상태를 한곳에서 다루는 macOS Native
워크스페이스다. 터미널·파일·diff·journal·evidence를 함께 보여주고, 에이전트의 완료 주장이
아니라 재현 가능한 증거로 작업 종료를 판정한다.

`gdm`은 Gidem 아래에서 동작하는 결정적 검증 엔진과 CLI다. 이 저장소에는 **Gidem 앱**과
**gdm 하네스**가 함께 들어 있다. 기반 원칙은
**작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우**다.

## 무엇을 해결하나

- 작업 시작 전에 필수 조건·금지 조건·검증 명령을 고정한다.
- 작업별 branch와 worktree로 변경을 격리한다.
- 검증 명령의 출력·종료 코드·SHA-256을 증거로 남긴다.
- 완료, 독립 검수, commit, PR, merge 권한을 서로 분리한다.
- 실패와 놓친 결함을 다음 작업의 검증 습관으로 환류한다.

## 제품 구성

| 구성 | 역할 | 현재 상태 |
|---|---|---|
| **Gidem Native** | Ghostty 터미널, 파일·편집기, diff, Proof Rail, 멀티 에이전트 lane | macOS 소스 빌드 가능 |
| **gdm CLI** | 작업 계약, check 실행, evidence, audit·delivery 게이트 | macOS·Linux 지원 |
| **스킬팩** | 구현·검수·분석·UI·DB·문서·PR 등 작업별 실행 프로토콜 | Codex·Claude·Pi 대상 생성 |
| **gdm-pi** | 요청에 맞는 스킬을 선택하고 구현 모델과 독립 검수 모델을 고정 | Pi 0.84.1 기준 검증 |
| **Context Pack** | 코드·문서·작업 관계를 제한된 크기의 탐색 힌트로 반환 | one-shot 실험 단계 |

> 현재 원격 release asset은 아직 게시되지 않았다. 아래 **소스 설치**가 현재 코드를 사용하는
> 권장 경로이며, `curl ... | bash` 설치기는 첫 GitHub Release 게시 후 사용할 수 있다.

## 빠른 시작

### 1. 소스에서 설치

요구사항: [Bun](https://bun.sh), Git, 대화형 실행 주체인 Codex 또는 Pi.

```bash
git clone https://github.com/Gdm0714/gdm.git
cd gdm
./install/install.sh
```

설치기는 `gdm`, `gdm-pi`, target별 스킬과 역할 실행기를 설치한다. 기존 Codex hook과 설정은
보존하고, 변경 전 hook 파일은 별도 backup으로 남긴다.

### 2. Pi에서 실행

```bash
gdm-pi                              # 요청별 자동 라우팅
gdm-pi go "로그인 오류를 고쳐줘"    # 일상 구현 루프
gdm-pi full "검수까지 완료해줘"     # 다른 모델의 독립 검수 포함
gdm-pi --raw                        # GDM 없이 원본 Pi 실행
```

기본 구현 모델은 `openai-codex/gpt-5.6-sol:xhigh`, 독립 검수 모델은
`openai-codex/gpt-5.6-terra:xhigh`다. 실행 중 모델을 바꾸는 대신 새 `gdm-pi` 프로세스의
환경변수로 설정해야 실행 metadata와 실제 모델이 일치한다.

<details>
<summary><strong>gdm CLI로 evidence loop 직접 실행하기</strong></summary>

```bash
gdm plan init --slug fix-login --brief "로그인 오류 수정" \
  --require "기존 로그인 동작 보존" \
  --forbid "자동 커밋" \
  --allow-path src --allow-path test \
  --risk medium --verification deterministic

gdm plan add --slug fix-login \
  --desc "로그인 회귀 테스트" \
  --cmd "bun test login" \
  --expect "exit 0" \
  --kind regression

gdm pass c1 --red --slug fix-login  # 수정 전 실패 재현
# 구현
gdm pass c1 --slug fix-login
gdm done --slug fix-login
```

`done`은 검증 완료만 뜻한다. commit·push·PR·merge 권한은 별도의 명시적 승인과 delivery
게이트가 필요하다.

</details>

## Gidem Native

Gidem Native는 별도 터미널 앱을 열지 않고도 작업을 끝낼 수 있는 terminal-first workbench다.

- 선택한 저장소에서 task별 branch와 worktree 생성
- 사용자가 승인한 verification plan만 실행
- Shell·Codex·Claude·Gemini용 독립 PTY lane
- Files, Editor, Terminal, Diff, Logs, Evidence, Proof pane
- `Needs You`, 검증, handoff와 advisory `PRIMARY` 상태 표시
- source·Git index가 바뀐 stale plan의 실행 차단

macOS 14 이상 Apple Silicon과 Xcode Command Line Tools가 필요하다.

```bash
cd native
./scripts/build-app.sh
open .build/app/Gidem.app
```

앱은 pinned GhosttyKit과 runtime resources를 자체 bundle에 포함한다. Developer ID 서명과
notarization을 포함한 공개 배포는 아직 준비 중이다. 자세한 기능과 제한은
[`native/README.md`](./native/README.md)에서 확인할 수 있다.

## 최근 추가된 Pi 기능

### 영구 메모리

`gdm-pi`는 사용자가 말한 장기 선호·안정적인 환경 정보·명시적 프로젝트 결정을 세션 간에
회상할 수 있다. 저장 내용은 로컬 JSONL에 남고, secret 형태의 값과 일시적인 작업 상태는
거부한다. 회상된 내용은 항상 오래되었을 수 있는 신뢰하지 않는 데이터로 취급한다.

```text
/remember [--global|--project] <내용>
/memory list [--global|--project]
/memory forget <id-prefix>
/memory doctor
```

### 격리 Computer Use

`gdm_computer_use`는 호스트 데스크톱 대신 별도의 macOS Tart VM을 조작한다. 좌표 입력 전에
항상 guest screenshot을 읽고, VM 화면의 텍스트는 신뢰하지 않는 데이터로 취급한다.

기본 설치 경로에서 한 번만 준비한다. pinned Tart 2.36.0과 최소 60 GiB의 여유 공간이 필요하다.

```bash
~/.pi/agent/skills/gdm-agents/pi/gdm-computer-use/setup.sh
```

VM 입력은 guest loopback RFB로 전달되며 host TCP listener와 host focus 변경을 허용하지 않는다.
세션이 끝나면 실행기가 소유한 VM만 종료한다.

### bounded Context Pack

`gdm context query`는 코드·문서·package·Work metadata의 관계를 읽어 기본 4 KiB 이하의
navigation hint를 반환한다. daemon, network, embedding, persistent cache 없이 one-shot으로
동작한다.

```bash
gdm context status
```

현재 Context Pack은 **Pi 자동 주입이나 기본 활성화에 연결되지 않은 실험 기능**이다. 18회
receipt-bound smoke 중 13회만 measurement-valid였으므로 token 절감이 입증됐다고 주장하지
않는다. 측정값과 승격 조건은
[`bench/context-pack-evaluation-2026-09-03.md`](./bench/context-pack-evaluation-2026-09-03.md)에
기록했다.

## 검증 모델

흐름은 `약속 → 증명 → 관찰 → 습관 → 비교`다.

| 단계 | gdm이 보존하는 것 |
|---|---|
| `plan` | 요구사항, 금지 조건, 허용 경로, 위험도, 재현 명령 |
| `pass` | 실제 명령 출력, 종료 코드, evidence SHA-256 |
| `done` | 전체 check 재실행과 scope·evidence 무결성 결과 |
| `audit` | 구현과 다른 모델의 판정, 보고서와 source fingerprint |
| `delivery` | 이슈, branch, HEAD, PR, CI와 merge 승인 |

Codex·Claude·Pi는 같은 `.gdm/<slug>` 상태와 versioned Work Protocol을 사용한다. snapshot과
handoff는 컨텍스트와 stale 상태만 전달하며 check나 delivery 권한을 부여하지 않는다. wire schema,
읽기 전용 역할 lifecycle과 trust boundary는 [`DESIGN.md`](./DESIGN.md)에 정리했다.

## 선택형 도구와 디자인

- [terminal-browser](https://github.com/zenbu-labs/terminal-browser)는 웹 UI 검증을 실제
  브라우저 동작으로 재현한다.
- [tuicr](https://tuicr.dev/)는 사람이 diff와 코멘트를 함께 검토하는 화면을 제공한다.
- Claude Code 쪽 스킬은
  비대화형 설계·검수 역할에 쓰인다.

두 companion tool은 선택형이며 gdm 설치기가 자동으로 설치하지 않는다. 사용할 수 없으면 기존
headless 테스트나 텍스트 리뷰로 폴백한다.

새 화면·레이아웃·프로토타입 생성은 claude.ai/design에서 시작한다. GDM은 Design용 prompt를
만들고 결과를 pull하지만 Chrome이나 브라우저를 자동 조작하지 않는다.

## 요구사항

| 용도 | 요구사항 |
|---|---|
| gdm CLI | macOS 또는 Linux, arm64 또는 x64 |
| 소스 설치·개발 | Bun |
| gdm-pi | Pi 0.84.1, `openai-codex` 로그인 |
| 기술 설계·독립 검수 | Claude Code CLI 로그인 |
| Gidem Native | macOS 14+, Apple Silicon, Xcode Command Line Tools |
| 0→1 화면 디자인 | claude.ai/design 접근 권한과 최초 1회 `/design-login` |

## 저장소 구조

```text
native/   Gidem macOS SwiftUI 워크스페이스
cli/      결정적 상태·증거 게이트와 gdm 바이너리
skills/   target 중립 GDM 스킬 source
agents/   역할 실행기, provider adapter, Pi 확장
install/  스킬 renderer와 transactional 설치기
bench/    동일 조건 benchmark와 측정 결과
website/  Gidem 소개 웹사이트
```

## 개발과 검증

CLI 전체 검증은 clean tree에서 binary를 먼저 만든 뒤 실행한다.

```bash
cd cli
bun run build
bun run verify
```

Gidem Native의 Swift test, Ghostty compatibility, 접근성·렌더 검증 명령은
[`native/README.md`](./native/README.md#검증)에 정리되어 있다.

## 문서

- [`DESIGN.md`](./DESIGN.md) — gdm 상태 머신, Work Protocol, trust boundary
- [`INVARIANTS.md`](./INVARIANTS.md) — 바뀌지 않아야 하는 안전·검증 불변식
- [`native/REQUIREMENTS.md`](./native/REQUIREMENTS.md) — Gidem Native 제품 계약
- [`GITFLOW.md`](./GITFLOW.md) — 이슈·branch·PR·squash merge 규칙
- [`bench/README.md`](./bench/README.md) — benchmark 방법과 해석 경계

## 라이선스

[MIT](./LICENSE)
