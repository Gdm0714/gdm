# gdm

**Agents run. Evidence decides.**

`gdm`은 코딩 에이전트의 작업을 계약·검증 명령·증거로 관리하는 하네스다.
**작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우**를 만든다.
이 저장소는 검증 CLI, 스킬, 실행 어댑터와 하네스 확장을 담는다.
`gdm-memory`와 `gdm-computer-use`도 하네스 구성에 포함된다.

## Language / 언어

The CLI supports Korean and English. It follows `LC_ALL`, `LC_MESSAGES`, then `LANG`, with the macOS system language as a fallback. Other languages use English.

```sh
gdm --language en --help   # Override this invocation
gdm language en            # Persist English; use ko or auto to change it
```

Priority: `--language` before the command, `GDM_LANGUAGE`, saved choice, system language. The choice is stored in `~/.config/gdm/language` (`GDM_CONFIG_DIR` or `XDG_CONFIG_HOME` can relocate it). Commands, JSON keys, user text and evidence stay unchanged. [English installation guide](https://gdmux.pages.dev/downloads/QUICKSTART.en.md).

## 무엇을 해결하나

- 작업 시작 전에 필수 조건·금지 조건·검증 명령을 고정한다.
- 실행 스킬이 작업별 branch와 worktree로 변경을 격리한다.
- 검증 명령의 출력·종료 코드·SHA-256을 증거로 남긴다.
- 완료, 독립 검수, commit, PR, merge 권한을 서로 분리한다.
- 실패와 놓친 결함을 다음 작업의 검증 습관으로 환류한다.

## 하네스 구성

| 구성 | 역할 | 현재 상태 |
|---|---|---|
| **gdm CLI** | 작업 계약, check 실행, evidence, audit·delivery 게이트 | macOS·Linux 지원 |
| **스킬팩** | 구현·검수·분석·UI·DB·문서·PR 등 작업별 실행 프로토콜 | Codex·Claude·Pi 대상 생성 |
| **gdm-pi** | 요청에 맞는 스킬을 선택하고 구현 모델과 독립 검수 모델을 고정 | Pi 0.84.1 기준 검증 |
| **gdm-memory** | 세션 간 선호·결정 회상과 로컬 메모리 저장 | Pi 하네스 확장 |
| **gdm-computer-use** | 격리 VM 입력, 후보 중 Jev 선택 실험 | Rust CLI·stdio MCP·Pi 어댑터 |
| **Context Pack** | 코드·문서·작업 관계를 제한된 크기의 탐색 힌트로 반환 | one-shot 실험 단계 |

## 실행 파일로 설치

소스는 이 저장소에 [MIT](./LICENSE) 라이선스로 공개되어 있습니다. 소스를 빌드하지 않고 쓰려면 macOS 13 이상의 Apple Silicon·Intel용 서명·공증된 실행 파일을 설치하세요. Rust·Bun·GitHub 로그인 없이 설치할 수 있습니다.

```sh
curl -fL https://gdmux.pages.dev/install.sh -o /tmp/gdm-tools-install.sh
zsh /tmp/gdm-tools-install.sh --tool gdm --with-skills
```

`gdm` 실행 파일은 기본적으로 `~/.local/bin`에 설치됩니다. 설치 후 PATH 안내가 나오면 해당 폴더를 셸의 명령 검색 경로에 추가하세요.
`--with-skills`는 Codex·Claude·Pi 스킬, Pi 실행기와 Codex hook을 설치합니다. CLI만 필요하면 옵션을 빼세요.
Linux용 사전 빌드 파일은 이번 프리뷰에 포함되지 않습니다.
[설치·첫 실행·업데이트 안내](https://gdmux.pages.dev/downloads/QUICKSTART.md)

## 빠른 시작

### 1. 소스에서 설치

요구사항: Rust 1.97 이상과 Cargo, Git, 대화형 실행 주체인 Claude Code, Codex 또는 Pi.

```bash
git clone https://github.com/Gdm0714/gdm.git
cd gdm
./install/install.sh
```

설치기는 `gdm`, `gdm-pi`, target별 스킬과 역할 실행기를 설치한다. 기존 Codex hook과 설정은
보존하고, 변경 전 hook 파일은 별도 backup으로 남긴다.

### 2. Claude Code에서 실행

Claude Code만으로 계획·구현·테스트·완료까지 사용할 수 있다. 소스 설치 후 작업할 프로젝트에서
`claude`를 시작하고 다음처럼 요청한다. 이미 실행 중인 세션은 새 세션으로 시작해 설치된
스킬을 다시 읽는다. GDM을 위해 Codex·Pi 설치나 OpenAI 로그인을 추가할 필요는 없다.

```text
/gdm-go 로그인 오류를 수정하고 검증까지 완료해줘
/gdm-plan 데이터 가져오기 기능을 설계해줘
/gdm-full 구현과 독립 검수까지 해줘
```

일상 작업은 현재 Claude Code에서 선택한 모델로 수행한다. 일반 세션은 파일 편집과 검증
명령을 실행하며, 별도로 호출하는 전문 역할에만 tool-0 읽기 전용 제한을 적용한다.
`gdm-full`은 구현과 다른 실제 모델의 검수를 요구한다. 같은 Claude 공급자의 다른 모델을
`run-role.sh ... --provider claude --model <모델 ID>`로 선택할 수 있다. 사용할 수 있는 다른
모델이 없으면 full은 차단되며, 일상 `gdm-go`에는 두 번째 모델이 필요하지 않다.
`GDM_CLAUDE_MODEL`은 전문 역할 기본 모델만 바꾸며 현재 진행자의 모델은 바꾸지 않는다.
모델 별칭만 다르게 쓰거나 새 대화를 여는 것으로 서로 다른 모델 검수를 대신하지 않는다.

### 3. Pi에서 실행

```bash
gdm-pi                              # 요청별 자동 라우팅
gdm-pi go "로그인 오류를 고쳐줘"    # 일상 구현 루프
gdm-pi full "검수까지 완료해줘"     # 다른 모델의 독립 검수 포함
gdm-pi --raw                        # GDM 없이 원본 Pi 실행
```

Pi 프로필의 기본 구현 모델은 `openai-codex/gpt-5.6-terra:high`다. 읽기 전용 조사는
`gpt-5.6-luna:medium`, 설계·중요 코드 검토와 독립 검수는 `gpt-6-astra:medium`을 쓴다.
동작 변경은 완료 전 검토를 받고, 구조·상태 계약·권한·동시성 변경은 구현 전 설계 자문도 받는다.
문서·서식만 바꾸는 작업은 제외한다. 모든 역할에 `medium`·`high`를 지정할 수 있다.
reviewer 결과는 자문이며 `gdm-full`의 독립 검수를 대신하지 않는다.

메인은 `GDM_PI_MODEL`, `GDM_PI_THINKING`으로 설정하고 역할별 작업자는
`GDM_PI_SCOUT_MODEL`, `GDM_PI_DESIGN_MODEL`, `GDM_PI_REVIEW_MODEL` 및 각각의
`_THINKING` 변수로 설정한다. 역할별 설정이 없으면 기존 `GDM_PI_CHILD_MODEL`,
`GDM_PI_CHILD_THINKING`을 호환용 공통 자식 설정으로 사용한다. 둘 다 없으면 역할 기본값을 쓴다.
full 검수는 `GDM_PI_AUDIT_MODEL=provider/model:thinking`으로 지정한다.

메인 모델은 세션 동안 고정된다. 복잡한 직접 구현에 Astra를 쓰려면
`GDM_PI_MODEL=openai-codex/gpt-6-astra`, `GDM_PI_THINKING=medium`으로 새 프로세스를
시작한다. full 검수는 다른 모델인 `GDM_PI_AUDIT_MODEL=openai-codex/gpt-5.6-terra:high`로
지정할 수 있다.

위임 결과에는 요청 모델·추론 강도·소요 시간·Pi가 보고한 토큰 사용량이 기록된다.
이는 원격 모델 신원 증명이나 구독 청구액이 아니다. 실패한 호출의 부분 사용량은 남기되
완전한 측정으로 표시하지 않는다. 거부된 요청·실패한 실행·빈 응답은 역할 완료로 세지 않는다.

자동 대화 요약이 보고한 사용량도 합산하며, 요약 후 재실행된 정상 응답을 이어서 처리한다.
출력 길이 제한으로 실패해도 이미 수신한 사용량은 보존하고, 요약 사용량이 없으면 불완전으로 표시한다.

도구 결과의 `delegation`은 `attempted` 요청 수, `launched` 프로세스 시작 수,
`succeeded` 정상 응답 수와 `rejected` 입력·설정 거부 수를 구분한다. 프로세스가 시작됐다는
사실만으로 지정 모델이 작업을 마쳤다고 판단하지 않는다.
[실제 협업 품질 비교](bench/astra-quality/results-2026-09-09.md)는 기능 검사와 역할 참여를 따로 보고한다.

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

기록된 실패를 다시 검사하려면 `gdm regression candidates`에서 후보를 고르고,
`capture`로 최소 입력과 검증 명령을 고정한 뒤 `replay`로 수정 전후를 비교한다.
사례 저장은 명령을 실행하지 않으며, 재실행 결과는 Work 완료 상태와 별도로 기록된다.
[실패 기록을 회귀 사례로 연결하기](docs/regression-cases.md)에 사용법과 실행 범위를 정리했다.

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
gdm computer-use setup --check
gdm computer-use setup
```

VM 입력은 guest loopback RFB로 전달되며 host TCP listener와 host focus 변경을 허용하지 않는다.
세션이 끝나면 실행기가 소유한 VM만 종료한다.

기존 모델이 후보를 만들고 Jev는 후보 중에서만 선택하는 실험 경로를 제공한다.
설정·동작·실측 방법은 [Computer Use와 Jev](docs/computer-use-jev.md)를 참조한다.

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
- Claude Code 쪽 스킬은 대화형 진행자의 전체 작업 절차를 제공한다. 별도 설계·검수
  프로세스에는 기존 읽기 전용 역할 실행기를 사용한다.

기술 설계는 진행자가 코드 근거로 판단한다. Claude 설계안은 사용자 요청이나 남은 독립
쟁점에 도움이 될 때 선택하며, 모든 새 기술 선택에 외부 호출을 요구하지 않는다.
check 수와 간소화 검사·회고는 작업 위험과 실제 사건에 맞춘다. 이미 받은 승인은 유지하고,
필수 검증 후에는 새 변경·실패·미해결 위험이 있을 때만 추가 검증한다. full의 독립 검수와
CLI의 증거·범위·완료 게이트는 그대로 적용한다.

두 companion tool은 선택형이며 gdm 설치기가 자동으로 설치하지 않는다. 사용할 수 없으면 기존
headless 테스트나 텍스트 리뷰로 폴백한다.

새 화면·레이아웃·프로토타입 생성은 claude.ai/design에서 시작한다. GDM은 Design용 prompt를
만들고 결과를 pull하지만 Chrome이나 브라우저를 자동 조작하지 않는다.

## 요구사항

| 용도 | 요구사항 |
|---|---|
| gdm CLI | macOS 또는 Linux, arm64 또는 x64 |
| 소스 설치·개발 | Rust 1.97+, Cargo, Git (이전 구현 비교 테스트만 Bun 필요) |
| gdm-pi | Pi 0.84.1, `openai-codex` 로그인 |
| 선택형 Claude 기술 설계 | Claude Code CLI 로그인 |
| full 독립 검수 | 구현 모델과 다른 검수 모델을 실행할 수 있는 provider 로그인 |
| 0→1 화면 디자인 | claude.ai/design 접근 권한과 최초 1회 `/design-login` |

## 저장소 구조

```text
src/      Rust CLI, 상태·증거 게이트, 통합과 Computer Use
tests/    Rust 검증과 이전 구현 비교 기준
cli/      이전 CLI와 호환성 테스트 (운영 경로에서 사용하지 않음)
skills/   target 중립 GDM 스킬 source
agents/   역할 실행기, provider adapter, Pi 확장 (memory·computer-use 포함)
install/  스킬 renderer와 transactional 설치기
bench/    동일 조건 benchmark와 측정 결과
fixtures/ 검증 프로토콜의 공통 테스트 데이터
script/   하네스 릴리스 패키징·검증
```

Gidem Native 앱과 디자인 자산은 별도 `gidem-native` 저장소에서 관리한다.
소개 사이트는 [gidem-website](https://github.com/Gdm0714/gidem-website)에 있다.
로컬에서는 `../gidem-native`, `../gidem-website`를 사용한다. `gid`와 `gdmux`도 각각 별도 저장소다.

## 개발과 검증

CLI 전체 검증은 clean tree에서 binary를 먼저 만든 뒤 실행한다.

```bash
cargo build --locked
cargo test --locked
python3 script/qa/rust-parity.py
python3 script/qa/rust-native-check.py
```

## 문서

- [Rust 전환과 코드 읽는 순서](docs/rust-runtime.md)
- [Computer Use와 Jev 실험](docs/computer-use-jev.md)

- [`DESIGN.md`](./DESIGN.md) — gdm 상태 머신, Work Protocol, trust boundary
- [`INVARIANTS.md`](./INVARIANTS.md) — 바뀌지 않아야 하는 안전·검증 불변식
- [`GITFLOW.md`](./GITFLOW.md) — 이슈·branch·PR·squash merge 규칙
- [`bench/README.md`](./bench/README.md) — benchmark 방법과 해석 경계

## 라이선스

[MIT](./LICENSE)

## iOS 실기기 검증

`gdm device`로 기기 확인, 개발 빌드, 설치, XCTest, 격리 화면 캡처를 실행합니다.
[gid 연결과 프로젝트 설정](integrations/device/README.md)을 참고하세요.
