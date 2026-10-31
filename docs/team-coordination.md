# GDM 팀 작업 조율

GDM은 구현을 나누는 것부터 결과를 검증하고 수락하는 것까지 하나의 Work에 기록한다.
`gdm team`은 작업 소유권과 결과의 장부다. 실제 에이전트 실행은 현재 gid·Codex·Claude 세션의
지원 도구가 맡고, 루트 조율자는 수용 기준·검증·통합·완료를 책임진다. 팀 상태는 정본을 원자적으로
저장한 뒤 진단용 journal을 기록하므로, 중간 종료에도 저장된 필수 task·결과·반려가 정본에 남는다.

## 실행 방식 선택

`gdm-go`와 `gdm-full`은 Work와 check를 만든 뒤 구현 전에 실행 방식을 정한다.
독립적으로 검증할 경계가 둘 이상이거나, 모듈을 가로지르는 변경이거나, 별도 조사·구현·리뷰가
실질적인 이득을 주는 작업은 중간 이상이다. 쓰기 위임을 지원하는 대상에서는 `coordinated`를
사용하고 구현을 워커에게 배정한다. 루트는 제한된 연결·충돌 수정을 할 수 있지만, 통상 구현을
전부 수행한 뒤 리뷰만 요청하는 것으로 조율을 대신하지 않는다.

| 대상·작업 | 방식 | 역할 |
|---|---|---|
| Codex·Claude의 중간 이상 작업, 쓰기 위임 지원 | `coordinated` | 워커가 분리된 구현을 맡고 루트가 수집·검증·통합 |
| 작고 순차적인 변경 | 구체적인 `--reason`이 있는 `single` | 불필요한 분할 없이 구현·검증 |
| 쓰기 위임을 지원하지 않는 세션 | capability 이유가 있는 `single` | 실제 지원되는 도구 안에서 진행 |

```sh
gdm team configure --slug team-change --mode coordinated --max-active 3
```

`coordinated`의 활성 task 한도는 기본 3, 범위 1~4다. 보통 2~3명의 워커로 충분하다. 워커 수를
채우려는 분할은 하지 않으며 실제로 독립된 경계와 자원 예산으로 정한다. `single`은 기본·최대
1개의 활성 task를 허용한다. 대상의 더 낮은 제한도 함께 지킨다. 무거운 빌드와 통합 테스트는
루트가 직렬화한다. `--session <id>`는 실제 현재 루트 세션 ID를 알고 있을 때만 추가한다.
ID를 임의로 만들지 않는다. 새 세션에서 재개할 때는 active task가 없는 상태에서 실제 새
`--session`과 구체적인 `--reason`으로 인계를 기록한다. active task가 남아 있으면 인계가 거부된다.

```sh
gdm team configure --slug typo-fix --mode single \
  --reason '한 파일의 오타 수정으로 독립 구현 경계가 없다'
```

## 소유 범위와 수용 기준 등록

각 task에는 역할, 소유 경로, 읽기/쓰기 접근, 산출물, 수용 기준, 기존 check를 지정한다.
경로와 check는 반복할 수 있다. 선행 task를 먼저 등록하고 `--depends-on`으로 연결한다.
선행 task가 현재 증거로 수락돼야 후속 task를 claim할 수 있다. 후속 attempt는 그 시점의 선행
attempt와 결과에 묶인다. 선행 task를 재시도하면 후속 수락도 낡아지므로 해당 후속 task를
명시적으로 반려·재시도한다.

아래 예시는 `team-change` Work와 의미 있는 검증 명령을 가진 `c1`, `c2`가 이미 등록된 경우다.

```sh
gdm team add --slug team-change --task team-core --role implementation \
  --path src/runtime/team.rs --access write \
  --deliverable '팀 상태 전이 구현과 변경 요약' \
  --acceptance '미수락 task는 완료를 막고 실제 검증 후에만 수락된다' --check c1
gdm team add --slug team-change --task team-docs --role documentation \
  --path docs/team-coordination.md --access write \
  --deliverable 'CLI와 대상별 한계를 설명한 문서' \
  --acceptance '명령과 제한이 실제 CLI 계약과 일치한다' --check c2
```

CLI는 활성 task 사이의 읽기/쓰기 또는 쓰기/쓰기 경로 겹침을 거부한다. 읽기/읽기는 가능하다.
이 검사는 OS 파일 잠금이 아니므로 워커에게 다른 작업자가 있음을 알리고, 다른 사람의 변경을
되돌리지 않도록 명시한다. 처음 claim한 뒤 task의 범위·수용 기준은 바꾸지 않는다.
새 경계가 필요하면 먼저 작업 계약과 검증 계획을 정리하고 별도 task를 추가한다.

## 실행, 결과 제출, 수락

1. spawn 전에 소유권을 claim한다. 아직 알 수 없는 공급자 runtime ID 대신 논리 assignee를
   사용하고 attempt ID는 Work 전체에서 유일하게 정하며 과거 ID를 재사용하지 않는다.

   ```sh
   gdm team claim --slug team-change --task team-core \
     --assignee worker-team-core-a1 --attempt team-core-a1
   ```

2. 현재 대상의 위임 도구에 Work slug·task·assignee·attempt, 소유 경로, 산출물, 수용 기준,
   검증과 종료 조건을 전달한다. 워커가 작업/check 완료를 스스로 부여하게 하지 않는다.
   Codex의 기존 envelope에는 새 필드를 추가하지 않는다. 실행별 논리 ID를 `taskId`에 쓰고,
   기존 `deliverable` 또는 `verify` 문자열에 Work와 attempt 정보를 포함한다. retry는 새
   attempt와 새 실행 ID를 쓴다. 기존 quota·depth·ownership 계약은 그대로 적용한다.

3. 실제 변경·확인 결과·남은 문제를 로컬 산출물로 저장하고 report한다. 산출물은 저장소 안의
   상대 경로에 있는 비어 있지 않은 UTF-8 일반 파일이어야 하며 최대 1 MiB다. CLI가 해시를
   기록하고 시도별 원문 사본도 CLI가 보관한다. 재시도에서 원본 파일을 덮어써도 이전 시도의
   사본은 유지되며, 현재 결과를 수락할 때는 원본과 사본의 해시를 모두 확인한다.
   수동 산출물은 허용된 별도 경로에 저장하고 `.gdm` 상태 파일은 직접 수정하지 않는다.

   ```sh
   gdm team report --slug team-change --task team-core --attempt team-core-a1 \
     --outcome completed --summary '상태 전이 구현, 검증 결과와 남은 한계 기록' \
     --artifact artifacts/team/team-core-a1.md
   ```

   outcome은 `completed|failed|cancelled|inconclusive`다. spawn 실패도 실패 원인을 파일에
   남기고 `failed`로 report해 active claim을 닫는다. stop, timeout, 빈 응답을 completed로
   바꾸지 않는다. 같은 attempt의 확정 report는 덮어쓰지 않는다.
   모든 인자와 privacy 검사는 보관 파일을 만들기 전에 끝낸다. 저장 중 중단돼 보관 파일만 남은
   경우에는 같은 attempt의 명시적 재보고로 복구할 수 있다. 정본에 확정된 report는 바뀌지 않는다.

4. 루트가 실제 diff와 산출물을 읽고 수용 기준을 대조한다. 연결된 check를 `gdm pass`로 증명한
   뒤 수락 또는 반려한다. 단순히 요청했다는 사실이나 워커의 성공 문장은 검증이 아니다.

   ```sh
   gdm pass c1 --slug team-change
   gdm team review --slug team-change --task team-core --attempt team-core-a1 \
     --decision accept --reason '실제 변경과 결과를 대조했고 연결 검증을 통과했다'
   ```

   review와 retry는 현재 `--attempt`를 필수로 받는다. 늦게 도착한 이전 attempt 요청은 거부돼
   새 attempt의 결과나 상태를 바꾸지 못한다. accept는 completed 결과, 변하지 않은 산출물,
   증명된 연결 check가 있어야 가능하다.
   결과나 연결 검증이 바뀌어 수락이 낡아지면 새 근거를 확인하고 다시 review한다. 산출물 자체를
   고쳐야 하면 이전 결과를 반려하고 새 attempt로 제출한다. 검증 기준을 낮춰 수락하지 않는다.

5. 실패·취소·불확정 결과나 반려는 이유를 기록하고 retry한다. 문제와 새 접근을 정한 뒤 다시
   claim한다. retry에는 종료할 현재 attempt ID를, 이어지는 claim에는 새 attempt ID를 넣는다.
   중단된 실행을 자동 성공으로 바꾸는 복구 경로는 없다.

   ```sh
   gdm team review --slug team-change --task team-core --attempt team-core-a1 \
     --decision reject --reason '실패 상태의 완료 차단 근거가 부족하다'
   gdm team retry --slug team-change --task team-core --attempt team-core-a1 \
     --reason '실패 상태 검증과 결과 산출물을 보완한다'
   gdm team claim --slug team-change --task team-core \
     --assignee worker-team-core-a2 --attempt team-core-a2
   ```

공유 기억은 Work의 task·attempt·report·review와 로컬 산출물이다. 전체 대화를 모든 워커에게
반복 전달할 필요는 없다. `--tokens <n>`와 `--elapsed-ms <n>`는 report에 선택적으로 붙이는
보고값이다. 자동 측정값, 실제 원격 모델 신원, 구독 요금을 증명하지 않는다.

## 요구 변경으로 불필요해진 작업 철회

작업이 필요 없어졌다면 완료했다고 보고하지 말고 이유와 함께 철회한다.

```sh
gdm team withdraw --slug team-change --task unused-task \
  --reason '요구 변경으로 이 작업은 더 이상 필요하지 않다'
gdm team withdraw --slug team-change --task cancelled-task --attempt cancelled-a1 \
  --reason '중단 결과를 확인했고 해당 요구가 철회됐다'
```

아직 claim하지 않은 pending task에는 attempt를 생략한다. 실행 이력이 있으면 최신 attempt를
반드시 지정한다. active task는 먼저 실제 실행을 중단하고 cancelled 결과를 보고해야 한다.
이 작업에 의존하는 미철회 task가 있으면 먼저 종속 작업을 정리한다. 철회는 이력과 이유를
보존하며, 기존 ID를 다시 활성화하거나 성공한 결과로 바꾸지 않는다. 새 요구에는 새 task를 만든다.
철회된 task는 팀 완료를 막지 않지만 Work의 필수 요구·check는 여전히 검증해야 한다.

검토 중인 Work는 check나 상류 수락이 낡아도 `protocol export`로 검토 자료를 전달할 수 있다.
완료 상태는 blocked로 남으며 `gdm done`의 검증 기준은 유지된다. 이미 수락한 산출물이나
증거가 누락·변조된 경우에는 export도 거부한다. 새 팀 문구는 export와 같은 자격증명 검사를
저장 전에 수행하며, 과거 기록에 민감한 값이 있다면 이력 파일을 수동 수정하지 않는다.

## 계속 진행하고 완료하기

```sh
gdm team status --slug team-change --json
gdm team next --slug team-change --json
```

`next`는 현재 필요한 행동을 제안한다. 팀 설정 전에는 `configure`를 안내한다.

| 행동 | 루트의 다음 작업 |
|---|---|
| `review` | 결과·실제 변경·연결 증거를 확인해 수락 또는 반려 |
| `retry` | 실패 원인과 새 접근을 기록하고 다시 배정 |
| `dispatch` | 준비된 task를 claim한 뒤 지원되는 위임 도구로 실행 |
| `wait` | 지원되는 mailbox/event로 결과를 기다린 뒤 `next`를 다시 확인 |
| `validate` | 모든 수락과 사용자 목표를 확인하고 기존 완료 게이트 실행 |

active·미수락·실패 task를 남긴 채 최종 응답으로 조율을 끝내지 않는다. 모든 task가 수락돼도
`validate`는 완료 판정이 아니다. `gdm done`이 성공해야 검증 완료이며, full의 다른 실제 모델에
의한 독립 audit와 전달 승인은 별도로 유지한다. full의 제품 변경은 기록된 하나의 실제 구현
모델이 작성하며 조율자가 제품 파일을 직접 고치는 경우에도 같은 조건이 적용된다.

`gdm team`은 에이전트를 자동 spawn하는 실행기나 종료 후에도 도는 데몬이 아니다. 실제로
지원되는 활성 host의 결과 수신과 hook continuation hint만 사용한다. 세션이 끝났다면 다음
세션이 Work를 읽고 명시적으로 재개해야 한다. Codex의 lifecycle 관찰도 산출물 수락과 별개다.
Claude에 없는 hook이나 자동 깨우기를 가정하지 않는다. 팀 기록은 새 권한이나 도구를 부여하지
않으며 기존 읽기 전용 전문 역할 runner의 보안 계약도 바꾸지 않는다.
