# Code graph navigation A/B — 2026-08-11

## 결론

현재 측정에서는 code graph가 결과 품질을 높이지 않았다. 두 실제 `gdm-analyze` 과제에서
control과 graph arm은 모두 정답 파일을 빠짐없이, 오탐 없이 반환했다. 큰 영향 그래프에서는
graph arm이 `truncated=true` 결과를 받은 뒤 계약대로 전체 검색을 다시 수행해 시간과 토큰이
늘었고, 작은 비절단 그래프에서는 비용이 사실상 같았다.

따라서 현재 구현은 선택형 파일럿으로 유지하고 기본 활성화하지 않는다. 다음 실험 전에는
요청 깊이 경계 도달과 실제 불완전 결과를 구분해 중복 fallback을 줄이는 것이 우선이다.

## 고정 조건

- 모델: `gpt-5.6-sol`, reasoning `xhigh`
- Codex CLI: `0.147.0`
- 저장소 HEAD: `990c89730cf06ebab7ef00621d313b98bf743362`
- 두 arm은 각 과제에서 동시에 시작했고 `read-only`, `--ephemeral`, 같은 prompt와 JSON schema를
  사용했다. 차이는 `GDM_GRAPH_PROVIDER` 설정 여부 하나다.
- provider SHA-256:
  `b74b75d83b004a7323ad6e7f68b95610ca6e318f606b619c9ca32348e9b12196`
- analyze skill SHA-256:
  `85a1fd7d3867307293e68646b9dd77ae68f53f05071d8f801ff1e49143dc2045`
- 정답 집합은 실제 import 행을 별도로 열어 검산했다. provider 출력만 정답으로 간주하지 않았다.

재현 입력은 다음 파일에 있다.

- `bench/graph-analysis-prompts/validation-boundary.md`
- `bench/graph-analysis-prompts/workflow-gates.md`
- `bench/graph-analysis-output.schema.json`

## 결과

| 과제 | control 정확도 | graph 정확도 | control 시간 | graph 시간 | control input tokens | graph input tokens | 실제 provider 호출 | 판정 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `validation-boundary` 2홉 dependents | 19/19, 오탐 0 | 19/19, 오탐 0 | 140.34초 | 218.78초 | 461,148 | 844,251 | 1 | 품질 동일, 시간 +55.9%, input +83.1% |
| `workflow-gates` 2홉 dependents | 2/2, 오탐 0 | 2/2, 오탐 0 | 115.46초 | 113.97초 | 249,629 | 226,180 | 2 | 품질 동일, 시간 -1.3%, input -9.4% |

토큰 수는 Codex JSONL의 전체 input 수치이며 cached input을 포함한다. cached input을 뺀 수치는
`validation-boundary`에서 control 64,348, graph 85,211(+32.4%), `workflow-gates`에서 control
41,757, graph 47,748(+14.3%)이었다. 작은 과제의 전체 input 감소는 cache 차이의 영향을 받았고,
실제 신규 입력량은 감소하지 않았다.

### 기존 구현 smoke (`t1`)

기존 `t1`은 graph-sensitive fixture가 아니므로 회귀와 비용만 확인했다.

| arm | hidden | visible | 시간 | tokens | diff lines | provider 호출 |
|---|---:|---:|---:|---:|---:|---:|
| `gdm` | 5/5 | 7/7 | 209초 | 94,295 | 55 | 0 |
| `gdm-graph` | 5/5 | 7/7 | 203초 | 75,509 | 55 | 0 |

두 diff의 source 변경은 동일했고 graph arm은 provider를 호출하지 않았다. 따라서 이 비용 차이는
code graph 효과로 귀속할 수 없다. Claude 익명 diff 심판은 control 9점, graph 8점으로 평가했지만
차이는 테스트 문구였으며 graph 탐색과 무관하다.

## 관찰

1. `validation-boundary` graph query는 요청한 2홉 파일 19개를 모두 반환했다. 동시에
   `max-depth-reached:2`, `truncated=true`도 반환했다.
2. 현재 라우팅 계약은 `truncated=true`를 partial 결과로 취급하므로 graph arm은 반환 파일을
   직접 확인한 뒤에도 저장소 전체 `rg` 탐색을 다시 수행했다. control 10회 대비 graph 18회의
   command execution이 발생했다.
3. `workflow-gates`는 작은 비절단 그래프였고 양 arm 비용이 거의 같았다. graph arm은 entry와
   다음 depth 확인을 위해 provider를 2회 호출했다.
4. graph가 정답 파일 누락을 줄인 사례는 이번 두 과제에서 나오지 않았다. control 자체가 두
   정답 집합을 모두 찾았다.

두 실제 분석 과제를 합치면 graph arm은 control 대비 총 I/O tokens +50.4%, cached input을 뺀
I/O tokens +26.6%, 벽시계 시간 +30.1%였다. command execution은 graph 26회, control 18회였다.

## 해석 한계

- 각 entry를 arm별 한 번만 실행했으므로 모델 표본 오차를 분리하지 못했다.
- 같은 조건을 맞추기 위해 두 arm을 병렬 실행했으므로 절대 시간에는 로컬 자원 경합이 섞일 수
  있다.
- 두 실행에서 일부 MCP startup 오류가 로그에 있었으나 분석에 필요하지 않은 connector였고 양
  최종 결과는 정상 종료했다.
- control도 모든 정답을 찾은 천장 효과가 있어, 이번 과제에는 품질 향상을 보여줄 여지가 없었다.

## 판정과 다음 실험

선택형 companion 승격 기준인 반복적인 누락 감소와 20% 이하 오버헤드를 충족하지 못했다.
현재는 기본 활성화보다 선택형 유지가 맞다.

다음 후보는 provider가 다음 두 상태를 구분하도록 만드는 것이다.

- 요청된 `maxDepth` 범위는 완전하지만 그 밖의 깊이를 의도적으로 자른 상태
- 파일·edge·byte 상한이나 parse 실패로 요청 범위 자체가 불완전한 상태

예를 들어 `completeWithinRequestedDepth` 또는 구조화된 `truncationReasons`를 추가하면 전자는
중복 전체 검색 없이 반환 후보 직접 확인만 수행할 수 있다. 이 변경 뒤 같은 두 과제를 최소 두 번
교차 순서로 반복해 정확도 유지와 시간·신규 input 감소를 다시 측정한다.

## 원시 증거

- `/Users/godongmin/projects/harness-bench-runs/logs/graph-analysis/validation-boundary-gdm.log`
- `/Users/godongmin/projects/harness-bench-runs/logs/graph-analysis/validation-boundary-gdm-graph.log`
- `/Users/godongmin/projects/harness-bench-runs/logs/graph-analysis/workflow-gates-gdm.log`
- `/Users/godongmin/projects/harness-bench-runs/logs/graph-analysis/workflow-gates-gdm-graph.log`
- `/Users/godongmin/projects/harness-bench-runs/logs/t1.graph-judge-out.json`
- `/Users/godongmin/projects/harness-bench-runs/results.csv`
