---
name: gdm-full
description: |
  gdm 하네스의 중량 실행 루프. gdm-go의 검증 항목 흐름에 독립 검수(fresh-context
  검수자의 통과/반려 판정)와 전달 승인 검사를 더한다. 승인된 경우에만 gdm-pr로 넘긴다.
  사용자가 "$gdm-full", "gdm full", "제대로/검수까지 해줘"라고 하거나, 배포·머지
  수준의 완성도가 필요한 작업을 맡길 때 사용한다.
---

# gdm:full — 검수 포함 중량 실행 루프

## 역할

배포 수준 작업의 **루트 조율자**. 한 작업의 실제 구현 모델을 하나로 기록하되, 그 모델의
여러 구현 에이전트가 겹치지 않는 파일·모듈을 나눠 맡길 수 있다. 루트 조율자가 산출물과
gdm 게이트를 통합하며, **실제 구현 모델과 다른 모델**의 새 컨텍스트 검수자가 통과 판정을
내린 상태로만 작업을 끝낸다. 라우팅 계약: `skills/_shared/routing.md`.

<!-- GDM_WORK_PROTOCOL_V1_BEGIN -->
## 공급자 중립 작업 프로토콜 v1

Codex와 Claude를 포함한 모든 실행자는 같은 로컬 `Work` 계약과 검증 상태를 정본으로 쓴다.
대화 요약이나 공급자별 메모는 이 정본을 대체하지 않는다.

- 지속 작업을 재개하거나 역할·공급자 경계를 넘는 수신자는 먼저
  `gdm protocol export --slug <s>`를 읽는다. 이 명령의 결과 스키마는
  `gdm-work-snapshot/v1`이다. `gdm-plan` 단계에서는 아직 `Work`가 없으므로 export를 먼저
  호출하지 않는다. 로컬 계획이 `gdm plan init`으로 등록되어 `Work`가 생긴 뒤에만 export한다.
- 경계를 넘겨 보내는 쪽은
  `gdm protocol handoff --slug <s> --handoff-id <handoff-id> --from-role <from-role> --to-role <to-role> --intent <intent>`로
  내구성 있는 `gdm-handoff/v1` 사건을 기록한다. 필요할 때만
  `--from-provider <provider-id>`, `--to-provider <provider-id>`, `--artifact <path>`,
  `--expected-plan-fingerprint <sha256>`, `--expected-state-fingerprint <sha256>`,
  `--expected-source-fingerprint <sha256>` 메타데이터를 덧붙여 stale 상태를 거부한다.
- snapshot과 handoff는 컨텍스트 전달과 stale 감지 수단일 뿐이다. evidence를 만들거나
  `gdm pass`, audit 판정, `gdm done`, commit 승인, delivery 승인을 대신하거나 부여하지 않는다.
  snapshot이 `ready-to-validate`여도 완료가 아니며 반드시 `gdm done --slug <s>` 검증을 거친다.
- provider ID는 관찰 가능한 메타데이터일 뿐 역할, 권한, 신뢰도, 구현·검수 독립성을
  자동으로 증명하지 않는다.
- 같은 네이티브 세션 안의 짧은 서브에이전트 대화를 모두 journal에 기록할 필요는 없다.
  중단 후 재개할 수 있어야 하거나 역할·공급자 경계를 넘는 내구성 있는 인계에서 handoff를 쓴다.
<!-- GDM_WORK_PROTOCOL_V1_END -->

<!-- GDM_WORK_PROTOCOL_V2_BEGIN -->
## 읽기 전용 전문 역할 lifecycle v2

v1 snapshot과 handoff는 계속 읽을 수 있다. 자동 실행이 필요한 `plan`, `analyze`, `review`,
`audit` 역할만 다음 lifecycle을 사용하며, write·shell·browser·network 역할은 지원하지 않는다.

- 송신자는 최신 `gdm protocol export --slug <s>`에서 얻은 plan·state·source fingerprint
  세 개를 모두 넣어 `gdm protocol offer ...`를 기록한다. runner와 스킬은 호환용
  `protocol handoff`를 새 자동 dispatch에 사용하지 않는다.
- 설치된 `gdm-agents/run-role.sh --mode work --provider <target> --role <role> --slug <s>
  --handoff-event-id <event-id> --claim-id <claim-id> --receiver-role <role>`만 역할 실행을
  시작한다. runner는 `gdm-read-only-specialist/v1` capability로 claim한 뒤
  canonical `gdm-dispatch-bundle/v1`을 만든다. 이 정본의 artifact는
  `{path,sha256,text,bytesBase64}`이며 `text`와 decoded `bytesBase64`는 같은 exact bytes다.
  provider 실행에는 `gdm protocol claim ... --model-view`의 결정적
  `gdm-dispatch-model-view/v1` projection만 전달한다. model-view는 같은
  claimId·handoff·snapshot·receiver·capabilityProfile과 canonical `bundleSha256`, artifact
  `{path,sha256,text}`를 가지며 `bytesBase64`를 포함하지 않는다. `bundleSha256`는 model-view의
  digest가 아니라 full canonical bundle의 digest다. provider wrapper의 기존
  `GDM_DISPATCH_BUNDLE_V1_BEGIN/END` 이름은 호환 framing으로 유지한다. runner는 관찰한
  exit·output·executable/adapter 정보를 finish receipt에 기록한다.
- Work mode는 `--prompt`를 받지 않는다. 역할 지시는 handoff intent 또는 해시된 artifact에
  완결적으로 넣으며 provider tool은 0개다. receiver는 canonical snapshot과 bound artifact `text`
  밖의 저장소 문맥을 탐색하지 않는다. sender는 plan/analyze에는 확인한 bounded code excerpt
  (경로·라인·내용), 계약, 결정 질문을, review/audit에는 실제 diff·관련 source excerpt와
  evidence exact content·hash·command output을 artifact에 포함한다. 자동 v2 artifact는
  credential-free valid UTF-8, 최대 1 MiB여야 한다.
  `bytesBase64`는 canonical identity/transport에만 쓰고 provider model-view에는 주입하지 않아
  같은 artifact의 중복 model tokenization을 피한다. 모델 검토 입력은 `text`다. claim은 legacy
  v1 handoff artifact도 다시 검사한다.
  finish output은 최대 2 MiB, canonical dispatch bundle은 최대 4 MiB다.
  위반은 `artifact_encoding_invalid|privacy_rejected|artifact_too_large|output_too_large|bundle_too_large`로
  fail-closed한다.
- exit 0은 마지막 비어 있지 않은 줄의 정확한
  `GDM_RECEIVER_ACK_V1=<single-line JSON>`과 `gdm-receiver-ack/v1` schema를 요구한다.
  ACK의 claim·handoff와 model-view에 실린 canonical full `bundleSha256`가 일치하고
  disposition이 `completed`일 때만 succeeded다.
  disposition은 receiver role 산출물의 완결성이지 Work 완료 상태가 아니다. handoff 질문을 model-view로
  답할 수 있으면 open Work check나 completion blocker만으로 `blocked`를 선택하지 않는다.
  `blocked`는 nonzero finish와 함께 blocked, 그 밖의 nonzero process exit는 failed다.
  `finish`에는 호출자가 정하는 `--status`가 없다.
- 정확히 한 receiver만 claim할 수 있다. exact replay는 idempotent하고 receiver mismatch,
  stale fingerprint, 바뀌거나 사라진 artifact, forged bundle, terminal transition은
  fail-closed로 거부한다.
- 성공한 finish도 Work/check/audit/delivery를 바꾸지 않는다. coordinator가 현재 fingerprint와
  artifact를 다시 검증한 뒤 `gdm protocol adopt --slug <s> --claim-id <claim-id>`로 산출물을
  선택해야 한다. 중단된 claim은 `gdm protocol recover --slug <s> --claim-id <claim-id>
  --reason <reason>`으로 abandoned 처리한 뒤에만 다시 claim할 수 있다.
- `gdm protocol status --slug <s>`는 offered·claimed·exited·adopted·abandoned 상태를 읽는다.
  `gdm-protocol-receipt/v1`, handoff, adoption은 evidence, `gdm pass`, audit verdict,
  `gdm done`, commit 또는 delivery 권한을 만들지 않는다.
- provider target, requested model, executable hash/version은 runner가 관찰한 metadata다.
  실제 원격 provider/model identity나 reasoning 품질을 증명하지 않는다.
- tool-0의 network 없음은 모델에게 network/browser tool을 노출하지 않는다는 뜻이다. provider
  CLI가 모델 backend에 연결하는 transport 자체를 차단하거나 증명한다는 뜻은 아니다.
- Work가 아직 없는 기술 설계는
  `gdm-agents/run-role.sh --mode preflight --provider <target> --role plan --prompt <path>
  --output <path> [--workspace <path>] [--model <id>]`의 `gdm-preflight-bundle/v1`을 쓴다.
  preflight는 claim·receipt·adoption을 만들지 않으며 tool 0이므로 필요한 문맥을 prompt bytes에
  미리 포함한다.
<!-- GDM_WORK_PROTOCOL_V2_END -->

## 제약

- gdm-go의 모든 제약이 그대로 적용된다 (상태는 CLI로만, done 전 완료 보고 금지,
  기준 몰래 완화 금지).
- CRITICAL: 한 작업의 **실제 구현 모델은 하나**이며 실제 구현 모델과 검수 모델은 달라야 한다.
  같은 구현 모델의 에이전트는 여러 명이어도 된다. 역할 이름이나 조율자 정체성이 아니라
  실제 diff를 만든 주체를 기준으로 기록한다.
- IMPORTANT: 구현·탐색·로그 분석·테스트 실행의 역할 배정은 설치 대상 어댑터가 정한다.
  루트 조율자가 변경 통합·충돌 해결과 최종 판정을 소유하며, 제품 파일을 직접 고치면 기록된
  실제 구현 모델과 동일해야 한다.

<!-- GDM_TARGET_FRAGMENT_V1:delegation -->

- NEVER: 검수보고를 직접 작성하지 않는다. 검수보고는 제한 실행기로 띄운 외부 leaf 검수자가
  stdout으로 반환하고 runner가 claim 전용 output artifact에 저장한다 — 실행자가 쓰면 자기 채점이다.
- NEVER: 검수자에게 작업 요약이나 저장소 경로만 판단 근거로 주지 않는다. audit artifact에는
  브리핑 원문, 실제 diff와 관련 source excerpt, evidence의 exact content·hash·command output을
  완결적으로 넣는다. tool-0 검수자는 이 bundle bytes 밖의 파일을 열거나 명령을 실행할 수 없다.
- CRITICAL: 검수 pass당 검수자는 정확히 1명이다. `MAX_AUDITORS_PER_PASS: 1`,
  `AUDITOR_MAX_AGENT_DEPTH: 0`, `AUDITOR_MAX_CHILD_AGENTS: 0`이다. 검수자를
  native delegation tool로 스폰하지 않고 `gdm-agents/run-role.sh --mode work`로만 실행한다.
- NEVER: 검수 실패나 지연을 이유로 추가 검수자를 병렬 실행하지 않는다. 실행기가 자원 한도로
  중단되면 `AUDITOR_RESOURCE_LIMIT`을 보고하고 해당 pass를 중단한다.
- NEVER: 프로세스 이름으로 Node, Gradle, Vite, Codex, Claude를 일괄 종료하지 않는다.
  실행기가 기록한 단일 검수 루트 PID와 그 하위 트리만 실행기가 회수한다.
- NEVER: 반려 사유를 무시하고 verdict --pass를 기록하지 않는다.
- NEVER: `gdm plan contract --check-commit --slug <슬러그>`가 exit 0이 아니면 stage,
  commit, push, PR을 하지 않는다. `done`이나 audit pass는 전달 승인이 아니다.
- IMPORTANT: 커밋 메시지에 AI 관련 표기를 넣지 않는다 (사용자 커밋 규칙).

## 도구

gdm-go의 도구 전부 + 검수:

| 명령 | 용도 |
|---|---|
| `gdm plan init --audit --require <보존> --forbid <금지> --risk <low\|medium\|high> --verification <deterministic\|inspectable\|opaque> [preflight·scope 플래그] [--simplify]` | preflight 계약·baseline과 함께 검수 필수 작업 시작 |
| `gdm audit brief` | 검수자에게 줄 브리핑 패키지 출력 |
| `gdm audit verdict (--pass\|--fail) --report <파일> --implementation-model <모델> --audit-model <모델>` | 검수자 판정과 독립성·보고서·워크트리 지문 기록 |
| `gdm-agents/run-role.sh --mode work --provider <codex\|claude\|pi> --role audit --slug <슬러그> --handoff-event-id <event-id> --claim-id <claim-id> --receiver-role audit [--workspace <경로>] [--model <모델>]` | canonical dispatch identity에 결속된 deterministic model-view를 주입하고 stdout을 `.gdm/<슬러그>/out/protocol/<claim-id>.out`에 저장하며 claim·finish receipt와 자원 제한 안에서 단일 검수 PID 트리를 실행. Work mode에는 `--prompt`를 쓰지 않는다 |

## 프로세스

1. 새 기술 설계 판단이 있으면 `gdm-plan`으로 Claude CLI 설계안을 먼저 받고 진행자가 실제
   코드 근거를 검증한 최종 계획을 brief로 쓴다. 0→1·전면 리디자인·개방형 시각 변경은
   `gdm-design`으로 Claude Design용 프롬프트를 사용자에게 전달하고, 사용자가
   claude.ai/design에서 생성 완료를 확인한 뒤 DesignSync로 pull한다. Chrome 제어로 생성을
   대신하지 않는다. 국소 버그·기계적 리팩터·구체적 UI 결함은 호출을 생략한다.
   `HTTP 429`, `rate_limit`, `quota exceeded`, 사용량 한도일 때만
   `coordinator-fallback`을 기록하고 진행자가 대신하며, 인증·권한·도구·프로젝트 문제나 timeout은
   대체하지 않는다. Claude의 설계·시각 산출물은 구현 모델이 아니며 로컬 제품 코드는 기록된
   실제 구현 모델만 작성한다.
2. 구현 전 가정·불확실성·허용/금지 경로·중단 조건·risk·verification을 분류하고
   `gdm plan init --slug <슬러그> --brief "<요약>" --audit --require "<보존 조건>"
   --forbid "자동 커밋" ...`에 모두 기록한다. 소스·설정 동작 변경은 `--simplify`를 붙인다.
   high risk는 `--audit`을 생략해도 CLI가 독립 검수를 요구하지만 full은 의도를 드러내기 위해
   명시한다. init 기준선 전에 있던 로컬 변경은 보존 대상이며 이후 delta만 범위 판정한다.
3. check 설계: gdm-go의 `regression|behavior|edge|static|manual` 분류에
   **adversarial 항목을 추가**한다 — 악의적/경계 입력에서 무너지지 않는지 검증하는 check 1개 이상.
   regression은 구현 전에 `gdm pass <id> --red`로 동일 명령의 non-zero 실패를 기록한다.
   `--simplify` 작업에는 라인 수가 아니라 dead code·중복·불필요한 추상화를 겨냥한 proven
   static check가 필요하다. high+opaque이면 실제 도메인 reviewer가 확인할
   `--manual --expert` check를 추가하고 pass에 `--reviewer`와 `--note`를 기록한다.
   실행 모델은 reviewer를 자칭하거나 전문가 판단 근거를 대신 작성하지 않는다.
   인터랙티브 표면(HTTP·CLI·화면)이 있는 작업이면 그 표면을 **실제로 구동한
   증거** check도 1개 이상 둔다 (curl 응답, 실행 기록, 스크린샷) — 코드 검증은
   표면 구동을 대신하지 못한다.
   등록 후 목록을 사용자에게 보여주고, 중량 작업이므로 이견 없는지 확인한다.
4. 구현 시작 전에 실제 구현 모델 하나를 지정한다. 검수 입력의 첫 필드에
   `implementationModel: <실제 모델>`을 기록하고 작업 기록에도 남긴다. 구현은 독립 경계와
   컨텍스트 이득에 따라 조율자가 맡거나, 같은 실제 구현 모델의 여러 워커에게 겹치지 않는
   파일·모듈을 배정한다. 루트 조율자는 산출물을 통합하고, 제품 파일 충돌을 직접 고치면
   기록된 실제 구현 모델과 동일해야 한다. 조율자는 gdm-go와 동일한 pass 게이트를 소유하고
   (위임 산출물도 문장이 아니라 증거로만 판정한다), 전 항목 통과 후 `gdm recheck`로 회귀를
   확인한다.
5. 검수:
   a. `gdm audit brief` 출력, 검수자 프롬프트 전문, 실제 `git diff`와 관련 source excerpt,
      evidence 파일의 exact content·hash·command output을 하나의 contained regular audit
      artifact로 준비한다. brief에는 preflight·경로 계약, red→green·static·expert 증거가
      포함되어야 한다. 경로나 요약만 넣지 않는다. 최신 세 fingerprint와
      `--artifact <audit-artifact>`를 넣은 `gdm protocol offer`로 이 bytes/hash를 먼저 고정한다.
      credential-free valid UTF-8 완결본이 1 MiB를 넘으면 내용을 임의로 자르지 말고 자동
      audit를 차단한다.
   b. **실제 구현 모델과 다른 모델의 검수자 정확히 1명을 새 컨텍스트로 실행한다.** 프롬프트는
      입력은 현재 대화 요약이나 별도 `--prompt`가 아니라 offer에 묶인 audit artifact를 포함한
      canonical bundle에서 만든 `gdm-dispatch-model-view/v1`이다. artifact의 path·hash·text와
      canonical `bundleSha256`는 전달하지만 `bytesBase64`는 중복 주입하지 않는다. `auditor.md`는
      설치 시 스킬 옆 `gdm-agents/`에 배치된다(소스:
      저장소 `agents/auditor.md`). 실행은 반드시 같은 디렉토리의 `run-role.sh --mode work`를
      사용한다. 이 실행기는 target adapter에서 하위 위임과 사용자 MCP를 끄고 읽기 전용
      capability profile을 적용하며, 시간·프로세스 수·RSS 한도를 넘으면 자신이 시작한
      트리만 종료한다.
      다른 모델을 사용할 수 없으면 임의로 같은 모델 검수로 낮추지 말고 사용자에게
      차단 상태를 보고한다.
   c. 검수자는 model-view에 포함된 artifact text와 상태만 검토해 `implementationModel`과
      `auditModel`을 포함한
      보고서를 stdout으로 반환한다. runner가 stdout을
      `.gdm/<슬러그>/out/protocol/<claim-id>.out`에 저장하며, 중요한 근거가 model-view에 없으면
      확인 불가로 적고 반려한다.
   d. `gdm audit verdict --pass|--fail --report .gdm/<슬러그>/out/protocol/<claim-id>.out
      --implementation-model <실제 구현 모델> --audit-model <검수 모델>`.
      CLI는 보고서 해시와 현재 Git 워크트리의 실제 파일 내용 지문을 함께 묶는다. 이후 코드나
      보고서가 바뀌면 검수가 무효가 되고, 같은 내용을 커밋해 HEAD만 바뀐 경우에는 유지된다.
      Git 지문이 유효한 경우 `done`은 같은 검증 명령을 다시 실행하지 않는다.
6. 반려면: 반려 사유를 check로 반영(`gdm plan add`/`edit --reason`)하고 4로.
   (check가 바뀌면 기존 검수는 자동 무효 — 재검수가 필요해진다. 정상 동작이다.)
7. 통과면 `gdm done` 뒤 gdm-go의 단일 habit feedback checkpoint를 수행한다.
8. 전달은 별도 gate다. `gdm plan contract --check-commit --slug <슬러그>`를 실행한다.
   - exit 4(기본값 커밋 금지)이고 사용자가 전달을 **명시적으로 승인하지 않았으면**:
     검증 결과만 보고하고 멈춘다. `done`이나 이 스킬 호출은 승인이 아니다.
   - 사용자가 전달을 명시적으로 승인했으면: `gdm plan contract --slug <슬러그>
     --commit explicitly-approved --reason "<승인 근거>"`로 승인을 기록한 뒤
     `--check-commit`를 재실행한다. exit 0이 되면 gdm-pr로 넘긴다.
   - 검수보고는 위키 자산이다 — 사용자가 원하면 wiki-ingest로 넘긴다.

## 엣지 케이스

- 실제 구현 모델과 다른 검수자를 실행할 수 없으면 `INDEPENDENCE_BLOCKED`를 보고하고
  full의 검수 통과·done·전달을 중단한다. 같은 모델 검수나 사용자 동의로 full 게이트를
  낮추지 않는다. 사용자가 경량 루프로 범위를 다시 정하면 별도 gdm-go 작업으로 시작한다.
- 재검수가 2회 이상 반복되면: 반려 사유들을 정리해 사용자에게 방향을 확인받는다.

## 출력 형식

gdm-go와 동일하되, 완료 보고에 검수 결과 한 줄을 추가한다:
"검수: 통과 (보고: .gdm/<슬러그>/out/protocol/<claim-id>.out)".

## 예시

Bad — 실행자가 검수까지 자기 손으로 (자기 채점):

```
구현이 끝났으니 제가 확인한 내용으로 검수보고를 작성하고
verdict --pass를 기록하겠습니다.
```

같은 컨텍스트에서 만든 사람이 판정하면 자기합리화가 걸러지지 않는다.
검수보고는 반드시 fresh-context 검수자가 작성한다.

Good:

<example>
사용자: 심의 상태 전이 버그 고쳐줘. 중요한 거니까 $gdm-full

어시스턴트:
1. plan init --audit --require "기존 심의 전이 보존" --forbid "자동 커밋",
   check 4개(happy/edge/regression/adversarial) 등록·공유
2. 구현은 현재 진행자 모델의 두 워커가 겹치지 않는 상태 전이·테스트 모듈을 맡음
   → 조율자가 변경 통합·pass ×4 → recheck 통과
3. audit brief + 실제 diff/source excerpt + evidence exact content/hash/command output을 묶어
   단일 검수자 실행 — 실제 구현 모델과 다른 사용 가능한 Claude 모델을 지정한다
   `gdm-agents/run-role.sh --mode work --provider claude --model <다른 실제 모델 ID> --role audit --slug ... --handoff-event-id ... --claim-id ... --receiver-role audit`
   → 검수자가 반려 ("전문간사 배정 전 통보 시도 케이스 미검증")
4. verdict --fail 기록 → 해당 케이스를 c5로 추가, 구현·pass → 재검수 → 통과
5. verdict --pass → done → habit feedback 1회 → commit gate가 닫혀 있어 전달 없이 정지
6. "검증 완료: 5개 항목 통과, 검수 통과(1회 반려 후 보완), 전달 승인 대기.
   보고: .gdm/…/out/protocol/<claim-id>.out"
</example>

<commentary>
반려가 실제 결함(미검증 케이스)을 잡았고, 반려 사유가 check로 환원되어
증거와 함께 해소됐다. 검수가 요식이 아니라 게이트로 동작한 흐름이다.
</commentary>
