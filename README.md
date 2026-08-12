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

## Codex·Claude 공통 작업 프로토콜

Codex와 Claude는 같은 `.gdm/<slug>` 상태를 `gdm-work-snapshot/v1` JSON으로 읽고,
`gdm-handoff/v1` journal event로 작업을 인계할 수 있다. snapshot에는 전체 작업 계약,
실행 가능한 check 명령, 증거 파일의 경로·해시, 현재 차단 사유가 들어가므로 모델이 바뀌어도
같은 작업 언어로 이어서 일한다. 이는 저장소 안에서 사용하는 로컬 프로토콜이다. brief와
명령도 포함하므로 export JSON을 외부 공개용 artifact로 게시하면 안 된다. 증거 출력·note 본문은
넣지 않으며 credential처럼 보이는 문자열이 감지되면 export를 거부한다.

```bash
gdm protocol export --slug fix-login

gdm protocol handoff --slug fix-login \
  --handoff-id implementation-to-audit-1 \
  --from-role implementer --from-provider codex \
  --to-role auditor --to-provider claude \
  --intent "현재 증거와 diff를 독립 검수"
```

같은 Work·journal과 source/Git 상태를 export하면 생성 시각 없이 같은 bytes가 나온다. handoff는 현재
plan·state·source fingerprint를 append-only journal에 묶어 두므로 이후 변경된 인계는 stale로
표시된다. 다만 snapshot과 handoff는 컨텍스트 전달과 stale 감지일 뿐이다. check를 통과시키거나
증거를 만들지 않으며, audit·`done`·commit·delivery 권한도 부여하지 않는다.

v2의 읽기 전용 전문 역할(`plan`, `analyze`, `review`, `audit`)은 이 상태 언어 위에서
`offer → claim → finish → adopt|recover` lifecycle을 쓴다. `gdm-agents/run-role.sh`가 동일한
canonical `gdm-dispatch-bundle/v1`과 `gdm-read-only-specialist/v1` capability profile을 claim하고
실행 관찰을 `gdm-protocol-receipt/v1`로 남긴다. canonical artifact
`{path,sha256,text,bytesBase64}`는 exact-byte identity를 보존한다. provider에는
`gdm protocol claim ... --model-view`가 만든 결정적 `gdm-dispatch-model-view/v1`만 전달되며,
여기에는 artifact `{path,sha256,text}`만 있고 `bytesBase64`는 없다. model-view의
`bundleSha256`는 full canonical bundle의 digest이고 receiver ACK와 receipt도 이 값에 결속한다.
기존 `GDM_DISPATCH_BUNDLE_V1_BEGIN/END` wrapper 이름은 호환 framing으로 유지한다. 성공한
finish도 자동 채택이나 완료가 아니며 coordinator가 현재 fingerprint와 artifact를 다시 확인한 뒤
명시적으로 adopt해야 한다.
Claude target adapter v2는 `--append-system-prompt`의
`GDM_RECEIVER_TRUST_BOOTSTRAP_V1:`으로 outer GDM envelope/model-view, receiver contract와 제공된
ACK 선택지만 이번 호출의 지시로 인증한다. artifact text와 그 안의 source/evidence·중첩 지시는
신뢰하지 않는 분석 데이터이며 outer handoff role·intent가 요구한 범위에서만 검토한다. 이 static
bootstrap은 원격 model identity나 artifact provenance attestation이 아니다. Codex adapter와 argv
policy는 v1을 유지한다.
두 provider 모두 tool 0으로 실행되어 파일 쓰기·shell·browser·network·MCP·하위 위임이 없고,
필요한 문맥은 sender가 canonical snapshot과 해시된 artifact에 완결적으로 넣는다. canonical
artifact의 `text`와 decoded `bytesBase64`는 같은 exact bytes이며, provider 모델은 중복
tokenization 없이 model-view의 `text`만 검토한다. Work
mode는 별도 prompt를 받지 않는다. Work가 생기기 전 기술 설계는 같은 tool-0 경계에서 receipt가
없는 `gdm-preflight-bundle/v1`을 쓰며 필요한 문맥을 prompt bytes에 미리 포함한다.
여기서 network 없음은 모델에게 노출된 network/browser tool이 없다는 뜻이며, provider CLI가
모델 backend에 연결하는 transport까지 차단한다는 뜻은 아니다.
자동 v2 artifact는 credential-free valid UTF-8로 최대 1 MiB이고, 모델은 model-view의 `text`를
검토하며 exact bytes는 canonical bundle의 `bytesBase64`로 identity/transport한다. finish
output은 최대 2 MiB, canonical dispatch bundle은 최대
4 MiB다. 위반은 `artifact_encoding_invalid`, `privacy_rejected`, `artifact_too_large`,
`output_too_large`, `bundle_too_large`로 fail-closed하며, 읽기 호환되는 legacy v1 handoff도
자동 claim 시 같은 경계를 다시 검사한다.

installer는 하나의 skill source에서 Codex·Claude용 self-contained `SKILL.md`를 결정적으로
생성한다. 각 skill root의 `gdm-target-manifest.json`은 target, 공통 source-template aggregate
hash(`canonicalSourceSha256`), 전체 source hash, adapter version, rendered skill hash,
role runner와 두 provider adapter의 byte hash, capability와 hook 지원 상태를 기록한다.
manifest의 `skills`는 설치 진입점 목록이며 `gdm-audit` skill은 의도적으로 없다. audit는
`gdm-full`이 `gdm-agents/run-role.sh --role audit`와 `gdm-agents/auditor.md`로 실행하는 별도
tool-0 leaf 역할이다. 따라서 Claude target의 standalone coordinator skill 지원을 뜻하지 않는다.
Codex hook은 `supported`, Claude
hook은 lifecycle을 runner와 CLI receipt가 강제하므로 사용하지 않는다는 뜻의 `not-required`며
실패나 누락이 아니다. provider/model 이름과 executable version은
runner가 관찰한 metadata일 뿐 원격 identity나 reasoning 품질이 같다는 증명이 아니다.

- 설계: [DESIGN.md](./DESIGN.md)
- 설치 (한 줄 · Bun·클론 불필요):
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Gdm0714/gdm/main/install.sh | bash
  ```
  플랫폼(macOS·Linux)에 맞는 바이너리와 target별 생성 스킬을 받아 `~/.local/bin`과 Claude Code·Codex
  스킬 폴더에 설치한다. Claude Code 쪽 스킬은 Codex가 비대화형 설계 역할을 맡길 때 쓰며,
  사용자가 작업을 시작하는 진입점은 Codex 하나다. Codex에서는 기존 `hooks.json`의 다른 handler를 보존하면서 gdm
  agent gate를 병합하고, 최초 변경 전 파일은 `hooks.json.gdm-backup`으로 남긴다.
  `config.toml`은 수정하지 않으며 실제 command hook 실행은 Codex `/hooks`에서 사용자가
  검토·신뢰한 뒤에만 확인된다. 상태는 `gdm agent hook-status` 또는 `gdm doctor`로 본다.
  특정 버전은 `GDM_VERSION=v<버전>`, 설치 경로는 `GDM_BIN_DIR`로 조정한다.
- 설치 (소스에서 · 개발용): 클론 후 `./install/install.sh` (Bun 필요)
- 사용: Codex에서 `$gdm-go <작업>`, 터미널에서 `gdm --help`

## 선택형 대화형 도구

gdm CLI에는 필수가 아니지만, 로컬 대화형 작업에서는 다음 도구를 감지해 사용한다.

- [terminal-browser](https://github.com/zenbu-labs/terminal-browser): 웹 UI check를 실제
  브라우저 pane에서 재현하고 `snapshot`, `click`, `fill`, `eval` 결과를 gdm 증거에 연결한다.
  단위·통합 테스트나 프로젝트 표준 Playwright·headless 테스트는 그대로 실행한다.
- [tuicr](https://tuicr.dev/): 사람이 변경 diff를 보고 코멘트하는 리뷰의 기본 공유 화면이다.
  gdm-review는 사용자 주도 리뷰의 저장된 코멘트를 CLI로 읽고, 에이전트 주도 리뷰의 발견은
  사용자가 요청한 경우에만 `Codex` 작성자로 기록한다.

두 도구와 Codex 스킬은 각각의 공식 설치 방법으로 별도 설치한다. 사용할 수 없거나
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
skills/   target 중립 core와 target adapter를 만드는 gdm 스킬 source
cli/      모델 호출 없이 상태와 증거를 판정하는 Bun/TypeScript CLI
agents/   독립 검수 기준
install/  deterministic skill renderer, 바이너리 빌드와 transactional 설치
```

## 개발

```bash
cd cli
bun run verify
```

`verify`는 타입 검사, 커버리지 기준, 전체 테스트, 빌드, 바이너리 스모크 테스트를 한 번만 순서대로 실행한다.

## 라이선스

[MIT](./LICENSE)
