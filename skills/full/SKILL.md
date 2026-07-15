---
name: gdm-full
description: |
  gdm 하네스의 중량 실행 루프. gdm-go의 검증 항목 흐름에 독립 검수(fresh-context
  검수자의 통과/반려 판정)와 전달 승인 검사를 더한다. 승인된 경우에만 gdm-pr로 넘긴다.
  사용자가 "$gdm-full", "gdm full", "제대로/검수까지 해줘"라고 하거나, 배포·머지
  수준의 완성도가 필요한 작업을 맡길 때 사용한다.
---

# gdm:full — 검수 포함 중량 실행 루프

## 역할

배포 수준 작업의 **조율자**. 제품 파일을 쓰는 실제 구현 주체는 한 명으로 유지하고 그 모델을
기록한다. gdm 게이트로 증거를 판정하며, **실제 구현 모델과 다른 모델**의 새 컨텍스트 검수자가
통과 판정을 내린 상태로만 작업을 끝낸다. 라우팅 계약: `skills/_shared/routing.md`.

## 제약

- gdm-go의 모든 제약이 그대로 적용된다 (상태는 CLI로만, done 전 완료 보고 금지,
  기준 몰래 완화 금지).
- CRITICAL: 제품 파일 작성자는 한 명이며, 실제 구현 모델과 검수 모델은 달라야 한다.
  역할 이름이나 조율자 정체성이 아니라 실제 diff를 만든 주체를 기준으로 기록한다.
- NEVER: 검수보고(audit-report.md)를 직접 작성하지 않는다. 검수보고는 검수자
  서브에이전트만 작성한다 — 실행자가 쓰면 자기 채점이다.
- NEVER: 검수자에게 작업 요약을 대신 판단 근거로 주지 않는다. 검수자는 브리핑
  원문과 diff, 증거 파일 경로를 받아 직접 확인한다.
- NEVER: 반려 사유를 무시하고 verdict --pass를 기록하지 않는다.
- NEVER: `gdm plan contract --check-commit --slug <슬러그>`가 exit 0이 아니면 stage,
  commit, push, PR을 하지 않는다. `done`이나 audit pass는 전달 승인이 아니다.
- IMPORTANT: 커밋 메시지에 AI 관련 표기를 넣지 않는다 (사용자 커밋 규칙).

## 도구

gdm-go의 도구 전부 + 검수:

| 명령 | 용도 |
|---|---|
| `gdm plan init --slug <s> --brief <설명> --audit --require <보존> --forbid <금지>` | 계약과 함께 검수 필수 작업 시작 |
| `gdm audit brief` | 검수자에게 줄 브리핑 패키지 출력 |
| `gdm audit verdict (--pass\|--fail) --report <파일>` | 검수자 판정 기록 (모든 항목 통과 후에만 가능) |

## 프로세스

1. `gdm plan init --slug <슬러그> --brief "<요약>" --audit --require "<보존 조건>" --forbid "자동 커밋"`
2. check 설계: gdm-go 기준(happy/edge/regression)에 **adversarial 항목을 추가**한다
   — 악의적/경계 입력에서 무너지지 않는지 검증하는 check 1개 이상.
   등록 후 목록을 사용자에게 보여주고, 중량 작업이므로 이견 없는지 확인한다.
3. 구현 시작 전에 실제 제품 작성자를 한 명 지정한다. 검수 입력의 첫 필드에
   `implementationModel: <실제 모델>`을 기록하고 구현 모델을 작업 기록에도 남긴다.
   경량 작업은 현재 실행자가 직접 맡고, 분리가 필요한 경우에도 제품 파일 writer는 하나만
   둔다. 조율자는 gdm-go와 동일한 pass 게이트를 소유하고(위임 산출물도 문장이 아니라
   증거로만 판정한다), 전 항목 통과 후 `gdm recheck`로 회귀를 확인한다.
4. 검수:
   a. `gdm audit brief` 출력과 `git diff`를 준비한다.
   b. **실제 구현 모델과 다른 모델의 검수자를 새 컨텍스트로 실행한다.** 프롬프트는
      검수자 프롬프트(`auditor.md`) 전문 + 브리핑 + diff이며 현재 대화 요약은 주지
      않는다. `auditor.md`는 설치 시 스킬 옆 `gdm-agents/`에 배치된다(소스:
      저장소 `agents/auditor.md`).
      다른 모델을 사용할 수 없으면 임의로 같은 모델 검수로 낮추지 말고 사용자에게
      차단 상태를 보고한다.
   c. 검수자가 보고서에 `implementationModel`과 `auditModel`을 기록하고
      `.gdm/<슬러그>/audit-report.md`를 저장한 뒤 통과/반려를 반환한다.
   d. `gdm audit verdict --pass|--fail --report .gdm/<슬러그>/audit-report.md`
5. 반려면: 반려 사유를 check로 반영(`gdm plan add`/`edit --reason`)하고 3으로.
   (check가 바뀌면 기존 검수는 자동 무효 — 재검수가 필요해진다. 정상 동작이다.)
6. 통과면 `gdm done` 뒤 gdm-go의 단일 habit feedback checkpoint를 수행한다.
7. 전달은 별도 gate다. `gdm plan contract --check-commit --slug <슬러그>`를 실행한다.
   - exit 4(기본값 커밋 금지)이고 사용자가 전달을 **명시적으로 승인하지 않았으면**:
     검증 결과만 보고하고 멈춘다. `done`이나 이 스킬 호출은 승인이 아니다.
   - 사용자가 전달을 명시적으로 승인했으면: `gdm plan contract --slug <슬러그>
     --commit explicitly-approved --reason "<승인 근거>"`로 승인을 기록한 뒤
     `--check-commit`를 재실행한다. exit 0이 되면 gdm-pr로 넘긴다.
   - 검수보고는 위키 자산이다 — 사용자가 원하면 wiki-ingest로 넘긴다.

## 엣지 케이스

- 실제 구현 모델과 다른 검수자를 실행할 수 없으면 `INDEPENDENCE_BLOCKED`를 보고하고
  full의 검수 통과·done·전달을 중단한다. 같은 모델 검수나 사용자 동의로 full 게이트를
  낮추지 않는다. 사용자가 경량 루프로 범위를 다시 정하면 별도 gdm-go 작업으로 시작한다.
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
1. plan init --audit --require "기존 심의 전이 보존" --forbid "자동 커밋",
   check 4개(happy/edge/regression/adversarial) 등록·공유
2. 구현은 Codex 워커에 위임(codex exec) → 조율자가 pass ×4 → recheck 통과
3. audit brief + git diff로 검수자 스폰 — 구현이 Codex였으므로 검수는 Claude(claude -p)
   → 검수자가 반려 ("전문간사 배정 전 통보 시도 케이스 미검증")
4. verdict --fail 기록 → 해당 케이스를 c5로 추가, 구현·pass → 재검수 → 통과
5. verdict --pass → done → habit feedback 1회 → commit gate가 닫혀 있어 전달 없이 정지
6. "검증 완료: 5개 항목 통과, 검수 통과(1회 반려 후 보완), 전달 승인 대기.
   보고: .gdm/…/audit-report.md"
</example>

<commentary>
반려가 실제 결함(미검증 케이스)을 잡았고, 반려 사유가 check로 환원되어
증거와 함께 해소됐다. 검수가 요식이 아니라 게이트로 동작한 흐름이다.
</commentary>
