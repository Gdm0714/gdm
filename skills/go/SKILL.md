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

사용자 원문 요청과 검증 가능한 확인 항목(check)을 등록하고, GDM이 생성한 배정의 실행과
구현 산출물의 수집·통합·검증을 책임지는 루트 조율자. 중간 이상 작업에서는 설치 대상이 지원하는 구현 워커에게 작업을 맡기고,
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

사용자 원문 요청을 Work brief로 보존하여 `gdm plan init`하고 check를 최소 1개 등록한 뒤,
구현 전에 다음 요청 기반 명령을 실행한다.

```sh
gdm team auto --slug <s> --from-request --provider <claude|codex> --model <planner-model> --max-active <1..32> --executor <native|unavailable> --json
```

GDM이 원문 요청·등록된 check·저장소 경로 목록을 모아 내부 planner를 제한된 tool-0 호출로
한 번 실행하고, 역할·소유 경로·의존성·check 연결·실행 route를 검증해 배정한다. 호스트는 실제
가용 슬롯·executor·허용 capability catalogue와 필요한 명시적 context만 제공한다.
진행자가 역할을 미리 매핑하거나 modules JSON을 작성하지 않는다. `--context <path>`는 필요한
문맥 파일마다 반복하고 `--capabilities-file <path>`에는 실제 허용된 실행 경로만 적는다.
기본 worker route는 `native-inherit`이며 planner의 `--model`은 worker 모델 선택이 아니다.
`--file <team-plan.json>`은 명시적 수동 import 호환 경로이며 기본 흐름이 아니다.
새 배정의 `--dry-run`도 실제 planner를 호출하므로 provider 사용량이 발생할 수 있지만 Work를
적용하지 않는다. 동일 입력의 재호출은 저장된 결과를 재사용하며 `plannerReused: true`를 반환한다.
planner 호출 실패·잘못된 배정은 명시적으로 실패하며 키워드 추정이나 진행자의 수동 배정으로
성공을 꾸미지 않는다. CLI는 자동 계획을 수행하지만 native 워커를 직접 띄우지 않는다.
승인된 작업은 매번 사용자에게 배정해 달라고 묻지 않고 아래 native dispatch 루프로 실행한다.

상세 계약은 gdm 저장소의 `docs/automatic-role-allocation.md`를 따른다. 생성된
`gdm-team-plan/v1`은 유지하되 새 요청 계획은 planner semantic v2(`input.promptVersion: 2`,
`plannerContract.version: 2`)를 쓴다. knowledge는 `acceptanceMode: artifact-review`, `checks: []`이며
등록된 모든 check는 implementation 또는 verification에 배정한다. 미확인 사항·integration이면 knowledge가
필요하며, 지식 조사·medium/high risk·여러 module·independentVerification이면 별도 verification이
필요하다. 명시적 verification 배정도 independentVerification 값과 무관하게 coordinated로 실행한다.
구현은 knowledge 수락 뒤, verify는 모든 선행 task 수락 뒤 시작한다. 조사와 무관한
기반 코드만 module의 구체적 `knowledgeIndependentReason`으로 병렬화한다. 경로 충돌은 여전히 직렬화한다.
후속 구현이 끝나야 통과하는 check를 선행 module의 수락 조건으로 두어 순환 대기를 만들지 않는다.
이 경우 구현 경계를 함께 잡거나 최종 check를 verification으로 연결하도록 GDM에 재계획을 요청한다.

자동 task는 `knowledge`(읽기), `implement-<module-id>`(쓰기), `verify`(읽기)다. 최종 검증자는
해당 Work의 구현에 참여하지 않은 실행자로 배정한다. 필요한 테스트 작성·수정 경로도 implementation의
쓰기 소유 범위에 포함한다. verifier는 읽기 전용을 유지하고 누락된 테스트 수정은 구현으로 되돌린다. 최종
verification은 고정한 후보의 원문 요구·동작·증거로 판단한다. native verification은 full의
독립 audit를 대체하지 않는다. 생성된 task를 개별 수정·철회하지 않는다. 첫 claim 뒤 지식 결과로
범위가 바뀌면 active 실행을 마치고 reported 결과를 수락/반려한 후 원문 요구·check·context를
갱신하여 같은 요청 기반 명령에 `--replan --reason '<변경 근거>'`를 붙여 재배정한다.
active·reported가 남으면 재계획할 수 없다. 이전 증거는 history에 보존되지만 새 task는 pending이며
검수·완료 결속을 다시 검증한다. 같은 입력의 재호출은 중복 배정하지 않으며 새 시도 ID는 재사용하지 않는다.
작은 low risk 단일 module이며 지식 조사·독립 검증이 필요 없으면 auto는 task 없는 single과
사유를 반환하고 루트가 직접 기존 check를 수행한다. 복잡한 작업의 executor가 unavailable이면
blocked를 보고하고 필수 역할을 없애 single로 낮추지 않는다. 독립적으로 가능한 작업은 계속한다.

coordinated의 통상 구현은 생성된 배정대로 위임하고 루트는 요구·수용 기준·검증·통합을 맡는다. 작은 연결·충돌
수정은 영향받은 검증과 함께 기록한다. 기본 상속 모델을 사용하고 모델·추론 수준 변경은 실제
사용 가능한 선택지와 이미 허용된 예산 안에서만 한다. 높은 추론은 필요한 설계·독립 검수에
집중하며 비싼 외부 Claude 호출을 자동 추가하거나 실제 모델 신원을 추측하지 않는다. 동시 예산은
고정 인원수가 아니라 독립적으로 진행 가능한 범위와 품질·완료 시간에 주는 이익으로 정한다.
실제 호스트 가용 슬롯·자원·사용자 비용 한도를 planner에 전달하고, 결과가
모일 때마다 대기 중인 의존성·충돌·중복 조사·통합 부담을 확인해 재계획에 반영한다.
역할 수를 채우기 위해 작업을 쪼개지 않으며 무거운 빌드·통합 테스트는 루트가 직렬화한다.
`gdm team configure`의 `--session <root-session-id>`는 실제 현재 루트 세션 ID를 아는 경우만 설정하며 ID를 만들거나
기존 작업을 다른 세션에 임의로 다시 묶지 않는다. 새 루트 세션에서 재개할 때는 active task가
없는지 확인한 뒤 실제 새 `--session`과 `--reason`으로 인계를 기록한다.

1. auto가 만든 task의 역할·소유 경로·연결 check·의존성을 대조하고
   `gdm team next --slug <s> --json`의 dispatch·route·prompt를 그대로 실행한다. 호스트가
   역할·worker 모델·소유 경로를 다시 정하지 않는다. route를 실행할 수 없으면 blocked로 기록한다. 워커에게 다른 작업자가
   있음과 기존 변경 보존, 사용자 승인·도구 권한·비밀 보호·비방해 검증 제약을 함께 전달한다.
   자동 배정은 읽기 전용 역할을 쓰기로 넓히거나 사용자 화면·입력 제어를 허용하지 않는다.
2. spawn 전에 `gdm team claim --slug <s> --task <id> --assignee <logical-worker-id> --attempt <attempt-id>`로
   소유권을 기록하고, 같은 identity·범위·수용 기준·검증·종료 조건을 대상의 위임 입력에 전달한다.
   spawn 자체가 실패하면 실패 산출물을 남겨 `report --outcome failed`로 active 상태를 닫는다.
3. 결과는 저장소 상대 경로의 로컬 파일에 남기고
   `gdm team report --slug <s> --task <id> --attempt <attempt-id> --outcome <completed|failed|cancelled|inconclusive>
   --summary "<결과>" --artifact <relative-path>`로 제출한다. 결과 파일에는 실제 변경·확인 결과·남은
   문제를 적는다. `.gdm` 상태는 CLI로만 변경하며 수동 결과 파일은 허용된 별도 경로에 저장한다.
   task 기록과 산출물이 Work의 공유 기억이다. 전체 대화를 반복 전달하지 않는다.
4. 루트가 실제 산출물과 diff를 읽고 수용 기준을 대조한다. implementation·verification은
   연결된 check를 `gdm pass`로 증명한다. planner semantic v2 knowledge의 artifact-review는
   원문 출처와 근거·미확인 사항을 담은 completed 보고서의 불변 해시와 수용 기준을 검토한다.
   아직 구현하지 않은 최종 동작 check의 통과를 knowledge 수락 조건으로 요구하지 않는다.
   `gdm team review --slug <s> --task <id> --attempt <current-attempt-id>
   --decision <accept|reject> --reason "<근거>"`로 판정한다.
   accept는 completed 결과·변하지 않은 산출물과 해당 수락 방식의 증거가 있어야 한다.
   artifact-review 예외는 planner semantic v2 knowledge에만 적용하며 수동·이전 계획의 연결 check 게이트를
   바꾸지 않는다. 모든 Work check는 implementation 또는 verification에서 증명하며 최종
   `gdm done`의 전체 check 게이트는 그대로다. 지식 수락만으로 check를 통과시키거나 필요한
   증거가 없는 verification-contract 미확인 사항을 resolve하지 않는다. 워커의 자기 보고,
   stop 이벤트, timeout, 프로세스 종료는 수락이 아니다. 워커는 check나 task 수락을 스스로 부여하지
   않는다. review와 retry의 `--attempt`는 현재 attempt를 정확히 지정해야 하며 과거 attempt 요청은
   거부된다. 반려·실패·취소·불확정은 원인과 새 접근을 정한 뒤 `gdm team retry --slug <s> --task <id>
   --attempt <current-attempt-id> --reason "<수정 이유>"`로 다시 열고 새 유일 attempt로 claim한다.
   선행 task를 재시도하면 그 결과에 의존한 후속 수락도 낡아지므로 해당 task를 명시적으로
   반려·재시도한다. 기준을 낮춰 없애지 않는다.
5. `gdm team next --slug <s> --json`의 `review|retry|dispatch|wait|validate|blocked`에 따라 계속한다.
   지식 결과 수락 뒤 구현을 열고 구현 결과 수락 뒤 별도 최종 검증을 연다. blocked면 실제
   실행 제약을 보고하고 지원되지 않는 실행을 약속하거나 성공으로 바꾸지 않는다.
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

- NEVER: `.gdm/`의 CLI 관리 상태·증거 기록을 직접 쓰거나 고치지 않는다. 상태 변경은 gdm CLI로만
  한다. 계획·import할 검증 계약·명시적 context·capability catalogue·보고서는 허용된 경로의 일반 파일로 작성한다.
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

## 외부 연동 검증 계약

새 작업이 외부 API·인증 신원·업무 상태 변경 또는 다중 턴 상태에 의존하면
`gdm plan init ... --profile integration`을 사용한다. 이런 흐름과 무관한 작은 로컬 수정과 기존 Work에 소급
강제하지 않으며, profile 없는 작업은 미분류로 남긴다. 기존 `--verification`은 검증 방식으로
계속 사용한다. check 통과 수나 `done`만으로 전체 제품·실환경 준비 완료를 주장하지 않는다.

check를 등록한 뒤, 첫 pass 전에 `gdm-verification-contract/v1` 계약 파일을 작성한다.
작성 형식은 gdm 저장소의 `fixtures/verification-v1/contract.json`과
`docs/integration-verification.md`를 정본으로 삼고 예제 ID·경로·digest를 실제 값으로 바꾼다.
`requirements`의 `input|positiveOutcome|deniedAction|stateContinuity`에 `checkIds`를 넣고,
비어 있으면 `notApplicableReason`을 적는다. `review.classifications`는 기존 `uncertainties`
배열의 각 `uncertaintyIndex`를 서로 다른 `unknownIds`에 빠짐없이 연결한다. `unknowns`는 모두
`status: open`으로 작성하고, `checks`의 fixture·target·validator 참조에는 실제 파일 hash를
넣는다. import는 기존 Work에도 적용할 수 있지만 이전 해소/waiver·검수·완료 결속을
무효화하고 모든 check를 open으로 돌린다. import 뒤 `gdm pass`를 다시 실행해 증거를 만들고
미확인 사항을 해소한다. 이전 evidence는 교체 전까지 조회용으로 남는다.

원문 요구를 다시 읽고 중요한 미확인 사항 각각에 ID·필요 증거·연결 check를 배정한다.
원문 입력 수용, 정상 사용자 업무 결과, 금지 행동 차단, 필요한 다중 턴 상태를 필수 check에
연결하고 적용되지 않는 조건은 사유를 남긴다. 정상 사용자까지 거절하는 구현도 실패해야 하며,
업무 결과는 응답 문구가 아니라 API 영수증·조회한 상태 등으로 검사한다. 접수와 처리 완료를
구분한다. 구현에 맞춰 만든 예제만으로 원문 요구를 덮었다고 판단하지 않는다.

입력 fixture는 출력 evidence와 별도 참조다. 확보한 원문과 직접 만든 fixture, 변형·익명화한
입력, 과거 trace를 구별하고 입력 출처·환경·대상·검사기의 실제 범위를 기록한다. 확보하지 못한
입력·원격 버전·설정은 unknown으로 남긴다. 로컬 fixture나 mock 성공을 실서비스 증거로 바꾸지
않으며, 민감한 설정값·비밀은 manifest나 외부 검수 입력에 넣지 않는다.
현재 remote/trace manifest의 hash는 그 로컬 파일의 내용 결속일 뿐 원격 대상의 관측 증거가
아니며 대상은 unverified로 남는다. 정책 문자열도 실제 승인 주체를 인증하는 증거가 아니다.

```text
gdm plan verification import --slug <s> --file <contract.json>
gdm plan verification show --slug <s> --json
gdm plan verification resolve --slug <s> --id <미확인-ID>
gdm plan verification waive --slug <s> --id <미확인-ID> --reason '<남는 한계>' --policy '<기존 정책·권한 근거>'
```

import 뒤 show의 요구→check→증거 범위와 모든 미확인 ID를 원문과 대조한 후 구현한다.
관련 check와 요구한 증거 조건이 실제로 충족된 뒤에만 resolve한다. open은 완료를 차단한다.
waive는 검증 통과가 아니라 기존 정책·권한 안에서 수용한 한계다. 사유와 정책 근거를 남기고
완료 보고에도 공개한다. unknown 범위까지 수용하는 정책일 때만 `--accept-unknown-scope`를
추가한다. 기존 승인으로 충분한 일을 다시 묻거나 done 도중 자동 waiver하지 않는다.
허용된 한계 수용 근거가 없으면 미해소로 남기고 독립적으로 가능한 작업은 계속한다.

최종 검증에서는 소스·계약·fixture·대상 manifest·검사기를 같은 후보로 고정한다. 서로 다른
환경/버전의 evidence를 섞지 않으며, 검증 중 변경하거나 과거 trace를 현재 실행으로 설명하지
않는다. 변경으로 증거가 낡으면 해당 범위를 다시 검증한다. validate는 완료 시 재실행 관측,
audit_bound는 결속된 검수 증거 사용이며 manual 증거도 자동 재실행과 구별해 보고한다.

## 도구

| 명령 | 용도 |
|---|---|
| `gdm plan init ... --assume <가정> --uncertain <불확실성> --allow-path <경로> --forbid-path <경로> --stop-if <조건> --risk <low\|medium\|high> --verification <deterministic\|inspectable\|opaque> [--simplify]` | preflight·범위·완료 정책과 init 기준선 기록 |
| `gdm plan init ... --profile integration` | 외부 연동의 필수 결과·미확인 사항·증거 범위 계약 활성화 |
| `gdm plan verification import --slug <s> --file <contract.json>` | check ID에 연결한 구조화 검증 계약 등록 |
| `gdm plan verification show --slug <s> --json` | 현재 계약·미확인 사항과 검증 범위 확인 |
| `gdm team auto --slug <s> --from-request --provider <claude\|codex> --model <planner-model> --max-active <1..32> --executor <native\|unavailable> [--context <path>] [--capabilities-file <path>] [--dry-run] [--json]` | 원문 요청·check로 내부 planner가 역할·의존성·route 배정 |
| `gdm team auto --slug <s> --from-request ... --replan --reason <근거>` | 활성 실행·미검토 보고 정리 후 갱신한 요청·check·context로 재배정 |
| `gdm team auto --slug <s> --file <team-plan.json> [--dry-run]` | 명시적 수동 import 호환 경로 |
| `gdm plan add --desc <항목> --cmd <검증 명령> --expect <기대> --kind <regression\|behavior\|edge\|static>` | 자동 항목 분류·등록 |
| `gdm plan add --desc <항목> --expect <기대> --manual [--expert]` | 수동 확인 항목 등록 |
| `gdm plan list` | 항목/상태 확인 |
| `gdm plan edit --check <id> [...] --reason <사유>` | 항목 조정 (사유 필수) |
| `gdm pass <id> --red` | regression 항목의 수정 전 동일 명령 실패(non-zero) 증거 기록 |
| `gdm pass <id>` | 자동 항목 통과 — gdm이 cmd를 직접 실행·저장·해시하고 exit 0일 때만 통과 |
| `gdm pass <id> --manual --observed <파일> [--reviewer <검토자> --note <근거>]` | 수동 항목 통과 — expert는 reviewer·근거 필수 |
| `gdm plan contract --allow-path <경로> --reason <사유>` | 검수 전 의도한 범위 확장 기록 |
| `gdm recheck` | 구현 중 중간 회귀 확인이 필요할 때만 통과한 자동 항목 재실행 |
| `gdm done` | 완료 — 자동 항목 재실행 또는 유효한 audit 결속, 증거·계약 게이트 검증 후에만 exit 0 |
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
team review·gdm pass 판정을 소유하며, 실제 소유 범위를 넘는 수정은 요청과 context를 갱신해 재계획한다.

<!-- GDM_TARGET_FRAGMENT_V1:delegation -->

1. 지속 계획의 작업 계약 초안에서 가정·불확실성·허용/금지 경로·중단 조건·risk·verification을
   꺼내 `gdm plan init`에 명시한다. 위의 구조 위험이 있으면 `--simplify`를 붙인다.
   외부 연동이면 `--profile integration`을 붙이고 check 등록 뒤 위 계약의 import·show
   checkpoint를 수행한다. `--uncertain` 문자열 목록만으로 구조화 계약을 대신하지 않는다.
   init 기준선은 이미 존재하던 로컬 변경을 보존하고 이후 delta만 범위 판정한다.
   필요한 `regression|behavior|edge|static|manual` 항목을 `gdm plan add`로 등록한다.
   기존 결함을 고치는 regression은 **구현 전에** `gdm pass <id> --red`로 동일 명령의
   non-zero 실패를 기록한다. red가 성공(exit 0)하면 결함을 드러내는 항목이 아니므로 고친다.
   좋은 check의
   기준은 하나다 — **cmd가 성공하면 기대가 충족됐다고 믿을 수 있는가.**
   등록한 목록(`gdm plan list`)을 사용자에게 보여준다. 적용할 adopted habit이 있으면
   첫 pass 전에만 `gdm plan contract --slug <슬러그> --activate-habit <id>@<version>`으로 고정한다.
2. 위 `gdm team auto`와 native dispatch 루프로 지식·구현·최종 검증을 배정·수집하고 `gdm pass <id>`.
   의도한 변경이 새 경로를 요구하면 검수 전에
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
   외부 연동은 원문 요구와 필수 결과·모든 중요 미확인 ID를 다시 대조하고 후보를 고정한다.
   `gdm plan verification show --slug <s> --json`에서 open·unknown·waived와 대상 결속을
   확인한다. 해소되지 않은 조건을 check 통과 수로 덮지 않는다.
   유효한 audit 결속이 없으면 `gdm done`이 자동 항목을 다시 실행하므로 직전에 `gdm recheck`를 중복 실행하지 않는다.
   `recheck`는 구현 도중 이미 통과한 항목의 중간 회귀를 확인해야 할 때만 사용한다.
4. `gdm done` 성공 뒤 외부 연동은 `gdm plan list --slug <s> --json`의 `verificationSummary`에서
   `completionValid`, `completionMode`, blockers·limitations를 확인한다. 누락·미지원·무효인
   요약은 실환경 검증 성공으로 해석하지 않는다. 유효한 receipt도 등록한 범위의 증거다.
   반복 실패·miss 또는 적용한 habit이 있을 때만
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
- 외부 연동은 검증한 후보·입력 출처·환경·대상 결속·완료 mode와 남은 unknown/waived를
  포함한다. waiver 사유·정책 근거는 로컬 상세 계약에서 확인해 설명하며 요약 count로 숨기지
  않는다. 미분류 작업은 실환경 검증 정보가 없음을 밝힌다. 통과 수는 이 범위를 대신하지 않는다.

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
3. `gdm team auto --slug excel-limit --from-request --provider <claude|codex> --model <planner-model> --max-active 1 --executor native` → 생성된 작은 작업 single 사유 확인
   → 구현 → `gdm pass c1` → `gdm pass c2` → `gdm pass c3` → `gdm done`
4. 반복 실패·miss 또는 적용한 habit이 있을 때만 관찰 수확 → 적용한 habit 결과 평가
5. "완료: 기본 제한이 50만 건으로 변경됐고 3개 항목이 전부 실행 증거로 통과했습니다.
   요약: .gdm/excel-limit/work.md"
</example>

<commentary>
완료 선언은 gdm done 성공 뒤에만 나온다. 실행 출력은 gdm이 저장하지만 cmd가 사용자 목표를
검증하는지, 입력 출처와 대상 범위를 올바르게 선언했는지는 별도로 판단한다. 이 작은 로컬
변경의 통과를 실서비스 전체의 준비 완료로 확대하지 않는다.
</commentary>
