---
name: gdm-reflect
description: 작업이 끝난 뒤 gdm 증거와 사용자가 명시적으로 선택한 로컬 노트·세션에서 반복 패턴을 찾아 정규화된 관찰과 습관 후보를 만든다. 사용자가 "$gdm-reflect", "회고해서 습관 후보 만들어줘", "내 노트 원칙을 이번 실수와 연결해줘", "AI 사용 실수를 워크플로우에 반영해줘"라고 할 때 사용한다.
---

# gdm reflect

원문을 원장에 옮기지 않고 `관찰 → 후보 → 사람 검토`까지만 진행한다. 채택은 사용자의 별도 명시 응답 뒤에만 가능하며 이 스킬은 `habit adopt`를 실행하지 않는다.

## 경계

- 기본 입력은 현재 저장소의 `.gdm` 증거뿐이다.
- Obsidian 노트나 코딩 세션은 사용자가 이번 실행에서 대상을 명시했을 때만 읽는다. 전체 vault·세션 디렉터리를 탐색하거나 경로를 하드코딩하지 않는다.
- 원문, 발췌문, 코드, diff, transcript, 절대 경로, URI, secret, 원문 해시는 저장·출력하지 않는다.
- CLI에는 정규화된 여섯 필드 observation만 전달한다.
- 자동으로 규칙 파일, AGENTS.md, 테스트, 훅, 노트 또는 원문 소스를 편집하지 않는다.
- 자동 채택·자동 폐기·커밋·푸시·PR을 하지 않는다.

## 실행

1. 현재 저장소에서 `gdm habit harvest --json`을 실행한다.
2. 사용자가 별도 소스를 선택했다면 이용 가능한 로컬 읽기 도구로 그 소스만 읽고, 다음 두 종류로 메모리 안에서 추상화한다.
   - `incident`: 실제 작업에서 관찰된 반복 실패·누락·수정 사건
   - `principle`: 사용자가 검토해 둔 재사용 가능한 원칙
3. 서로 다른 source group 두 개 이상이 같은 pattern을 가리키고 그중 하나 이상이 `incident`인지 확인한다. 원칙 두 개만으로 후보를 만들지 않는다.
4. 각 근거를 다음 JSONL 스키마로 정규화하고, 여섯 필드가 모두 안전한 값인지
   메모리 안에서 전부 확인한 뒤에만 임시 파일을 만든다.

```json
{"schemaVersion":1,"pattern":"learning.example-pattern","taxonomy":"recovery","sourceToken":"src-manual-1","sourceGroup":"grp-work-1","sourceKind":"incident"}
```

5. source token/group은 원문이나 원문 해시에서 만들지 않는다. 실행 범위 안의 비민감 opaque ID만 사용한다.
6. 저장소 루트에 정규화 JSONL 임시 파일을 만들고, 성공·실패 어느 쪽에서도 삭제되도록
   cleanup trap을 먼저 건 뒤 `gdm habit import --file <상대경로>`로 가져온다. 사용자가
   선택한 원문 경로는 import 인수나 JSONL 필드로 넘기지 않는다. `.gdm` 상태는 직접 쓰지 않는다.
7. 안전한 habit ledger에서 해당 observation event ID만 선택해 다음을 실행한다.

```text
gdm habit propose --pattern <pattern> --statement <최소 규칙> \
  --source-event <incident-event-id> --source-event <principle-event-id>
```

8. 동일한 의미의 현재 후보가 있으면 새 후보를 중복 생성하지 않는다.
9. 후보, 근거 종류, 다음 작업에서 확인할 결과를 짧게 보여주고 `ADOPTION_REQUIRED`로 멈춘다.

## 후보 작성 규칙

- 반복 사건 하나에 최소 규칙 하나만 제안한다.
- 규칙은 다음 작업에서 적용 가능 여부와 재발 여부를 확인할 수 있어야 한다.
- 오래된 맥락 설명 대신 반복되는 gotcha나 불변식만 남긴다.
- 효과가 없으면 강화하지 말고 `gdm habit retire` 검토를 제안한다.
- 적용 표본이 3건 미만이면 개선 여부를 단정하지 않는다.

## 출력

다음 항목만 보여준다.

- pattern
- incident/principle 근거 개수
- 제안한 최소 규칙
- 다음 작업의 관찰 기준
- 사용자가 채택하려면 직접 확인해야 할 rule 파일과 `gdm habit adopt` 명령 예시
- 마지막 줄 `ADOPTION_REQUIRED`

사용자가 거절하거나 명확히 동의하지 않으면 채택하지 않는다. 명시적으로 채택한 뒤의 적용·평가는 `gdm-go` 또는 `gdm-full` 실행 루프에 맡긴다.
