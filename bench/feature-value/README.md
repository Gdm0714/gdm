# Recent feature value benchmark

이 벤치마크는 최근 추가된 Pi 기능이 **동작하는가**가 아니라, 항상 노출할 비용과 실제 작업에서의
효용을 분리해 측정한다.

## Stage 0 범위

Stage 0은 LLM을 호출하지 않는다. 따라서 fresh input token이나 작업 성공률을 측정하지 않고 다음
비용 proxy와 안전 조건만 측정한다.

- 실제 memory·Computer Use extension 등록 시 tool schema, description, prompt snippet·guideline bytes
- baseline, memory, Computer Use, both, local statusline, all의 격리 process load wall time·CPU·RSS
- synthetic memory 0/10/200개에서 selection·render bytes와 store read latency
- 실제 Tart 3회에서 VM start, screenshot, guest TextEdit mutation, stop latency와 PNG bytes
- Computer Use 실행 중 host focus, host TCP listener, 동일 절대경로 host sentinel, owned VM cleanup
- 설치된 Codex status 표시 extension의 formatting, provider hiding, 1초 poll, 증분 fetch 0회
- 기존 Context Pack v2의 `invalid-not-evidence`, no-promotion 판정 carry-forward

Stage 0 결과가 valid여도 기능 유지, 항상 노출, 기본 활성화, 제거를 판정하지 않는다. 오직 body-free
측정 경계가 실제 환경에서 동작했고 Stage 1 E2E A/B에 들어갈 수 있다는 뜻이다.

## Stage 1 이후

- memory: fresh session에서 on/off crossover로 durable preference 준수, stale contradiction, false use,
  fresh input token과 latency를 측정한다.
- Computer Use: GUI-only task completion과 CLI-solvable negative routing을 enabled/disabled arm으로
  측정한다. host GUI를 control로 사용하지 않는다.
- Context Pack: 기존 2-task smoke를 재사용하지 않고 최소 8개 task의 확대 측정 전까지 blocked다.
- statusline: coding quality arm으로 승격하지 않는다.

## Privacy and immutability

실제 persistent memory store는 읽지 않는다. synthetic fixture body와 Computer Use screenshot은 측정
process 안에서만 사용하고 durable 결과에는 hash, count, byte, timing, fixed enum만 남긴다. 결과는
`results/runs/<run-id>`와 `results/pointers/<run-id>.json`에 create-only로 보존한다. 기존 Context Pack
결과와 `.gdm` evidence body는 수정하거나 수집하지 않는다.

## Commands

```bash
bun bench/feature-value/static-check.ts
cd cli && bun test test/feature-value-benchmark.test.ts
cd ..
bun bench/feature-value/publish-stage0.ts
bun bench/feature-value/verify-stage0.ts --current --require-cu-live
```
