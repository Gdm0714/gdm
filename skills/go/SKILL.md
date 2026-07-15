---
name: gdm-go
description: |
  gdm 하네스의 일상 실행 루프. 작업을 검증 항목(check)으로 분해하고, gdm CLI가
  각 항목의 재현 명령을 직접 실행해 증거(출력 파일 + 해시 + exit code)를 만들며,
  전부 통과해야만 완료를 선언한다. 사용자가 "$gdm-go", "gdm go", "gdm으로 해줘"라고
  하거나, 구현·수정 작업을 완료 보장과 함께 맡길 때 사용한다.
---

# gdm:go — 검증 항목 기반 실행 루프

## 역할

작업을 받아 검증 가능한 확인 항목(check)으로 계획하고, 구현→검증→통과를 반복해서
모든 항목이 증거로 통과된 상태로만 작업을 끝내는 실행자.

## 제약

- NEVER: `.gdm/` 아래 파일을 직접 쓰거나 고치지 않는다. 상태 변경은 gdm CLI로만 한다.
- NEVER: `gdm done`이 성공(exit 0)하기 전에 "완료했다"고 보고하지 않는다.
- NEVER: 이 실행 루프에서 stage, commit, push, PR을 만들지 않는다. `done`은 검증 완료이지
  전달 승인이 아니다.
- NEVER: 통과가 어렵다는 이유로 check의 cmd나 expect를 약하게 고치지 않는다.
  기준 조정이 정말 필요하면 `gdm plan edit --reason`으로 사유를 남긴다
  (통과된 항목을 고치면 통과가 해제되고, 모든 수정·거부는 journal에 기록된다).
- IMPORTANT: cmd는 "기대가 충족될 때만 exit 0"이 되도록 설계한다 — 판정은 gdm이
  exit code로 하므로, 그냥 실행되는 명령이 아니라 검증하는 명령이어야 한다.
  (예: `./gradlew test --tests '*Excel*'`, `grep -q "limit=500000" src/config.ts`,
  `curl -sf localhost:8080/health | grep -q '"status":"UP"'`)
- IMPORTANT: check는 3~7개로 유지한다. 그보다 많으면 작업을 쪼개는 신호다.

## 도구

| 명령 | 용도 |
|---|---|
| `gdm plan init --slug <s> --brief <설명> --require <보존> --forbid <금지>` | 작업 계약과 함께 시작 |
| `gdm plan add --desc <항목> --cmd <검증 명령> --expect <기대> [--manual]` | 항목 등록 |
| `gdm plan list` | 항목/상태 확인 |
| `gdm plan edit --check <id> [...] --reason <사유>` | 항목 조정 (사유 필수) |
| `gdm pass <id>` | 자동 항목 통과 — gdm이 cmd를 직접 실행·저장·해시하고 exit 0일 때만 통과 |
| `gdm pass <id> --manual --observed <파일>` | 수동 항목 통과 — 스크린샷 등 확인 기록 제출 |
| `gdm recheck` | 통과한 자동 항목 전부 재실행 — 회귀 검출, 실패 항목은 open 회귀 |
| `gdm done` | 완료 — 전 항목 통과 + 증거 파일 현존·해시 재검증 후에만 exit 0 |
| `gdm status` | 현재 디렉토리 전체 작업 현황 |
| `gdm resume` | 중단된 작업 상태 복원 |
| `gdm attempt fail ...` | 실패 서명·가설과 한 번의 확인 재시도 기록 |
| `gdm attempt retry ...` | 바뀐 전제와 새 증거가 있을 때만 다음 재시도 허용 |
| `gdm habit harvest --json` | 종료 시 실제 journal 사건을 정규화된 관찰로 수확 |

## 프로세스

순서는 계약(init → add → pass → done)이고, 그 안의 진행 방식은 판단에 맡긴다.

구현 워커: 경량 루프이므로 **조율자(앉은 CLI)가 직접 구현**하는 것이 기본이다 — 매 스텝
headless 위임은 과하다. 특정 항목만 `codex exec`로 위임하는 것은 선택이며, 검수까지 필요한
중량 작업은 gdm-full로 올린다. 라우팅 계약: `skills/_shared/routing.md`.

1. 지속 계획의 작업 계약 초안으로 `gdm plan init --require ... --forbid ...`을 실행한 뒤
   작업을 검증 항목으로 분해해 `gdm plan add`. 좋은 check의
   기준은 하나다 — **cmd가 성공하면 기대가 충족됐다고 믿을 수 있는가.**
   등록한 목록(`gdm plan list`)을 사용자에게 보여준다. 적용할 adopted habit이 있으면
   첫 pass 전에만 `gdm plan contract --slug <슬러그> --activate-habit <id>@<version>`으로 고정한다.
2. 구현하고 `gdm pass <id>`. 실패하면 출력(`.gdm/<슬러그>/out/<id>.txt`)을 읽고
   `gdm attempt fail`로 command/capability·target·error-code·가설을 기록한다. 같은 실패
   서명은 확인 재시도를 한 번만 허용한다. 다시 실패하면 그대로 반복하지 말고,
   전제가 실제로 바뀐 경우에만 새 contained evidence와 함께
   `gdm attempt retry --changed <종류> --evidence <파일>`로 다음 epoch를 연다.
   수동 항목은 확인 기록을 저장한 뒤 `--manual --observed <경로>`.

   ```text
   gdm attempt fail --slug <s> --attempt-id a1 --command <id> --target <id> --error-code <id> --hypothesis <가설>
   gdm attempt retry --slug <s> --attempt-id a2 --fingerprint <첫 명령이 출력한 fingerprint>
   gdm attempt fail --slug <s> --attempt-id a3 --command <id> --target <id> --error-code <id> --hypothesis <확인 결과>
   gdm attempt retry --slug <s> --attempt-id a4 --fingerprint <fingerprint> --changed <종류> --evidence <파일>
   ```
3. 여러 항목·여러 파일을 고쳤으면 done 전에 `gdm recheck`.
4. `gdm done` 성공 뒤 `gdm habit harvest --json`을 정확히 한 번 실행해 이번 작업의
   반복 사건을 수확하고, 적용한 habit이 있으면 `ineligible|skipped|clean|recurred` 중
   실제 결과를 `gdm habit evaluate`로 기록한다. 새 후보 검토가 필요하면
   `gdm-reflect`를 안내하되 자동 채택하지 않는다.
5. 이 피드백 checkpoint까지 끝난 뒤에만 완료를 보고한다. 재개는 `gdm resume`. 완료 이후
   이 작업에서 결함이 발견되면 `gdm miss --desc ... --type ...`으로 기록한다
   — 게이트 개선(retro --all)의 입력이 된다.

## 작업 유형별 관행 (실사용 빈도 기반)

- **UI 변경** (스크린샷 확인이 관행인 작업): manual 항목의 증거는
  `.gdm/<슬러그>/ui/`에 파일로 남긴다. 사용자가 채팅에 이미지를 붙였으면
  파일 경로로 저장해달라고 요청하고, 직접 확인 가능한 환경(시뮬레이터,
  스크린샷 도구)이면 직접 찍는다. 문답으로만 확인된 경우 확인 내용·시각을
  텍스트 파일로 기록해 그 파일로 pass 한다.
- **DB 검증**: check의 cmd에 비밀번호·접속 문자열을 인라인으로 쓰지 않는다
  (환경변수·설정 파일 참조). 검증 쿼리는 조회 전용이어야 한다 — 검증 명령이
  데이터를 바꾸면 그것은 검증이 아니라 부작용이다.
- **반복 명령**: 프로젝트 표준 명령(빌드/테스트/실행)은 `gdm preset set`으로
  등록하고 check에서 `@이름`으로 참조한다. 같은 명령을 두 번 타이핑하고 있다면
  프리셋 등록 신호다.

## 엣지 케이스

- check가 잘못 세워졌음이 드러나면: `gdm plan edit --reason`으로 고친다.
  임의로 무시하고 진행하지 않는다.
- 권한·외부 환경 문제로 검증이 불가능하면: 그 항목은 미통과로 남기고 사용자에게
  보고한다. 검증을 우회하려고 `--manual`로 바꾸지 않는다.
- 진행 중 작업이 여러 개라 슬러그가 모호하면: `--slug`를 명시한다.

## 출력 형식

- 진행 중에는 항목 통과 시마다 한 줄(`c2 통과 (2/5)`)만 보고한다.
- 완료 보고는 결론 먼저: 무엇이 어떻게 됐는지 한두 문장 → 항목 표(gdm plan list)
  → 증거 파일 경로. 요약 문서는 `.gdm/<슬러그>/work.md`에 이미 있다.

## 예시

Bad — 통과가 안 되니 기준을 몰래 낮추는 흐름 (거부/기록된다):

```
c2(테스트 통과)가 계속 실패하므로 expect를 "일부 통과"로 바꾸고 진행하겠습니다.
→ gdm plan edit --check c2 --expect "일부 통과"   # --reason 없음 → exit 1
```

기준 완화는 사유 없이는 불가능하고, 사유를 남겨도 journal에 영구 기록되며 사용자에게
보고해야 한다. 올바른 대응은 테스트가 실패하는 원인을 고치는 것이다.

Good:

<example>
사용자: 엑셀 다운로드 기본 제한을 50만 건으로 바꿔줘. $gdm-go

어시스턴트:
1. `gdm plan init --slug excel-limit --brief "엑셀 다운로드 기본 제한 50만 건으로 변경" --require "기존 다운로드 동작 보존" --forbid "자동 커밋"`
2. check 등록:
   c1 "설정값 변경" (cmd: grep -q "DEFAULT_LIMIT = 500_000" src/config.ts)
   c2 "단위 테스트 통과" (cmd: ./gradlew test --tests '*Excel*')
   c3 "50만 초과 요청 시 안내 응답" (cmd: curl -sf .../download?rows=600000 | grep -q "제한")
3. 구현 → `gdm pass c1` → `gdm pass c2` → `gdm pass c3` → `gdm done`
4. `gdm habit harvest --json` → 적용한 habit이 있으면 결과 평가
5. "완료: 기본 제한이 50만 건으로 변경됐고 3개 항목이 전부 실행 증거로 통과했습니다.
   요약: .gdm/excel-limit/work.md"
</example>

<commentary>
완료 선언이 gdm done 성공 뒤에만 나오고, 증거는 gdm이 직접 실행해 만들었으므로
지어낼 수 없다. 모델의 역할은 cmd가 성공하도록 구현을 고치는 것뿐이다.
</commentary>
