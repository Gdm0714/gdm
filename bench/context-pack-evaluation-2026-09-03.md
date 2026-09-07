# Context Pack 도입 근거와 E2E token 비교 — 2026-09-03

## 결정

Context Pack one-shot provider는 **bounded navigation으로 최종 품질을 유지하면서 fresh input token을 줄일 가능성**을 확인하기 위해 도입하고 개선한다. 첫 receipt-bound E2E smoke에서 Context arm의 fresh input token이 Control과 Graph보다 적은 방향이 관찰됐고, Context arm 자체는 6/6 run에서 품질·provider·직접 읽기·anchor-first·command·usage gate를 모두 통과했다.

다만 이 결과를 절감 효과의 확정 증거나 기본 활성화 근거로 사용하지 않는다. 전체 18 run 중 13/18만 measurement-valid였고 세 arm이 모두 valid인 동일 조건은 3쌍뿐이다. 현재 공식 판정은 `invalid-not-evidence`이며 P2, SQLite, Pi 자동 주입과 기본 활성화는 계속 차단한다.

## 왜 도입했는가

기존 탐색은 모델이 넓은 후보를 검색하고 여러 파일을 읽으면서 fresh input token을 반복 소비한다. Context Pack은 같은 문제를 최대 4 KiB의 결정적 navigation hint로 먼저 좁혀, 실제 근거 파일을 직접 읽는 원칙은 유지하면서 불필요한 입력을 줄일 수 있는지 검증하기 위한 기능이다.

도입 이유는 “Context Graph가 좋아 보인다”는 추측이 아니라 아래의 실제 방향성 수치다. 향후 ranking, seed, budget, edge 종류를 개선할 때도 **같은 품질에서 fresh input token이 줄어드는가**를 판단 기준으로 삼는다.

## 공식 run

- protocol: `allowlisted-io-receipts/v2`
- run ID: `0a5d55558621dcdd3a4ddc898f34c21f`
- model: `gpt-5.6-sol`, reasoning `xhigh`
- 구성: 2 tasks × 3 arms × 3 trials = 18 runs
- Context Pack 크기: ownership 830 bytes, budget 1,082 bytes
- 원시 결과: `bench/context-pack-e2e/results/runs/0a5d55558621dcdd3a4ddc898f34c21f/summary.json`
- immutable pointer: `bench/context-pack-e2e/results/current-v2.json`

`fresh input`은 각 run의 `inputTokens - cachedInputTokens`로 기록된 값이다. 아래 중앙값은 run별 fresh input을 먼저 계산한 뒤 구했으므로 total input 중앙값에서 cached input 중앙값을 빼서 재구성하지 않는다.

## 전체 run의 관찰값

각 arm의 6회를 성공 여부와 무관하게 그대로 포함한 단순 중앙값이다.

| Arm | run | valid | total input 중앙값 | cached input 중앙값 | fresh input 중앙값 | output 중앙값 |
|---|---:|---:|---:|---:|---:|---:|
| Control | 6 | 4 | 144,652.5 | 107,136 | **36,771** | 1,066 |
| Graph | 6 | 3 | 169,863.5 | 142,656 | **27,910** | 1,414 |
| Context | 6 | 6 | 132,521 | 110,208 | **22,441** | 1,230 |

명목상 Context fresh input 중앙값은 다음과 같이 작았다.

- Control 대비 14,330 tokens, **39.0% 감소**
- Graph 대비 5,469 tokens, **19.6% 감소**

이 계산에는 measurement-invalid run 5개가 포함되므로 효과 추정치가 아니라 raw 관찰값이다.

## 동일 조건에서 세 arm 모두 valid인 3쌍

유효하지 않은 arm만 골라 버리는 선택 편향을 줄이기 위해, 같은 task·trial의 세 arm이 모두 valid인 경우만 나란히 놓았다.

| Task / trial | Control fresh input | Graph fresh input | Context fresh input | Context vs Control | Context vs Graph |
|---|---:|---:|---:|---:|---:|
| budget / 3 | 37,606 | 23,092 | **19,758** | -47.5% | -14.4% |
| ownership / 1 | **26,148** | 38,591 | 27,036 | +3.4% | -29.9% |
| ownership / 3 | **18,952** | 27,961 | 22,499 | +18.7% | -19.5% |
| **중앙값** | **26,148** | **27,961** | **22,499** | **-14.0%** | **-19.5%** |

동일 valid 3쌍의 중앙값에서 Context는 Control보다 3,649 tokens, **14.0% 감소**했고 Graph보다 5,462 tokens, **19.5% 감소**했다.

반면 ownership 두 쌍에서는 Context가 Control보다 각각 3.4%, 18.7% 더 사용했다. budget 한 쌍의 큰 감소가 전체 방향에 영향을 주므로 태스크 수를 늘리기 전에는 일반화하지 않는다.

## 유효성 경계

- Context: 6/6 valid
- Control: 4/6 valid
- Graph: 3/6 valid
- 전체: **13/18 valid**
- invalid 5개 중 4개는 quality recall 0.9375, 1개는 Graph provider·anchor·command 계약 실패였다.
- assessor는 모든 run의 품질·측정 gate가 통과할 때만 arm 중앙값을 공식 token evidence로 채택한다. 따라서 공식 결론은 `invalid-not-evidence`다.

숫자는 “Context Pack 개선을 계속 측정할 이유”로 보존한다. “token 절감이 입증됐다”, “기본 활성화해도 된다”, “다른 저장소에서도 같은 비율로 줄어든다”는 결론으로 확대하지 않는다.

## 향후 개선의 판단 기준

Context Pack의 ranking, query term, node·edge 종류, byte budget 또는 호출 경계를 바꿀 때 다음을 이 기록과 비교한다.

1. 같은 task·model·reasoning·anchor·직접 읽기 정책에서 비교한다.
2. quality recall 1.0과 provider·direct-read·anchor-first·command·usage gate를 모두 통과한 paired run만 효과 판정에 쓴다.
3. Context Pack은 4 KiB 이하 one-shot navigation hint로 유지하고 최종 근거 파일은 직접 읽는다.
4. fresh input token뿐 아니라 품질, output token, command 수와 지연시간의 회귀도 함께 본다.
5. 확대 benchmark와 독립 audit 전에는 P2, SQLite, Pi 자동 주입과 기본 활성화를 승인하지 않는다.

이 기준에서 반복 감소가 재현되지 않으면 기능을 유지해야 할 이유도 다시 검토한다.
