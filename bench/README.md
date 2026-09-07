# bench — 하네스 동일 조건 측정 리그

불변식 개정 조항의 "동일 조건 측정"을 재현하는 도구. 하네스(또는 스킬 변경)의
효과를 감상이 아니라 숫자로 판정할 때 쓴다. 2026-07-13 벤치 15런
(gdm/무하네스/외부 하네스 3종 × 태스크 3종)이 이 리그의 첫 실행이다.

## 방법 — 세 가지 원칙

1. **정답이 먼저 존재한다**: 태스크는 결함 주입(정상 코드에 버그를 심고 증상만
   브리프로 제공) 또는 과거 이슈 리플레이로 만든다. 수용 기준은 **히든 테스트**
   — 실행 전에 고정하고, 러너에게는 보이지 않는 곳에 둔다.
2. **동일 조건**: 같은 브리프, 같은 실행 CLI·모델, 태스크마다 fresh worktree.
   하네스 지침은 프롬프트에 전문 인라인한다 (스킬 확장에 의존하지 않는다).
3. **눈가림 채점**: 정확도는 히든 테스트(기계 판정), 품질은 익명·셔플된 diff를
   별도 모델 심판이 비교 평가. 심판은 어느 하네스의 산출물인지 모른다.

## 파일

| 파일 | 역할 |
|---|---|
| `run.sh <task> <arm>` | 워크트리 생성 → 프롬프트 조립(브리프+하네스 지침 전문+공통 규칙) → `codex exec` 실행 → 시간 기록 |
| `judge.sh <task> <arm>` | 히든 테스트 실행, 가시 테스트 회귀, diff 추출, 완료 마커·토큰·시간 수집 → `results.csv` |
| `quality-judge.sh <task>` | 태스크의 전 arm diff를 익명 셔플해 눈가림 심판(claude -p) 비교 평가 → JSON |
| `graph-quality-judge.sh <task>` | `gdm`과 `gdm-graph` 두 diff만 익명 셔플해 같은 관점으로 쌍대 비교 → JSON |
| `context-pack-evaluation-2026-09-03.md` | Context Pack 도입 근거, 실제 token 수치, 유효성 한계와 재검증 기준 |

## Context Pack 비교 기록

2026-09-03 receipt-bound E2E smoke의 raw 6회 중앙값 fresh input은 Control 36,771,
Graph 27,910, Context 22,441이었다. 세 arm 모두 valid인 동일 조건 3쌍의 중앙값은 각각
26,148, 27,961, 22,499였다. Context Pack을 개선하는 이유는 이 감소 방향을 같은 품질의
확대 benchmark에서 재현하기 위해서다. 전체는 13/18 valid였으므로 확정 효과나 기본 활성화
근거로 쓰지 않는다. 원시 경로와 task별 편차는
`bench/context-pack-evaluation-2026-09-03.md`에 기록했다.

## 경로 계약

스크립트는 세 위치를 가정한다 (교체 가능 — 새 측정마다 샌드박스만 갈아끼운다):

- `~/projects/harness-bench` — 샌드박스 프로젝트 (태스크 브랜치 포함)
- `~/projects/harness-bench-hidden` — 히든 테스트(`<task>.hidden.test.ts`) + 브리프(`briefs/<task>.md`)
- `~/projects/harness-bench-runs` — 런 워크트리·로그·결과 (일회성, 삭제 가능)

## `gdm-graph` 대조 arm

`gdm-graph`는 정상 `gdm` arm과 같은 브리프·gdm-go 지침을 사용한 뒤 선택형 graph navigation
지침만 덧붙인다. 이 arm에서만 현재 저장소의
`cli/src/graph-nav-provider.ts` 절대경로를 `GDM_GRAPH_PROVIDER`로 export한다. 다른 arm은 호출자의
환경에 같은 변수가 있어도 이를 제거하므로 정상 `gdm` 의미와 Check/Evidence 게이트는 바뀌지 않는다.

추가 지침은 구체적인 TypeScript 계열 entry가 있을 때 작업당 최대 2회, `maxDepth` 2 이하의
local one-shot 조회만 허용한다. provider는 daemon·network·cache 없이 실행되고 호출자가 shell
timeout wrapper 대신 10초 상한을 적용한다. 요청은 `gdm-graph-query/v1`, 응답은
`gdm-graph-result/v2`다. v2는 `nodes[{path,depth}]`와
`coverage{requestedMaxDepth,completeWithinRequestedDepth,frontier,incompleteReasons}`를 반환한다.
`frontier`는 요청한 depth 경계에서 실제 다음 관계가 있는 노드이지 partial 또는 저장소 전체
완전성 표시가 아니다. fresh하고 requested-depth complete이며 `truncated=false`이고 관련
`unresolved`가 없으면 repository-wide 검색을 반복하지 않지만 반환 후보는 반드시 직접 읽는다.

provider 부재·비실행·실패·timeout·잘못된 JSON/schema·stale 응답은 버리고 기존 검색으로
폴백한다. hard cap·parse/read 문제 등으로 `completeWithinRequestedDepth=false`인 응답은 반환
후보를 보조 힌트로만 쓰고 기존 `rg`와 직접 source read로 누락을 보완한다. 질문이 frontier
밖까지 필요할 때도 depth를 늘려 다시 조회하거나 기존 검색으로 전환한다. 빈 edge나 frontier가
없다는 사실은 저장소 전체에서 영향이 없다는 증거가 아니다. graph 결과는 evidence, scope 확장,
`pass`/`done`/`audit` 판정에 사용할 수 없다.

기존 소형 fixture의 overhead·회귀와 쌍대 diff 품질 smoke는 다음처럼 한 쌍을 실행한다.

```bash
bench/run.sh t1 gdm
bench/run.sh t1 gdm-graph
bench/judge.sh t1 gdm
bench/judge.sh t1 gdm-graph
bench/graph-quality-judge.sh t1
```

### v2 graph-sensitive A/B 재측정

실제 라우팅 효과는 `bench/graph-analysis-prompts/`의 동일 prompt와
`bench/graph-analysis-output.schema.json`을 사용해 과제별·arm별 두 번씩 측정한다. 로컬 자원
경합과 한쪽의 지속적인 선행 효과를 줄이기 위해 병렬 실행하지 않고 다음처럼 순서를 교차한다.

| trial | 직렬 실행 순서 |
|---|---|
| 1 | `gdm` control → `gdm-graph` |
| 2 | `gdm-graph` → `gdm` control |

네 실행은 같은 모델·reasoning·CLI·저장소 지문·prompt·JSON schema를 쓰고, graph arm의
`GDM_GRAPH_PROVIDER` 설정 외 환경 차이를 제거한다. 각 실행은 fresh ephemeral session에서
시작하며 로그와 출력은 과제·arm·trial id로 따로 보존한다. 한 런이 실패해도 순서를 바꾸거나
성공한 런으로 교체하지 않고 실패 상태와 원인을 함께 기록한다.

결과표에는 trial마다 다음 값을 원시 로그에서 수집한다.

- 정답 파일 집합의 true positive·false negative·false positive와 직접 확인한 import/re-export
  `파일:라인` 근거
- provider 실제 호출 횟수(control은 0이어야 함)와 `item.started`인 `command_execution` 수
- 벽시계 시간
- Codex usage의 total input tokens와 `input_tokens - cached_input_tokens`로 계산한 cached 제외
  input tokens

과제별 두 trial의 개별값을 먼저 공개하고 arm 요약을 그 뒤에 낸다. 정확도 손실이 있거나
fail-closed 폴백이 누락되면 비용과 무관하게 회귀다. 시간·토큰·command 감소는 반복 방향이
같을 때만 개선 후보로 해석하며, 측정 전에는 v2가 좋아졌다고 결론내리지 않는다.

2026-08-12 교차 재측정 결과와 원시 증거 경로는
`bench/code-graph-evaluation-2026-08-12.md`에 기록했다. 두 과제 모두 정확도는 그대로였고,
시간과 total/cached 제외 input은 각 trial에서 graph 방향으로 감소했다. 이 결과만으로 기본
활성화하지는 않는다.

이 대조 arm은 **simulation/overhead-regression probe**다. 현재 소형 `t1`~`t3` fixture는 code graph
효용을 판별하도록 설계되지 않았으므로, 결과가 같으면 효과가 없다는 뜻이 아니다. 실제
`gdm-plan`·`gdm-analyze`·`gdm-review` 라우팅 효과와 graph-sensitive 정확도는 cross-file 영향
경로와 연결된 테스트를 숨긴 전용 fixture에서 후속 측정해야 한다. 그 fixture 추가는 현재
파일럿의 허용 경로 밖이다.

선택형 companion으로 승격하려면 graph-sensitive 태스크 최소 2종에서 영향 파일 누락 또는 탈출
결함을 반복적으로 줄이고, 새 hidden regression이 없어야 한다. graph-sensitive arm의 중앙값
시간·토큰 오버헤드는 각각 20% 이하, 기존 소형 대조군은 graph 호출 0회 또는 전체 오버헤드 5%
이하여야 한다. 매 실행 뒤 잔존 provider 프로세스와 stale/partial/unsupported 결과를 영향 없음으로
오인한 사례도 각각 0건이어야 한다. 이 기준을 충족하지 못하면 일반 라우팅으로 승격하지 않고
수동 실험 도구로 남긴다.

## 지표 읽는 법

- **탈출 결함**(히든 테스트 실패)이 1차 지표. 전 arm 만점이면 태스크가 쉬웠다는
  뜻이고, 그때의 판정 근거는 비용(시간·토큰)과 완료 신뢰도(마커·거짓 완료)다.
- 품질 점수는 태스크 간 요동이 크다 — 큰 차이(비용 배수)만 믿고 작은 차이
  (점수 몇 점)는 무시한다. n을 늘리기 전에는 순위 하나로 결론 내지 않는다.
- `graph-quality-judge.sh`의 한 번의 승패는 graph 효용 증거가 아니다. 히든 테스트·시간·토큰과
  graph-sensitive 반복 측정이 승격 판단의 정본이고, 쌍대 심판은 diff 품질 회귀를 보조한다.

## 운영 주의 (실측 사고에서)

- 병렬 런은 2개까지 — 세션당 데몬을 남기는 플러그인이 있으면 프로세스 테이블이
  포화된다 (실측: 1,300개 누적으로 배치 연쇄 사망).
- 장시간 배치는 세션에서 분리해(nohup) 돌리고, 완료는 파일(results.csv)로
  판정한다.
