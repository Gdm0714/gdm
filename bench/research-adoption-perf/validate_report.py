#!/usr/bin/env python3
"""Render/check the aggregate report from saved measurements; no timing rerun."""
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECTS = HERE.parents[2]
PATHS = {name: PROJECTS / name / 'bench/research-adoption-perf/results.json'
         for name in ['gdmux', 'gid', 'gdm']}


def render():
    data = {name: json.loads(path.read_text()) for name, path in PATHS.items()}
    mux, gid, gdm = (data[name] for name in ['gdmux', 'gid', 'gdm'])
    assert len(mux['samples']) == 216
    assert sum(len(g['runs']) for g in gid['groups']) == 324
    assert sum(len(s) for c in gdm['cases'] for s in c['samples'].values()) == 54
    lines = [
        '# 개선 전후 성능 측정 — 2026-10-29', '',
        '부분 화면 갱신과 반복 성공 로그 전달량은 크게 줄었다. 전체 화면 갱신은 느려졌고, 원본 보존·전체 요청 검사·회귀 기록에는 추가 비용이 든다. 모든 항목이 빨라진 변경은 아니다.', '',
        '## 측정 조건', '',
        '- Apple M4, 메모리 16 GiB, macOS 26.5.1. 최적화 release 빌드.',
        '- 항목별 예열 후 전후 실행 순서를 번갈아 9쌍 측정. 세 제품의 측정과 컴파일을 서로 겹치지 않았다.',
        '- 총 594개 측정 프로세스. 사용자 앱은 유지했으며 OneDrive 업데이트 등의 배경 부하가 있었다. 완전히 유휴한 실험실 측정은 아니다.',
        '- 실제 화면·키보드·마우스 조작, 앱 재시작, 설치본 교체, 실제 모델 호출 없이 합성 입력만 사용했다.',
        '- 중앙값과 원시 표본을 보존했다. 9회 표본의 p95는 관측 통계이며 장기적인 꼬리 지연 추정치가 아니다.',
        '- gdmux 파서·스냅샷과 gdm은 개선 전 소스를 복원했다. gid는 이전 미커밋 변경이 섞여 있어 관련 생산 코드의 처리 함수만 추출한 비교다. 전체 구버전 앱 비교로 해석하지 않는다.', '',
        '## gdmux: 화면 데이터 처리', '',
        '40행×120열, 패널당 20회 예열 후 120프레임. 파서 처리 + 스냅샷 생성 + JSON 직렬화 + 결과 해제까지 측정했다. 화면 데이터와 JSON은 모든 프레임에서 동일했다. 아래 시간은 패널 한 번 갱신당 평균 처리량을 각 실행에서 구한 뒤 취한 중앙값이다. UI·IPC·터미널 표시까지의 입력 지연이 아니다.', '',
        '| 작업 | 패널 수 | 전 µs/갱신 | 후 µs/갱신 | 전후 쌍 기준 시간 감소 | 전 → 후 최대 RSS 중앙값 MiB |',
        '|---|---:|---:|---:|---:|---:|',
    ]
    labels = {'cursor': '커서 이동', 'sparse': '한 줄 갱신', 'scroll': '출력 스크롤', 'redraw': '전체 화면 갱신'}
    for s in mux['summary']:
        b, a = s['before'], s['after']
        lines.append(f"| {labels[s['workload']]} | {s['panes']} | {b['median_us_per_pane_update']:.2f} | {a['median_us_per_pane_update']:.2f} | {s['median_elapsed_reduction_percent']:.1f}% | {b['peak_rss_bytes']['median']/2**20:.2f} → {a['peak_rss_bytes']['median']/2**20:.2f} |")
    lines += ['', '음수 감소율은 더 느려졌다는 뜻이다. 전체 화면이 바뀌면 캐시 확인·갱신 비용이 추가된다. 최대 RSS는 격리된 벤치마크 프로세스 값이며 실제 gdmux 앱 전체 메모리가 아니다. wire 출력 크기는 전후 같으므로 네트워크 대역폭 절감은 없다.', '',
              '## gid: 모델에 전달되는 도구 결과', '',
              '기존 32 KiB/2,000줄 제한을 기준으로 비교했다. 원본 전체와 축약본을 비교해 절감률을 계산하지 않았다. 아래는 안내 문구와 파일 경로를 포함한 content의 UTF-8 바이트다. 청구 토큰 수나 전체 대화 비용이 아니다.', '',
              '| 입력 사례 | 전 bytes | 후 bytes | 크기 감소 | 마지막 오류 보존 전 → 후 |', '|---|---:|---:|---:|---|']
    for c in gid['checks']['output_cases']:
        b, a = c['before'], c['after']
        def diagnostic(v):
            return '해당 없음' if v is None else ('보존' if v else '누락')
        lines.append(f"| {c['case']} | {b['content_bytes']:,} | {a['content_bytes']:,} | {(1-a['content_bytes']/b['content_bytes'])*100:.1f}% | {diagnostic(b['diagnostic_in_preview'])} → {diagnostic(a['diagnostic_in_preview'])} |")
    lines += ['', '성공 테스트 로그는 크게 줄지만 일반 장문 로그는 거의 같은 크기다. 후자는 마지막 오류가 보존되는 이득이 있다. 8 MiB 초과 입력의 원본 전체가 보존되는 것은 아니며, 손실 표시와 앞·뒤 부분을 남긴다.', '',
              '### 로컬 처리 비용', '',
              'finish는 출력 보존 한도 처리, 실제 파일 쓰기와 fsync를 포함한다. 프로세스 생성·실제 셸 작업·모델 응답 시간은 제외한다. budget은 한도 계산 자체의 비용이다.', '',
              '| 처리 | 입력 | 전 µs/회 | 후 µs/회 | 후 p95 배치 평균 µs/회 |', '|---|---|---:|---:|---:|']
    for g in gid['groups']:
        if g['kind'] in ['finish', 'budget']:
            b, a = g['before'], g['after']
            lines.append(f"| {g['kind']} | {g['case']} | {b['median_ns_per_op']/1000:.2f} | {a['median_ns_per_op']/1000:.2f} | {a['p95_batch_ns_per_op']/1000:.2f} |")
    lines += ['', '200개 성공 테스트 사례는 이전에는 파일을 만들지 않았지만, 이제 생략된 내용을 다시 읽을 수 있도록 보존하여 약 5ms가 추가된다. 전체 요청 계산은 시스템 지침·도구·이미지 예약량·CLI 이스케이프 비용을 더 확인하므로 CPU 비용이 증가했다. 계산에 포함된 바이트가 늘어난 것은 실제 요청에 그만큼 새 데이터를 추가했다는 뜻이 아니다.', '',
              '## gdm: CLI 처리', '',
              '10개 합성 Work와 실패 기록 200건. status 출력과 retro의 기존 필드는 동일하다. retro에는 회귀 후보 200건이 추가된다.', '',
              '| 명령 | 전 wall 중앙값 ms | 후 wall 중앙값 ms | 전 → 후 CPU 중앙값 ms | 전 → 후 wall p95 ms |', '|---|---:|---:|---:|---:|']
    for c in gdm['cases'][:2]:
        b, a = c['summary']['before'], c['summary']['after']
        lines.append(f"| {c['name']} | {b['wall_ms']['median']:.3f} | {a['wall_ms']['median']:.3f} | {b['cpu_ms']['median']:.3f} → {a['cpu_ms']['median']:.3f} | {b['wall_ms']['p95']:.3f} → {a['wall_ms']['p95']:.3f} |")
    r = gdm['cases'][2]['summary']
    lines += ['', 'status의 실행 범위는 거의 같으며 측정 범위가 겹친다. 이번 약 0.5ms 차이를 확정적인 코드 회귀로 단정하지 않는다. retro는 추가 조회·해시·출력을 수행한다.', '',
              f"새 회귀 replay는 단순 cmp 실행 {r['direct_shell']['wall_ms']['median']:.3f}ms 대비 {r['recorded_replay']['wall_ms']['median']:.3f}ms였다. 고정 입력·출처 검사·프로세스 그룹·내구성 있는 결과 기록을 추가하므로 동등 기능의 전후 비교가 아니다.", '',
              '## 해석과 남은 측정', '',
              '- 스크롤·부분 갱신에서는 화면 처리 최적화의 이득이 확인됐다. 전체 화면 갱신 경로에는 추가 최적화 여지가 있다.',
              '- 성공 로그 축약은 모델 입력을 줄인다. 전체 작업의 청구 비용·성공률·답변 품질 향상은 별도 실험이 필요하다.',
              '- 모델 변경 인계 품질, 실제 압축 모델 호출 시간, 이벤트 정합성, 수신 큐가 체감 입력 지연에 미치는 효과는 이 성능 수치로 입증하지 않았다. 이전 회귀 검증과 성능 측정은 구분한다.',
              '- 벤치마크용 파일만 추가했으며 제품 코드·설치본·실행 세션은 변경하지 않았다.', '',
              '## 원시 측정과 재현', '',
              '- [gdmux 원시 결과](../../../gdmux/bench/research-adoption-perf/results.json)',
              '- [gid 원시 결과](../../../gid/bench/research-adoption-perf/results.json)',
              '- [gdm 원시 결과](results.json)',
              '- [실행 환경](environment.json)', '',
              '각 저장소의 bench/research-adoption-perf/README.md에 재현 절차와 출처가 있다. 아래 해시는 보고서가 참조한 원시 결과를 고정한다.', '']
    for name, path in PATHS.items():
        lines.append(f"- {name}: `{hashlib.sha256(path.read_bytes()).hexdigest()}`")
    return '\n'.join(lines) + '\n'


expected = render()
path = HERE / 'REPORT.md'
if '--write' in sys.argv:
    path.write_text(expected)
assert path.read_text() == expected, 'Report is stale or differs from saved measurements'
print('PASS: aggregate report matches 594 saved measurements and result hashes')
