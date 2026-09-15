"""Uniform reporting clarification; frozen primary analyzer is retained unchanged.
Separates measured code behavior from edit-policy compliance. Estimates compare
only complete matched usage observations; no model input or score is changed.
"""
import statistics
from collections import Counter
from pathlib import Path
from common import HERE, active, hashes, load, save, sha

def supplement(run,m):
 rows=[]
 for e in m['schedule']:
  d=run/'runs'/e['id'];r=load(d/'result.json');before=hashes(run/'frozen/cases'/e['case']/'candidate');after=r['finalSha256'];g=r['grading'];baseline=load(HERE/'fixtures-validation.json')['results'][e['case']+'-candidate']
  protected=[p for p,h in before.items() if not p.startswith('cli/src/') and after.get(p)!=h]
  reference=load(HERE/'fixtures-validation.json')['results'][e['case']+'-reference']
  coverage={phase:bool(g and Counter(g[phase]['passed']+g[phase]['failed'])==Counter(reference[phase]['passed']+reference[phase]['failed'])) for phase in ['hidden','visible']}
  observed={role:load(d/role/'result.json') for role in (['repair'] if e['arm']=='self' else ['review','repair'])}
  normalCompletion=bool(r['repairTransportSuccess'] and (not r['reviewRequested'] or r['reviewAvailable']))
  usageComplete=bool(r['usageComplete'] and all(v['transportSuccess'] for v in observed.values()))
  reviewReads=[]
  if 'review' in observed:
   for call in observed['review']['calls']:
    if call['name']=='read' and isinstance(call.get('args'),dict):
     path=Path(call['args'].get('path',''));absolute=path if path.is_absolute() else d/'workspace'/path
     try:reviewReads.append(str(absolute.resolve().relative_to((d/'workspace').resolve())))
     except ValueError:reviewReads.append('OUTSIDE:'+str(path))
  reviewAccess={'contractReadRequested':'PR.md' in reviewReads,'diffReadRequested':'PR.diff' in reviewReads,'sourceReadRequests':sorted(set(p for p in reviewReads if p.startswith('cli/src/'))),'outsideReadRequests':[p for p in reviewReads if p.startswith('OUTSIDE:')]}
  substantive={}
  for role in observed:
   events=[__import__('json').loads(line) for line in (d/role/'events.jsonl').read_text().splitlines() if line.strip()]
   substantive[role]=any(ev.get('type')=='message_end' and ev.get('message',{}).get('role')=='assistant' and ev['message'].get('stopReason') not in ['error','aborted'] and any(c.get('type') in ['text','toolCall'] for c in ev['message'].get('content',[])) for ev in events)
  invocationCounts={role:{'attempted':1,'launched':int(o['launched']),'modelResponseObserved':int(substantive[role] and o['reportedModels']==[m['mainModel'] if role=='repair' else m['reviewerModels'][e['arm']]]),'transportSuccess':int(o['transportSuccess'])} for role,o in observed.items()}
  row={**e,'testsPass':bool(g and all(coverage.values()) and g['hidden']['exitCode']==g['visible']['exitCode']==0),'gradingCoverageComplete':coverage,'normalCompletion':normalCompletion,'completedTestsPass':bool(normalCompletion and g and all(coverage.values()) and g['hidden']['exitCode']==g['visible']['exitCode']==0),'observedCalls':invocationCounts,'reviewReadRequests':reviewAccess,'protectedChangedPaths':protected,'newHiddenFailures':sorted(set(g['hidden']['failed'])-set(baseline['hidden']['failed'])) if g else None,'newPublicFailures':sorted(set(g['visible']['failed'])-set(baseline['visible']['failed'])) if g else None,'seconds':r['seconds'],'usageComplete':usageComplete,'rawUsageCompleteFlag':r['usageComplete'],'recordedApiCostEstimateUSD':r['usage']['apiCostEstimateUSD'],'reviewCalls':0 if e['arm']=='self' else 1,'repairCalls':1}
  rows.append(row)
 arms={}
 for arm in ['self','terra','astra']:
  rs=[r for r in rows if r['arm']==arm];arms[arm]={'finalTestsPass':sum(r['completedTestsPass'] for r in rs),'snapshotTestsPass':sum(r['testsPass'] for r in rs),'normalCompletions':sum(r['normalCompletion'] for r in rs),'completeGradingRuns':sum(all(r['gradingCoverageComplete'].values()) for r in rs),'totalRuns':len(rs),'newHiddenFailures':sum(len(r['newHiddenFailures'] or []) for r in rs),'newPublicFailures':sum(len(r['newPublicFailures'] or []) for r in rs),'protectedEditRuns':sum(bool(r['protectedChangedPaths']) for r in rs),'completeUsageRuns':sum(r['usageComplete'] for r in rs),'totalRecordedApiCostEstimateUSD':sum(r['recordedApiCostEstimateUSD'] for r in rs),'costTotalComplete':all(r['usageComplete'] for r in rs),'costTotalLabel':'complete API list estimate' if all(r['usageComplete'] for r in rs) else 'partial recorded lower bound; not comparable as an arm total'}
 pairs={}
 for a,b in [('self','terra'),('self','astra'),('terra','astra')]:
  matched=[];excluded=[]
  for case in ['C01','C02','C03']:
   for rep in [1,2]:
    x=next(r for r in rows if r['arm']==a and r['case']==case and r['repetition']==rep);y=next(r for r in rows if r['arm']==b and r['case']==case and r['repetition']==rep)
    if x['usageComplete'] and y['usageComplete'] and x['recordedApiCostEstimateUSD']>0:matched.append(y['recordedApiCostEstimateUSD']/x['recordedApiCostEstimateUSD'])
    else:excluded.append([x['id'],y['id']])
  pairs[a+'->'+b]={'completePairs':len(matched),'excludedPairs':excluded,'medianApiCostRatio':statistics.median(matched) if matched else None}
 keys=[(case,rep) for case in ['C01','C02','C03'] for rep in [1,2] if all(next(r for r in rows if r['arm']==arm and r['case']==case and r['repetition']==rep)['normalCompletion'] and next(r for r in rows if r['arm']==arm and r['case']==case and r['repetition']==rep)['usageComplete'] for arm in ['self','terra','astra'])]
 cohort={}
 for arm in ['self','terra','astra']:
  rs=[r for r in rows if r['arm']==arm and (r['case'],r['repetition']) in keys]
  cohort[arm]={'ids':[r['id'] for r in rs],'runs':len(rs),'medianSeconds':statistics.median(r['seconds'] for r in rs),'totalSeconds':sum(r['seconds'] for r in rs),'apiCostEstimateUSD':sum(r['recordedApiCostEstimateUSD'] for r in rs),'medianApiCostEstimateUSD':statistics.median(r['recordedApiCostEstimateUSD'] for r in rs),'testsPass':sum(r['completedTestsPass'] for r in rs)}
 return {'manifestSha256':sha((run/'manifest.json').read_bytes()),'scriptSha256':sha((HERE/'supplement.py').read_bytes()),'clarification':'Frozen functionalPass is a strict combined result. testsPass reports code behavior under original tests separately from protected-file policy. Only complete usage contributes to paired cost estimates. Added during execution after methodology QA; amended after host-sleep interruption. Incomplete final streams are partial usage even if all finished messages had valid usage. Model inputs, known targets and schedule unchanged.','rows':rows,'arms':arms,'completeCostPairs':pairs,'matchedThreeArmCohort':{'caseRepetitionKeys':keys,'arms':cohort},'actualCalls':{role:{k:sum(r['observedCalls'].get(role,{}).get(k,0) for r in rows) for k in ['attempted','launched','modelResponseObserved','transportSuccess']} for role in ['review','repair']}}
if __name__=='__main__':
 run,m=active();s=supplement(run,m);save(HERE/'supplement.json',s);print(__import__('json').dumps(s['arms'],indent=2))
