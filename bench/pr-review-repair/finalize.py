"""Unblind locked AI assessments and aggregate preserved outcomes; never invokes models."""
from collections import Counter
from common import HERE,active,load,save,sha

def assessments(run,m):
 lock=load(HERE/'assessment-lock.json');mapping=load(run/'assessment-map.json');rows=[]
 supplement=load(HERE/'supplement.json');statuses={r['id']:r for r in supplement['rows']}
 for name,digest in lock['files'].items():
  assert sha((HERE/name).read_bytes())==digest
  for a in load(HERE/name)['assessments']:
   packet=run/'assessment-packets'/(a['packetId']+'.json');assert sha(packet.read_bytes())==a['packetSha256']==lock['packets'][a['packetId']]
   p=load(packet);assert Counter(f['id'] for f in p['review'].get('findings',[]))==Counter(f['findingId'] for f in a['findings'])
   rid=mapping[a['packetId']];d=run/'runs'/rid
   rows.append({'id':rid,'packetId':a['packetId'],'packetSha256':a['packetSha256'],'diffSha256':sha((d/'changes.diff').read_bytes()),'reviewSha256':sha((d/'review-input.json').read_bytes()),'assessment':a['summary'],'findings':a['findings'],'changes':a['sourceChanges'],'protectedChanges':a.get('protectedChanges',[]),'normalCompletion':statuses[rid]['normalCompletion']})
 assert len(rows)==len({r['id'] for r in rows})==18
 return {'manifestSha256':sha((run/'manifest.json').read_bytes()),'assessmentLockSha256':sha((HERE/'assessment-lock.json').read_bytes()),'mapSha256':sha((run/'assessment-map.json').read_bytes()),'assessmentType':'AI source-grounded assessment of model-label-free packets; not human review. Root knew overall experiment and some run outcomes; blinding is partial and not independent human adjudication. All packet assessments locked before map opening.','runs':sorted(rows,key=lambda r:r['id'])}

def aggregate(run,m,a):
 s=load(HERE/'supplement.json');rows={r['id']:r for r in s['rows']};ar={r['id']:r for r in a['runs']}
 bom={r['label']:r['result']['refusesWithoutWriteOrSuccessJournal'] for r in load(HERE/'bom-cli-verification.json')['observations']}
 evidence={r['label']:r['result']['protectsStaleEvidence'] for r in load(HERE/'evidence-cli-verification.json')['observations']}
 observations=[]
 for e in m['schedule']:
  rid=e['id'];r=rows[rid];raw=load(run/'runs'/rid/'result.json');isrecovery=e['case']!='C02'
  observations.append({**e,'completed':r['normalCompletion'],'knownTargetOpportunities':2 if e['case']!='C03' else 0,'knownTargetsFixedInSnapshot':2 if e['case']!='C03' and r['testsPass'] else 0,'hiddenPassed':len(raw['grading']['hidden']['passed']),'publicPassed':len(raw['grading']['visible']['passed']),'bomPreservedOrFixed':bom[rid] if isrecovery else None,'introducedBomRegression':isrecovery and bom[e['case']+'-candidate'] and not bom[rid],'staleEvidenceProtected':evidence[rid],'introducedEvidenceRegression':evidence[e['case']+'-candidate'] and not evidence[rid],'unresolvedSourceChanges':sum(c['classification']=='unresolved' for c in ar[rid]['changes']),'protectedOriginalTestEdit':bool(r['protectedChangedPaths']),'seconds':r['seconds'],'recordedApiCostEstimateUSD':r['recordedApiCostEstimateUSD'],'usageComplete':r['usageComplete']})
 cohort={}
 for arm,base in s['matchedThreeArmCohort']['arms'].items():
  selected=[r for r in observations if r['id'] in base['ids']];bs=[r for r in selected if r['bomPreservedOrFixed'] is not None]
  cohort[arm]={**base,'targetOpportunities':sum(r['knownTargetOpportunities'] for r in selected),'knownTargetsFixed':sum(r['knownTargetsFixedInSnapshot'] for r in selected),'hiddenPassed':sum(r['hiddenPassed'] for r in selected),'publicPassed':sum(r['publicPassed'] for r in selected),'bomObservations':len(bs),'bomPass':sum(r['bomPreservedOrFixed'] for r in bs),'introducedBomRegressions':sum(r['introducedBomRegression'] for r in bs),'evidenceRegressions':sum(r['introducedEvidenceRegression'] for r in selected),'noConfirmedDefectInMeasuredScope':sum(r['bomPreservedOrFixed'] is not False and r['staleEvidenceProtected'] for r in selected),'unresolvedSourceChangeRuns':sum(r['unresolvedSourceChanges']>0 for r in selected),'protectedOriginalTestEditRuns':sum(r['protectedOriginalTestEdit'] for r in selected)}
 findings={}
 for arm in ['terra','astra']:
  fs=[f for r in a['runs'] if rows[r['id']]['arm']==arm for f in r['findings']]
  findings[arm]={'dispositions':dict(Counter(f['classification'] for f in fs)),'total':len(fs),'successfulReviewResponses':sum(rows[r['id']]['observedCalls'].get('review',{}).get('transportSuccess',0) for r in a['runs'] if rows[r['id']]['arm']==arm)}
 return {'manifestSha256':sha((run/'manifest.json').read_bytes()),'actualCalls':s['actualCalls'],'completedRepairPipelines':sum(r['completed'] for r in observations),'incompleteIds':[r['id'] for r in observations if not r['completed']],'cohortKeys':s['matchedThreeArmCohort']['caseRepetitionKeys'],'matchedCohort':cohort,'reviewFindingsAllObserved':findings,'observations':observations,'commonCohortTotalCostRatios':{'astraToTerra':cohort['astra']['apiCostEstimateUSD']/cohort['terra']['apiCostEstimateUSD'],'astraToSelf':cohort['astra']['apiCostEstimateUSD']/cohort['self']['apiCostEstimateUSD'],'terraToSelf':cohort['terra']['apiCostEstimateUSD']/cohort['self']['apiCostEstimateUSD']},'notes':['Posthoc BOM/evidence probes are secondary; never change four target-defect denominator.','All snapshots tested, but only completed matched pipelines contribute to primary model comparison.','No confirmed unnecessary change is not proof of no unnecessary changes: unresolved source changes remain.','API estimates use Pi-reported usage/prices, not actual subscription billing.']}

if __name__=='__main__':
 run,m=active();a=assessments(run,m);save(HERE/'change-assessment.json',a);f=aggregate(run,m,a);save(HERE/'final-analysis.json',f)
 print(__import__('json').dumps({k:v for k,v in f.items() if k!='observations'},indent=2))
