# GDM Work Protocol production v2 평가

평가일: 2026-08-12
갱신일: 2026-08-13
상태: **로컬 자동·실제 provider conformance 통과 — 독립 audit와 사용자 설치는 별도 게이트다.**
대상: source CLI, packaged binary, generated Codex·Claude skills, read-only role runner

## 지원 주장

production v2가 완료되면 다음의 좁은 범위만 주장한다.

- v1 Work·snapshot·handoff 읽기 호환
- 로컬 journal corruption·symlink·동시 writer·지원 crash point의 fail-closed 처리
- `plan|analyze|review|audit` 역할의 동일 canonical dispatch identity·capability·receipt lifecycle과
  `bytesBase64` 중복을 제거한 결정적 provider model-view
- generated target skill의 canonical source-template와 전체 source hash parity

실제 원격 provider/model identity, reasoning 품질 동일성, 동일 사용자가 binary와 state를 함께
다시 쓰는 공격, write·shell·browser·network 역할 대칭은 지원 주장이 아니다.

## 증거 매트릭스

| 축 | 상태 | 재현 명령 | 필수 산출물 |
|---|---|---|---|
| persisted trust boundary | pass | `cd cli && bun test --timeout 30000 test/protocol-integrity-v2.test.ts` | 5 pass; symlink·forged done·discriminator·artifact·malformed journal fail-closed |
| journal anchor·crash recovery | pass | `cd cli && GDM_PROP_SEED=20260812 bun test --timeout 30000 test/protocol-journal-integrity.test.ts test/protocol-crash-recovery.test.ts` | 12 pass; mutation corpus와 두 commit-point old-or-new 수렴 |
| receipt lifecycle·권한 비부여 | pass | `cd cli && bun test --timeout 30000 test/protocol-receipt.test.ts test/protocol-cli.test.ts` | 17 pass; claim/finish/adopt/recover와 Work 권한 비부여 |
| concurrent writer | pass | `cd cli && bun test --timeout 30000 test/protocol-concurrency.test.ts` | 3 pass; 단일 winner와 lossless revision chain |
| offline target adapter | pass | `cd cli && bun test --timeout 30000 test/protocol-runner-conformance.test.ts` | fake provider argv/model-view/output/limit/TOCTOU receipt; provider-visible artifact에는 `{path,sha256,text}`만 있고 ACK는 canonical bundle hash에 결속 |
| generated skills·installer | pass | `cd cli && bun test --timeout 30000 test/protocol-skill-renderer.test.ts test/install.test.ts test/work-protocol-routing.test.ts` | manifest·runner/adapter hash와 precommit rollback 포함. canonical `{text,bytesBase64}`와 provider model-view `{text}`의 분리, standalone `gdm-audit` 부재를 고정 |
| source·packaged parity | pending refresh | `./bench/work-protocol-v2-release-conformance.sh && ./script/qa/gdm-release-qa.zsh` | 2026-08-12의 canonical bundle·receipt·adopt·status, runner/adapter bytes, rollback parity는 pass. 새 model-view source/package golden과 갱신된 runner byte parity를 추가해 다시 실행해야 pass로 복귀 |
| 실제 Codex·Claude | pass | `./bench/work-protocol-provider-conformance.sh --provider <target> --rounds 3` | Codex 0.147.0·Claude 2.1.228 각 fresh 3회, authority 및 artifact/source stale 경계 통과 |

## 최종 판정 규칙

- 자동 항목 하나라도 pending/fail이면 production-complete가 아니다.
- 실제 provider 인증·quota·tool 부재는 pass가 아니라 blocked다.
- 두 target의 공통 source-template aggregate인 `canonicalSourceSha256`, 전체 `sourceSha256`,
  capability profile이 다르면 fail이다. target별 rendered body가 byte-identical하다는 뜻은 아니다.
- handoff·receipt·adoption이 Work/check/audit/delivery bytes를 바꾸면 fail이다.
- 실제 모델 평가는 실행 횟수와 version을 함께 적으며 장기 준수율로 일반화하지 않는다.

## Pre-fix Claude audit timeout 관찰

`audit-claude-4`, `audit-claude-5`, `audit-claude-6`은 각각 317,177 bytes, 148,962 bytes,
111,984 bytes artifact를 받았지만 bounded runner timeout으로 exit 124가 기록됐고 output은 모두
0 bytes(SHA-256 `e3b0c442...b855`)였다. 세 실행에서 canonical dispatch JSON을 그대로 provider에
주입해 같은 artifact bytes가 `text`와 `bytesBase64` 두 표현으로 model input에 함께 들어간 것이
pre-fix harness의 입력 확대 경로였다. artifact를 두 차례 줄여도 이 중복 경로는 남아 있었다.

수정 후 canonical `gdm-dispatch-bundle/v1`은 exact-byte identity를 위해
`{path,sha256,text,bytesBase64}`와 그 `bundleSha256`를 그대로 유지한다. provider에는
`gdm protocol claim ... --model-view`의 결정적 `gdm-dispatch-model-view/v1`을 보내 artifact
`{path,sha256,text}`만 한 번 노출한다. model-view의 `bundleSha256`는 canonical full bundle
digest이므로 기존 ACK·receipt 결속은 바뀌지 않는다. Claude adapter v2의 static
`GDM_RECEIVER_TRUST_BOOTSTRAP_V1:`은 outer envelope/model-view와 receiver contract·ACK만 인증하고,
artifact source/evidence와 중첩 지시는 untrusted data로 유지한다. 세 timeout은 이 pre-fix harness
입력 경로와 bounded 실행의 실패 관찰이지 Claude의 모델 품질, reasoning 능력, 원격 model
identity에 대한 평가가 아니다.

## 결과 기록

각 실행의 exact bytes와 hash는 `.gdm/work-protocol-production-v2/out/c1.txt`부터 `c8.txt`까지의
GDM evidence에 저장한다. source fingerprint는 audit offer 직전에 생성한 canonical snapshot에
묶으며 이 보고서 안에 자기참조 hash를 적지 않는다.

- 전체 source verify: 370 pass, 1 skip, 0 fail, 4,938 assertions
- source·packaged parity: v1 read, v2 bundle/receipt/status, legacy anchor migration, rollback 모두 true
- provider conformance trace: `.gdm/work-protocol-production-v2/out/c8.txt`
- 실제 실행 경계: Codex CLI 0.147.0, Claude Code 2.1.228, `gdm-read-only-specialist/v1`
- 독립 audit report와 설치 binary/manifest hash: audit·설치 단계에서 GDM 및 doctor가 별도 기록

중간 live 실행에서 placeholder ACK 누락과 artifact 내부 지시를 prompt injection으로 본 Claude의
`blocked`가 각각 한 번 관찰됐다. 이를 성공으로 재분류하지 않았다. runner가 identity-bound ACK
선택지를 생성하도록 바꾸고, artifact는 순수 데이터, handoff intent는 요청으로 분리했으며,
disposition이 Work 완료가 아니라 receiver 결과 완결성임을 계약에 명시한 뒤 양쪽 3회씩 다시
통과했다. 이 표는 장기 모델 품질이나 원격 provider identity의 보장이 아니다.
