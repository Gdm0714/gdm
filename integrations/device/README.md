# gid에서 GDM 실기기 검증하기

`gdm device`는 연결된 실제 iPhone·iPad에서 개발 빌드, 설치, XCTest, 앱 화면 캡처를 실행하고
증거를 파일로 남긴다. gdmux 안에서 실행한 gid도 같은 CLI를 사용한다. 실행 주체는 gid,
기기 작업은 gdm과 Xcode가 담당한다.

## 준비

- macOS와 Xcode 개발 도구, 서명 가능한 iOS 프로젝트, `gdm device`를 포함한 gdm CLI.
- Mac과 페어링되어 연결된 실제 기기. 개발자 모드가 활성화되고 잠금이 해제되어 있어야 한다.
- XCTest는 사용자 기록과 분리된 저장소·계정·테스트 데이터를 사용해야 한다.
- 캡처에는 아래의 앱 전용 DEBUG 진입점이 필요하다.

`gdm device list --json`으로 장치를 찾고 설정한 뒤 `gdm device doctor --json`으로
연결·페어링·잠금과 개발자 디스크 이미지(DDI) 상태를 확인한다. Simulator 검증으로 대체하지 않는다.

## gid에 스킬 연결

gdm 저장소 루트에서 설치 내용을 확인하고 스킬을 복사한다.

```bash
python3 integrations/device/install-gid-skill.py --dry-run
python3 integrations/device/install-gid-skill.py
```

기본 설치 위치는 `~/.agents/skills/gdm-device`다. 설치기는 `SKILL.md`, 이 문서,
`example.json`만 복사한다. 기존 내용이 다르면 원래 디렉터리·파일·심볼릭 링크를
`~/.agents/skill-backups/gdm-device.backup-<timestamp>-<id>`에 보존한다. 백업은 스킬 탐색
폴더 밖에 두어 같은 스킬이 중복 등록되지 않게 한다. 사용자 지정 목적지의 부모가 `skills`면
같은 방식으로 형제 `skill-backups` 폴더를 사용하고, 그 외 목적지는 같은 부모에 백업한다.
완전히 같으면 아무것도 바꾸지 않는다.
CLI·gid 바이너리나 gid 권한 설정은 수정하지 않는다.

다른 경로에 시험 설치할 때는 최종 스킬 디렉터리를 지정한다.

```bash
python3 integrations/device/install-gid-skill.py --destination /tmp/gdm-device-preview
```

### 일반 gid 실행

실기기 자동 안내가 포함된 gid에서는 프로젝트 폴더에서 `gid`만 실행하고 “Gooo 실기기에서
테스트해줘”라고 요청하면 됩니다. `.gdm-device.json` 또는 `.xcodeproj`가 있으면 필요한
gdm 명령과 명령별 승인 절차가 자동 안내됩니다. `--attach`와 전체 세션 샌드박스 해제가
필수는 아닙니다. 기기 명령에 필요한 접근은 gid의 기존 승인 화면에서 확인합니다.

### 자동 안내가 없는 이전 gid 설치본

먼저 `gid --help`로 설치된 엔진의 옵션을 확인한다. 2026-09-21 초기 확인한 설치본은
`--cwd`와 `--attach`를 지원하는 공식 CLI 연결 엔진이다. gdmux의 터미널에서 다음처럼 시작한다.

```bash
gid --cwd /path/to/ios-project \
  --attach "$HOME/.agents/skills/gdm-device/SKILL.md"
```

이어서 `gdm-device 지침으로 연결된 iPhone에서 doctor를 실행해줘`처럼 요청한다.
전역 설치 없이 사용할 때는 `--attach /path/to/gdm/integrations/device/SKILL.md`를 지정할 수 있다.
세부 설정 문서에 접근할 수 없는 세션에서는 같은 폴더의 `README.md`도 `--attach`로 추가한다.

### native 엔진을 설치한 경우

gid의 새 native 엔진 소스는 프로젝트·사용자 `~/.agents/skills`에서 스킬을 발견하고,
`read_skill`로 본문을 읽으며 `/reload`로 스킬 목록을 갱신한다. **이 스킬 설치기는 설치된
gid를 새 엔진으로 교체하지 않는다.** 실제 실행 중인 버전에서 기능을 확인한 뒤 사용한다.

native 엔진의 `bash` 도구로 동일한 명령을 실행하거나, 직접 셸 실행을 지원하는 버전에서는
다음처럼 모델 호출 없이 상태를 확인한다.

```text
!gdm device doctor --json
```

이 스킬은 특정 제공자나 외부 Computer Use API를 요구하지 않는다. 현재 gid 세션의 승인과
샌드박스 정책을 그대로 따른다. 기기 서비스가 거부되면 실제 오류와 차단한 정책을 확인한다.
작업을 통과시키기 위해 `--sandbox off`나 `--skip-permissions`를 자동으로 추가하지 않는다.

이전 설치본의 `workspace-write` 안에서 CoreDeviceService XPC 연결이 실패하고 일반 셸의
동일 명령은 성공한 사례를 확인했다. 사용자가 **실기기 실행에 한해 호스트 접근을 승인한 경우**
다음처럼 그 gid 실행에만 적용할 수 있다. `--permissions ask`를 유지하며 전역 설정을 바꾸지 않는다.

```bash
gid --cwd /path/to/ios-project \
  --attach "$HOME/.agents/skills/gdm-device/SKILL.md" \
  --sandbox off --permissions ask
```

`--sandbox off`는 해당 세션의 OS 샌드박스를 해제하는 옵션이다. 기본 실행 명령에 자동으로
넣지 말고 실기기 작업용 세션에서만 사용한다. 비대화형 `--print`는 승인 질문에 답할 수 없으므로
추가 승인이 필요한 작업에는 대화형 gid를 사용한다.

## 프로젝트 설정

프로젝트 루트에 [example.json](example.json)을 `.gdm-device.json`으로 복사하고 값을 바꾼다.
예제의 장치 ID·UDID는 설명용 값이다.

```json
{
  "version": 1,
  "device": {
    "id": "11111111-2222-3333-4444-555555555555",
    "udid": "00008120-001234567890001E",
    "name": "My iPhone"
  },
  "bundleID": "com.example.app",
  "project": "App.xcodeproj",
  "scheme": "App",
  "derivedDataPath": ".build/Device",
  "appPath": ".build/Device/Build/Products/Debug-iphoneos/App.app",
  "testTargets": ["AppTests/ExampleTests"],
  "capture": {
    "isolationArgument": "-capturePhysicalEvidence",
    "cases": [
      {"name": "dark", "arguments": ["-visualAppearance", "dark"]},
      {"name": "light", "arguments": ["-visualAppearance", "light"]}
    ]
  }
}
```

| 필드 | 의미 |
|---|---|
| `version` | 설정 형식 버전. 현재 `1` |
| `device.id` | CoreDevice의 기기 식별자. `devicectl` 대상 |
| `device.udid` | Xcode가 표시하는 물리 장치 UDID. 빌드·테스트 목적지 |
| `device.name` | 실제 기기 이름과 일치해야 하는 표시 이름. ID 대신 사용하지 않음 |
| `bundleID` | 설치·실행할 앱의 번들 ID |
| `project`, `scheme` | `.xcodeproj` 경로와 실행 scheme |
| `derivedDataPath` | 빌드 산출물 디렉터리 |
| `appPath` | 설치할 서명 완료 `.app` 경로 |
| `testTargets` | 실행할 XCTest 식별자. 예: `AppTests/ExampleTests` |
| `capture.isolationArgument` | 앱이 처리하는 DEBUG 캡처 진입 인자 |
| `capture.cases` | 고유한 케이스 이름과 앱에 전달할 인자 배열 |

`device.id`와 `device.udid`는 서로 다른 값일 수 있다. 동일한 물리 장치인지 확인해서 넣는다.
`project`, `derivedDataPath`, `appPath`는 작업 폴더 안의 상대 경로만 허용하며,
**명령을 실행한 현재 디렉터리 기준**이다.
`--config config/phone.json`을 사용해도 경로 기준은 바뀌지 않는다.

`capture`는 캡처를 사용할 때만 필요하다. 케이스는 1~20개이며 이름은 영문 소문자·숫자로
시작하는 최대 64자의 소문자·숫자·하이픈 조합이어야 한다. 케이스 인자에
`isolationArgument`를 다시 넣지 않는다. 설정은 128 KiB 이하의 일반 JSON 파일을 사용한다.

## 명령

프로젝트 루트에서 실행한다. `list` 외에는 설정 파일이 필요하다.
기본 설정은 `.gdm-device.json`이며 모든 명령에 `--json`을 추가할 수 있다.

```bash
gdm device list --json
gdm device doctor --config .gdm-device.json --json
gdm device build --json
gdm device install --json
gdm device test --json
gdm device capture --json
gdm device capture --case dark --json
```

| 명령 | 동작과 확인 범위 |
|---|---|
| `list` | 연결된 기기 목록을 조회 |
| `doctor` | 설정의 실제 기기와 개발 도구 준비 상태를 검사 |
| `build` | 명시한 물리 장치 대상으로 개발 빌드 생성. 프로젝트의 서명 설정과 `jobs=2`, `nice=10` 사용 |
| `install` | `appPath`의 서명된 기존 앱을 설치. 빌드·앱 삭제는 수행하지 않음 |
| `test` | 선택한 XCTest를 실행하고 `.xcresult`의 기기·실행 수·실패 수 검증 |
| `capture` | 첫 케이스 또는 `--case`로 지정한 한 케이스를 실행하고 앱이 생성한 PNG를 복사·검증 |

앱을 바꾼 뒤 캡처하려면 `build` → `install` → `capture` 순으로 실행한다.
실제 테스트 수가 0인 실행은 테스트 성공으로 인정하지 않는다. 테스트는 실제 사용자 기록을
건드리지 않아야 하며, CLI는 테스트 코드의 저장소 격리 여부까지 증명하지 않는다.
현재 검증은 실제 성공한 테스트가 있고 실패와 예상된 실패(`expectedFailures`)가 모두 0인
결과를 요구한다.

## 앱 캡처 계약

이 캡처는 앱이 자신의 화면을 PNG로 저장하는 방식이다. 홈 화면·다른 앱을 조작하거나 임의의
시스템 화면을 찍는 기능은 제공하지 않는다.

앱은 DEBUG 빌드에서 다음 동작을 구현해야 한다.

1. 시작 인자에서 `capture.isolationArgument`를 찾고 바로 다음 값을 출력 PNG 파일명으로 읽는다.
2. 일반 영구 저장소를 열기 전에 캡처 분기로 들어간다. 메모리 저장소와 테스트 데이터로 화면을
   구성하고 실제 계정·서버·사용자 기록을 변경하지 않는다.
3. 뒤따르는 케이스 인자로 상태를 선택한다. `-visualAppearance dark` 등은 예제이며 앱이 직접
   해석해야 한다. CLI가 테마나 테스트 데이터를 자동으로 설정하는 것은 아니다.
4. 렌더링이 완료된 화면을 앱의 Documents 디렉터리에 지정 파일명으로 저장한다.
5. 캡처 인자가 없는 일반 실행에서는 원래 앱 흐름을 유지한다. Release 빌드에는 캡처 분기를 넣지 않는다.

CLI가 전달하는 시작 인자의 구조는 다음과 같다.

```text
-capturePhysicalEvidence <이번-실행의-고유-파일명>.png -visualAppearance dark
```

CLI는 매 실행에 새 파일명을 발급하고, 생성된 PNG를 Mac으로 복사해 파일 형식과 크기를
검증한 뒤 해시를 기록한다. 캡처가 성공하거나 실패한 뒤에는 캡처 인자 없이 앱을 다시 실행해
일반 상태로 복원을 시도한다. 연결 끊김 등으로 복원에 실패하면 그 실패를 결과에 남긴다.

같은 기기에 대한 gdm 명령은 동시에 실행하지 않는다. 이전 작업이 강제 종료되어 잠금이
남으면 오류에 표시된 폴더의 `owner.json`에서 PID와 기록을 확인한다. 해당 프로세스가 종료된
것을 확인한 뒤 그 잠금 폴더만 정리한다. 강제 종료·기기 연결 끊김 때는 앱 복원이 보장되지 않는다.

**새 이미지 확보는 화면 내용의 정확성까지 증명하지 않는다.** 이미지에서 기대한 케이스,
텍스트, 색상, 잘림 등을 별도로 검토해야 한다. 테스트·캡처 설정을 선언하는 것만으로 앱의
데이터 격리가 입증되지는 않으므로 진입점과 데이터 경로를 코드로 확인한다.

## 증거와 완료 범위

실행 결과는 `.gdm-artifacts/device/<unique-run>/` 아래에 저장된다.
`receipt.json`에는 실행 결과와 증거 정보가 남고, 명령에 따라 로그·PNG·`.xcresult`가 포함된다.
성공·실패 판단은 실제 출력과 영수증을 함께 확인한다.

빌드 성공은 설치나 테스트 통과를 뜻하지 않는다. 캡처 성공은 시각 검토 완료를 뜻하지 않는다.
이미 GDM check로 관리하는 작업이라면 해당 명령을 check에 연결한다. 기기 영수증을
`gdm done` 또는 검수·전달 게이트 통과로 간주하지 않는다.
