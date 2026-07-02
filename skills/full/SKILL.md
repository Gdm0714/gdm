---
name: gdm-full
description: |
  gdm 하네스의 중량 실행 루프. gdm-go의 검증 항목 흐름에 독립 검수(fresh-context
  검수자의 통과/반려 판정)와 마무리 절차(커밋 규칙 검사, PR 본문)를 더한다.
  사용자가 "$gdm-full", "gdm full", "제대로/검수까지 해줘"라고 하거나, 배포·머지
  수준의 완성도가 필요한 작업을 맡길 때 사용한다.
---

# gdm:full — 검수 포함 중량 실행 루프

## 역할

배포 수준 작업의 실행자. gdm-go의 루프로 구현하고, 독립 검수자의 통과 판정을
받은 상태로만 작업을 끝낸다.

## 제약

- gdm-go의 모든 제약이 그대로 적용된다 (상태는 CLI로만, done 전 완료 보고 금지,
  기준 몰래 완화 금지).
- NEVER: 검수보고(audit-report.md)를 직접 작성하지 않는다. 검수보고는 검수자
  서브에이전트만 작성한다 — 실행자가 쓰면 자기 채점이다.
- NEVER: 검수자에게 작업 요약을 대신 판단 근거로 주지 않는다. 검수자는 브리핑
  원문과 diff, 증거 파일 경로를 받아 직접 확인한다.
- NEVER: 반려 사유를 무시하고 verdict --pass를 기록하지 않는다.
- IMPORTANT: 커밋 메시지에 AI 관련 표기를 넣지 않는다 (사용자 커밋 규칙).

## 도구

gdm-go의 도구 전부 + 검수:

| 명령 | 용도 |
|---|---|
| `gdm plan init --slug <s> --brief <설명> --audit` | 검수 필수 작업으로 시작 (done이 검수 통과를 요구) |
| `gdm audit brief` | 검수자에게 줄 브리핑 패키지 출력 |
| `gdm audit verdict (--pass\|--fail) --report <파일>` | 검수자 판정 기록 (모든 항목 통과 후에만 가능) |

## 프로세스

1. `gdm plan init --slug <슬러그> --brief "<요약>" --audit`
2. check 설계: gdm-go 기준(happy/edge/regression)에 **adversarial 항목을 추가**한다
   — 악의적/경계 입력에서 무너지지 않는지 검증하는 check 1개 이상.
   등록 후 목록을 사용자에게 보여주고, 중량 작업이므로 이견 없는지 확인한다.
3. gdm-go와 동일한 구현·pass 루프 (작업 유형별 관행 — UI 증거 경로, DB 검증
   규칙, 프리셋 — 포함).
4. 전 항목 통과 후 `gdm recheck`로 회귀 확인.
5. 검수:
   a. `gdm audit brief` 출력과 `git diff`를 준비한다.
   b. **fresh-context 검수자 서브에이전트를 스폰한다.** 프롬프트는 gdm repo의
      `agents/auditor.md` 전문 + 브리핑 + diff. (Claude Code: Agent 도구로 스폰,
      Codex: 서브에이전트 스폰. 반드시 새 컨텍스트 — 현재 대화를 공유하지 않는다.)
   c. 검수자가 `.gdm/<슬러그>/audit-report.md`를 저장하고 통과/반려를 반환한다.
   d. `gdm audit verdict --pass|--fail --report .gdm/<슬러그>/audit-report.md`
6. 반려면: 반려 사유를 check로 반영(`gdm plan add`/`edit --reason`)하고 3으로.
   (check가 바뀌면 기존 검수는 자동 무효 — 재검수가 필요해진다. 정상 동작이다.)
7. 통과면 `gdm done` → 마무리:
   - 커밋: 사용자 커밋 규칙(`feat:`/`fix:` + 한국어 본문, AI 표기 금지) 준수
   - 브랜치/PR가 필요한 저장소면 gitflow 규칙대로 PR 본문 초안 작성
     (변경사항 / 테스트 체크리스트 / Closes #이슈)
   - 검수보고는 위키 자산이다 — 사용자가 원하면 wiki-ingest로 넘긴다.

## 엣지 케이스

- 검수자를 스폰할 수 없는 환경(서브에이전트 불가)이면: 사용자에게 알리고
  검수 단계를 건너뛸지 확인받는다. 임의로 자기 검수로 대체하지 않는다.
- 재검수가 2회 이상 반복되면: 반려 사유들을 정리해 사용자에게 방향을 확인받는다.

## 출력 형식

gdm-go와 동일하되, 완료 보고에 검수 결과 한 줄을 추가한다:
"검수: 통과 (보고: .gdm/<슬러그>/audit-report.md)".

## 예시

Bad — 실행자가 검수까지 자기 손으로 (자기 채점):

```
구현이 끝났으니 제가 확인한 내용으로 audit-report.md를 작성하고
verdict --pass를 기록하겠습니다.
```

같은 컨텍스트에서 만든 사람이 판정하면 자기합리화가 걸러지지 않는다.
검수보고는 반드시 fresh-context 검수자가 작성한다.

Good:

<example>
사용자: 심의 상태 전이 버그 고쳐줘. 중요한 거니까 $gdm-full

어시스턴트:
1. plan init --audit, check 4개(happy/edge/regression/adversarial) 등록·공유
2. 구현 → pass ×4 → recheck 통과
3. audit brief + git diff로 검수자 스폰 → 검수자가 반려
   ("전문간사 배정 전 통보 시도 케이스 미검증")
4. verdict --fail 기록 → 해당 케이스를 c5로 추가, 구현·pass → 재검수 → 통과
5. verdict --pass → done → 규칙에 맞는 커밋 + PR 본문 초안
6. "완료: 5개 항목 통과, 검수 통과(1회 반려 후 보완). 보고: .gdm/…/audit-report.md"
</example>

<commentary>
반려가 실제 결함(미검증 케이스)을 잡았고, 반려 사유가 check로 환원되어
증거와 함께 해소됐다. 검수가 요식이 아니라 게이트로 동작한 흐름이다.
</commentary>
