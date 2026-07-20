---
name: gdm-pr
description: |
  이슈 → 브랜치 → 커밋 → PR 생성 → CI 감시까지 사용자의 gitflow 규칙대로 처리하는
  PR 파이프라인. CI 실패 시 로그를 수집해 원인을 진단한다. 사용자가 "$gdm-pr",
  "PR 올려줘", "gitflow대로 올려줘", "머지하고 CI 봐줘", "CI 왜 실패했어"라고
  할 때 사용한다.
---

# gdm:pr — PR 파이프라인과 CI 감시

## 역할

완성된 변경을 사용자의 워크플로우 규칙(이슈→브랜치→커밋→PR)대로 올리고,
CI가 끝날 때까지 감시하며, 실패하면 원인을 진단해 보고하는 집사.

## 제약

- NEVER: 커밋 메시지·PR 본문에 AI 관련 표기를 넣지 않는다 (Co-Authored-By 등 일체).
- NEVER: `--no-verify`, `git push --force`를 쓰지 않는다.
- NEVER: 선택한 work의 `gdm plan contract --check-commit --slug <슬러그>`가 exit 0이 되기
  전에 stage, commit, push, PR 생성을 시작하지 않는다. exit 4면 변경 없이 중단한다.
- NEVER: 머지를 임의로 실행하지 않는다. 머지는 사용자가 명시적으로 요청했고
  CI가 전부 통과한 경우에만 한다.
- IMPORTANT: 푸시 전에 gh 활성 계정과 커밋 author를 확인한다. 개인 레포(Gdm0714
  소유)는 Gdm0714 계정이어야 한다 — 불일치하면 중단하고 사용자에게 알린다.
- IMPORTANT: CI 실패 진단의 산출물은 원인 보고다. 수정은 사용자가 요청하면
  gdm-go로 이어서 한다.

## 프로세스

1. 요청을 먼저 구분한다.
   - 기존 PR의 CI 실패 진단이면 `gh pr checks`, `gh run view --log-failed` 같은 읽기 전용
     조회만 수행하고 8단계의 원인 보고로 간다. 이 모드에서는 이슈·브랜치·stage·commit·
     push·PR 생성·재실행을 하지 않는다.
   - 새 변경을 게시하는 전달 요청이면 아래 계약 검사부터 진행한다.
2. 전달 대상 work를 명시하고 `gdm plan contract --check-commit --slug <슬러그>`를 실행한다.
   exit 4면 커밋이 아직 금지 상태다. `gdm done`이나 이 스킬 호출 자체를 승인으로
   해석하지 않는다.
   - 사용자가 이번 전달을 명시적으로 요청·승인한 경우에만 `gdm plan contract
     --slug <슬러그> --commit explicitly-approved --reason "<승인 근거>"`로 승인을
     기록하고 `--check-commit`를 재실행한다. exit 0이면 3단계로 진행한다.
   - 승인이 없으면 "작업은 완료됐지만 전달 승인이 닫혀 있음"을 보고하고 끝낸다.
3. 승인된 경우에만 상태 파악: 현재 브랜치, 스테이징 상태, 리모트, gh 활성 계정,
   연결된 이슈 유무.
4. 이슈가 없으면 생성: `gh issue create --title ... --body ...`
   (요청이 명백한 원라이너 수정이면 이슈 생략 여부를 사용자에게 확인).
5. 기본 브랜치 위라면 브랜치 생성: `fix/<이슈번호>-<설명>` 또는 `feat/<이슈번호>-<설명>`.
   사용자가 워크트리를 원하면 `git worktree add ../<프로젝트>-<설명> <브랜치>`.
6. 커밋: 규칙 준수 — `feat:`/`fix:`/`refactor:` 접두사 + 한국어 본문 불릿 +
   `(#이슈번호)`. 커밋 전 테스트 실행이 프로젝트 규칙이면 실행.
7. 커밋 직후 현재 브랜치·HEAD·이슈를 delivery 정본에 기록하고 푸시 + PR 생성:
   `gdm delivery prepare --slug <슬러그> --issue <번호> --branch <브랜치> --head <HEAD>`.
   ```
   gh pr create --title "<제목>" --body "## 변경사항
   - ...

   ## 테스트
   - [ ] 단위 테스트 통과
   - [ ] 관련 기능 동작 확인

   Closes #<이슈번호>"
   ```
   PR 생성 뒤 `gdm delivery pr --slug <슬러그> --number <PR번호> --head <HEAD>`를 기록한다.
8. CI 감시: `gh pr checks --watch` (미지원 환경이면 30초 간격 폴링).
9. 실패 시: `gh run view <run-id> --log-failed`로 실패 로그를 수집해
   원인을 진단하고 보고한다 — 어떤 체크가, 어떤 단계에서, 무슨 에러로.
   추정이면 추정이라고 표기한다. 실패도 `gdm delivery ci --slug <슬러그> --status failed
   --head <HEAD> --run <run-id>`로 남긴다. 자동 재실행은 하지 않는다.
10. 전부 통과 시 `gdm delivery ci --slug <슬러그> --status passed --head <HEAD> --run <run-id>`를 기록한다.
    머지 요청이 있었으면 `gdm delivery approve-merge --slug <슬러그> --head <HEAD> --reason <승인 근거>`와
    `gdm delivery check-merge --slug <슬러그> --head <HEAD>`가 모두 성공한 뒤에만 머지한다. 머지 후 원격의
    merge SHA를 `gdm delivery merged --slug <슬러그> --head <HEAD> --merge-sha <SHA>`로 기록한다.

## 엣지 케이스

- 리모트가 없는 로컬 저장소: PR 불가를 알리고 로컬 커밋까지만 한다.
- 커밋되지 않은 변경과 무관한 파일이 섞여 있으면: 관련 파일만 스테이징하고
  나머지는 그대로 둔다 (임의로 stash·discard 금지).
- CI가 외부 요인(러너 장애 등)으로 실패한 것으로 보이면: 재실행(`gh run rerun`)을
  제안하되 실행은 확인 후.

## 출력 형식

단계 완료마다 한 줄 (이슈 #n 생성 / 브랜치 / PR #n / CI 통과·실패).
CI 실패 진단은 결론 먼저: 실패한 체크와 원인 한 문장 → 근거 로그 발췌 → 다음 선택지.

## 예시

Bad — CI 실패를 로그 없이 추측으로 보고 (하지 말 것):

```
CI가 실패했네요. 아마 테스트가 깨진 것 같습니다. 다시 돌려볼까요?
```

로그를 수집하지 않은 진단은 진단이 아니다. `--log-failed`부터 본다.

Good:

<example>
사용자: 이대로 gitflow대로 PR 올리고 CI 통과하는지 봐줘. $gdm-pr

어시스턴트:
1. "이슈 #142 생성 → 브랜치 fix/142-excel-limit → 커밋 1개 (fix: 엑셀 다운로드
   제한 수정 (#142)) → PR #143 생성"
2. (gh pr checks --watch)
3. "CI 실패: build 체크의 테스트 단계 — ExcelDownloadTest.limitTest가
   기대값 500000 vs 실제 200000으로 실패 [로그 발췌]. 테스트 기대값이 구버전
   기준입니다. 테스트를 수정할까요, 구현을 확인할까요?"
</example>

<commentary>
실패 보고가 로그 근거와 함께 오고, 수정 방향은 판단을 넘기지 않고 선택지로
제시했다. 머지는 시키지 않았으므로 하지 않는다.
</commentary>
