---
name: gdm-plan
description: |
  구현에 들어가기 전 요구와 코드 근거로 계획한다. 필요하면 Claude CLI의 설계안을 검증·통합한다. 요구와
  검증 항목(check) 초안을 포함한 계획 문서를 .gdm/plans/에 산출하며, 이 문서가 그대로
  gdm-go/gdm-full의 brief 입력이 된다. 사용자가 "$gdm-plan", "계획부터",
  "설계하고 시작하자"라고 할 때 사용한다.
---

# gdm:plan — 계획 수립

## 역할

작업 요청을 받아 구현 없이 계획을 통합하는 진행자. 실제 코드 근거와 작업 계약으로
설계를 판단하고 필요한 경우에만 외부 설계안을 비교해 실행 스킬(gdm-go/full)이 바로
받아 쓸 수 있는 최종 계획 문서를 만든다.

사용자의 명시적 지시와 기존 승인은 스킬의 기본 절차보다 우선한다. 계획만 요청받으면
계획 문서를 전달하고, 구현까지 요청받았으면 계획 뒤 승인된 실행을 계속한다.
일반적인 선택은 근거와 가정으로 해결하고 결과를 바꾸는 미해결 사항만 질문한다.
스킬 때문에 중단한다면 읽은 SKILL.md 경로·해당 문구·적용 이유와 기존 승인으로
해결되지 않는 이유를 밝힌다.

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

- NEVER: 계획 단계에서 제품 코드를 수정하지 않는다. 구현도 요청받았다면 계획을 만든 뒤
  gdm-go/full로 이어서 수행한다. 계획만 요청받은 작업에는 구현을 추가하지 않는다.
- NEVER: 확인하지 않은 코드 구조를 전제로 계획하지 않는다. 계획에 등장하는
  파일·함수는 실제로 열어 확인한 것만 쓴다.
- IMPORTANT: 기술 설계의 기본 소유자는 진행자다. Claude CLI는 사용자가 요청하거나,
  로컬 조사 후에도 남은 독립적인 설계 쟁점에 도움이 될 때 선택한다.
- NEVER: Claude CLI에 쓰기 도구, 비밀·자격증명, 전체 대화, 불필요한 저장소 원문을 준다.
- IMPORTANT: 질문은 답이 구현 방향을 실제로 가르는 경우에만, 한 번에 2~3개까지만
  한다. 관례적 기본값이 있는 것은 기본값을 택하고 계획에 명시한다.

## 외부 연동 검증 계획

새 작업이 외부 API·인증 신원·업무 상태 변경 또는 다중 턴 상태에 의존하면 계획에
`profile: integration`을 기록한다. 이런 흐름과 무관한 작은 로컬 수정과 기존 Work에 이를 소급 강제하지 않는다.
profile이 없는 작업은 미분류이며 실환경 검증으로 설명하지 않는다. 기존 `verification`
(`deterministic|inspectable|opaque`)은 검증 방식이므로 이 profile과 별개로 유지한다.

진행자는 구현 전에 원문 요구와 확보한 입력을 대조해 다음을 계획에 남긴다.

- 중요한 미확인 사항마다 고유 ID, 미확인 내용, 해소에 필요한 관측, 연결할 check를 적는다.
  `uncertain` 한 줄이나 무관한 proven check 하나로 여러 미확인 사항을 해소하지 않는다.
- 필수 결과를 원문 입력 수용, 정상 사용자의 업무 결과, 금지 행동 차단, 필요한 다중 턴
  상태로 나누어 check에 연결한다. 적용되지 않는 조건에는 사유를 쓴다. 정상 사용자까지
  모두 거절하는 구현을 잡고, 접수·환불·변경은 응답 문구 대신 API 영수증이나 실제 상태를
  검증한다. 접수 성공과 처리 완료도 구분한다.
- 원문에서 확보한 입력과 직접 만든 fixture를 구분하고, 입력 출처·실행 환경·대상 식별과
  필요한 fixture/대상 manifest를 정한다. 변형·익명화했으면 그 범위도 남긴다. 원문 입력이나
  원격 대상 버전을 확보하지 못했으면 unknown으로 남기며 합성 입력이나 과거 trace로 대체해
  실환경 검증을 주장하지 않는다. 민감 원문·비밀은 외부 검수 artifact에 싣지 않는다.

실행 단계에서 check ID를 확정한 뒤 `gdm plan verification import --slug <s> --file <contract.json>`으로
구조화 계약을 등록하고 `gdm plan verification show --slug <s> --json`으로 이 매핑을 대조한다.
작성 형식은 gdm 저장소의 `fixtures/verification-v1/contract.json`과
`docs/integration-verification.md`를 사용하며 예제 digest나 범위를 실제 작업에 재사용하지 않는다.
계약 작성·해소·한계 수용과 후보 고정 절차는 gdm-go의 외부 연동 검증 계약을 따른다.

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
기술 설계 초안은 직접 작성하거나 선택형 Claude CLI에 맡긴다. 추가 조사는 독립 코드 경계, 필요한 전문성·
fresh context, 넓은 탐색이 주 컨텍스트에 만드는 노이즈를 보고 직접 수행하거나 위임한다.
여러 조사 역할에는 겹치지 않는 영역과 종료 조건을 주며, 진행자가 인용할 실제 파일을 다시
확인하고 최종 문서를 저장한다.

실질적 구현 작업의 역할 배정은 GDM이 원문 요청과 check를 해석해 생성한다. 진행자가 역할을
미리 매핑하거나 modules JSON을 작성하지 않는다. 계획 문서는 사용자 원문·코드 근거·검증 항목을
보존하고 실행 단계에서 제공할 명시적 context를 가리킨다. 계획만 요청받았으면 이 문서를
준비하고, 구현도 승인됐으면 원문을 Work brief에 보존해 init하고 check를 최소 1개 등록한 후
아래 명령과 gdm-go의 native dispatch 루프로 이어간다.

```sh
gdm team auto --slug <s> --from-request --provider <claude|codex> --model <planner-model> --max-active <1..32> --executor <native|unavailable> --json
```

호스트는 실제 가용 슬롯·executor·허용 capability catalogue와 필요한 명시적 context만 제공한다.
`--context <path>`는 반복 가능하고 `--capabilities-file <path>`는 사용 가능한 route의 목록이다.
호스트 도구가 여러 모델 선택을 지원하면 현재 도구 메타데이터와 사용자 예산에서 실제 실행 가능한
후보로 capability catalogue v2를 자동 구성한다. 역할마다 여러 후보를 허용하고 고정 역할·모델 표를
만들지 않는다. GDM이 각 작업의 난도·위험·필요 능력과 비용 조건을 보고 route·effort·selectionReason을
선택한다. 선택 기능이 없는 호스트의 기본 worker route는 `native-inherit`이며 planner의 `--model`은 worker 모델 선택이 아니다.
선택된 모델·추론 수준은 그대로 실행하고 claim에 동일한 host-declared 실행 정보를 기록한다.
지원하지 않는 경로를 다른 모델로 바꾸지 않는다. 상세 schema와 한도는 `docs/automatic-role-allocation.md`를 따른다.
GDM이 내부 planner를 제한된 tool-0 호출로 한 번 실행해 역할·경로·의존성·route를 검증하고
`gdm-team-plan/v1`과 provenance를 만든다. `--file <team-plan.json>`은 명시적 수동 import
호환 경로이며 기본 흐름이 아니다. 상세는 gdm 저장소의 `docs/automatic-role-allocation.md`를 따른다.
새 배정의 `--dry-run`도 실제 planner를 호출하며 배정 적용만 생략한다. 동일 입력은 저장된
결과를 재사용하며 `plannerReused: true`를 반환한다. planner 실패를 진행자의 수동
배정이나 키워드 추정으로 대체하지 않는다. CLI는 native 워커를 직접 띄우지 않으므로 호스트가
생성된 next·route·prompt를 그대로 실행하고 spawn 전에 claim한다. 배정 자체의 재승인은 묻지 않는다.
미확인 사항·integration에는 knowledge, 지식 조사·medium/high risk·다중 module·독립 검증에는
verification이 필요하다. 지식 수락 뒤 구현, 선행 결과 수락 뒤 별도 실행자의 최종 검증을 연다.
새 요청 계획은 schema `gdm-team-plan/v1`을 유지한다. capability catalogue v1은 planner semantic v2, 다중 모델 catalogue v2는 semantic v3로 식별한다.
knowledge의 `acceptanceMode: artifact-review`, `checks: []`는 출처·근거·미확인 사항이 담긴 completed 보고서의
불변 해시와 수용 기준으로 판단한다. 미래의 최종 동작 check 통과를 지식 수락의 선행 조건으로
넣지 않는다. 모든 Work check는 implementation 또는 verification에 연결하며 최종 `gdm done`
게이트는 유지한다. implementation에는 필요한 테스트 작성·수정 경로의 쓰기 소유권을 포함하고
verifier는 읽기 전용을 유지한다. 수동·이전 계획의 연결 check 수락 방식은 바꾸지 않는다.
작은 low risk 단일 module은 auto의 single 사유와 직접 검증을 유지한다. executor가 unavailable이면
복잡한 작업의 필수 역할은 blocked로 남긴다. 권한·예산·비방해 검증 제약을 유지한다.
실행 중 지식 결과가 범위를 바꾸면 active·reported를 정리하고 요청·check·context를 갱신해
같은 요청 기반 명령에 `--replan --reason '<변경 근거>'`를 붙인다. 과거 증거 보존과 새 검증은 gdm-go를 따른다.

<!-- GDM_TARGET_FRAGMENT_V1:delegation -->

1. 요청을 읽고 모호한 지점을 가른다: 방향을 가르는 모호함이면 질문, 아니면
   기본값 선택 후 문서에 "가정"으로 기록.
2. 관련 코드를 읽어 현재 구조와 설계 선택지를 파악한다 (추측 금지). 직접 설계하면
   `설계 출처: coordinator-direct`와 판단 근거를 기록한다. 새 기술 선택 자체는 외부 호출의 조건이 아니다.
3. 사용자 요청 또는 남은 독립 설계 쟁점 때문에 Claude 설계안을 선택하면 설치된 공통
   runner를 preflight plan mode로 호출한다. 기본 실행 형태는
   `gdm-agents/run-role.sh --mode preflight --provider claude --role plan --prompt <prompt-file> --output <draft-file> --workspace <repo>`이며,
   provider executable과 읽기 전용 argv는 runner의 target adapter만 소유한다. prompt에는
   요구·계약·결정 질문과 진행자가 이미 확인한 bounded code excerpt(경로·라인·내용)를
   완결적으로 넣는다. 비밀·전체 대화·전체 저장소 원문은 금지한다. runner는 preflight prompt를
   credential-free valid UTF-8, 최대 1 MiB로 하드 거부한다. Claude에는 다음 형식으로 답하게 한다:
   목표, 가정, 확인한 `파일:라인`, 결정과 이유, 구현 경계, 위험, 검증 항목 초안.
4. 외부 설계안을 받았으면 모든 `파일:라인`과 전제를 직접 확인한다. 틀린 근거·범위 밖
   제안은 반려 사유와 좁힌 입력으로 한 번만 재요청하며, 확인되지 않은 내용을 최종 계획에
   넣지 않는다.
5. 선택형 호출의 인증·권한·CLI 부재·일반 네트워크 오류·timeout·잘못된 산출물은
   `설계 출처: coordinator-fallback`과 실패 이유를 기록하고 확인한 근거로 직접 설계한다.
   사용자가 Claude 결과 자체를 요구했거나 필수 근거가 없을 때만 해당 의존 작업을 보류한다.
   실패한 호출을 성공했다고 쓰거나 확인되지 않은 제안을 채택하지 않는다.
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
- simplify: yes | no (구조 변경의 추상화·dead code·중복 위험을 별도로 검증할 때 yes)

## 외부 연동 검증 계약 초안 (해당 작업만)
- profile: integration | 미분류 (선택 이유)
- 중요한 미확인 사항: <ID / 내용 / 필요한 관측 / 연결 check>
- 필수 결과: <원문 입력 / 정상 업무 결과 / 금지 행동 / 다중 턴 상태 → check, 또는 비적용 사유>
- 증거 범위: <입력 출처 / 실행 환경 / 대상 식별 / fixture·대상 manifest / unknown>
- 계약 파일: <실행 단계에서 check ID 확정 후 import할 gdm-verification-contract/v1 파일>

## 구현 단계
1. <파일:위치> 무엇을 어떻게
2. ...

## 요청 기반 자동 배정 입력
- 원문 요청: <Work brief로 보존할 사용자 요청>
- 문맥: <GDM에 --context로 전달할 필요한 로컬 파일>
- 실행 조건: <실제 executor / 가용 슬롯 / 허용 capability catalogue / 비방해 검증>
- 실행: <check 등록 후 gdm team auto --from-request; 역할·module·route는 GDM이 생성>

## 범위 밖 (하지 않는 것)
- ...
```

7. 대화가 끊겨도 새 컨텍스트가 복원할 수 있도록 목표·가정·검증 항목뿐 아니라
   `require`/`forbid`와 preflight 계약을 문서에 남긴다. regression 명령은 구현 전 같은
   명령이 실패해야 하고, high risk는 audit, high+opaque는 실제 reviewer의 expert manual
   증거가 필요하다고 계획에 적는다. 라인 수 감소를 간소화 증거로 쓰지 않는다.
   채팅 요약만 다음 실행에 넘기지 않는다.
8. 계획만 요청받았으면 문서 경로와 실행 연결을 안내한다. 구현까지 요청받았으면
   기존 승인 범위에서 gdm-go/full로 이어서 실행한다:
   `gdm plan init --slug <슬러그> --brief-file .gdm/plans/<슬러그>.md --require '<보존 조건>'
   --forbid '<금지 조건>' --assume '<가정>' --uncertain '<불확실성>' --allow-path <경로>
   --forbid-path <경로> --stop-if '<중단 조건>' --risk <등급> --verification <방식> [--simplify]`
   (+중량이면 `--audit`, 외부 연동이면 `--profile integration`).
   `gdm plan add --from-brief`가 괄호 marker를 check 종류로 보존하지만 구조화 검증 계약을
   대신 등록하지는 않는다. 외부 연동은 check ID 확정 후 위 import·show checkpoint까지 수행한다.
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
--forbid '자동 커밋' --audit --profile integration
check 등록 후 검증 계약 import와 team auto로 지식·구현·검증 배정"
</example>

<commentary>
조사에 근거한 위치, 실행 스킬로 바로 이어지는 check 초안, 방향을 가르는
질문 하나만 — 계획 문서가 다음 단계의 입력으로 완결된다.
</commentary>
