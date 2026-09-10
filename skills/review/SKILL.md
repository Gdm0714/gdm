---
name: gdm-review
description: |
  diff를 읽기 전용으로 리뷰해 결함을 찾는다. 커버리지 우선 — 확신이 낮아도 신뢰도를
  붙여 보고하고, 걸러내기는 사람이 한다. 사용자가 "$gdm-review", "리뷰해줘",
  "이 변경 문제 없나 봐줘"라고 할 때 사용한다.
---

# gdm:review — 결함 탐색 리뷰

## 역할

변경 diff에서 실제 결함을 찾는 읽기 전용 리뷰어. 판정이 아니라 발견이 임무다.

## 제약

- NEVER: 코드를 수정하지 않는다. 수정은 사용자가 요청할 때 별도 작업으로 한다.
- NEVER: 발견을 스스로 걸러 보고를 줄이지 않는다. 확신이 낮으면 신뢰도를 낮게
  표기해 보고한다 — 침묵으로 버려진 발견은 검증 기회조차 없다.
- NEVER: diff에 없는 줄을 인용하지 않는다. 모든 발견은 파일:라인으로 고정한다.
- IMPORTANT: 스타일 취향은 결함이 아니다. 보고 기준은 "잘못된 동작, 테스트 실패,
  오해를 부르는 결과를 만들 수 있는가"다.

## tuicr 공유 리뷰 화면

`HUMAN_REVIEW_PROVIDER: tuicr`, `COMPANION_TOOL_POLICY: optional`로 라우팅한다. 시작할 때
사용자가 직접 변경을 보고 코멘트하려는 **사용자 주도 리뷰**인지, 에이전트에게 결함 탐색을
맡긴 **에이전트 주도 리뷰**인지 먼저 구분한다.

- 사용자 주도 리뷰: 관련 활성 tuicr 세션에 attach한다. 세션이 없고 tmux·Zellij·Herdr를
  사용할 수 있으면 설치된 tuicr 스킬의 `tuicr-wrapper.sh`, `tuicr-wrapper-zellij.sh`,
  `tuicr-wrapper-herdr.sh` 중 환경에 맞는 wrapper로 pane을 연다. 사용자가 코멘트를 마쳤다고
  하거나 명시적으로 기다리라고 한 경우 `tuicr review comments`를 읽는다. 사용자 코멘트를
  에이전트가 대신 만들거나 자기 리뷰 결과로 바꾸지 않는다.
- 에이전트 주도 리뷰: tuicr가 있으면 shared diff surface로 열거나 기존 활성 세션에 attach할
  수 있지만, 아래의 읽기 전용 runtime·edge·반증 pass가 판정 정본이다. 발견을 tuicr에 쓰는
  것은 사용자가 명시적으로 요청했을 때만 허용하며 `tuicr review add --username "<실제 검토자>"`로
  작성자를 구분한다. 승인 없이 사용자 코멘트인 것처럼 기록하지 않는다.
- tuicr나 multiplexer가 없거나 비대화형 환경이면 기존 텍스트 리뷰로 폴백하고 알린다.
  gdm이 자동 설치하지 않으며, tuicr는 gdm-full의 독립 auditor를 대신하지 않는다.

## 선택형 코드 그래프 내비게이션

`GRAPH_NAV_PROVIDER: env:GDM_GRAPH_PROVIDER`, `COMPANION_TOOL_POLICY: optional`이다. 실제 diff와
변경 파일을 먼저 읽은 뒤, 변경된 entry의 호출자·의존자·후보 테스트 영향 경계가 불명확할 때만
쓴다. `dependencies`는 entry가 의존하는 방향, `dependents`는 entry에 의존하는 영향 방향이다.
현재 Git root와 repository-relative entry 하나를 고정하고 질문을 가르는 데 필요한 가장 작은
`maxDepth`를 1부터 5 사이에서 고른다. 그래프 결과만 보고 diff 밖 결함을 확정하지 않는다.

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
열어 확인하기 전에는 finding이나 증거가 아니다. 그래프 출력만으로 작업 계약의 범위 확장을
정당화하거나 `gdm pass`, `gdm done`, audit 판정을 만들 수 없다. 후보는 아래의 runtime·edge·
반증 pass에서 실제 diff 줄, 호출자, 테스트, 재현 명령으로 확인한다.

## 프로세스

워커 배정: 루트 진행자는 범위·불변식·중복 제거·반증·최종 보고를 소유한다. 각 리뷰 pass는
크기만으로 실행 주체를 고정하지 않고, 독립 호출 경로나 runtime·edge·test/docs 관점,
필요한 전문성·fresh context, 추적 출력의 노이즈를 보고 직접 수행하거나 읽기 전용 역할에
맡긴다. 각 워커는 구체적인 관점·코드 경계·종료 조건과 실제 diff·증거를 받아 후보를 반환한다.

<!-- GDM_TARGET_FRAGMENT_V1:delegation -->

1. 실제 리뷰 대상 diff와 gdm 증거를 직접 읽고, 작업 목표와 반드시 지켜야 할 불변식을
   한 줄씩 고정한다. 실행자의 요약만으로 범위를 정하지 않는다.
2. runtime pass — 변경된 줄과 실제 호출 경로에서 상태 전이, 오류 처리, 부작용을 추적한다.
3. edge pass — 경계값, null/빈값, 재실행, 동시성, 개인정보·경로·권한 실패를 추적한다.
4. 각 후보를 호출자·테스트·재현 명령으로 반증해 다음 중 하나로 분류한다.
   - `confirmed`: 구체적인 실패 시나리오와 증거가 있는 결함
   - `duplicate`: 이미 확인된 같은 원인·수정 지점에 포함되는 후보
   - `rejected`: 반증됐거나 코드 근거가 없는 후보
5. confirmed 후보마다 심각도(Critical/Major/Minor) + 신뢰도(높음/중간/낮음) + 실패
   시나리오("어떤 입력/상태에서 → 무엇이 잘못되는가")를 붙인다.
6. confirmed에서 새로운 결함 유형이나 영향 경로가 나왔을 때만 그 경로를 한 번 확장한다.
   전체 pass 한 번에서 새 confirmed 유형이 나오지 않으면 탐색을 끝낸다.

## 출력 형식

결론 먼저: `confirmed n / duplicate n / rejected n`과 심각도 합계를 한 줄로 쓴 뒤
confirmed를 심각도순으로 보고한다. duplicate/rejected는 짧은 근거와 연결 대상을 남긴다.

```
[Critical|높음] 파일:라인 — 한 줄 요약
  시나리오: <입력/상태> → <잘못된 결과>
```

발견 없으면 "결함 발견 없음"과 함께 어디까지 봤는지(훑기 범위)를 명시한다.

## 예시

Bad — 확신이 없어서 침묵 (하지 말 것):

```
(내심: 이 null 체크가 없는 게 문제일 수도 있는데... 확실하지 않으니 넘어가자)
발견 없음.
```

낮은 확신은 낮은 신뢰도로 보고하면 된다. 침묵은 검증 기회를 없앤다.

Good:

<example>
[Major|중간] src/download.ts:142 — 제한값 0을 "무제한"으로 처리
  시나리오: 관리자가 제한을 0으로 설정 → falsy 체크에 걸려 기본값 대신
  무제한 다운로드 허용 → 대용량 요청이 제한 없이 통과
</example>

<commentary>
확신이 완전하지 않아도(중간) 구체적 시나리오와 함께 보고했다. 판단은
사용자가 한다.
</commentary>
