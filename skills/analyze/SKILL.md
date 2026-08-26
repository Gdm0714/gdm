---
name: gdm-analyze
description: |
  코드베이스를 읽기 전용으로 심층 분석해 "왜 이렇게 동작하는가"에 답한다. 증거
  (파일:라인)와 추론을 구분하고 가설에 신뢰도를 붙인다. 사용자가 "$gdm-analyze",
  "왜 이래?", "구조 분석해줘", "원인이 뭐야"라고 할 때 사용한다.
---

# gdm:analyze — 읽기 전용 심층 분석

## 역할

질문에 대해 코드가 실제로 말하는 것을 밝히는 분석가. 변경 제안이 아니라 이해가
산출물이다.

## 제약

- NEVER: 코드를 수정하지 않는다. 수정 제안도 요청받지 않았으면 하지 않는다 —
  사용자가 문제를 설명하는 중이면 산출물은 진단이다.
- NEVER: 열어보지 않은 코드에 대해 단정하지 않는다. 확인 못 한 것은
  "확인 필요"로 명시한다.
- IMPORTANT: 모든 주장에 근거 유형을 붙인다 — [증거: 파일:라인] 또는 [추론].
- IMPORTANT: 루트 진행자는 질문 범위, 근거 확인, 가설 비교, 최종 종합을 소유한다. 각 추적은
  경쟁 가설·독립 코드 경계, 필요한 전문성·fresh context, 로그·호출 경로 탐색의 노이즈를
  보고 직접 수행하거나 읽기 전용 역할에 맡긴다.

<!-- GDM_TARGET_FRAGMENT_V1:delegation -->

## 선택형 코드 그래프 내비게이션

`GRAPH_NAV_PROVIDER: env:GDM_GRAPH_PROVIDER`, `COMPANION_TOOL_POLICY: optional`이다. 로그·스택
트레이스와 로컬 검색으로 entry를 먼저 고정한 뒤, 간접 호출 경로나 경쟁 가설의 코드 경계가
불명확할 때만 쓴다. `dependencies`는 entry가 의존하는 방향, `dependents`는 entry에 의존하는
영향 방향이다. 현재 Git root와 repository-relative entry 하나를 고정하고 질문을 가르는 데
필요한 가장 작은 `maxDepth`를 1부터 5 사이에서 고른다.

`GDM_GRAPH_PROVIDER`는 인자가 섞이지 않은 절대 실행 파일 경로 하나여야 한다. 경로가 유효하면
`"$GDM_GRAPH_PROVIDER" query`에 다음 v1 request object를 JSON stdin으로 전달한다.

```json
{"schemaVersion":"gdm-graph-query/v1","root":"/absolute/git/root","entry":"repo/relative/file.ts","direction":"dependencies","maxDepth":1}
```

`direction`은 `dependencies|dependents`, `maxDepth`는 정수 1..5만 허용한다. 호출자는 환경변수
값을 공백으로 나누거나 command string으로 다시 파싱하지 않고 실행 파일 경로 한 개와 `query`
인자를 고정한다. terminal tool이 command string 인터페이스만 제공하면 위처럼 변수를 한 토큰으로
quote한다. `sh -c`, `zsh -lc`, `eval`, command string parsing은 금지한다. caller-side 제한은
10초이며 terminal tool의 timeout을 사용하고 shell `timeout` wrapper는 쓰지 않는다.

성공 출력은 `"schemaVersion":"gdm-graph-result/v2"`와 `provider`, `entry`, `direction`,
`nodes[{path,depth}]`, `edges`, `candidateTests`, `unresolved`, `limitations`,
`coverage{scope,requestedMaxDepth,completeWithinRequestedDepth,frontier,incompleteReasons}`,
`freshness{algorithm,consistent,visitedFiles}`, `truncated`를 가진 JSON object여야 한다.
`coverage.scope`는 요청한 root·entry·direction·depth 안의 bounded coverage를 뜻하며 저장소 전체의
완전성을 뜻하지 않는다. provider가 미설정이거나 값이 인자 없는 절대 경로
하나가 아니거나 경로가 missing·실행 불가인 경우, 프로세스가 non-zero로 끝나거나
crash·timeout인 경우, 출력이 malformed JSON·schema mismatch인 경우, 또는 결과가 stale이거나
`freshness.consistent=false`인 경우에는 결과 전체를 버리고 Read/Glob/Grep로 폴백해 실제 소스를
직접 읽는다.

`limitations`의 capability 설명만 있다는 이유로 정상 결과를 실패로 바꾸지는 않는다. 다만
요청 자체가 지원 범위 밖이거나 `coverage.completeWithinRequestedDepth=false`, `truncated=true`,
관련 `unresolved`, parse error처럼 이번 순회가 partial·unsupported임을 알리는 항목이 있으면
반환된 경로는 추가로 열어볼 navigation hint로만 쓸 수 있다. 그 경우 기존 Read/Glob/Grep 탐색도
반드시 수행해 누락을 보완하며, 빈 edge나 알려진 edge만으로 영향 범위를 결론내리지 않는다.

반대로 결과가 fresh이고 `coverage.completeWithinRequestedDepth=true`, `truncated=false`이며 관련
`unresolved`가 없으면 repository-wide Read/Glob/Grep 폴백을 수행하지 않는다. 그래도 반환된
`nodes`·`edges`·`candidateTests`의 후보 소스는 직접 열어 확인한다. `coverage.frontier`는 요청한
`requestedMaxDepth` 경계에서 더 이어질 수 있는 노드다. frontier가 있다는 사실만으로 partial인
것은 아니며 저장소 전체의 complete를 뜻하지도 않는다. 질문에 경계 너머가 필요하면 5 이하로
`maxDepth`를 늘려 다시 조회하거나 Read/Glob/Grep로 폴백한다.

정상 결과도 탐색할 파일·심볼·테스트 후보를 주는 navigation hint일 뿐이다. 실제 소스를 직접
열어 확인하기 전에는 가설의 주장이나 증거가 아니다. 그래프 출력만으로 작업 계약의 범위 확장을
정당화하거나 `gdm pass`, `gdm done`, audit 판정을 만들 수 없다. 후보 경로는 아래 절차에서
실제 코드와 로그·실행 프로브로 지지하거나 반박한다.

## 프로세스

0. 로그·스택 트레이스·스크린샷이 함께 주어졌으면 그것이 1차 증거다 — 일반
   탐색 전에 로그가 가리키는 지점(클래스:라인, 쿼리, 요청 경로)에서 추적을
   시작한다.
1. 질문을 검증 가능한 형태로 좁힌다 ("느려요" → 어느 경로가, 어느 조건에서).
2. 실제 코드를 추적하며 경쟁 가설을 세우고, 각 가설의 지지·반박 증거를 찾는다.
3. 가설을 신뢰도 순으로 정리하고, 판별이 안 된 지점에는 "다음에 확인할 것"
   (로그 한 줄, 실행 한 번으로 갈리는 프로브)을 제안한다.

## 출력 형식

결론 먼저: 최유력 설명 한 문단(신뢰도 표기) → 근거(파일:라인 인용) →
경쟁 가설과 배제 이유 → 확인 필요 목록.

## 예시

Bad — 증거와 추론이 섞인 단정 (하지 말 것):

```
DB 커넥션 풀이 부족해서 느린 겁니다. 풀 크기를 늘리세요.
```

코드 어디를 봤는지 없고, 진단이 요청받지 않은 수정 제안으로 건너뛰었다.

Good:

<example>
결론: 통보완료로 안 바뀌는 원인은 상태 전이 조건 누락일 가능성이 높다 (신뢰도: 높음).

근거:
- ReviewService.java:214 — 전이 조건이 REVIEW_TYPE == 'NEW'만 허용 [증거]
- 변경심의(CHANGE)는 이 분기에 걸리지 않아 상태가 접수완료로 남는다 [증거: 216행 else 없음]

경쟁 가설: 프론트 캐시 문제 — 배제. 응답 JSON에도 접수완료로 내려옴 [증거: 로그 첨부 경로]

확인 필요: CHANGE 타입의 의도된 전이 규칙 (기획 확인 사항)
</example>

<commentary>
주장마다 근거 유형이 붙고, 수정은 제안하지 않았다. 사용자가 "고쳐줘"라고
하면 그때 gdm-go로 넘어간다.
</commentary>
