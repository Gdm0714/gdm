# Code graph bounded-coverage A/B — 2026-08-12

## 결론

v2 code graph는 두 실제 `gdm-analyze` 과제에서 정확도를 떨어뜨리지 않으면서 탐색 비용을
줄였다. control과 graph arm은 8개 실행 모두 정답 파일 집합을 정확히 반환했고(false negative
0, false positive 0), graph arm은 네 실행에서 provider를 각각 한 번만 사용했다.

두 과제·두 trial을 합치면 graph arm은 control 대비 다음과 같았다.

| 지표 | control 합계 | graph 합계 | 변화 |
|---|---:|---:|---:|
| 벽시계 시간 | 645.37초 | 282.52초 | **-56.2%** |
| total input tokens | 2,222,068 | 711,236 | **-68.0%** |
| cached 제외 input tokens | 255,220 | 151,876 | **-40.5%** |
| command executions | 51 | 40 | -21.6% |

따라서 이번 변경은 **결과 정확도 향상**이 아니라 **같은 정확도를 더 적은 시간과 입력으로
얻은 탐색 효율 향상**으로 판정한다. 두 과제 모두 control도 만점인 천장 효과가 있고 표본이
작으므로, code graph는 아직 기본 활성화하지 않고 선택형 파일럿으로 유지한다.

## 채택한 설계

유명한 코드 그래프·탐색 도구에서 현재 파일 그래프에 필요한 작은 공통부분만 가져왔다.

- [Sourcegraph precise navigation](https://sourcegraph.com/docs/code-navigation/precise-code-navigation)의
  정확한 결과와 search fallback 분리처럼, 요청 범위가 완전한 결과와 실제 불완전 결과를 나눴다.
- [SCIP의 구조화된 document·occurrence 모델](https://github.com/sourcegraph/scip/blob/6407d1fbfe118c67a897c6969cb84d820dfaff5e5/scip.proto#L66-L99)과
  [Kythe의 안정적인 노드·edge 표현](https://github.com/kythe/kythe/blob/26056edfc953b5d4ea0ed8e94db072caa7f7d4c7/kythe/proto/storage.proto#L38-L119)을
  축소해 canonical 상대 경로, node depth, provider version을 명시했다.
- [CodeQL path query](https://github.com/github/codeql/blob/08547cbce75ab9c8d542ba1ca3266d6bec9a514b/docs/codeql/writing-codeql-queries/creating-path-queries.rst#L49-L107)처럼
  결과가 왜 포함됐는지 확인할 수 있도록 depth와 경계를 반환한다.
- [Joern의 명시적 maxDepth](https://github.com/joernio/joern/blob/2b5250b43de853e38c5ae20a8c52d007f6be7c7d/changelog/traversal_removal.md#L11-L26)와
  [LSP의 직접 관계 조회](https://github.com/microsoft/language-server-protocol/blob/8d5153933153aed3a488b9b8f46b22ed0f90f552/_specifications/specification-3-16.md#L7264-L7378)를
  따라 요청한 탐색 경계와 partial 상태를 별도 계약으로 만들었다.

요청은 `gdm-graph-query/v1`을 유지하고 응답만 `gdm-graph-result/v2`, provider version 2로
올렸다. 주요 응답은 다음 두 필드다.

```text
nodes[{path, depth}]
coverage{
  scope,
  requestedMaxDepth,
  completeWithinRequestedDepth,
  frontier,
  incompleteReasons
}
```

`frontier`는 요청한 깊이 경계에서 실제 다음 관계가 있는 노드다. partial이나 저장소 전체의
완전성을 뜻하지 않는다. hard cap, parse/read/freshness 문제는 `incompleteReasons`로 남기고
기존 `rg` 탐색에 fail-closed로 폴백한다.

persistent index, symbol/occurrence identity, source range, CPG·CFG·data-flow, streaming은 현재
로컬 one-shot 파일 탐색 문제보다 크므로 이번 구현에는 넣지 않았다.

## 고정 조건

- Codex CLI: `0.147.0`
- 모델: `gpt-5.6-sol`, reasoning `xhigh`
- 저장소 HEAD: `990c89730cf06ebab7ef00621d313b98bf743362`
- 실행: `read-only`, `--ephemeral`, 같은 prompt와 JSON schema, 직렬 실행
- arm 차이: graph arm의 `GDM_GRAPH_PROVIDER` 설정뿐
- 순서: 과제별 두 trial에서 control → graph와 graph → control을 한 번씩 교차
- provider SHA-256:
  `79a99a8fb63475f4986b2e6277cf553ddb8075b063372be2c9b243a2c5f1ff79`
- analyze skill SHA-256:
  `40abd5c0004563196bdadb3b709b2b734070ae3f4a795dd89955b171c076436f`
- output schema SHA-256:
  `73d0f3f1c3624d588442216256a8aef42b64867fb4e69d8893999ae7878fb726`
- `validation-boundary` prompt SHA-256:
  `43404ebb9885cabd40847bc835539312c79906855b593441ff178a53ab89316f`
- `workflow-gates` prompt SHA-256:
  `d84315886e22d939a8d4d4f2f420a535a68bd67de949e7572ce4133a037fac89`

정답은 실제 import/re-export 행으로 별도 검산했다. provider 출력 자체를 정답으로 간주하지
않았다. 재현 입력은 `bench/graph-analysis-prompts/`와
`bench/graph-analysis-output.schema.json`에 있다.

## 개별 실행 결과

`fresh input`은 `input_tokens - cached_input_tokens`다. `commands`는 JSONL에서
`item.started`인 `command_execution` 수이며, provider 호출은 실행 command를 별도로 확인했다.

| 과제 | trial | arm | 시간 | commands | provider | input | cached | fresh input |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| validation-boundary | 1 | control | 138.60초 | 9 | 0 | 455,294 | 387,840 | 67,454 |
| validation-boundary | 1 | graph | 81.93초 | 27 | 1 | 198,159 | 151,040 | 47,119 |
| validation-boundary | 2 | graph | 94.63초 | 5 | 1 | 184,754 | 135,936 | 48,818 |
| validation-boundary | 2 | control | 168.50초 | 12 | 0 | 504,689 | 441,344 | 63,345 |
| workflow-gates | 1 | graph | 46.04초 | 4 | 1 | 112,737 | 84,992 | 27,745 |
| workflow-gates | 1 | control | 139.81초 | 11 | 0 | 520,281 | 454,912 | 65,369 |
| workflow-gates | 2 | control | 198.46초 | 19 | 0 | 741,804 | 682,752 | 59,052 |
| workflow-gates | 2 | graph | 59.92초 | 4 | 1 | 215,586 | 187,392 | 28,194 |

## 정확도

각 final JSON의 production/test 경로와 depth를 독립 정답 집합과 기계 비교했다.

| 과제 | trial | control | graph |
|---|---:|---|---|
| validation-boundary | 1 | TP 19, FN 0, FP 0 | TP 19, FN 0, FP 0 |
| validation-boundary | 2 | TP 19, FN 0, FP 0 | TP 19, FN 0, FP 0 |
| workflow-gates | 1 | TP 2, FN 0, FP 0 | TP 2, FN 0, FP 0 |
| workflow-gates | 2 | TP 2, FN 0, FP 0 | TP 2, FN 0, FP 0 |

`validation-boundary`의 정답은 production 16개와 test 3개, `workflow-gates`는 production 1개와
test 1개다. 모든 실행에서 depth도 정답과 일치했다.

## 과제별 요약

| 과제 | 지표 | control 평균 | graph 평균 | 변화 |
|---|---|---:|---:|---:|
| validation-boundary | 시간 | 153.55초 | 88.28초 | **-42.5%** |
| validation-boundary | total input | 479,991.5 | 191,456.5 | **-60.1%** |
| validation-boundary | fresh input | 65,399.5 | 47,968.5 | **-26.7%** |
| validation-boundary | commands | 10.5 | 16.0 | +52.4% |
| workflow-gates | 시간 | 169.14초 | 52.98초 | **-68.7%** |
| workflow-gates | total input | 631,042.5 | 164,161.5 | **-74.0%** |
| workflow-gates | fresh input | 62,210.5 | 27,969.5 | **-55.0%** |
| workflow-gates | commands | 15.0 | 4.0 | -73.3% |

시간, total input, fresh input은 두 과제의 두 trial 모두 graph 방향으로 감소했다.
`validation-boundary` trial 1은 반환된 19개 파일을 각각 여는 방식 때문에 graph command가
27회로 늘었다. 따라서 command 감소는 과제별로 일관된 결과가 아니며, aggregate -21.6%만으로
일반화하지 않는다.

## 라우팅 관찰

1. `validation-boundary` graph 결과는 요청한 2홉 정답 19개를 모두 반환했다. 요청 경계에서
   다음 관계가 있는 여섯 노드는 `frontier`로 표시됐지만 `truncated=false`,
   `completeWithinRequestedDepth=true`였다.
2. `workflow-gates`는 정답 두 개를 반환했고 frontier가 비어 있었다. 이것은 요청 범위의
   직접 관계가 끝났다는 뜻이며 저장소 전체 영향 없음의 증거로 사용하지 않았다.
3. graph arm 네 실행 모두 provider 호출은 한 번이었다. provider 이후 반환 후보를 직접
   확인했으며, v1 실험에서 발생한 repository-wide fallback 반복은 없었다.
4. 모든 control과 graph 결과가 정확했으므로 이번 표본에서는 누락 감소나 답변 품질 향상을
   입증하지 못했다.

## 판정과 한계

v2의 bounded-coverage 계약은 이전 실험의 중복 fallback 원인을 제거했고, 동일한 정확도에서
시간과 입력 토큰을 반복적으로 줄였다. 변경 자체는 유지할 가치가 있다.

그러나 선택형 companion의 기본 승격 기준에는 graph-sensitive 과제에서 반복적인 누락 감소도
포함된다. 이번 두 과제는 control도 100%였고 과제당 2 trial뿐이므로 그 기준은 아직 충족하지
못했다. 다음 단계는 그래프 없이는 관련 파일을 놓치기 쉬운 hidden fixture를 최소 두 종류 추가해
정확도 차이까지 측정하는 것이다.

## 회귀 검증

- provider tests: 3 pass, 0 fail, 95 assertions
- routing tests: 7 pass, 0 fail, 514 assertions
- TypeScript typecheck: pass
- 전체 CLI suite: 286 pass, 1 skip, 0 fail, 3,447 assertions (33 files)

## 원시 증거

- 실행 상태와 종료 코드:
  `/Users/godongmin/projects/harness-bench-runs/logs/graph-analysis-v2-20260812/status.tsv`
- 실행별 JSONL:
  `/Users/godongmin/projects/harness-bench-runs/logs/graph-analysis-v2-20260812/<task>-t<trial>-<arm>.log`
- 실행별 최종 구조화 결과:
  `/Users/godongmin/projects/harness-bench-runs/logs/graph-analysis-v2-20260812/<task>-t<trial>-<arm>.last.json`
- gdm check evidence:
  `.gdm/code-graph-bounded-coverage/out/`
