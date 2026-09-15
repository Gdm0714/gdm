#!/usr/bin/env python3
"""Publish individual outcomes before matched-arm descriptive statistics."""
import json
from pathlib import Path
import statistics

here = Path(__file__).resolve().parent
run = Path((here / "latest-run.txt").read_text().strip())
data = json.loads((run / "assessed.json").read_text())
arms = ["current", "ondemand", "calibrated"]
rows = data["runs"]
complete_groups = []
for task in ["t1", "t2", "t3"]:
    for trial in [1, 2]:
        group = [r for r in rows if r["task"] == task and r["trial"] == trial]
        if len(group) == 3 and all(r["measurementValid"] for r in group):
            complete_groups.append((task, trial))
matched = [r for r in rows if (r["task"], r["trial"]) in complete_groups]
summary = {}
for arm in arms:
    selected = [r for r in matched if r["arm"] == arm]
    if selected:
        summary[arm] = {"n":len(selected), "successes":sum(r["success"] for r in selected), **{key:statistics.median(r[key] for r in selected) for key in ["seconds", "freshInputTokens", "commandCount", "checks"]}, **{key:statistics.median(r["usage"][key] for r in selected) for key in ["input_tokens", "cached_input_tokens", "output_tokens"]}}
contrasts = {}
for control,treatment in [("current","ondemand"),("ondemand","calibrated"),("current","calibrated")]:
    pairs = [p for p in data["paired"] if p["measurementValid"] and p["control"] == control and p["treatment"] == treatment and (p["task"],p["trial"]) in complete_groups]
    if pairs:
        contrasts[f"{control}->{treatment}"] = {key:{"medianPairedPercent":statistics.median(p["deltaPercent"][key] for p in pairs), "improvedPairs":sum(p["deltaPercent"][key] < 0 for p in pairs), "pairs":len(pairs), "individualPercent":[p["deltaPercent"][key] for p in pairs]} for key in ["seconds", "freshInputTokens", "commandCount"]}
result = {"completedRuns":len(rows), "successfulCompletions":sum(r["success"] for r in rows), "measurementValidRuns":sum(r["measurementValid"] for r in rows), "completeGroups":complete_groups, "matchedSummary":summary, "contrasts":contrasts}
(run / "matched-summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
lines = ["# Astra ablation individual results", "", "`NA`는 usage가 보고되지 않은 실행이다. 성공은 hidden/visible, 원래 테스트 보존, done과 evidence 검증을 모두 포함한다. 환경 오류는 실패 기록을 삭제하지 않고 비용 비교에서 제외한다.", "", "| 실행 | 완료 검증 | 측정 유효 | 초 | fresh input | 전체 input | output | 쉘 명령 | checks |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
for row in sorted(rows,key=lambda r:(r["trial"],r["task"],arms.index(r["arm"]))):
    fresh = f'{row["freshInputTokens"]:,}' if row["usageValid"] else "NA"
    lines.append(f'| {row["id"]} | {"통과" if row["success"] else "미완료"} | {"yes" if row["measurementValid"] else "no"} | {row["seconds"]:.1f} | {fresh} | {row["usage"].get("input_tokens", "NA")} | {row["usage"].get("output_tokens", "NA")} | {row["commandCount"]} | {row["checks"]} |')
lines += ["", "## 세 arm 모두 정상 측정된 같은 과제·반복만 비교", "", f"포함 묶음: {complete_groups}", "", "| arm | n | 완료 통과 | 시간 중앙값(s) | fresh input 중앙값 | 전체 input 중앙값 | output 중앙값 | 명령 중앙값 |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
for arm,s in summary.items():
    lines.append(f'| {arm} | {s["n"]} | {s["successes"]} | {s["seconds"]:.1f} | {s["freshInputTokens"]:,.0f} | {s["input_tokens"]:,.0f} | {s["output_tokens"]:,.0f} | {s["commandCount"]:g} |')
lines += ["", "## 짝별 변화율", "", "중앙값끼리의 비율과, 각 쌍의 변화율 중앙값은 다를 수 있다. 아래는 각 쌍에서 먼저 변화율을 계산한 값이다. 음수는 감소다.", "", "| 비교 | 지표 | 짝별 변화율 중앙값 | 감소한 쌍 | 개별 변화율 |", "|---|---|---:|---:|---|"]
for contrast,metrics in contrasts.items():
    for key,m in metrics.items():
        lines.append(f'| {contrast} | {key} | {m["medianPairedPercent"]:+.1f}% | {m["improvedPairs"]}/{m["pairs"]} | {m["individualPercent"]} |')
lines += ["", "작은 재사용 과제, 두 번의 반복, 일부 환경 오류가 있는 탐색 실험이다. 과제군 수준의 유효 표본은 3개 이하이며 테스트 assertion 개수를 독립 표본 수로 취급하지 않는다. 유의성이나 일반적인 품질 비열등성을 주장하지 않는다.", ""]
(here / "results-2026-09-08.md").write_text("\n".join(lines))
print(json.dumps(result,ensure_ascii=False,indent=2))
