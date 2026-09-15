# Claude Code 단독 GDM 검증 — 2026-09-10

Claude 설치 대상에 전체 실행 스킬을 제공하도록 렌더러를 수정했다. 일반 Claude Code 세션이
계획·구현·검증을 담당하며, `run-role.sh`로 호출한 전문 역할에는 기존 tool-0 제한을 유지한다.
Pi의 Terra·Luna·Astra 모델 설정은 그대로 둔다.

## 자동 검증

| 검사 | 결과 |
|---|---|
| Claude 전체 스킬 본문·메타데이터·모델 경로 회귀 | 2개 통과. 수정 전 동일 명령에서 2개 실패 기록 |
| 대상별 렌더링·역할 실행기·작업 정책·그래프 라우팅 | 38개 통과 |
| 격리 설치·작업 완료·검수 무결성 | 5개 통과 |
| 기존 설치 교체·사용자 설정 보존·실패 시 복구 | 5개 통과 |
| CLI TypeScript 검사 | 통과 |

격리 설치는 개인 인증·설정이 없는 임시 HOME에서 실행했다. `codex`, `pi`, `claude`를 호출하면
실패를 기록하는 실행 파일을 두었으며 호출은 없었다. 설치된 GDM으로 regression red → pass →
done을 수행했고, 미완료 작업·동일 모델 검수·자동 커밋은 거부됐다. 같은 공급자의 서로 다른
모델 식별자는 검수 게이트를 통과했다. 이 검수 사례는 합성 보고서로 CLI 조건을 검사한 것으로,
실제 두 Claude 모델의 검수 실행이나 품질 측정은 아니다.

## 실제 Claude Code 실행

- Claude Code 2.1.263, 응답에 기록된 모델 `claude-opus-5[1m]`.
- 설치된 `gdm-go`를 Skill 도구로 성공적으로 호출했다.
- 합성 Git 저장소에서 합계 함수의 초기값 오류를 수정했다. 기존 테스트 3개는 변경하지 않았다.
- 실제 `gdm plan init/add`, regression `--red`, 코드 편집, `gdm pass`, `gdm done`을 실행했다.
- 2개 check가 proven이며, 변경 허용·금지 경로와 커밋 금지 계약을 유지했다.
- 약 51.3초, 15턴, 도구 호출 13회. CLI가 보고한 비용은 $0.6831이며 구독 청구액을 뜻하지 않는다.
- Codex·Pi 호출 0회. Astra 사용이 필요한 작업 경로는 없었다.
- 스킬·실행 로그·검증 증거 해시와 최종 테스트를 별도 검증기로 다시 확인했다.

실제 실행은 총 2회 시도했다. 첫 시도는 테스트에서 `--setting-sources project`로 사용자 스킬을
제외했고 Git 기준점도 준비하지 않아 180초 제한으로 종료됐다. 이를 성공으로 집계하지 않았다.
일반 사용자 스킬 로딩과 합성 Git 기준점을 사용하는 수정된 프로브 1회가 위 결과다.

성공 증거: `/tmp/gdm-claude-coordinator-live-20260910-0150/`의 `stdout.jsonl`, `receipt.json`,
`project/.gdm/claude-live/`. 실패 증거도 같은 접두어의 `0145/`에 보존했다.

```bash
# 저장된 실제 증거만 검증한다. 모델을 다시 호출하지 않는다.
bun script/qa/claude-coordinator-smoke.ts --verify /tmp/gdm-claude-coordinator-live-20260910-0150

# 새 실제 검증이 필요할 때만 실행한다. 새 경로와 Claude Code 로그인이 필요하다.
bun script/qa/claude-coordinator-smoke.ts --run /absolute/new-evidence-directory
```

이 결과는 Claude Code 단독 기본 작업 경로의 작동 확인이다. 복잡한 작업의 품질 벤치마크나
`gdm-full`의 실제 복수 모델 검수까지 측정한 결과는 아니다. 변경된 13개 Claude 스킬은 로컬에
설치했으며, 원격 저장소·릴리스에는 게시하지 않았다.
