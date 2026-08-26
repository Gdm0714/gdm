$gdm-analyze

읽기 전용 A/B 측정입니다. `cli/src/workflow-gates.ts`에 정적 상대 import로 직접 또는 간접
의존하는 파일을 최대 2홉까지 찾으세요.

- entry 자체는 결과 배열에서 제외합니다.
- production 파일과 test 파일을 분리합니다.
- 각 파일의 최소 hop 수(`depth`)와 실제 import/re-export를 직접 연 파일의 `파일:라인` 근거를
  하나씩 적습니다.
- 반환 후보는 반드시 직접 열어 확인합니다.
- bare package, dynamic import, require, alias, 해석 실패, 깊이 제한 등 결과 완전성을 해칠 수
  있는 사항은 `limitations`에 적습니다.
- 코드 수정이나 수정 제안은 하지 않습니다.
- 이 실험에서는 서브에이전트를 만들지 않습니다.
- 지정된 JSON schema만 출력합니다.
