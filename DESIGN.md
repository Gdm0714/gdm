# gdm — 개인 AI 하네스 설계

> v0.3 (2026-07-02) · 대상: Claude Code + Codex
> 목적: OMO(lazycodex 포함)·OMX를 걷어내고 **독자 설계의 gdm**으로 대체 + 세션 밖 실행 관리

## 0. 판올림 요지

- v0.2: 완전 대체 목표 확정, lazycodex 구조 계승 전략
- **v0.3: 독자 설계 원칙 추가.** 기존 하네스의 스키마·용어·프롬프트를 차용하지 않고,
  작업 모델을 "검증 항목(check) 중심"으로 자체 재설계. 설계 취향의 근거를
  내 규칙 문서(환각 방지, 과잉 엔지니어링 방지, 토스 라이팅)에서 도출.

## 1. 독자 설계 원칙 (도용 금지)

1. **원문 차단**: OMO/OMX/workbook의 프롬프트 원문, 상태 파일 스키마, 명령어 어휘를
   열어서 베끼지 않는다. 참조는 "무엇이 왜 효과적이었나"라는 아이디어 수준까지만.
2. **아이디어 수준 차용은 허용**: 증거 기반 완료 판정, fresh-context 독립 검수,
   append-only 기록 — 업계 일반 패턴이며 특정 구현의 소유물이 아니다.
3. **취향의 출처는 내 규칙 문서**: gdm의 설계 결정은 아래에서 도출한다.
   - `~/.claude/rules/claude.md` 환각 방지 → 모든 주장은 확인된 사실이어야 한다
     ⇒ 작업 모델을 목표가 아니라 **검증 항목 중심**으로
   - 같은 문서의 과잉 엔지니어링 방지 ⇒ 역할·기능 최소주의
   - 토스 테크니컬 라이팅(wiki-writing에서 사용 중) ⇒ 산출 문서는 역피라미드, 결론 먼저
   - 내 커밋/PR 규칙 (gitflow, AI 표기 금지) ⇒ 마무리 단계에 내장

## 2. 목표 / 비목표

### 목표

1. OMO·OMX를 완전히 제거하고 실사용 기능의 gdm 대응물로 갈아탄다 (OMC는 마지막에 판단)
2. Claude Code·Codex 동시 지원 (스킬 파일 공유, 설치만 어댑터)
3. 완료 판정은 결정적 CLI 게이트가 한다 — 검증 안 된 항목이 남으면 완료 선언 불가
4. 산출물(작업 문서, 검수보고)이 그대로 위키 자산이 되는 문서 품질
5. 세션 밖 실행 관리(run/watch/알림)로 확장

### 비목표

- lazycodex 파이프라인 복제 (역할 수, 어휘, 스키마 모두 독자 설계)
- 안 쓰는 기능 재현 (autopilot, HUD, telemetry, codegraph, lsp 등)
- Agent SDK 기반 자체 루프 (API 과금 회피, CLI 워커에 위임)
- 범용 프레임워크·타인 배포

## 3. gdm의 작업 모델 (자체 설계의 핵심)

기존 하네스들은 "목표(goal) → 성공 기준(criteria)" 분류로 작업을 조직한다.
gdm은 내 환각 방지 규칙에서 출발해 **검증 항목(check) 중심**으로 뒤집는다:

> 작업이란 "확인 항목들을 전부 초록으로 만드는 일"이다.
> 확인 항목은 처음부터 재현 가능한 형태(명령 + 기대 결과)로 적는다.

### 상태 파일 (`.gdm/<작업슬러그>/`)

| 파일 | 성격 | 내용 |
|---|---|---|
| `work.md` | 사람용, 역피라미드 | 결론(현재 상태) → 목표 → 진행 기록. 세션이 갱신 |
| `checks.json` | 기계용 | `[{id, 설명, cmd(재현 명령), expect(기대 관찰), observed(출력 파일 경로), status}]` |
| `journal.jsonl` | append-only | 모든 CLI 호출 이벤트 (감사·재개·회고용) |

check의 상태 전이는 CLI만 할 수 있다:
`open → proven (gdm pass가 cmd를 직접 실행해 exit 0 + 출력 sha256 기록) → audited(P2)`

### 증거의 정의 (환각 방지 규칙의 기계화)

증거 = **재현 명령 + 기대 + 실제 출력 파일(sha256 해시 포함)**. "테스트 통과했음"이라는
문장은 증거가 아니다. 자동 항목의 증거는 **CLI가 직접 생산한다**: `gdm pass`가
cmd를 실행해 출력을 `.gdm/<슬러그>/out/`에 저장·해시하고, exit 0일 때만 통과시킨다
(cmd는 "기대 충족 시에만 성공"하도록 작성하는 것이 계약). `gdm done`은 증거 파일의
현존과 해시 일치를 재검증한다 — pass 이후 삭제·변조된 증거로는 완료할 수 없다.
수동 확인만 가능한 항목(UI 등)은 `--manual` + 확인 기록 파일 제출로만 허용.
거부된 시도(실패한 pass/done)도 journal에 기록되어 회고(retro)의 입력이 된다.

## 4. 전체 아키텍처

```
┌─ L1. 스킬팩 (마크다운, 양 CLI 공용) ─────────────────────┐
│  일상:  gdm:go     (경량 실행 루프)                       │
│  중량:  gdm:full   (go + 독립 검수 + 마무리 절차)          │
│  보조:  gdm:plan  gdm:review  gdm:analyze  gdm:research  │
└──────────────┬───────────────────────────────────────────┘
               │ 스킬이 bash로 호출
┌─ L2. gdm CLI (TypeScript, 결정적 상태 머신) ──────────────┐
│  gdm plan|pass|recheck|done             ← 작업 상태·게이트│
│  gdm status|resume|retro                ← 현황·재개·회고  │
│  gdm audit                              ← 검수 기록 (P2)  │
│  모델 호출·네트워크 없음, JSON 입출력 + exit code           │
└──────────────┬───────────────────────────────────────────┘
               │ P5+
┌─ L3. 오케스트레이터 ───────────────────────────────────────┐
│  gdm run -p <프로젝트> "<작업>" / ps / log / watch / notify│
└───────────────────────────────────────────────────────────┘
```

### gdm:go vs gdm:full

| | gdm:go | gdm:full |
|---|---|---|
| 용도 | 중소 작업 일상 루프 | 배포 수준 중량 작업 |
| 완료 조건 | 모든 check가 proven | proven + 검수 통과 + 마무리 절차 |
| 검수 | 없음 (CLI 게이트만) | fresh-context 검수자 서브에이전트 1명 |
| 마무리 | — | 커밋 규칙 검사(gitflow, AI 표기 금지), PR 본문 생성, 검수보고 위키행 |

같은 상태 파일을 공유한다. full은 go의 상위 호환.

### 검수(audit) 설계 — 역할 1명, 산출물은 문서

- fresh-context, read-only 서브에이전트. 실행자의 문장을 믿지 않고
  checks.json의 observed 파일과 diff를 직접 열어 확인한다.
- 판정 어휘: **통과 / 반려** (반려 시 반려 사유가 새 check로 환원된다)
- 산출물: `검수보고` — 토스 라이팅 역피라미드로 작성 (결론 → 근거 → 세부).
  그대로 wiki-ingest 가능한 포맷. 검수보고 자체가 자산이 되는 것이 기존 하네스와의
  차별점이다 (기존은 게이트 로그가 버려지는 텍스트였다).
- 역할을 늘리지 않는 근거: 독립 검수의 가치는 fresh context에서 나오고,
  세부 관점(리뷰/QA/슬롭)은 검수 체크리스트로 흡수한다. 실사용에서 반복적으로
  놓치는 유형이 `gdm retro`로 확인되면 그때만 역할 분리를 검토한다.

## 5. 대체 맵 (걷어내기 체크리스트)

| 기존 | 사용량(실측) | gdm 대응 | Phase |
|---|---|---|---|
| $omo:ulw-loop | 22회 | gdm:go | P1 |
| lazycodex 파이프라인 | 상시 | gdm:full | P2 |
| $review, $omo:review-work | 35회+ | gdm:review | P3 |
| $analyze (OMX) | 28회 | gdm:analyze | P3 |
| $omo:ulw-plan, plan | 소량 | gdm:plan (산출물이 gdm plan init의 brief 입력) | P3 |
| $omo:ultraresearch, autoresearch | 10회+ | gdm:research | P4 |
| $team, teammode | 10회 | full의 병렬 check 실행으로 흡수, 부족 시 P4 재검토 | P4 |
| start-work / continuation | 소량 | gdm resume | P1 |
| (수동 반복) PR 생성·CI 감시 요청 | 179회 | gdm-pr | 완료 |
| (수동 반복) 프로젝트 표준 명령 재타이핑 | local-run 스킬 3종 자작 | gdm preset + @참조 | 완료 |
| **만들지 않음** | | | |
| workbook 워크플로우 ($solve/$define/$problem/$reflect/$submit/$do) | 100회+ | 폐기. 단계 흐름은 plan → go/full → review가 대신 | — |
| codegraph, lsp(-daemon) | — | CLI 내장 기능 사용 | — |
| comment-checker, remove-ai-slops | — | 검수 체크리스트에 흡수 | — |
| HUD, telemetry, autopilot 등 | — | 불필요/미사용 | — |

제거 순서: P1~P4 완료(각 기존 스킬 호출 0회) → Codex의 OMO/OMX 언인스톨 → OMC 판단.

## 6. 저장소 구조

```
~/projects/gdm/
├── DESIGN.md
├── skills/                  # 소스 오브 트루스
│   ├── go/SKILL.md
│   ├── full/SKILL.md
│   ├── plan/SKILL.md  review/SKILL.md  analyze/SKILL.md  research/SKILL.md
│   └── _shared/             # 검수 체크리스트, 문서 포맷 규칙
├── agents/                  # 검수자 정의 소스 → claude(.md)/codex(.toml) 생성
├── cli/                     # gdm 바이너리 (TypeScript)
│   ├── src/{work,audit,retro}/
│   ├── src/{run,adapters}/  # P5
│   └── test/
├── install/install.sh       # 심링크 설치 + PATH
└── README.md
```

- 스킬 포맷은 양 CLI 동일(SKILL.md + front-matter) — 확인 완료.
- 배포: 개발 중 install.sh, 안정화 후 nix home-manager 번들 승격.

## 7. 스킬 개요

공통 계약: 상태 기록은 gdm CLI 경유만 / 완료 주장 전 증거 3요소 /
프롬프트는 prompt-patterns.md 준수(제약이 능력보다 먼저) / 프롬프트는 전부 자작.

- **gdm:go** (P1): brief → `gdm plan init` → check 목록 등록 → 구현·`gdm pass` 반복(CLI가 cmd 실행·판정) →
  전 check proven 시 `gdm done`(증거 재검증 포함). 막히면 `gdm plan edit --reason`을 journal에 남기고 계속.
  재개: `$gdm:go --resume`.
- **gdm:full** (P2): go 흐름 + `gdm audit`으로 검수자 스폰 → 통과/반려 →
  반려는 check로 환원 → 통과 시 마무리 절차(커밋 규칙 검사, PR 본문, 검수보고).
- **gdm:plan / review / analyze** (P3), **gdm:research** (P4): v0.2와 동일 개요.

## 8. 로드맵

| Phase | 내용 | 완료 기준 |
|---|---|---|
| P1 | repo 뼈대, work 상태머신+테스트, gdm:go, 양 CLI 설치 | 실전 1건 완주, ulw-loop 호출 0회 |
| P2 | gdm:full (검수자 + audit/retro) | 중량 2건에서 검수가 실결함 1개+ 반려, lazycodex 미사용 |
| P3 | plan / review / analyze | 1주 실사용, $review·$analyze 호출 0회 |
| P4 | research (+필요시 병렬 확장) | ultraresearch 미사용 |
| P5 | 오케스트레이터: run/ps/log + Telegram | 폰에서 던지고 알림 수신 |
| P6 | OMO/OMX 언인스톨, CI watch, wiki-ingest 훅 | gdm만으로 1주 정상 동작 |

strangler 방식 유지. history.jsonl 호출 빈도가 진행률 지표.

## 9. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 검수 1명이 결함을 놓침 | retro로 놓친 유형 추적, 반복 유형만 역할 분리 승격 |
| check 선정 자체가 부실 (검증 항목 누락) | start 단계에서 check 목록을 사용자에게 확인받는 옵션(중량 작업 기본 on) |
| 게이트 과잉 엄격 → 우회 | plan edit --reason으로 정식 완화 경로, journal 기록으로 사후 조정 |
| CLI 포맷 변경 | 소스는 repo, 설치는 어댑터로 격리 |
| 걷어낸 후 회귀 | P6 전 언인스톨 금지, Phase 기준을 "호출 0회"로 계량화 |

## 10. 미결 사항

- [ ] Codex에서 bash로 gdm 호출 시 권한 프롬프트 처리 확인
- [ ] 스킬 이름 최종 확정 — go/full은 자리표시자. 실사용 후 입에 붙는 말로 rename
- [ ] Telegram 연동 방식 (P5)

## 11. 결정 로그

- 2026-07-02: CLI 어휘 확정 — `plan / pass / done / audit / resume / retro`. 기준: CLI는 모델이
  치고 사람은 읽으므로 역할 가독성 우선. 스킬 이름은 `go`/`full` **자리표시자** —
  실사용 후 입에 붙는 말로 rename (사용자 합의)
- 2026-07-02: 런타임 bun 확정 (1.3.14 설치 확인) — 개발·테스트는 bun 직접 실행,
  배포는 `bun build --compile` 단일 바이너리 → `~/.local/bin/gdm`

- 2026-07-03: **v0.5.0 — 실사용 데이터 기반 개인화.** history.jsonl 3,448건 실측:
  스크린샷 확인 498회 / DB 작업 230회 / PR·CI 179회 / 원인 진단 122회. 반영:
  gdm-pr 스킬 신설(이슈→브랜치→커밋→PR→CI 감시, 실패 로그 진단), `gdm preset`
  (프로젝트 표준 명령 등록, check에서 @이름 참조 — 등록 시점에 실제 명령으로
  치환해 증거 재현성 유지), go/full에 UI 증거·DB 검증 관행, analyze에 로그-우선 절차
- 2026-07-02: **v0.4.0 — P2~P4 스킬팩 완성.** 검수(audit) 게이트를 상태 머신에 내장:
  `plan init --audit` 작업은 done이 검수 통과를 요구하고, 판정 시점 checks 스냅샷
  해시(stateHash)로 검수 후 상태 변경 시 자동 무효화. 검수자는 이중 포맷(md/toml)
  대신 프롬프트 파일(agents/auditor.md)을 스킬이 서브에이전트에 그대로 전달하는
  방식으로 단순화. 스킬 6종 완성: go/full/plan/review/analyze/research
- 2026-07-02: **v0.3.0 기능 추가** — `recheck`(통과 항목 재실행으로 회귀 검출, done의 해시
  검사가 못 잡는 코드 회귀 보완), `status`(전 작업 현황), `retro`(journal 회고 — P2에서 조기
  구현, 거부·수정·재검증 이력 집계), 알 수 없는 플래그 감지(오타 조용한 무시 차단)
- 2026-07-02: **셀프 리뷰(8관점) 반영, 게이트 재설계** — 자동 항목의 증거는 gdm이 직접
  생산(pass가 cmd 실행·저장·sha256), done이 증거 현존·해시 재검증, 거부 시도 journal 기록,
  상태 파일 손상 방어(validateWork)·원자적 쓰기·슬러그 경로 순회 차단. "증거 조작"이
  프롬프트 규칙이 아니라 구조적으로 불가능해짐
- 2026-07-02: $solve/$define/$submit 계열은 workbook 출처 — 흡수하지 않고 폐기 (사용자 확인)
- 2026-07-02: **독자 설계 원칙 채택** — 기존 하네스의 스키마·용어·프롬프트 비차용,
  작업 모델을 검증 항목(check) 중심으로 자체 설계, 취향 근거는 내 규칙 문서 (사용자 지시)
