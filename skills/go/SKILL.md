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
| `gdm plan init --slug <s> --brief <설명>` | 작업 시작 |
| `gdm plan add --desc <항목> --cmd <검증 명령> --expect <기대> [--manual]` | 항목 등록 |
| `gdm plan list` | 항목/상태 확인 |
| `gdm plan edit --check <id> [...] --reason <사유>` | 항목 조정 (사유 필수) |
| `gdm pass <id>` | 자동 항목 통과 — gdm이 cmd를 직접 실행·저장·해시하고 exit 0일 때만 통과 |
| `gdm pass <id> --manual --observed <파일>` | 수동 항목 통과 — 스크린샷 등 확인 기록 제출 |
| `gdm done` | 완료 — 전 항목 통과 + 증거 파일 현존·해시 재검증 후에만 exit 0 |
| `gdm resume` | 중단된 작업 상태 복원 |

## 프로세스

1. 요청을 한 문단으로 요약해 `gdm plan init --slug <kebab-슬러그> --brief "<요약>"`.
2. 작업을 검증 항목으로 분해해 `gdm plan add`로 등록한다. 각 항목은
   "무엇을(desc) / 어떤 명령이 성공하면 통과이고(cmd) / 그때 무엇이 관찰되는가(expect)"가
   명확해야 한다. UI처럼 수동 확인만 가능한 항목은 `--manual`.
   등록 후 `gdm plan list` 출력을 사용자에게 보여준다.
3. 반복:
   a. 미통과 항목 하나를 골라 구현한다.
   b. `gdm pass <id>` — gdm이 cmd를 실행해 출력을 저장하고 판정한다.
   c. 실패(exit≠0)하면 출력을 읽고 구현을 고쳐 b로 돌아간다. cmd 출력은
      `.gdm/<슬러그>/out/<id>.txt`에 남아 있다.
   d. 수동 항목은 확인 기록(스크린샷 등)을 파일로 저장한 뒤
      `gdm pass <id> --manual --observed <경로>`.
4. 전 항목 통과 후 `gdm done`. 성공한 경우에만 완료를 보고한다.
5. 새 세션에서 이어받으면 먼저 `gdm resume`으로 상태를 복원한다.

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
1. `gdm plan init --slug excel-limit --brief "엑셀 다운로드 기본 제한 50만 건으로 변경"`
2. check 등록:
   c1 "설정값 변경" (cmd: grep -q "DEFAULT_LIMIT = 500_000" src/config.ts)
   c2 "단위 테스트 통과" (cmd: ./gradlew test --tests '*Excel*')
   c3 "50만 초과 요청 시 안내 응답" (cmd: curl -sf .../download?rows=600000 | grep -q "제한")
3. 구현 → `gdm pass c1` → `gdm pass c2` → `gdm pass c3` → `gdm done`
4. "완료: 기본 제한이 50만 건으로 변경됐고 3개 항목이 전부 실행 증거로 통과했습니다.
   요약: .gdm/excel-limit/work.md"
</example>

<commentary>
완료 선언이 gdm done 성공 뒤에만 나오고, 증거는 gdm이 직접 실행해 만들었으므로
지어낼 수 없다. 모델의 역할은 cmd가 성공하도록 구현을 고치는 것뿐이다.
</commentary>
