# Astra instruction ablation

현재 설치된 gdm-go와 후보 지침을 `gpt-6-astra`, `xhigh`로 비교한다. 제품 소스와 설치된 스킬은 변경하지 않는다.

- `current`: 현재 설치본 전문.
- `ondemand`: 단일 로컬 함수 구현에 쓰이지 않는 adapter, Work lifecycle, native delegation, 웹 검증, 도메인 설명과 일반 실행 예시를 분리한다. 실행·증거·완료 게이트와 기존 검사 정책은 유지한다.
- `calibrated`: ondemand에 검사 수 유연화, 복잡성 위험이 있는 변경에만 static 증명, 반복 실패나 adopted habit이 있을 때만 회고, 필요한 검증 후 중단 기준을 적용한다.

기술 설계자 선택, 다중 모델 검수, 브라우저, 멀티 에이전트 성능은 이 실험의 측정 범위가 아니다.

```bash
python3 bench/astra-ablation/run.py             # 모델 호출 없이 manifest와 프롬프트 준비
python3 bench/astra-ablation/run.py --execute   # 3 tasks × 3 arms × 2 trials, 직렬
python3 bench/astra-ablation/assess.py          # 원시 결과의 완료·증거를 독립 재구성
python3 bench/astra-ablation/summarize.py       # 개별값과 세 arm 모두 유효한 묶음의 비교
bun bench/astra-ablation/contract-probe.ts      # 실제 관찰된 자연어 계약 거부 재현
```

각 실행은 새 로컬 Git fixture와 ephemeral CLI session을 사용한다. 모델·추론 강도·CLI·gdm 실행 파일, fixture commit, brief·hidden test·prompt SHA-256을 고정한다. arm 선행 순서를 task별로 회전하고 trial 2에서는 역순으로 실행한다. 숨긴 테스트는 모델 실행이 끝난 다음에만 workspace에 복사하여 채점하고 즉시 제거한다. 원래 visible test 보존도 검사한다. hidden test의 파일시스템 접근을 OS 수준으로 완전히 차단한 실험은 아니며, raw command trace에서 접근 위반을 별도로 확인해야 한다.

주 지표는 숨긴 테스트와 원래 테스트 통과, 원래 테스트 보존, 실제 gdm 완료와 증거 일치다. 부 지표는 시간, total/cached/fresh input, output, 명령 수와 check 수다. `fresh input = input_tokens - cached_input_tokens`이며 가격·cache write를 반영한 실제 청구액은 아니다. timeout과 실패는 제외하거나 성공 실행으로 교체하지 않는다.

3개의 작은 재사용 과제여서 정확도 만점의 천장 효과가 예상된다. 반복 2회와 비용 감소만으로 대규모 작업의 품질 비열등성이나 특정 모델에만 있는 효과를 주장하지 않는다. calibrated는 여러 정책을 함께 바꿨으므로 개별 규칙의 인과 효과를 분리하지 못한다.

실행 디렉터리는 `latest-run.txt`에 기록한다. manifest, 프롬프트 전문과 diff, invocation, raw JSONL, 출력, 채점 로그, 구현 diff와 workspace를 보존한다. 최초 배치의 runner는 완료 파일명을 `state.json`으로 잘못 조회했다. `runner-at-start.py`와 raw 결과를 보존하고 `assess.py`가 실제 `checks.json`, 성공한 done 명령, evidence hash로 모든 arm을 동일하게 재채점한다. 실행 프롬프트·시간·usage·hidden test에는 영향이 없다. 완료 여부의 정본은 **assessed.json**이며 최초 runner의 result.json/results.jsonl/summary.json에 있는 success 필드는 사용하지 않는다.

실측 중 DNS 장애·재연결, 모델 목록 갱신 timeout, 파일 시각과 monotonic 타이머의 큰 불일치가 관찰됐다. 이러한 실행과 원래 설치 스킬의 추가 읽기는 측정 유효성과 분리해 기록한다. 중단된 실행은 대체하지 않는다. `infrastructure-abort.json`에는 시간 불일치·정체로 종료한 소유 PID를 기록했다. 배치 중 추가한 idle sleep 억제는 runner PID에 결속되어 종료 시 해제되며 시스템 설정을 영구 변경하지 않는다. `time.monotonic()` 기반 seconds가 시스템 중단을 포함한 실제 경과 시간과 같다고 가정하지 않는다.

이번 설치 gdm은 0.9.1, 저장소 CLI 소스는 0.10.0이다. 스킬 13개는 현재 source renderer와 일치한다. E2E는 실제 설치 binary를 고정했으며, 별도로 실행한 기존 gate 단위 테스트 24개는 저장소 source 대상이다.
