#!/usr/bin/env python3
"""Report paired task/trial outcomes; do not hide failed or incomplete-usage runs."""
import math
import json
from pathlib import Path
import random
import statistics
from run import HERE, load, save, summarize, complete_usage as eligible
from adjudicate import adjudicate

def delegation_attempts(path):
    """Audit attempts independently of the frozen legacy child-only parser."""
    attempts = {}
    for line in path.read_text().splitlines():
        try: event = json.loads(line)
        except ValueError: continue
        if event.get('toolName') != 'gdm_delegate': continue
        key = event.get('toolCallId')
        if event.get('type') == 'tool_execution_start':
            attempts[key] = {'id': key, 'tasks': event.get('args', {}).get('tasks'), 'ended': False}
        elif event.get('type') == 'tool_execution_end':
            result = event.get('result', {})
            text = '\n'.join(c.get('text', '') for c in result.get('content', []) if c.get('type') == 'text')
            rejected = 'GDM_PI_DELEGATION_REJECTED:' in text
            attempts.setdefault(key, {'id': key}).update(ended=True, rejected=rejected,
                error=event.get('isError') is True or result.get('isError') is True or rejected,
                childCount=len(result.get('details', {}).get('results', [])))
    return list(attempts.values())

def paired(rows, a, b, metric):
    pairs=[]
    index={(r['task'],r['trial'],r['arm']):r for r in rows}
    for task,trial,arm in index:
        if arm!=a or (task,trial,b) not in index:continue
        x=index[task,trial,a];y=index[task,trial,b]
        if not (x['success'] and y['success']):continue
        if metric!='seconds' and not(eligible(x) and eligible(y)):continue
        xv=x['seconds'] if metric=='seconds' else x['totalUsage'][metric]
        yv=y['seconds'] if metric=='seconds' else y['totalUsage'][metric]
        if xv<=0:continue
        pairs.append({'task':task,'trial':trial,'ratio':yv/xv,'baseline':xv,'candidate':yv})
    if not pairs:return {'pairs':0}
    # Cluster bootstrap by task: both trials of a task stay together.
    groups={}
    for p in pairs:groups.setdefault(p['task'],[]).append(p['ratio'])
    randomizer=random.Random(20260908);keys=list(groups);boot=[]
    for _ in range(4000):
        sampled=[v for k in randomizer.choices(keys,k=len(keys)) for v in groups[k]]
        boot.append(statistics.median(sampled))
    boot.sort()
    return {'pairs':len(pairs),'tasks':len(groups),'medianRatio':statistics.median(p['ratio'] for p in pairs),'taskClusterBootstrap95':[boot[100],boot[3899]] if len(groups)>=4 else None,'fasterOrCheaperPairs':sum(p['ratio']<1 for p in pairs),'observations':pairs}

def main():
    run=Path(load(HERE/'active-run.json')['path']);manifest=load(run/'manifest.json');summarize(run)
    rows=[load(p) for p in sorted((run/'runs').glob('*/result.json'))]
    summary=load(run/'summary.json');comparisons={}
    for a,b in [('legacy','routed'),('legacy','terra'),('terra','routed'),('routed','astra')]:
        comparisons[a+'→'+b]={m:paired(rows,a,b,m) for m in ['seconds','totalTokens','input','apiCostEstimateUSD']}
    arm_rows={}
    for arm in manifest['arms']:
        values=[r for r in rows if r['arm']==arm];valid=[r for r in values if eligible(r)]
        arm_rows[arm]={'runs':len(values),'successes':sum(r['success'] for r in values),'hiddenPassed':sum(r['hidden']['exitCode']==0 for r in values),'validUsageRuns':len(valid),'totalSecondsAll':sum(r['seconds'] for r in values),'totalApiEstimateUSDValid':sum(r['totalUsage']['apiCostEstimateUSD'] for r in valid),'failedRunIds':[r['id'] for r in values if not r['success']],'providerErrorRunIds':[r['id'] for r in values if any(m.get('error') for m in r['messages'])],'delegations':[{'run':r['id'],**{k:c.get(k) for k in ['role','model','thinking','elapsedMs','ok','usageComplete']}} for r in values for c in r['children']]}
    sensitivity={a+'→'+b:paired([r for r in rows if r['task']!='t1'],a,b,'seconds') for a,b in [('legacy','routed'),('legacy','terra'),('terra','routed')]}
    for arm, data in arm_rows.items():
        data['delegateAttempts'] = [{'run': r['id'], **a} for r in rows if r['arm'] == arm
            for a in delegation_attempts(run / 'runs' / r['id'] / 'events.jsonl')]
    # Exploratory diagnostics after observing a provider retry in the first run.
    # Keep the primary comparison unchanged; never silently discard that observation.
    clean=[r for r in rows if not any(m.get('error') for m in r['messages'])]
    error_free={a+'→'+b:paired(clean,a,b,'seconds') for a,b in [('legacy','routed'),('legacy','terra'),('terra','routed'),('routed','astra')]}
    leave_one_out={task:{a+'→'+b:paired([r for r in rows if r['task']!=task],a,b,'seconds') for a,b in [('legacy','routed'),('legacy','terra'),('terra','routed')]} for task in sorted({r['task'] for r in rows})}
    corrected_rows=adjudicate(run,rows)
    corrected_arms={arm:{'runs':sum(r['arm']==arm for r in corrected_rows),'successes':sum(r['arm']==arm and r['success'] for r in corrected_rows),'failedRunIds':[r['id'] for r in corrected_rows if r['arm']==arm and not r['success']]} for arm in manifest['arms']}
    corrected_comparisons={a+'→'+b:{m:paired(corrected_rows,a,b,m) for m in ['seconds','totalTokens','input','apiCostEstimateUSD']} for a,b in [('legacy','routed'),('legacy','terra'),('terra','routed'),('routed','astra')]}
    result={'schema':'gdm-pi-model-routing-analysis/v1','run':str(run),'completed':len(rows),'planned':len(manifest['schedule']),'summary':summary,'arms':arm_rows,'pairedComparisons':comparisons,'sensitivityWithoutT1':sensitivity,'exploratoryWithoutProviderErrors':error_free,'exploratoryLeaveOneTaskOut':leave_one_out,'notes':['Speed/cost comparisons only use matched successful runs; all failures stay in success-rate denominators','Task-cluster bootstrap is exploratory for only 8 small synthetic tasks','API catalogue estimates include child usage; they are not OAuth subscription credit charges','Failed/incomplete assistant streams are excluded from complete-usage comparisons, even if every observed message included usage','Superseded batch results are preserved separately and not pooled with this corrected, frozen experiment.','Provider-error exclusion and all-task leave-one-out diagnostics were added after observing a provider retry; primary results retain every observation.']}
    result['postHocGradingCorrection']={'record':'grader-correction.json','arms':corrected_arms,'pairedComparisons':corrected_comparisons,
        'withoutProviderErrors':{a+'→'+b:paired([r for r in corrected_rows if not any(m.get('error') for m in r['messages'])],a,b,'seconds') for a,b in [('legacy','routed'),('legacy','terra'),('terra','routed'),('routed','astra')]}}
    save(HERE/'analysis.json',result)
    labels={'legacy':'Sol xhigh + 기존 위임 설정','terra':'Terra high 단독','routed':'Terra high + 역할 분담','astra':'Astra low 단독'}
    lines=['# Pi 모델 비교 결과 — 2026-09-08','',f"상태: {len(rows)}/{len(manifest['schedule'])}회 기록. "+('모든 사전 등록 실행을 수집했다.' if len(rows)==len(manifest['schedule']) else '실행 중이며 최종 순위로 해석하지 않는다.'),'', '| 구성 | 원채점 성공 | 보정 성공 | 완료 시간 중앙값(초, 전체) | 전체 토큰 중앙값 | API 추정 비용 중앙값 | 자식 호출 |','|---|---:|---:|---:|---:|---:|---:|']
    for arm,s in summary['arms'].items():
        tokens=f"{s['medianTokens']:,.0f}" if s['medianTokens'] is not None else '측정 불완전'
        cost=f"${s['medianApiCostEstimateUSD']:.4f}" if s['medianApiCostEstimateUSD'] is not None else '측정 불완전'
        lines.append(f"| {labels[arm]} | {s['successes']}/{s['runs']} | {corrected_arms[arm]['successes']}/{s['runs']} | {s['medianSecondsAll']:.1f} | {tokens} | {cost} | {s['children']} |")
    lines += ['', '성공은 숨긴 테스트, 원래 가시 테스트, 보호 파일 보존, gdm 완료 상태와 최종 완료 마커를 함께 요구한다. 시간은 자식 대기까지 포함하며, 토큰과 API 추정 비용도 자식을 합산한다. 구독 크레딧이나 실제 청구액으로 환산하지 않는다.', '', '보정은 t4의 조회 횟수 단언 하나만 변경했다. 요청은 정확한 갱신과 캐시 최적화를 요구하므로 write-through의 2회 조회도 invalidate-then-read의 3회 조회와 함께 유효하다. 원래의 정확히 3회 단언은 허용 가능한 최적화를 오답 처리했다. 첫 오류 관찰 후 이를 문서화하고 모든 구성·반복의 t4에 동일하게 적용했다. 모델 재실행 없이 원본 로그·채점·비교와 보정 결과를 함께 보존한다. `grader-correction.json`, `grader-correction-validation.json`, `adjudication.json`에 근거가 있다.', '', '## 사전 등록 원채점의 성공 쌍 비교', '', '비율은 오른쪽 구성 ÷ 왼쪽 구성이다. 1 미만이면 오른쪽 구성이 적게 썼다. 실패는 성공률 분모에 남기고 아래 성공 쌍 비교에는 넣지 않는다.', '', '| 비교 | 성공 쌍 | 시간 비율 중앙값 | 과제 bootstrap 95% 구간 | API 비용 비율 중앙값 |', '|---|---:|---:|---|---:|']
    for name,c in comparisons.items():
        t=c['seconds'];cost=c['apiCostEstimateUSD']
        if not t['pairs']:continue
        ci=t.get('taskClusterBootstrap95');interval=f"{ci[0]:.3f}–{ci[1]:.3f}" if ci else '과제 수 부족'
        price=f"{cost['medianRatio']:.3f}" if cost['pairs'] else '측정 불완전'
        lines.append(f"| {name} | {t['pairs']} | {t['medianRatio']:.3f} | {interval} | {price} |")
    lines += ['', '## 채점 오류 보정 후의 성공 쌍 비교', '', '같은 실행에서 허용 가능한 캐시 갱신 전략을 인정한 사후 분석이다. 모델 입력·원시 결과·원채점은 변경하지 않았다.', '', '| 비교 | 성공 쌍 | 시간 비율 중앙값 | 과제 bootstrap 95% 구간 | API 비용 비율 중앙값 |', '|---|---:|---:|---|---:|']
    for name,c in corrected_comparisons.items():
        t=c['seconds'];cost=c['apiCostEstimateUSD']
        if not t['pairs']:continue
        ci=t.get('taskClusterBootstrap95');interval=f"{ci[0]:.3f}–{ci[1]:.3f}" if ci else '과제 수 부족'
        price=f"{cost['medianRatio']:.3f}" if cost['pairs'] else '측정 불완전'
        lines.append(f"| {name} | {t['pairs']} | {t['medianRatio']:.3f} | {interval} | {price} |")
    lines += ['', '## 탐색적 민감도 분석', '', '다음 세 수치는 원채점 기준이다. 작은 첫 과제 하나가 결과를 좌우하는지 확인하도록 t1을 제외한 시간 비율을 제시한다.', '']
    for name,c in sensitivity.items():
        if c['pairs']:lines.append(f"- t1 제외 {name}: {c['pairs']}쌍, 시간 비율 중앙값 {c['medianRatio']:.3f}")
    lines += ['', '첫 실행의 서비스 재시도를 관찰한 뒤 다음 탐색 분석을 추가했다. 주 비교에서는 해당 실행을 제거하지 않는다. 원채점에서 오류가 보고된 main 실행을 제외한 성공 쌍은 다음과 같다. 자식 오류는 별도 위임 기록으로 남긴다.', '']
    for name,c in error_free.items():
        if c['pairs']:lines.append(f"- main 서비스 오류 제외 {name}: {c['pairs']}쌍, 시간 비율 중앙값 {c['medianRatio']:.3f}")
    lines += ['', '각 과제를 하나씩 제외한 원채점 민감도 분석은 `analysis.json`의 `exploratoryLeaveOneTaskOut`에 보존한다.', '', '채점 오류를 보정하고 main 서비스 오류가 있었던 실행을 제외한 결과도 별도로 계산했다.', '']
    for name,c in result['postHocGradingCorrection']['withoutProviderErrors'].items():
        if c['pairs']:lines.append(f"- 보정 후 main 서비스 오류 제외 {name}: {c['pairs']}쌍, 시간 비율 중앙값 {c['medianRatio']:.3f}")
    lines += ['', '## 위임과 실패', '']
    for arm,a in arm_rows.items():
        counts={}
        for child in a['delegations']:
            key=child['role']+' / '+str(child['model'])+' / '+str(child['thinking']);counts[key]=counts.get(key,0)+1
        attempts = a['delegateAttempts']
        lines.append(f"- {arm}: 위임 도구 시도 {len(attempts)}회, 거부 {sum(x.get('rejected', False) for x in attempts)}회, 실제 자식 실행 {len(a['delegations'])}회. "+('; '.join(f'{k}: {v}회' for k,v in counts.items()) if counts else '실행된 자식 없음.'))
        if a['failedRunIds']:lines.append('  원채점 실패: '+', '.join(a['failedRunIds']))
        if corrected_arms[arm]['failedRunIds']:lines.append('  보정 후에도 실패: '+', '.join(corrected_arms[arm]['failedRunIds']))
        if a['providerErrorRunIds']:lines.append('  main 서비스 오류 관찰(자동 재시도 후 성공 포함): '+', '.join(a['providerErrorRunIds']))
    lines += ['', '## 해석 범위', '', '- 작은 합성 과제 8종이며 3종은 기존 실험에서 재사용했다. 새로운 5종은 결함 주입 상태와 정답 구현으로 숨긴 테스트를 검증했다.', '- 모델·추론 강도는 Pi 요청과 응답 메타데이터다. 원격 모델 신원을 독립적으로 증명하지 않는다.', '- 실행기·지침·과제·순서·시간 상한은 manifest에 고정했다. memory, Computer Use, gdm-full의 공식 검수는 이 비교에서 제외했다.', '- 위임을 호출하지 않은 관측은 Terra 메인 변경과 도구 노출 효과를 보는 관측이다. 그 관측으로 Luna/Astra 협업의 품질 향상을 주장하지 않는다.', '- 짧은 코드 테스트가 모두 통과해도 실제 프로젝트의 동등한 품질을 입증하지 않는다. 작은 표본의 bootstrap 구간은 탐색적인 불확실성 표시다.', '', '## 재현 자료', '', f'- 원시 실행: `{run}`', '- 실행 계약: `active-run.json` → `manifest.json`', '- 분석 원자료와 과제별 비율: `analysis.json`', '- 독립 재채점과 설치 확인: `verification.json` (완료 검사 후 생성)', '- 비교 전 예비 실행: `canary.json` (주 비교에 미포함)', '- 초기 배치 중단: `superseded-batch.json`. 설계 역할을 막는 이전 스킬 문구를 수정하기 전의 완료 10건과 중단 1건은 보존하며 최종 비교에 합치지 않는다.', '']
    (HERE/'results-2026-09-08.md').write_text('\n'.join(lines))
    print(f"completed={len(rows)}/{len(manifest['schedule'])}")
    for arm,s in summary['arms'].items():print(arm,s)

if __name__=='__main__':main()
