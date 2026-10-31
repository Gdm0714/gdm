# 실패 기록을 다시 실행하는 회귀 사례

`gdm regression`은 `feedback --value bad`와 `miss`로 기록한 실패를 작은 로컬 테스트로 연결한다. 후보 조회와 사례 저장은 명령을 실행하지 않는다. 사용자가 작성한 검증 명령은 `replay`를 실행할 때만 실행된다.

## 후보에서 고정된 사례 만들기

```sh
gdm feedback --slug sample --value bad --reason '빌드 오류가 출력에서 누락됨'
gdm regression candidates --slug sample --json
```

출력의 `candidates[].id`를 사용한다. 후보 ID는 작업, journal 위치, 해당 사건의 해시에 결속되어 이후 사건을 추가해도 유지된다. `miss`도 후보로 나오며 긍정적 피드백은 제외된다. `gdm retro --all --json`의 `regressionCandidates`에서도 같은 목록을 볼 수 있다.

예를 들어 `result.txt`가 필수 오류 메시지를 보존하는지 확인한다면:

```sh
mkdir -p fixtures/regressions
printf '%s\n' 'ERROR: failed build' > fixtures/regressions/expected.txt

gdm regression capture --slug sample --candidate reg-REPLACE_WITH_CANDIDATE_ID \
  --case build-error-v1 \
  --fixture fixtures/regressions/expected.txt \
  --cmd 'cmp fixtures/regressions/expected.txt "$GDM_REGRESSION_PROJECT/result.txt"' \
  --expect '결과에 필수 빌드 오류가 남아 있음' \
  --timeout-ms 30000
```

실제 과제에서는 `--cmd`에 해당 결함을 확인하는 테스트 명령을 작성한다. **기대 동작이 충족될 때만 exit 0**이어야 한다. `--expect`는 사람이 읽는 기준이며 자동으로 문장을 채점하지 않는다. 잘못된 검사 명령의 성공은 올바른 구현의 증명이 아니다.

`--fixture`는 여러 번 지정할 수 있다. 입력 파일 내용, 경로, 해시, 명령, 기준, timeout, 실패 출처를 하나의 사례로 고정한다. 저장 위치는 `.gdm/<slug>/regressions/<case>.json`이다. 원래 입력 파일을 나중에 바꿔도 저장된 입력은 바뀌지 않는다. 수정본을 만들 때는 새 사례 이름을 쓴다.

## 확인하고 재실행하기

```sh
gdm regression show --slug sample --case build-error-v1
gdm regression replay --slug sample --case build-error-v1
```

`show`는 실행 없이 명령·입력·기준·사례 해시를 보여 준다. 자동화에서 읽은 사례를 정확히 실행하려면 `replay --expected-case-sha256 <show의 sha256>`을 추가한다.

재실행 시 저장된 입력을 새 임시 디렉토리에 복사하고 그 디렉토리에서 검증 명령을 실행한다. `$GDM_REGRESSION_PROJECT`는 현재 프로젝트의 절대 경로다. 같은 고정 입력으로 수정 전·후 구현을 검사할 수 있다. 명령은 호스트 환경과 현재 도구를 사용하며 **임시 디렉토리는 운영체제 sandbox가 아니다**. 신뢰할 수 있는 로컬 검증 명령만 등록한다. 도구 버전·현재 구현 전체를 고정하는 재현 환경 패키지는 이 기능에 포함되지 않는다.

각 실행은 고유 `runId`, 고정 사례 해시, exit code, timeout 등 실행 오류, 출력 경로와 해시를 journal에 남긴다. 실행 시작 기록만 있고 결과가 없으면 중단된 실행이며 통과가 아니다. Git HEAD와 branch는 확인 가능한 경우 기록하지만 미커밋 변경까지 식별하는 값은 아니다. 실패 시 CLI도 nonzero로 종료한다.

결과는 기존 Work의 check, audit, done 상태를 바꾸지 않는다. 수정 전 실패와 수정 후 통과를 비교한 뒤 필요한 검증을 기존 `gdm plan add`에 등록한다. 일반 검증 항목에는 사례의 원래 검사 명령을 등록하거나 별도 임시 checkout에서 replay한다. 같은 저장소의 `gdm pass` 안에서 `gdm regression replay`를 다시 호출하면 저장소 lock과 충돌하므로 중첩하지 않는다. 회귀 결과를 check 증거로 자동 승격하지 않는다.

## 경계와 보존

- 사례당 UTF-8 입력 파일 1~16개, 파일당 128 KiB, 직렬화된 사례 최대 4 MiB를 허용한다.
- 상대 경로만 허용하며 경로 이탈, symlink, `.git`·`.gdm` 입력을 거부한다.
- 알려진 자격증명 모양을 입력·명령에서 검사한다. 이 검사는 임의의 비밀정보가 없음을 보증하지 않는다. 필요한 최소 입력을 직접 준비한다.
- 저장된 사례가 journal의 캡처 해시와 다르거나 출처가 바뀌면 실행을 거부한다. 새 버전은 새 이름으로 캡처한다.
- timeout은 기본 60초이며 100ms~10분 범위에서 정한다. 취소·timeout·출력 상한 초과에는 해당 실행의 process group만 정리한다.
- 출력 저장은 1 MiB 수준으로 제한하며 넘치면 앞·뒤를 남기고 `outputTruncated: true`를 기록한다. 성공/실패는 출력 축약 전에 관찰한 실행 결과로 결정한다.
- 원본 대화 전체 수집, 자동 명령 생성, 외부 업로드, 자동 재실행은 하지 않는다.
