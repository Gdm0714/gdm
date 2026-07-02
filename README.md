# gdm

검증 항목(check) 기반 개인 AI 하네스. 작업을 "확인 항목을 전부 초록으로 만드는 일"로
정의하고, 완료 판정을 모델이 아니라 결정적 CLI 게이트가 한다.

- 설계: [DESIGN.md](./DESIGN.md)
- 설치: `./install/install.sh` (bun 필요)
- 사용: Claude Code / Codex에서 `$gdm-go <작업>`, 터미널에서 `gdm --help`

## 구조

```
skills/   스킬 (Claude Code·Codex 공용 SKILL.md)
cli/      gdm CLI — 모델 호출 없는 순수 상태 머신 (bun/TypeScript)
install/  설치 스크립트 (바이너리 빌드 + 스킬 심링크)
```

## 개발

```
cd cli
bun test        # 상태 머신 유닛 테스트
bun run build   # dist/gdm 단일 바이너리
```
