---
name: gdm-go
description: |
  gdm 하네스의 일상 실행 루프. 작업을 검증 항목(check)으로 분해하고, gdm CLI가
  각 항목의 재현 명령을 직접 실행해 증거(출력 파일 + 해시 + exit code)를 만들며,
  전부 통과해야만 완료를 선언한다. 사용자가 "$gdm-go", "gdm go", "gdm으로 해줘"라고
  하거나, 구현·수정 작업을 완료 보장과 함께 맡길 때 사용한다.
---

# gdm:go — 검증 항목 기반 실행 루프

## 역할

작업을 검증 가능한 확인 항목(check)과 소유 범위로 나누고, 구현 산출물의 수집·통합·검증을
책임지는 루트 조율자. 중간 이상 작업에서는 설치 대상이 지원하는 구현 워커에게 작업을 맡기고,
모든 항목과 팀 산출물이 증거로 수락된 상태에서만 작업을 끝낸다.

## 판단 기준

- 사용자의 명시적 지시와 기존 승인은 스킬의 기본 절차보다 우선한다. 요청한 구현·수정은
  실행 요청으로 받아들이고, 승인된 범위의 작업은 계획 제시나 재확인에서 멈추지 않는다.
- 목표·성공 조건·허용 범위를 기준으로 방법을 선택한다. 일반적인 구현 선택은 직접 해결하고,
  답이 결과를 바꾸는 미해결 사항만 질문한다. 기다리는 동안 독립적으로 할 수 있는 일은 진행한다.
- 추가 승인이 실제로 필요하면 승인 가능한 결과와 검증을 먼저 준비한다. 스킬 때문에
  중단한다면 읽은 SKILL.md 경로·해당 문구·적용 이유와 이미 받은 승인으로 해결되지 않는 이유를 밝힌다.
- check 통과뿐 아니라 사용자 목표가 충족됐는지 확인한다. 빠진 요구를 발견하면 계약과
  check를 보완하고 계속한다. 필수 검사 이후 추가 검증은 새 변경·실패·미해결 위험이 있을 때만 한다.

## 팀 실행과 완료 책임

`gdm plan init`과 check 등록 뒤, 구현 전에 `gdm team configure --slug <s> --mode <coordinated|single>`로
실행 방식을 기록한다. 독립적으로 검증할 경계가 둘 이상이거나, 모듈을 가로지르는 변경이거나,
별도 조사·구현·리뷰가 실질적인 이득을 주면 중간 이상 작업이다. 쓰기 가능한 하위 에이전트가
지원되는 대상에서는 `coordinated`가 기본이며, 루트는 분해·수용 기준·검증·통합을 맡고 구현을
위임한다. 루트가 모든 작업을 통상적으로 직접 구현한 뒤 리뷰만 요청하는 것으로 대체하지 않는다.
겹친 변경의 병합이나 작은 연결 수정은 허용하되 변경과 영향받은 검증을 기록한다.

작고 순차적인 변경은 `--mode single --reason "<분리 이득이 없는 구체적 이유>"`로 실행한다.
대상에 쓰기 가능한 위임 기능이 없으면 그 capability 한계를 이유로 `single`을 쓰고 해당 대상의
필수 전문 역할을 유지한다. 사용자 지시도 기록하되 임의의 워커 수를 채우려고 일을 쪼개지 않는다.
`coordinated`의 `--max-active`는 기본 3, 허용 범위 1~4다. `single`은 기본·최대 1이다.
보통 2~3명을 쓰되 대상의 더 낮은 상한과 실제 자원 예산을 우선한다. CPU·메모리를 많이 쓰는 빌드와 통합 테스트는 루트가 직렬화한다.
`--session <root-session-id>`는 실제 현재 루트 세션 ID를 아는 경우만 설정하며 ID를 만들거나
기존 작업을 다른 세션에 임의로 다시 묶지 않는다. 새 루트 세션에서 재개할 때는 active task가
없는지 확인한 뒤 실제 새 `--session`과 `--reason`으로 인계를 기록한다.

1. 각 task를 `gdm team add --slug <s> --task <id> --role <role> --path <path> --access <read|write>
   --deliverable "<산출물>" --acceptance "<수용 기준>" --check <cN>`으로 등록한다. 경로와 check는
   반복할 수 있으며 선행 작업은 `--depends-on <id>`로 지정한다. 활성 쓰기와 겹치는 읽기·쓰기는
   배정하지 않는다. 각 워커에게 자신만 작업 중인 것이 아님을 알리고 다른 작업자의 변경을 보존하게 한다.
2. spawn 전에 `gdm team claim --slug <s> --task <id> --assignee <logical-worker-id> --attempt <attempt-id>`로
   소유권을 기록하고, 같은 identity·범위·수용 기준·검증·종료 조건을 대상의 위임 입력에 전달한다.
   spawn 자체가 실패하면 실패 산출물을 남겨 `report --outcome failed`로 active 상태를 닫는다.
3. 결과는 저장소 상대 경로의 로컬 파일에 남기고
   `gdm team report --slug <s> --task <id> --attempt <attempt-id> --outcome <completed|failed|cancelled|inconclusive>
   --summary "<결과>" --artifact <relative-path>`로 제출한다. 결과 파일에는 실제 변경·확인 결과·남은
   문제를 적는다. `.gdm` 상태는 CLI로만 변경하며 수동 결과 파일은 허용된 별도 경로에 저장한다.
   task 기록과 산출물이 Work의 공유 기억이다. 전체 대화를 반복 전달하지 않는다.
4. 루트가 실제 산출물과 diff를 읽고 수용 기준을 대조한 뒤 연결된 check를 `gdm pass`로 증명한다.
   `gdm team review --slug <s> --task <id> --attempt <current-attempt-id>
   --decision <accept|reject> --reason "<근거>"`로 판정한다.
   accept는 completed 결과·변하지 않은 산출물·증명된 연결 check가 있어야 한다. 워커의 자기 보고,
   stop 이벤트, timeout, 프로세스 종료는 수락이 아니다. 워커는 check나 task 수락을 스스로 부여하지
   않는다. review와 retry의 `--attempt`는 현재 attempt를 정확히 지정해야 하며 과거 attempt 요청은
   거부된다. 반려·실패·취소·불확정은 원인과 새 접근을 정한 뒤 `gdm team retry --slug <s> --task <id>
   --attempt <current-attempt-id> --reason "<수정 이유>"`로 다시 열고 새 유일 attempt로 claim한다.
   선행 task를 재시도하면 그 결과에 의존한 후속 수락도 낡아지므로 해당 task를 명시적으로
   반려·재시도한다. 기준을 낮춰 없애지 않는다.
5. `gdm team next --slug <s> --json`의 `review|retry|dispatch|wait|validate`에 따라 계속한다.
   `wait`이면 지원되는 mailbox/event 대기로 결과를 받은 뒤 `team next`를 다시 읽는다. active·미수락·
   실패 작업이 있는데 최종 응답으로 조율을 끝내지 않는다. 지원되지 않는 자동 깨우기나 종료 후
   백그라운드 실행을 약속하지 않는다. `validate`도 완료가 아니며 모든 수락과 사용자 목표를 확인한
   뒤 기존 `gdm done`·audit·전달 게이트를 통과한다.

`gdm team status --slug <s> --json`으로 재개 시 상태를 읽는다. 선택적인 report의 `--tokens`와
`--elapsed-ms`는 보고된 관찰값이며 실제 요금이나 자동 측정의 증거가 아니다. 팀 기록은 협력적인
소유권·수락 장부이지 OS 파일 잠금, 새로운 도구 권한, 독립 실행 데몬이 아니다. 읽기 전용 전문
역할의 아래 v2 capability 계약을 쓰기 권한으로 넓히지 않는다.

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

- NEVER: `.gdm/` 아래 파일을 직접 쓰거나 고치지 않는다. 상태 변경은 gdm CLI로만 한다.
- NEVER: `gdm done`이 성공(exit 0)하기 전에 "완료했다"고 보고하지 않는다.
- NEVER: 이 실행 루프에서 stage, commit, push, PR을 만들지 않는다. `done`은 검증 완료이지
  전달 승인이 아니다.
- NEVER: 통과가 어렵다는 이유로 check의 cmd나 expect를 약하게 고치지 않는다.
  기준 조정이 정말 필요하면 `gdm plan edit --reason`으로 사유를 남긴다
  (통과된 항목을 고치면 통과가 해제되고, 모든 수정·거부는 journal에 기록된다).
- IMPORTANT: cmd는 "기대가 충족될 때만 exit 0"이 되도록 설계한다 — 판정은 gdm이
  exit code로 하므로, 그냥 실행되는 명령이 아니라 검증하는 명령이어야 한다.
  (예: `./gradlew test --tests '*Excel*'`, `grep -q "limit=500000" src/config.ts`,
  `curl -sf localhost:8080/health | grep -q '"status":"UP"'`)
- IMPORTANT: check 개수는 독립적인 성공 조건과 위험에 맞춘다. 작은 변경은 1개로도 충분하며,
  개수를 채우기 위한 항목은 만들지 않는다. 작업 분리는 개수보다 독립된 범위와 검증 비용으로 판단한다.
- IMPORTANT: init 전에 가정·불확실성·허용/금지 경로·중단 조건·위험도·검증 가능성을
  분류한다. 구조 변경으로 추상화·dead code·중복 위험을 검증해야 할 때 `--simplify`를
  사용하고 해당 위험을 잡는 proven `static` check를 둔다. 단순 소스·설정 수정에는 강제하지 않는다.
  라인 수나 diff 크기만으로 간소화를 판정하지 않는다.
- IMPORTANT: `risk=high`는 gdm-full의 독립 검수로 올린다. `high+opaque`는 실제 도메인
  reviewer가 필요한 작업이며 AI가 reviewer를 자칭하거나 근거를 대신 쓰지 않는다.
- IMPORTANT: 구현 범위는 사용자 목표와 보존 조건으로 정한다. 처음 만든 check에 빠졌더라도
  목표 달성에 필요한 처리는 포함하고 check를 보완한다. 관련 없는 기능·동반 리팩토링은 추가하지 않는다.

## 도구

| 명령 | 용도 |
|---|---|
| `gdm plan init ... --assume <가정> --uncertain <불확실성> --allow-path <경로> --forbid-path <경로> --stop-if <조건> --risk <low\|medium\|high> --verification <deterministic\|inspectable\|opaque> [--simplify]` | preflight·범위·완료 정책과 init 기준선 기록 |
| `gdm plan add --desc <항목> --cmd <검증 명령> --expect <기대> --kind <regression\|behavior\|edge\|static>` | 자동 항목 분류·등록 |
| `gdm plan add --desc <항목> --expect <기대> --manual [--expert]` | 수동 확인 항목 등록 |
| `gdm plan list` | 항목/상태 확인 |
| `gdm plan edit --check <id> [...] --reason <사유>` | 항목 조정 (사유 필수) |
| `gdm pass <id> --red` | regression 항목의 수정 전 동일 명령 실패(non-zero) 증거 기록 |
| `gdm pass <id>` | 자동 항목 통과 — gdm이 cmd를 직접 실행·저장·해시하고 exit 0일 때만 통과 |
| `gdm pass <id> --manual --observed <파일> [--reviewer <검토자> --note <근거>]` | 수동 항목 통과 — expert는 reviewer·근거 필수 |
| `gdm plan contract --allow-path <경로> --reason <사유>` | 검수 전 의도한 범위 확장 기록 |
| `gdm recheck` | 구현 중 중간 회귀 확인이 필요할 때만 통과한 자동 항목 재실행 |
| `gdm done` | 완료 — 자동 항목 재실행 + 증거 파일 현존·해시 재검증 후에만 exit 0 |
| `gdm status` | 현재 디렉토리 전체 작업 현황 |
| `gdm resume` | 중단된 작업 상태 복원 |
| `gdm attempt fail ...` | 실패 서명·가설과 한 번의 확인 재시도 기록 |
| `gdm attempt retry ...` | 바뀐 전제와 새 증거가 있을 때만 다음 재시도 허용 |
| `gdm habit harvest --json` | 반복 실패·miss 또는 적용한 habit이 있을 때 journal 관찰 수확 |

## 프로세스

순서는 계약(init → add → pass → done)이고, 그 안의 진행 방식은 판단에 맡긴다.

새 기술 설계 판단은 코드 근거와 성공 조건으로 해결한다. 별도 계획 문서가 필요하면
`gdm-plan`을 사용한다. Claude CLI 설계안은 사용자가 요청하거나, 로컬 조사 후에도 남은
독립적인 설계 쟁점에 도움이 될 때 선택한다. 매 기술 선택마다 외부 모델을 호출하지 않는다.
0→1·전면 리디자인·개방형 시각 변경은 `gdm-design`으로 방향을 정하고, 위 팀 실행 방식에 따라 구현을 배정한다.
Claude Design이나 사용자 시안 생성을 필수로 요구하지 않는다. 사용자가 Claude Design을
명시적으로 요청한 경우에만 해당 스킬의 선택적 연동 경로를 사용한다.
기존 화면의 구체적인 결함은 `gdm-ui`로 바로 수정한다.

선택형 Claude CLI가 실패하면 원인과 `coordinator-fallback`을 기록하고 확인한 근거로 진행한다.
사용자가 Claude 결과 자체를 요구했거나 필수 근거가 없을 때만 해당 의존 작업을 보류한다.
선택적으로 요청받은 Claude Design의 생성·동기화는 `gdm-design`의 계약을 따른다.

구현 워커의 실행 방식과 권한은 설치 대상 어댑터가 정한다. 루트 조율자는 변경 통합·충돌 해결·
team review·gdm pass 판정을 소유하며, 실제 소유 범위를 넘는 수정은 다시 분해·배정한다.

<!-- GDM_TARGET_FRAGMENT_V1:delegation -->

1. 지속 계획의 작업 계약 초안에서 가정·불확실성·허용/금지 경로·중단 조건·risk·verification을
   꺼내 `gdm plan init`에 명시한다. 위의 구조 위험이 있으면 `--simplify`를 붙인다.
   init 기준선은 이미 존재하던 로컬 변경을 보존하고 이후 delta만 범위 판정한다.
   필요한 `regression|behavior|edge|static|manual` 항목을 `gdm plan add`로 등록한다.
   기존 결함을 고치는 regression은 **구현 전에** `gdm pass <id> --red`로 동일 명령의
   non-zero 실패를 기록한다. red가 성공(exit 0)하면 결함을 드러내는 항목이 아니므로 고친다.
   좋은 check의
   기준은 하나다 — **cmd가 성공하면 기대가 충족됐다고 믿을 수 있는가.**
   등록한 목록(`gdm plan list`)을 사용자에게 보여준다. 적용할 adopted habit이 있으면
   첫 pass 전에만 `gdm plan contract --slug <슬러그> --activate-habit <id>@<version>`으로 고정한다.
2. 팀 실행 계약에 따라 허용 경로 안에서 구현을 배정·수집하고 `gdm pass <id>`. 의도한 변경이 새 경로를 요구하면 검수 전에
   `gdm plan contract --allow-path <경로> --reason <사유>`로 계약을 확장한다. 몰래 넓히지 않는다.
   실패하면 출력(`.gdm/<슬러그>/out/<id>.txt`)을 읽고
   `gdm attempt fail`로 command/capability·target·error-code·가설을 기록한다. 같은 실패
   서명은 확인 재시도를 한 번만 허용한다. 다시 실패하면 그대로 반복하지 말고,
   전제가 실제로 바뀐 경우에만 새 contained evidence와 함께
   `gdm attempt retry --changed <종류> --evidence <파일>`로 다음 epoch를 연다.
   수동 항목은 확인 기록을 저장한 뒤 `--manual --observed <경로>`.

   ```text
   gdm attempt fail --slug <s> --attempt-id a1 --command <id> --target <id> --error-code <id> --hypothesis <가설>
   gdm attempt retry --slug <s> --attempt-id a2 --fingerprint <첫 명령이 출력한 fingerprint>
   gdm attempt fail --slug <s> --attempt-id a3 --command <id> --target <id> --error-code <id> --hypothesis <확인 결과>
   gdm attempt retry --slug <s> --attempt-id a4 --fingerprint <fingerprint> --changed <종류> --evidence <파일>
   ```
3. `gdm done` 전에 팀의 모든 task가 수락됐는지 확인하고 diff를 열어 요청 범위 밖 변경이 섞이지 않았는지 최종 대조한다.
   `gdm done`이 자동 항목을 다시 실행하므로 직전에 `gdm recheck`를 중복 실행하지 않는다.
   `recheck`는 구현 도중 이미 통과한 항목의 중간 회귀를 확인해야 할 때만 사용한다.
4. `gdm done` 성공 뒤 반복 실패·miss 또는 적용한 habit이 있을 때만
   `gdm habit harvest --json`으로 관찰을 수확한다. 적용한 habit이 있으면 `ineligible|skipped|clean|recurred` 중
   실제 결과를 `gdm habit evaluate`로 기록한다. 새 후보 검토가 필요하면
   `gdm-reflect`를 안내하되 자동 채택하지 않는다.
5. 사용자 목표와 필수 게이트가 충족되면 완료를 보고한다. 회고할 사건이 없는 작업에는 별도
   피드백 checkpoint를 만들지 않는다. 재개는 `gdm resume`. 완료 이후
   이 작업에서 결함이 발견되면 `gdm miss --desc ... --type ...`으로 기록한다
   — 게이트 개선(retro --all)의 입력이 된다.

## 대화형 웹 검증

`WEB_RUNTIME_PROVIDER: terminal-browser`, `COMPANION_TOOL_POLICY: optional`로 라우팅한다.
웹 UI check에 실행 가능한 URL 또는 로컬 HTML이 있고 terminal-browser와 지원 터미널을
사용할 수 있으면 다음 순서로 실제 브라우저 동작을 재현한다.

```text
terminal-browser-background-tab.sh open <url>
# 반환 JSON의 browser와 tab을 각각 <key>, <id>로 고정한다.
terminal-browser action --browser <key> --tab <id> -- snapshot
terminal-browser action --browser <key> --tab <id> -- click <ref>
terminal-browser action --browser <key> --tab <id> -- fill <ref> <value>
terminal-browser action --browser <key> --tab <id> -- eval <assertion>
terminal-browser-background-tab.sh close <key> <id>
```

헬퍼는 이 SKILL.md와 같은 디렉터리에 있으며 실행 중인 terminal-browser 가운데 현재 터미널
탭 밖의 인스턴스를 우선 선택한다. 보이지 않는 가운데 클릭으로 탭을 만든 뒤 기존 활성 탭이
그대로이고 새 탭이 `active: false`인지 확인한다. action은 반환된 `--browser <key> --tab <id>`를
항상 명시하고 `--follow`를 사용하지 않는다. 셸 trap을 쓸 수 있으면 close를 EXIT 정리에 묶어
실패 때도 AI 탭을 남기지 않는다. 자동 검증에서는 `terminal-browser open`이나 `--split`을
호출하지 않는다.

사용자가 화면 표시를 명시적으로 요청한 경우만 terminal-browser 스킬의 대화형 open 절차를
별도로 사용한다. 실행 중인 terminal-browser가 없거나 비활성 탭 생성이 실패하면 새 pane이나
새 창을 열지 말고 기존 headless 테스트로 폴백한다.

기계 판정 가능한 action과 assertion은 check의 `cmd`에 넣어 gdm이 출력과 exit code를
증거로 저장하게 한다. 시각 판정은 `.gdm/<슬러그>/ui/`의 스크린샷 또는 manual 근거를
별도로 남긴다. terminal-browser는 단위·통합 테스트, 프로젝트 표준 Playwright·headless
테스트, 빌드·타입 검사를 대체하지 않으며 웹 UI가 아닌 check에는 열지 않는다. 도구·지원
터미널·URL이 없거나 CI 같은 비대화형 환경이면 기존 자동 테스트 또는 manual 증거 흐름으로
폴백한다. 사용자가 terminal-browser 자체를 필수로 지정한 경우에만 부재를 차단으로 취급한다.

## 작업 유형별 관행 (실사용 빈도 기반)

- **UI 변경** (스크린샷 확인이 관행인 작업): manual 항목의 증거는
  `.gdm/<슬러그>/ui/`에 파일로 남긴다. 사용자가 채팅에 이미지를 붙였으면
  파일 경로로 저장해달라고 요청하고, 직접 확인 가능한 환경(시뮬레이터,
  스크린샷 도구)이면 직접 찍는다. 웹 UI이고 위 조건이 맞으면 terminal-browser를
  우선 사용해 실제 상태 전이와 DOM을 확인한다. 문답으로만 확인된 경우 확인 내용·시각을
  텍스트 파일로 기록해 그 파일로 pass 한다.
- **DB 검증**: check의 cmd에 비밀번호·접속 문자열을 인라인으로 쓰지 않는다
  (환경변수·설정 파일 참조). 검증 쿼리는 조회 전용이어야 한다 — 검증 명령이
  데이터를 바꾸면 그것은 검증이 아니라 부작용이다.
- **반복 명령**: 프로젝트 표준 명령(빌드/테스트/실행)은 `gdm preset set`으로
  등록하고 check에서 `@이름`으로 참조한다. 같은 명령을 두 번 타이핑하고 있다면
  프리셋 등록 신호다. lint·typecheck 표준 명령이 있는 프로젝트면 회귀 check
  하나가 필요하면 기존 항목과 합치거나 추가한다. 같은 검사를 중복 등록하지 않는다.
- **검증 코드 추가**: 동작 회귀·경계 조건을 검증할 때 추가하고 기존 관례를 따른다.
  되돌리기 쉬운 작은 변경이나 구현 문구를 그대로 반복하는 테스트를 의례적으로 만들지 않는다.
  기존 테스트·실행 검사로 충분하면 이를 사용한다. 새 파일은 독립된 검증 책임이 있을 때 만든다.

## 엣지 케이스

- check가 잘못 세워졌음이 드러나면: `gdm plan edit --reason`으로 고친다.
  임의로 무시하고 진행하지 않는다.
- 권한·외부 환경 문제로 검증이 불가능하면: 그 항목은 미통과로 남기고 사용자에게
  보고한다. 검증을 우회하려고 `--manual`로 바꾸지 않는다.
- 진행 중 작업이 여러 개라 슬러그가 모호하면: `--slug`를 명시한다.

## 출력 형식

- 진행 중에는 의미 있는 결과·막힌 원인·다음 검증을 간결하게 알린다.
- 완료 보고는 바뀐 결과, 검증과 남은 한계, 증거 경로를 짧게 제시한다. 항목 표는 비교가
  필요할 때만 쓴다. 요약 문서는 `.gdm/<슬러그>/work.md`에 이미 있다.

## 예시

Bad — 통과가 안 되니 기준을 몰래 낮추는 흐름 (거부/기록된다):

```
c2(테스트 통과)가 계속 실패하므로 expect를 "일부 통과"로 바꾸고 진행하겠습니다.
→ gdm plan edit --check c2 --expect "일부 통과"   # --reason 없음 → exit 1
```

기준 완화는 사유 없이는 불가능하고, 사유를 남겨도 journal에 영구 기록되며 사용자에게
보고해야 한다. 올바른 대응은 테스트가 실패하는 원인을 고치는 것이다.

Good:

<example>
사용자: 엑셀 다운로드 기본 제한을 50만 건으로 바꿔줘. $gdm-go

어시스턴트:
1. `gdm plan init --slug excel-limit --brief "엑셀 다운로드 기본 제한 50만 건으로 변경" --require "기존 다운로드 동작 보존" --forbid "자동 커밋"`
2. check 등록:
   c1 "설정값 변경" (cmd: grep -q "DEFAULT_LIMIT = 500_000" src/config.ts)
   c2 "단위 테스트 통과" (cmd: ./gradlew test --tests '*Excel*')
   c3 "50만 초과 요청 시 안내 응답" (cmd: curl -sf .../download?rows=600000 | grep -q "제한")
3. 구현 → `gdm pass c1` → `gdm pass c2` → `gdm pass c3` → `gdm done`
4. 반복 실패·miss 또는 적용한 habit이 있을 때만 관찰 수확 → 적용한 habit 결과 평가
5. "완료: 기본 제한이 50만 건으로 변경됐고 3개 항목이 전부 실행 증거로 통과했습니다.
   요약: .gdm/excel-limit/work.md"
</example>

<commentary>
완료 선언이 gdm done 성공 뒤에만 나오고, 증거는 gdm이 직접 실행해 만들었으므로
지어낼 수 없다. 모델은 사용자 목표를 구현하고 cmd가 그 목표를 실제로 검증하는지도 판단한다.
</commentary>
