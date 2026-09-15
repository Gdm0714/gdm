"""Check corrected accounting, locked adjudication and uniformly bound posthoc evidence."""
from collections import Counter
import json
from common import HERE,active,hashes,load,sha
from supplement import supplement
from finalize import assessments,aggregate

def main():
 run,m=active();digest=sha((run/'manifest.json').read_bytes())
 s=load(HERE/'supplement.json');assert s==json.loads(json.dumps(supplement(run,m)))
 a=load(HERE/'change-assessment.json');assert a==assessments(run,m)
 f=load(HERE/'final-analysis.json');assert f==aggregate(run,m,a)
 assert f['completedRepairPipelines']==15 and f['incompleteIds']==['P15','P17','P18']
 assert f['actualCalls']=={'review':{'attempted':12,'launched':12,'modelResponseObserved':11,'transportSuccess':11},'repair':{'attempted':18,'launched':18,'modelResponseObserved':17,'transportSuccess':15}}
 assert all(all(r['gradingCoverageComplete'].values()) for r in s['rows'])
 snapshots={case+'-'+variant:run/'frozen/cases'/case/variant for case in ['C01','C02','C03'] for variant in ['reference','candidate']}
 snapshots.update({e['id']:run/'runs'/e['id']/'final-snapshot' for e in m['schedule']})
 recovery={k for k,p in snapshots.items() if k.startswith(('C01','C03')) or any(e['id']==k and e['case']!='C02' for e in m['schedule'])}
 delivery=set(snapshots)-recovery
 configs=[('bom-cli-verification.json','bom-cli-probe.ts',recovery),('evidence-cli-verification.json','evidence-cli-probe.ts',set(snapshots)),('merge-repeat-verification.json','merge-repeat-probe.ts',delivery)]
 for filename,probe,expected in configs:
  v=load(HERE/filename);assert v['success'] and v['manifestSha256']==digest and v['probeSha256']==sha((HERE/probe).read_bytes())
  assert Counter(r['label'] for r in v['observations'])==Counter(expected)
  for r in v['observations']:assert r['sourceSha256']=={n:h for n,h in hashes(snapshots[r['label']]).items() if n.startswith('cli/src/')}
 bom={r['label']:r['result'] for r in load(HERE/'bom-cli-verification.json')['observations']}
 for k,v in bom.items():
  assert v['refusesWithoutWriteOrSuccessJournal']==(v['exitCode']!=0 and v['bytesUnchanged'] and v['successJournals']==0)
  assert not v['loadable']
 ex=load(HERE/'exploratory.json');assert ex['manifestSha256']==digest;assert Counter(r['label'] for r in ex['probes'])==Counter(list(snapshots))
 for r in ex['probes']:
  assert r['binding']['sourceSha256']=={n:h for n,h in hashes(snapshots[r['label']]).items() if n.startswith('cli/src/')}
  if r['label'] in bom:assert r['result']['refusesWithoutWrite']==bom[r['label']]['refusesWithoutWriteOrSuccessJournal']
 evidence=load(HERE/'evidence-cli-verification.json')['observations']
 assert [r['label'] for r in evidence if not r['result']['protectsStaleEvidence']]==['P16']
 for r in evidence:
  v=r['result'];assert Counter(x['mode'] for x in v['results'])==Counter(['intact','deleted','tampered','new-output'])
  for x in v['results']:
   if x['mode'] in ['intact','new-output']:assert x['exitCode']==0 and x['done']
   elif r['label']=='P16':assert x['exitCode']==0 and x['done'] and x['staleEvents']==0
   else:assert x['exitCode']!=0 and not x['done'] and x['checkStatus']=='open' and x['staleEvents']>0
 for arm,bompass in [('self',1),('terra',2),('astra',3)]:
  c=f['matchedCohort'][arm];assert c['runs']==4 and c['knownTargetsFixed']==c['targetOpportunities']==6 and c['hiddenPassed']==32 and c['publicPassed']==431 and c['bomPass']==bompass and c['bomObservations']==3
 failed=[]
 for e in m['schedule']:
  for role in (['repair'] if e['arm']=='self' else ['review','repair']):
   if not load(run/'runs'/e['id']/role/'result.json')['transportSuccess']:failed.append((e['id'],role))
 incidents=load(HERE/'execution-incidents.json');assert Counter(failed)==Counter((r['id'],r['role']) for r in incidents['failedRoleObservations'])
 for r in incidents['failedRoleObservations']:
  d=run/'runs'/r['id']/r['role'];assert r['rawLogSha256']==sha((d/'events.jsonl').read_bytes()) and r['resultSha256']==sha((d/'result.json').read_bytes())
 assert load(HERE/'infrastructure-incident.json')['powerLogSha256']==sha((HERE/'power-incident.log').read_bytes())
 cohortids={rid for c in f['matchedCohort'].values() for rid in c['ids']}
 assert all(abs(r['wallMinusReported'])<1 for r in load(HERE/'timing-audit.json') if r['id'] in cohortids)
 report=(HERE/'results-2026-09-09.md').read_text()
 assert '| 사후 BOM 복구 검사 | 1/3 | 2/3 | 3/3 |' in report
 assert '| 사전 목표 결함 수정 기회 | 6/6 | 6/6 | 6/6 |' in report
 for c in f['matchedCohort'].values():assert f"${c['apiCostEstimateUSD']:.5f}" in report
 assert 'Astra는 정상 리뷰 5회' in report and '정상적인 리뷰+수정 파이프라인은 18개 중 15개' in report and 'P16만 삭제/변조를 놓쳤' in report
 print('FINAL PASS: 30 role attempts/26 normal transports; 15 completed pipelines; 4 matched triples; 18 locked assessments; 16 BOM and 24 evidence snapshots; preserved failures, source bindings and report totals')
if __name__=='__main__':main()
