# gdm 공통 작업 프로토콜

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
