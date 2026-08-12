# GDM Work Protocol v1 로컬 실동작 평가

> 상태: **superseded historical evidence**. 이 문서는 최초 handoff 시각 결함 수정과
> production v2 lifecycle 도입 전 실행을 보존한다. 현재 지원 상태나 test count로 인용하지
> 말고, 후속 평가는 `work-protocol-v2-evaluation-2026-08-12.md`를 사용한다.

평가일: 2026-08-12
대상: 로컬 설치본 `/Users/godongmin/.local/bin/gdm`과 Codex 역할 수신 흐름
결론: 일상적인 snapshot·handoff·stale 차단·완료 권한 분리는 실제 로컬 실행에서 동작했다.
다만 손상된 journal의 최초 handoff 시각 검증에는 결함 1개가 남아 있으므로, 현재 상태를
무결성 경계까지 완전하다고 평가할 수는 없다.

## 실행 결과

| 축 | 결과 | 관찰 |
|---|---|---|
| 설치 CLI happy path | 통과 | `gdm-work-snapshot/v1` export, fresh `gdm-handoff/v1`, handoff만으로 `done` 불가, evidence 후 완료 |
| adversarial CLI | 통과 | state/source stale fingerprint, credential 형태, 저장소 밖 artifact가 모두 fail-closed로 거부됨 |
| source-only stale | 통과 | Work 상태를 바꾸지 않고 source만 바꿨을 때 이유가 정확히 `source_changed` 하나였음 |
| 집중 회귀 | 통과 | protocol 관련 21 tests, 251 assertions, typecheck 성공 |
| 전체 CLI 회귀 | 통과 | 307 pass, 1 skip, 0 fail, 3704 assertions, coverage/build/smoke 성공 |
| 정적 검사 | 통과 | `bash -n`, ShellCheck, 단일 runner/cleanup 구조 검사 성공 |
| 실제 Codex 수신자 | 통과 | stale revision 1·2에서는 artifact를 열지 않고 중단, fresh revision 3에서만 해시 확인 후 읽음 |
| 문서·스킬 의미 일치 | 통과 | schema, stale 의미, 완료 권한 분리, provider-neutral 범위의 drift 없음 |

## 실제 Codex 수신 순서

1. revision 1 수신 시 `plan_changed`, `state_changed`, `source_changed`를 보고하고 artifact를
   열지 않았다.
2. revision 2는 발행 직후 다른 check가 통과해 state fingerprint가 바뀌었다. 수신자는
   `state_changed`를 보고하고 다시 artifact를 열지 않았다.
3. 모든 기계 상태 변경 뒤 revision 3을 발행했다. 수신자는 `stale:false`, 빈 staleReasons,
   artifact SHA-256 일치를 확인한 뒤에만 파일을 읽었다.
4. 수신자는 `mktemp` 고정 접두사, 허용 경로 패턴 검사 뒤의 `rm -rf --`, EXIT trap을 근거로
   임시 디렉터리 정리 경계를 보고했다.

이 순서는 모델이 단순히 handoff 문장을 따르는 것이 아니라 매번 snapshot을 다시 읽고 현재
fingerprint와 비교하는지를 확인한다. 이번 실행에서는 2회의 stale 중단과 1회의 fresh 재개가
의도대로 나타났다. 단일 세션의 3회 관찰이므로 장기적인 확률적 준수율을 뜻하지는 않는다.

## 확인된 결함

### Major: 저장된 최초 handoff가 Work 생성 전 시각이어도 읽기 경로가 수용한다

`recordProtocolHandoff()`는 새 event의 시각이 Work 생성 시각보다 빠르면 거부한다. 하지만
`readProtocolHandoffEvents()`는 두 번째 event부터 직전 event와의 단조 증가만 검사하고,
`buildWorkSnapshot()`도 최초 event의 시각을 Work 생성 시각과 다시 대조하지 않는다.

격리 probe는 다음을 재현했다.

```json
{
  "schemaVersion": "gdm-work-protocol-integrity-probe/v1",
  "preCreationFirstEventAccepted": true,
  "sourceOnlyStaleReasons": ["source_changed"]
}
```

정상 CLI 쓰기 경로에서는 만들 수 없지만, journal 손상·이전 버전·수동 변조를 읽는 trust
boundary에서 fail-closed가 깨진다. 수정 시 최초 handoff `ts >= work.createdAt`을 snapshot
구성 경계에서 검증하고 core test를 추가해야 한다.

## 해석

- 현재 프로토콜은 Codex와 Claude의 **공통 작업 상태 언어**로 실사용할 수 있다.
- handoff는 pass·audit·done 권한을 만들지 않으며, 실제 설치본에서도 그 경계가 유지됐다.
- stale 감지는 실제 Codex의 작업 재개를 막는 운영 신호로 작동했다.
- 그러나 이것은 두 모델의 실행 정책과 도구 권한을 완전히 통일하는 adapter가 아니며,
  저장 journal 무결성 결함이 해결되기 전에는 모든 손상 입력에 안전하다고 주장하면 안 된다.

## 재현 명령

```bash
./bench/work-protocol-live-smoke.sh happy
./bench/work-protocol-live-smoke.sh adversarial
cd cli && bun ../bench/work-protocol-integrity-probe.ts
bun test test/protocol.test.ts test/protocol-cli.test.ts test/work-protocol-routing.test.ts
bun run verify
```
