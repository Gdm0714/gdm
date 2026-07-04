# gdm 브랜치 전략 (gitflow)

개인 레포에 맞춘 간소화 gitflow. 자동화 실행자는 `$gdm-pr` 스킬이다.

## 브랜치

| 브랜치 | 역할 | 규칙 |
|---|---|---|
| `main` | 항상 동작하는 상태 | 직접 커밋 금지(문서 오타 수준 제외), PR로만 병합 |
| `feat/<이슈>-<설명>` | 새 기능 | 예: `feat/1-coverage-ci-gitflow` |
| `fix/<이슈>-<설명>` | 버그 수정 | 예: `fix/7-preset-escape` |
| `refactor/<설명>` | 리팩토링 | 이슈 없이 가능 |

실험적 작업은 브랜치 없이 로컬에서 하고, 방향이 잡히면 이슈·브랜치로 승격한다.

## 작업 흐름

```
1. gh issue create            이슈로 할 일 고정
2. git checkout -b feat/<이슈>-<설명>
3. 구현 + 논리 단위 커밋       (gdm 작업이면 $gdm-go / $gdm-full)
4. gh pr create               본문: 변경사항 / 테스트 체크 / Closes #이슈
5. CI 통과 확인               gh pr checks --watch
6. squash 머지 → 브랜치 삭제
```

## 커밋 메시지

```
<타입>: <한국어 요약> (#<이슈번호>)

- 상세 불릿 (선택)
```

- 타입: `feat` `fix` `refactor` `test` `docs` `chore`
- 논리 단위로 쪼갠다 — 한 커밋 = 한 가지 이유
- **AI·클로드 관련 표기 금지.** Co-Authored-By류 트레일러 포함 일체 금지.
  CI의 커밋 메시지 가드가 전체 히스토리를 검사해 강제한다.

## 금지 사항

- `git push --force` to main — 히스토리 정정이 필요한 예외 상황은 명시 합의 후
  `--force-with-lease`로만
- `--no-verify`로 훅 우회
- CI 실패 상태의 PR 머지

## 버전

- `cli/src/cli.ts`의 `VERSION` — CLI 동작이 바뀌면 semver로 올린다
  (스킬 문서만 바뀌면 유지)
- 릴리스 태그는 아직 사용하지 않는다 (P5 오케스트레이터 전까지 보류)
