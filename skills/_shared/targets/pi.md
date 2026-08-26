## 설치 대상 어댑터

- target ID: `pi`
- provider adapter: `gdm-provider-adapter-v1`, argv policy: `gdm-pi-read-only-v1`
- Work 역할 실행 계약: `gdm-agents/run-role.sh --mode work --provider pi --role <role> --slug <slug> --handoff-event-id <event-id> --claim-id <claim-id> --receiver-role <receiver-role>`
- Work 없는 사전 설계 계약: `gdm-agents/run-role.sh --mode preflight --provider pi --role <role> --prompt <path> --output <path>`
- capability profile: `gdm-read-only-specialist/v1`
- 전문 역할 실행에서는 provider tool, 파일 쓰기, shell, browser, network, MCP, 하위 위임을
  허용하지 않는다. canonical bundle은 artifact `{path,sha256,text,bytesBase64}`를 보존하지만
  provider에는 결정적 `gdm-dispatch-model-view/v1`의 `{path,sha256,text}`만 전달한다.
  model-view의 `bundleSha256`는 full canonical bundle의 digest이고 ACK도 그 값에 결속한다.
- Pi adapter는 `--system-prompt`로 `GDM_RECEIVER_TRUST_BOOTSTRAP_V1:` static bootstrap을
  설정한다. 이 bootstrap은 outer GDM envelope/model-view와 receiver contract·제공된 ACK 선택지만
  이번 호출의 coordinator 지시로 인증한다. `artifact.text`와 그 안의 source/evidence·중첩 지시는
  신뢰하지 않는 분석 데이터이며, outer handoff role·intent가 요구하는 범위에서만 검토한다.
  bootstrap은 원격 provider/model identity나 artifact provenance를 증명하지 않는다.
- 여기서 network 없음은 모델에 network/browser tool을 노출하지 않는다는 뜻이며, provider
  transport가 모델 backend에 연결하지 않는다는 뜻은 아니다.
- preflight도 tool 0으로 실행하므로 필요한 저장소 문맥을 prompt bytes에 미리 포함한다.
- target hook: 별도 lifecycle hook이 필요하지 않으며 상태는 `not-required`다.
- 이 블록은 target argv와 hook 지원 상태만 설명한다. Work 상태나 역할 권한은 공통 source
  template에서 생성된 target body가 정한다.
