"""Report every preregistered observation; never discard workflow or model failures."""
from pathlib import Path
import statistics
from common import HERE, load, save

def analyze(run):
    manifest=load(run/'manifest.json');rows=[load(run/'runs'/e['id']/'result.json') for e in manifest['schedule'] if (run/'runs'/e['id']/'result.json').exists()]
    arms={};details=[]
    labels={'solo':'Terra 단독','terra_team':'Terra 설계·검토','astra_team':'Astra 설계·검토'}
    for arm in manifest['arms']:
        rr=[r for r in rows if r['arm']==arm];cost=[r for r in rr if r['usageComplete'] and r['exitCode']==0 and not r['timeout']]
        children=[c for r in rr for c in r['children']];attempts=[a for r in rr for a in r['delegateAttempts']]
        groups=sum(len(load(run/'frozen/fixtures-validation.json')['tasks'][r['task']]['groups']) for r in rr)
        passed=sum(len(r.get('grading',{}).get('final',{}).get('hidden',{}).get('passed',[])) for r in rr)
        repaired=sum(len(r['grading']['final']['hidden']['passed'])-len(r['grading']['preReview']['hidden']['passed']) for r in rr if 'preReview' in r.get('grading',{}))
        arms[arm]={'runs':len(rr),'functionalPasses':sum(r['functionalPass'] for r in rr),'successfulCompletions':sum(r['success'] for r in rr),
          'workflowCompliant':sum(r['phaseEvidence']['compliant'] for r in rr),'gdmDone':sum(r['workDone'] for r in rr),'groupsPassed':passed,'groupsTotal':groups,
          'delegateToolAttempts':len(attempts),'rejectedAttempts':sum(a.get('rejected',False) for a in attempts),
          'unfinishedAttempts':sum(not a.get('ended',False) for a in attempts),'children':len(children),'successfulChildren':sum(c['ok'] for c in children),
          'roleCounts':{role:sum(c['role']==role and c['ok'] for c in children) for role in ['scout','design','reviewer']},
          'postReviewGroupGain':repaired,'medianSeconds':statistics.median(r['seconds'] for r in rr) if rr else None,
          'totalSeconds':sum(r['seconds'] for r in rr),'usageCompleteRuns':len(cost),
          'medianTokens':statistics.median(r['totalUsage']['totalTokens'] for r in cost) if cost else None,
          'totalApiEstimateUSD':sum(r['totalUsage']['apiCostEstimateUSD'] for r in cost),'failedRunIds':[r['id'] for r in rr if not r['success']]}
    for r in rows:
        final=r.get('grading',{}).get('final',{}).get('hidden',{});pre=r.get('grading',{}).get('preReview',{}).get('hidden')
        details.append({'id':r['id'],'task':r['task'],'arm':r['arm'],'passedGroups':final.get('passed',[]),'failedGroups':final.get('failed',[]),
          'preReviewPassedGroups':pre.get('passed',[]) if pre else None,'preReviewFailedGroups':pre.get('failed',[]) if pre else None,
          'seconds':r['seconds'],'functionalPass':r['functionalPass'],'success':r['success'],'workflowIssues':r['phaseEvidence']['issues'],
          'completionIssues':([] if r['doneMarker'] else ['사전 등록 완료 마커 형식 불일치']) + ([] if r['workDone'] else ['gdm 완료 없음']) + ([] if r['agentEnded'] and r['stopReason']=='stop' and r['exitCode']==0 else ['모델 정상 종료 미확인']),
          'phases':r['phaseEvidence']['phases'],'delegateAttempts':r['delegateAttempts'],'timeout':r['timeout'],
          'toolErrors':sum(t['error'] for t in r['tools']),'providerErrors':[m['error'] for m in r['messages'] if m.get('error')]})
    paired={};index={(r['task'],r['arm']):r for r in rows}
    for baseline,candidate in [('solo','terra_team'),('solo','astra_team'),('terra_team','astra_team')]:
        pairs=[]
        for task in manifest['fixtureSha256']:
            a=index.get((task,baseline));b=index.get((task,candidate))
            if not a or not b:continue
            complete=all(r['usageComplete'] and r['exitCode']==0 and not r['timeout'] for r in [a,b])
            pairs.append({'task':task,'secondsRatio':b['seconds']/a['seconds'],
              'apiCostRatio':b['totalUsage']['apiCostEstimateUSD']/a['totalUsage']['apiCostEstimateUSD'] if complete and a['totalUsage']['apiCostEstimateUSD']>0 else None,
              'functionalPasses':[a['functionalPass'],b['functionalPass']]})
        prices=[p['apiCostRatio'] for p in pairs if p['apiCostRatio'] is not None]
        paired[baseline+'→'+candidate]={'pairs':pairs,'medianSecondsRatio':statistics.median(p['secondsRatio'] for p in pairs) if pairs else None,'medianApiCostRatio':statistics.median(prices) if prices else None,'completeCostPairs':len(prices)}
    result={'schema':'gdm-astra-quality-analysis/v1','run':str(run),'completed':len(rows),'planned':len(manifest['schedule']),'arms':arms,'observations':details,'pairedComparisons':paired,'limitations':manifest['limitations']}
    if (HERE/'exploratory-review.json').exists(): result['exploratoryReview']=load(HERE/'exploratory-review.json')
    save(HERE/'analysis.json',result)
    lines=['# Astra 전문 역할 품질 비교 — 2026-09-09','',f"기록: {len(rows)}/{len(manifest['schedule'])}회. 모든 구성의 주 작업자는 Terra high다.",'',
      '| 구성 | 기능 통과 | 숨긴 요구사항 통과 | 역할·순서 준수 | gdm 완료 | 시간 중앙값 | 실제 자식 성공 |','|---|---:|---:|---:|---:|---:|---:|']
    for arm,a in arms.items():
        duration=f"{a['medianSeconds']:.1f}초" if a['runs'] else '미측정'
        lines.append(f"| {labels[arm]} | {a['functionalPasses']}/{a['runs']} | {a['groupsPassed']}/{a['groupsTotal']} | {a['workflowCompliant']}/{a['runs']} | {a['gdmDone']}/{a['runs']} | {duration} | {a['successfulChildren']}/{a['children']} |")
    lines += ['', '기능 통과는 숨긴 검사·원래 가시 검사·보호 파일 보존이다. 전체 완료는 여기에 성공한 모델 종료, 역할·순서 준수, 최종 소스 검토, gdm 완료를 더한다. 역할 준수의 read 기록은 필요한 파일 경로를 성공적으로 읽었다는 근거이며, 전체 내용을 이해했다는 증명은 아니다.', '', '| 구성 | 설계 / 검토 성공 | 거부 / 미종료 시도 | 검토 이후 통과 그룹 증가 | 토큰 중앙값 | API 추정 비용 합계 |', '|---|---:|---:|---:|---:|---:|']
    for arm,a in arms.items():
        tok=f"{a['medianTokens']:,.0f}" if a['medianTokens'] is not None else '불완전'
        lines.append(f"| {labels[arm]} | {a['roleCounts']['design']} / {a['roleCounts']['reviewer']} | {a['rejectedAttempts']} / {a['unfinishedAttempts']} | {a['postReviewGroupGain'] if arm!='solo' else '해당 없음'} | {tok} | ${a['totalApiEstimateUSD']:.4f} ({a['usageCompleteRuns']}회 완전 집계) |")
    lines += ['', '검토 전후 차이는 검토 뒤 수정 과정의 변화다. 설계 자문의 기여를 분리하거나 각 결함을 검토자 덕분에 고쳤다는 인과 증명은 아니다. API 비용은 Pi가 보고한 목록 가격 추정치이며 구독 크레딧이나 실제 청구액이 아니다.', '', '| 같은 과제의 비교 | 쌍 수 | 시간 비율 중앙값 | API 비용 비율 중앙값 |','|---|---:|---:|---:|']
    for name,p in paired.items():
        if p['pairs']:
            price=f"{p['medianApiCostRatio']:.3f} ({p['completeCostPairs']}쌍)" if p['medianApiCostRatio'] is not None else '불완전'
            lines.append(f"| {name} | {len(p['pairs'])} | {p['medianSecondsRatio']:.3f} | {price} |")
    lines += ['', '비율은 오른쪽 구성 ÷ 왼쪽 구성이다. 시간은 실패를 포함한 모든 관측 쌍, 비용은 사용량이 완전한 관측 쌍을 쓴다. 작은 표본이므로 유의성이나 안정적인 순위를 주장하지 않는다.', '', '| 과제 | 구성 | 최종 실패 그룹 | 실행·역할 문제 |','|---|---|---|---|']
    for d in details:
        issues=d['workflowIssues']+d['completionIssues']+(['시간 초과'] if d['timeout'] else [])
        lines.append(f"| {d['task']} | {labels[d['arm']]} | {'; '.join(d['failedGroups']) or '없음'} | {'; '.join(issues) or '없음'} |")
    strict=sum(r['success'] for r in rows)
    lines += ['', f'사전 등록한 전체 success 지표는 {strict}/{len(rows)}다. 위 표는 기능 검사와 실제 gdm 완료를 분리해서 표시하며, 원래 success 판정을 사후 변경하지 않았다. 각 미충족 사유는 위 실행 문제 열과 원시 결과에 남긴다.']
    if 'exploratoryReview' in result:
        lines += ['', '예약 과제의 Terra reviewer R1을 관찰한 뒤, 정적 string 타입 밖의 런타임 입력 방어를 세 구성에 똑같이 추가 검사했다. 원래 36개 그룹 점수에는 포함하지 않은 탐색 검사다. Terra 협업은 검토 전 실패하고 수정 후 통과했으며, Terra 단독 최종 코드와 Astra 협업의 검토 전·최종 코드도 통과했다. 따라서 실제 검토가 그 실행의 입력 방어를 보완한 사례는 있으나 Astra만의 최종 품질 우위는 아니다. 같은 Terra 검토자의 R2 오버플로 요청은 과제에서 명시적으로 제외한 연산 범위여서 결함 제거로 세지 않는다. 상세 입력·로그·해시는 `exploratory-review.json`에 보존한다.']
    lines += ['', '표본은 합성 과제 4종 × 구성당 1회다. 단독과 협업 비교는 계산량과 절차가 함께 달라진다. Terra 협업과 Astra 협업이 검토자 모델 차이에 더 가까운 비교다. 이 결과만으로 안정적인 우열이나 실서비스 품질을 단정하지 않는다. 이전 64회 소과제 결과와 합산하지 않는다.', '', f'원시 실행·동결 입력·검토 전후 소스: `{run}`. `analysis.json`에 과제별 검사와 자문 원문을, `verification.json`에 독립 재채점과 설치 대조를 기록한다.']
    (HERE/'results-2026-09-09.md').write_text('\n'.join(lines)+'\n')
    print({k:v for k,v in result.items() if k in ['completed','planned','arms']})
    return result
if __name__=='__main__':analyze(Path(load(HERE/'active-run.json')['path']))
