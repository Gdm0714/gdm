## 이 target에서 지원하지 않는 coordinator skill

이 스킬은 쓰기·상태 변경 또는 대화형 coordinator 권한이 필요한 워크플로이므로 Claude target
skill로 직접 실행하지 않는다. 이 파일은 설치·doctor가 capability 불일치를 명시적으로 확인할
수 있게 남겨 둔 비실행 stub이다. 읽기 전용 전문 역할은 `gdm-agents/run-role.sh --mode work`를
통해 지원되는 `plan|analyze|review|audit` 역할로만 실행하고, 구현·설치·전달·UI·DB·문서 변경은
Codex coordinator에게 반환한다.
