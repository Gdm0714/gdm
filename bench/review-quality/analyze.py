import argparse
import random
import statistics
from common import HERE, active, load, save, sha

LABELS={'known_true_positive','additional_confirmed','unsupported','out_of_scope','duplicate','unresolved'}

def blind(run,m):
    assert all((run/'reviews'/e['id']/'result.json').exists() for e in m['schedule'])
    rows=[];mapping={};entries=list(m['schedule']);random.Random(41319).shuffle(entries)
    for i,e in enumerate(entries,1):
        r=load(run/'reviews'/e['id']/'result.json');bid=f'B{i:02d}';mapping[bid]=e['id']
        rows.append({'blindId':bid,'case':e['case'],'usable':r['transportSuccess'] and r['responseValid'],
                     'response':r['response'],'final':r['final'] if not r['responseValid'] else None})
    # Mapping is stored separately and is not included in the adjudication packet.
    save(run/'blind-map.json',mapping)
    save(HERE/'blind-reviews.json',{'manifestSha256':sha((run/'manifest.json').read_bytes()),'reviews':rows})
    print('Created model-anonymous reviews. Adjudicate every finding before --report.')

def metrics(rows,truth,adjudications):
    out={};detail=[]
    for arm in ['terra','astra']:
        group=[r for r in rows if r['arm']==arm];known=0;den=0;tp=0;fp=0;unresolved=0;duplicates=0;controlAlarms=0;controls=0;usable=0;highFound=0;highDen=0
        bycase={}
        for r in group:
            t=truth[r['case']];labels=[a for a in adjudications if a['review']==r['id']]
            valid=r['transportSuccess'] and r['responseValid'];usable+=valid
            hit=valid and any(a['label']=='known_true_positive' for a in labels)
            den+=t['defective'];known+=bool(t['defective'] and hit)
            highDen+=bool(t['defective'] and t['severity']=='high');highFound+=bool(t['defective'] and t['severity']=='high' and hit)
            good=sum(a['label'] in ['known_true_positive','additional_confirmed'] for a in labels)
            bad=sum(a['label'] in ['unsupported','out_of_scope'] for a in labels)
            unknown=sum(a['label']=='unresolved' for a in labels)
            tp+=good;fp+=bad;unresolved+=unknown;duplicates+=sum(a['label']=='duplicate' for a in labels)
            if not t['defective']:controls+=1;controlAlarms+=bad>0
            bycase.setdefault(r['case'],[]).append({'valid':valid,'knownDetected':hit,'unsupportedCount':bad,'unknownCount':unknown})
            detail.append({'id':r['id'],'arm':arm,'case':r['case'],'family':t['family'],'defective':t['defective'],
                          'repetition':r['repetition'],'usable':valid,'detected':hit,'confirmed':good,'unsupported':bad,'unresolved':unknown})
        denom=tp+fp+unresolved
        out[arm]={'observations':len(group),'usable':usable,'knownDetected':known,'knownOpportunities':den,
          'knownRecall':known/den if den else None,'highDetected':highFound,'highOpportunities':highDen,
          'confirmedFindings':tp,'unsupportedFindings':fp,'unresolvedFindings':unresolved,'duplicates':duplicates,
          'precisionLower':tp/denom if denom else None,'precisionUpper':(tp+unresolved)/denom if denom else None,
          'controlFalseAlarmRuns':controlAlarms,'controlRuns':controls,
          'repeatAgreement':sum(len(v)==2 and v[0]==v[1] for v in bycase.values()),'repeatPairs':len(bycase),
          'medianSeconds':statistics.median(r['seconds'] for r in group if not r.get('latencyExcluded')),'latencyObservations':sum(not r.get('latencyExcluded') for r in group),'totalSeconds':sum(r['seconds'] for r in group),
          'apiCostEstimateUSD':sum(r['usage']['apiCostEstimateUSD'] for r in group),
          'totalTokens':sum(r['usage']['totalTokens'] for r in group),'usageComplete':all(r['usageComplete'] for r in group)}
    pairs=[]
    for case,t in truth.items():
        for rep in [1,2]:
            a=next(r for r in detail if r['case']==case and r['repetition']==rep and r['arm']=='astra')
            b=next(r for r in detail if r['case']==case and r['repetition']==rep and r['arm']=='terra')
            pairs.append({'case':case,'family':t['family'],'repetition':rep,'defective':t['defective'],
                          'astraDetected':a['detected'],'terraDetected':b['detected'],
                          'astraUnsupported':a['unsupported'],'terraUnsupported':b['unsupported']})
    return {'arms':out,'observations':detail,'pairs':pairs}

def report(run,m):
    assert (HERE/'adjudication-lock.json').exists(),'freeze anonymous adjudications before unblinding'
    lock=load(HERE/'adjudication-lock.json')
    for name,h in lock['sha256'].items():assert sha((HERE/name).read_bytes())==h
    blindmap=load(run/'blind-map.json');adj=load(HERE/'adjudications.json')['findings']
    adjudications=[{**a,'review':blindmap[a['blindId']]} for a in adj]
    rows=[{**load(run/'reviews'/e['id']/'result.json'),'arm':e['arm'],'latencyExcluded':e['id'] in m.get('amendment',{}).get('latencyExcluded',[])} for e in m['schedule']]
    truth={t['case']:t for t in load(run/'frozen/truth.json')}
    result=metrics(rows,truth,adjudications);result['manifestSha256']=sha((run/'manifest.json').read_bytes())
    save(HERE/'analysis.json',result)
    lines=['# Terra / Astra 동일 입력 리뷰 비교','',
      '실제 GDM 결함 4종 × 결함/수정 대조 × 모델 2종 × 2회 = 32회. 두 모델 모두 medium. 도구 없이 같은 코드와 계약을 입력했다.',
      '실제 코드에서 관련 부분을 추출·재구성한 파일 추가 리뷰이며, 전체 PR이나 최종 구현 품질 평가가 아니다.','',
      '| 지표 | Terra | Astra |','|---|---:|---:|']
    a=result['arms']['terra'];b=result['arms']['astra']
    specs=[('사용 가능한 리뷰',lambda x:f"{x['usable']}/{x['observations']}"),
      ('알려진 결함 발견',lambda x:f"{x['knownDetected']}/{x['knownOpportunities']}"),
      ('높은 심각도 결함 발견',lambda x:f"{x['highDetected']}/{x['highOpportunities']}"),
      ('확인된 / 근거 없는 지적',lambda x:f"{x['confirmedFindings']} / {x['unsupportedFindings']}"),
      ('미확정 지적',lambda x:str(x['unresolvedFindings'])),
      ('수정 대조에서 오탐 발생',lambda x:f"{x['controlFalseAlarmRuns']}/{x['controlRuns']}"),
      ('입력별 반복 판정 일치',lambda x:f"{x['repeatAgreement']}/{x['repeatPairs']}"),
      ('리뷰 시간 중앙값',lambda x:f"{x['medianSeconds']:.1f}초"),
      ('전체 API 정가 추정',lambda x:f"${x['apiCostEstimateUSD']:.4f}")]
    lines += [f'| {label} | {fn(a)} | {fn(b)} |' for label,fn in specs]
    lines += ['', '## 가족별 발견 결과','', '| 결함 유형 | Terra | Astra |','|---|---:|---:|']
    for family in ['effort','launch','audit','atomic']:
        group=[r for r in result['observations'] if r['family']==family and r['defective']]
        lines.append(f"| {family} | {sum(r['detected'] for r in group if r['arm']=='terra')}/2 | {sum(r['detected'] for r in group if r['arm']=='astra')}/2 |")
    lines += ['', '## 해석 범위','',
      '- 32회는 독립 작업 32개가 아니다. 실제 결함 가족은 4개이며 수정 대조와 반복 실행은 같은 코드를 공유한다.',
      '- 정상 대조는 표적 결함을 수정한 버전이다. 모든 가능한 결함이 없다는 보장은 아니다.',
      '- 모든 지적은 모델명을 제거한 뒤 루트 AI 진행자가 계약·코드·재현 근거로 판정했다. 독립된 사람 검수 결과가 아니다.',
      '- 모델 신원·사용량은 Pi가 보고한 메타데이터이며 원격 증명이나 OAuth 실제 청구액이 아니다.',
      '- 같은 medium은 같은 연산량을 보장하지 않는다. 순차 교차 순서로 실행했지만 서버 부하와 캐시를 통제하지 않았다.',
      '- 리뷰 지적을 구현자가 반영하는 과정, 설계 품질, 후속 변경 난이도와 사람의 수정 시간은 이번 실험에서 측정하지 않았다.',
      '- 입력 검사에서 C01/C03 보조 함수 본문 누락을 발견해 해당 사례의 첫 호출 전에 수정했다. 이미 실행된 R01–R08은 입력이 동일함을 해시로 확인해 보존했다. 출력 내용을 보고 수정하거나 관측을 재시도하지 않았다.',
      '- 중단 시점 R08의 실행 시간에 감독 프로세스 일시정지가 포함돼 R07/R08 짝을 시간 중앙값에서 제외했다. 원본 시간과 사용량은 보존한다. 이번 결과만으로 설치된 모델 정책을 변경하지 않는다.',
      '', f'원본 실행: `{run}`',f"Manifest SHA-256: `{result['manifestSha256']}`",'']
    (HERE/'results-2026-09-09.md').write_text('\n'.join(lines))
    print(result['arms'])

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--blind',action='store_true');p.add_argument('--report',action='store_true');o=p.parse_args()
    run,m=active()
    if o.blind:blind(run,m)
    if o.report:report(run,m)
