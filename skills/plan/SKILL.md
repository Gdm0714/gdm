---
name: gdm-plan
description: |
  구현에 들어가기 전 Claude CLI의 기술 설계안을 받아 진행자가 검증·통합한다. 요구와
  검증 항목(check) 초안을 포함한 계획 문서를 .gdm/plans/에 산출하며, 이 문서가 그대로
  gdm-go/gdm-full의 brief 입력이 된다. 사용자가 "$gdm-plan", "계획부터",
  "설계하고 시작하자"라고 할 때 사용한다.
---

# gdm:plan — 계획 수립

## 역할

작업 요청을 받아 구현 없이 계획을 통합하는 진행자. 새 기술 선택은 Claude CLI가
설계하고, 진행자는 실제 코드 근거와 작업 계약으로 검증해 실행 스킬(gdm-go/full)이 바로
받아 쓸 수 있는 최종 계획 문서를 만든다.

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

- NEVER: 코드를 수정하지 않는다. 이 스킬의 산출물은 문서 하나뿐이다.
- NEVER: 확인하지 않은 코드 구조를 전제로 계획하지 않는다. 계획에 등장하는
  파일·함수는 실제로 열어 확인한 것만 쓴다.
- NEVER: 새 기술 설계 판단이 필요한데 진행자가 Claude 설계안을 조용히 생략하거나 대신
  만들지 않는다. 명확한 사용량 한도·rate limit만 예외다.
- NEVER: Claude CLI에 쓰기 도구, 비밀·자격증명, 전체 대화, 불필요한 저장소 원문을 준다.
- IMPORTANT: 질문은 답이 구현 방향을 실제로 가르는 경우에만, 한 번에 2~3개까지만
  한다. 관례적 기본값이 있는 것은 기본값을 택하고 계획에 명시한다.

## 선택형 코드 그래프 내비게이션

`GRAPH_NAV_PROVIDER: env:GDM_GRAPH_PROVIDER`, `COMPANION_TOOL_POLICY: optional`이다. 관련 코드를
직접 읽은 뒤에도 여러 파일의 의존 경계나 변경 영향 후보가 불명확한 계획에서만 쓴다.
`dependencies`는 entry가 의존하는 방향, `dependents`는 entry에 의존하는 영향 방향이다. 현재
Git root와 repository-relative entry 하나를 고정하고 질문을 가르는 데 필요한 가장 작은
`maxDepth`를 1부터 5 사이에서 고른다. 그래프 때문에 계획 범위를 먼저 넓히지 않는다.

`GDM_GRAPH_PROVIDER`는 인자가 섞이지 않은 절대 실행 파일 경로 하나여야 한다. 경로가 유효하면
`"$GDM_GRAPH_PROVIDER" query`에 다음 v1 request object를 JSON stdin으로 전달한다.

```json
{"schemaVersion":"gdm-graph-query/v1","root":"/absolute/git/root","entry":"repo/relative/file.ts","direction":"dependencies","maxDepth":1}
```

`direction`은 `dependencies|dependents`, `maxDepth`는 정수 1..5만 허용한다. 호출자는 환경변수
값을 공백으로 나누거나 command string으로 다시 파싱하지 않고 실행 파일 경로 한 개와 `query`
인자를 고정한다. terminal tool이 command string 인터페이스만 제공하면 위처럼 변수를 한 토큰으로
quote한다. `sh -c`, `zsh -lc`, `eval`, command string parsing은 금지한다. caller-side 제한은
10초이며 terminal tool의 timeout을 사용하고 shell `timeout` wrapper는 쓰지 않는다.

성공 출력은 `"schemaVersion":"gdm-graph-result/v2"`와 `provider`, `entry`, `direction`,
`nodes[{path,depth}]`, `edges`, `candidateTests`, `unresolved`, `limitations`,
`coverage{scope,requestedMaxDepth,completeWithinRequestedDepth,frontier,incompleteReasons}`,
`freshness{algorithm,consistent,visitedFiles}`, `truncated`를 가진 JSON object여야 한다.
`coverage.scope`는 요청한 root·entry·direction·depth 안의 bounded coverage를 뜻하며 저장소 전체의
완전성을 뜻하지 않는다. provider가 미설정이거나 값이 인자 없는 절대 경로
하나가 아니거나 경로가 missing·실행 불가인 경우, 프로세스가 non-zero로 끝나거나
crash·timeout인 경우, 출력이 malformed JSON·schema mismatch인 경우, 또는 결과가 stale이거나
`freshness.consistent=false`인 경우에는 결과 전체를 버리고 Read/Glob/Grep로 폴백해 실제 소스를
직접 읽는다.

`limitations`의 capability 설명만 있다는 이유로 정상 결과를 실패로 바꾸지는 않는다. 다만
요청 자체가 지원 범위 밖이거나 `coverage.completeWithinRequestedDepth=false`, `truncated=true`,
관련 `unresolved`, parse error처럼 이번 순회가 partial·unsupported임을 알리는 항목이 있으면
반환된 경로는 추가로 열어볼 navigation hint로만 쓸 수 있다. 그 경우 기존 Read/Glob/Grep 탐색도
반드시 수행해 누락을 보완하며, 빈 edge나 알려진 edge만으로 영향 범위를 결론내리지 않는다.

반대로 결과가 fresh이고 `coverage.completeWithinRequestedDepth=true`, `truncated=false`이며 관련
`unresolved`가 없으면 repository-wide Read/Glob/Grep 폴백을 수행하지 않는다. 그래도 반환된
`nodes`·`edges`·`candidateTests`의 후보 소스는 직접 열어 확인한다. `coverage.frontier`는 요청한
`requestedMaxDepth` 경계에서 더 이어질 수 있는 노드다. frontier가 있다는 사실만으로 partial인
것은 아니며 저장소 전체의 complete를 뜻하지도 않는다. 질문에 경계 너머가 필요하면 5 이하로
`maxDepth`를 늘려 다시 조회하거나 Read/Glob/Grep로 폴백한다.

정상 결과도 탐색할 파일·심볼·테스트 후보를 주는 navigation hint일 뿐이다. 실제 소스를 직접
열어 확인하기 전에는 계획의 주장이나 증거가 아니다. 그래프 출력만으로 작업 계약의 범위 확장을
정당화하거나 `gdm pass`, `gdm done`, audit 판정을 만들 수 없다. 모든 후보 파일·함수는 아래의
기존 절차대로 직접 열고 `파일:라인`을 다시 확인한다.

## 프로세스

워커 배정: 계획의 **소유자는 루트 진행자**다 — 사용자 문답, 작업 계약, 근거 판정, 최종 문서
검토·저장은 진행자가 소유한다 (라우팅 계약: `skills/_shared/routing.md`의 역할 배정 표와 동일).
그 안의 기술 설계 초안은 Claude CLI에 맡긴다. 추가 조사는 독립 코드 경계, 필요한 전문성·
fresh context, 넓은 탐색이 주 컨텍스트에 만드는 노이즈를 보고 직접 수행하거나 위임한다.
여러 조사 역할에는 겹치지 않는 영역과 종료 조건을 주며, 진행자가 인용할 실제 파일을 다시
확인하고 최종 문서를 저장한다.

<!-- GDM_TARGET_FRAGMENT_V1:delegation -->

1. 요청을 읽고 모호한 지점을 가른다: 방향을 가르는 모호함이면 질문, 아니면
   기본값 선택 후 문서에 "가정"으로 기록.
2. 관련 코드를 읽어 현재 구조를 파악한다 (추측 금지). 국소 버그·기계적 리팩터·
   사용자가 해법을 지정한 변경처럼 새 기술 설계 판단이 없으면 Claude 호출을 생략하고
   `설계 출처: coordinator-direct / 사유: 새 설계 판단 없음`을 기록한다.
3. 새 아키텍처·API·데이터 모델·상태 흐름·컴포넌트 경계·마이그레이션 선택이 필요하면
   설치된 공통 runner를 preflight plan mode로 호출한다. 기본 실행 형태는
   `gdm-agents/run-role.sh --mode preflight --provider claude --role plan --prompt <prompt-file> --output <draft-file> --workspace <repo>`이며,
   provider executable과 읽기 전용 argv는 runner의 target adapter만 소유한다. prompt에는
   요구·계약·결정 질문과 진행자가 이미 확인한 bounded code excerpt(경로·라인·내용)를
   완결적으로 넣는다. 비밀·전체 대화·전체 저장소 원문은 금지한다. runner는 preflight prompt를
   credential-free valid UTF-8, 최대 1 MiB로 하드 거부한다. Claude에는 다음 형식으로 답하게 한다:
   목표, 가정, 확인한 `파일:라인`, 결정과 이유, 구현 경계, 위험, 검증 항목 초안.
4. 진행자가 Claude 설계안의 모든 `파일:라인`과 전제를 직접 확인한다. 틀린 근거·범위 밖
   제안은 반려 사유와 좁힌 입력으로 한 번만 재요청하며, 확인되지 않은 내용을 최종 계획에
   넣지 않는다.
5. 실패를 분류한다. 인증·권한·CLI 부재·일반 네트워크 오류·timeout·잘못된 산출물은
   중단하고 보고한다. `HTTP 429`, `rate_limit`, `quota exceeded`, 사용량 한도임이 명확할
   때만 `설계 출처: coordinator-fallback`과 원문 오류를 기록하고 진행자가 설계한다.
6. 계획 문서를 `.gdm/plans/<슬러그>.md`로 저장한다:

```markdown
# 계획: <제목>

## 목표
사용자가 받게 될 결과 한 문단.

## 설계 출처
- provider: claude | coordinator-direct | coordinator-fallback
- reason: <직접 처리 또는 fallback 근거>

## 가정 (질문 대신 택한 기본값)
- ...

## 검증 항목 초안
gdm plan add에 그대로 쓸 수 있는 형태:
- desc: ... (regression) / cmd: ... / expect: 수정 전 red 실패, 수정 후 green 성공
- desc: ... (behavior) / cmd: ... / expect: ...
- desc: ... (edge) / cmd: ... / expect: ...
- desc: ... (static) / cmd: ... / expect: ...
- desc: ... (manual) / expect: ...
- desc: ... (expert) / expect: reviewer와 판단 근거 기록

## 작업 계약 초안
- require: <반드시 보존할 사용자 결과·기존 변경>
- forbid: <하면 안 되는 전달·데이터·범위 변경>

## Preflight 계약 초안
- assume: <질문 대신 택한 가정>
- uncertain: <구현 전 아직 불확실한 사실>
- allow-path: <저장소 상대 prefix>
- forbid-path: <절대 바꾸지 않을 저장소 상대 prefix>
- stop-if: <발견하면 구현을 멈추고 사용자에게 돌아갈 조건>
- risk: low | medium | high
- verification: deterministic | inspectable | opaque
- simplify: yes | no (소스·설정 동작 변경은 기본 yes)

## 구현 단계
1. <파일:위치> 무엇을 어떻게
2. ...

## 범위 밖 (하지 않는 것)
- ...
```

7. 대화가 끊겨도 새 컨텍스트가 복원할 수 있도록 목표·가정·검증 항목뿐 아니라
   `require`/`forbid`와 preflight 계약을 문서에 남긴다. regression 명령은 구현 전 같은
   명령이 실패해야 하고, high risk는 audit, high+opaque는 실제 reviewer의 expert manual
   증거가 필요하다고 계획에 적는다. 라인 수 감소를 간소화 증거로 쓰지 않는다.
   채팅 요약만 다음 실행에 넘기지 않는다.
8. 문서 경로를 알려주고, 계약을 포함한 실행 연결을 안내한다:
   `gdm plan init --slug <슬러그> --brief-file .gdm/plans/<슬러그>.md --require '<보존 조건>'
   --forbid '<금지 조건>' --assume '<가정>' --uncertain '<불확실성>' --allow-path <경로>
   --forbid-path <경로> --stop-if '<중단 조건>' --risk <등급> --verification <방식> [--simplify]`
   (+중량이면 `--audit`). `gdm plan add --from-brief`가 괄호 marker를 check 종류로 보존한다.
   `--forbid '자동 커밋'`이 기본이며 사용자가 별도로 승인하기
   전에는 계획 완료나 `done`을 전달 승인으로 해석하지 않는다.

## 엣지 케이스

- 조사 중 요청 자체가 잘못된 전제 위에 있음을 발견하면: 계획을 멈추고 근거와
  함께 보고한다. 잘못된 전제로 계획을 완성하지 않는다.

## 출력 형식

결론 먼저: 계획 한 줄 요약 → 문서 경로 → 사용자 확인이 필요한 지점(있으면).

## 예시

Bad — 코드를 안 열고 세운 계획 (거부되는 방식):

```
아마 DownloadService에 제한 로직이 있을 테니 거기를 수정하는 계획을 세웁니다.
```

"아마"로 시작하는 계획은 구현 단계에서 전부 다시 조사하게 된다. 파일을 열어
확인한 위치만 계획에 쓴다.

Good:

<example>
사용자: 대용량 다운로드 제한을 관리자가 바꿀 수 있게 하고 싶어. $gdm-plan

어시스턴트: (관련 파일 조사 후)
"계획 완료: 설정 테이블에 제한값 추가 + 관리자 메뉴 노출 + 다운로드 경로에서 참조.
문서: .gdm/plans/download-limit-config.md — 검증 항목 초안 4개 포함.
확인 필요: 상한선을 두시겠어요? (문서에는 100만 건 상한 가정으로 작성)
바로 시작하려면: gdm plan init --slug download-limit-config
--brief-file .gdm/plans/download-limit-config.md --require '기존 다운로드 동작 보존'
--forbid '자동 커밋' --audit"
</example>

<commentary>
조사에 근거한 위치, 실행 스킬로 바로 이어지는 check 초안, 방향을 가르는
질문 하나만 — 계획 문서가 다음 단계의 입력으로 완결된다.
</commentary>
