---
name: gdm-device
description: gdm CLI로 연결된 실제 iPhone·iPad의 개발 빌드, 설치, 격리된 XCTest와 앱 화면 캡처를 실행하고 증거를 확인한다. gid 또는 다른 코딩 에이전트에서 iOS 실기기 검증을 요청할 때 사용한다.
---

# GDM 실기기 검증

프로젝트의 `.gdm-device.json`과 `gdm device` 명령으로 실기기 검증을 수행한다.
현재 에이전트의 셸 도구를 사용한다. 특정 모델, gid 엔진, 외부 Computer Use API에 의존하지 않는다.
설정 필드와 앱 캡처 계약이 필요하면 [README.md](README.md)를 읽는다.

## 실행 전 확인

- 프로젝트 루트에서 실행한다. `--config`를 바꿔도 설정 안의 상대 경로는 실행 디렉터리 기준이다.
- `gdm device list --json`으로 장치를 찾고, 설정의 CoreDevice ID와 Xcode UDID를 실제 장치에 맞춘다.
  표시 이름만으로 장치를 선택하거나 Simulator로 대체하지 않는다.
- `gdm device doctor --json`으로 연결·페어링·잠금 상태와 개발자 디스크 이미지(DDI)를 확인한다.
  해결되지 않은 검사 실패가 있으면 후속 기기 작업을 멈추고 실제 원인을 보고한다.
- 현재 세션에서 이미 허용한 작업 범위와 실행 권한을 따른다. 기기 서비스 접근이 거부되면
  실패한 명령과 실제 거부 내용을 설명한다. 현재 정책이 허용하면 필요한 기기 명령에만
  도구의 호스트 접근 승인 절차를 사용한다. 임의로 gid의 sandbox 또는 permissions를 변경하지 않는다.

## 요청에 맞는 명령 실행

```bash
gdm device list --json
gdm device doctor --json
gdm device build --json
gdm device install --json
gdm device test --json
gdm device capture --case dark --json
```

`list` 외에는 설정 파일이 필요하다. 기본값은 `.gdm-device.json`이며 각 명령에
`--config path/to/device.json`을 지정할 수 있다. 모든 명령을 무조건 실행하지 말고 요청에 필요한
검증만 수행한다. 빌드는 설치하지 않으며 `install`은 설정된 서명 완료 `.app`을 설치한다.
빌드를 변경했다면 다시 빌드한 앱을 설치한 뒤 캡처한다.

### XCTest

- `testTargets`에 해당 검증 범위의 XCTest 식별자를 명시한다.
- 테스트 코드를 읽고 테스트 저장소·계정·네트워크가 실제 사용자 기록에 영향을 주지 않는지 확인한다.
  설정 파일이나 테스트 이름만으로 격리가 입증되지는 않는다. 격리가 없으면 먼저 구현·검증한다.
- `.xcresult`에 선택한 물리 장치가 기록되고 실행 테스트 수가 0보다 크며 실패가 0인지 확인한다.
  프로세스 종료 코드나 `TEST SUCCEEDED` 문자열만으로 통과를 선언하지 않는다.

### 앱 화면 캡처

- 먼저 앱의 DEBUG 전용 캡처 진입점을 확인한다. 캡처 모드는 영구 저장소를 열기 전에 분기하고
  메모리 저장소·별도 테스트 데이터로 화면을 구성해야 한다. 일반 사용자 기록을 수정하지 않는다.
- `capture.isolationArgument` 다음에 CLI가 생성한 새 PNG 파일명이 전달된다. 앱은 지정 파일명으로
  자신의 Documents 디렉터리에 PNG를 저장해야 한다. 케이스별 인자는 그 뒤에 전달된다.
- CLI는 PNG를 복사·검증하고 실행 증거를 남긴 뒤, 성공·실패 시 모두 일반 실행으로 복원을 시도한다.
  복원 실패도 보고한다. 앱을 삭제하거나 사용자 데이터를 지워 복구하지 않는다.
- 새 PNG 생성과 파일 검증은 화면 내용의 정확성을 입증하지 않는다. 생성 이미지를 지원되는
  이미지 읽기 도구로 열어 요청한 상태·레이아웃을 확인한다. 이미지 도구가 없으면 사람이 확인할
  파일 경로를 제공하고 시각 검토가 남았다고 명시한다.

## 결과 보고

`.gdm-artifacts/device/<run>/receipt.json`과 해당 로그·PNG·`.xcresult` 경로를 확인한다.
수행 명령, 대상 기기, 실제 검사 결과, 남은 제한을 간결히 보고한다. 빌드 성공, 설치 성공,
XCTest 통과, 화면 검토를 각각 실제로 확인한 범위에 맞춰 표현한다.

기기 영수증은 GDM 작업 전체의 완료 판정과 별개다. 이미 `gdm-go` 또는 `gdm-full` 작업에 참여
중이면 해당 검증 명령을 그 작업의 check에 연결하고 기존 완료 게이트를 따른다.
