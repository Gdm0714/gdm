import statistics
from common import HERE, active, load, save, sha

def metrics(run,m):
 rows=[]
 for e in m['schedule']:
  d=run/'runs'/e['id'];r=load(d/'result.json');meta=load(run/'frozen/cases'/e['case']/'meta.json');known=meta['knownDefects'];g=r['grading']
  passed=g['hidden']['passed'] if g else [];failed=g['hidden']['failed'] if g else []
  hit=[k for k in known if any(x.startswith(k+' ') or x.startswith(k+':') or (' > '+k+':') in x for x in passed)]
  hidden_failed=len(failed) if g else None
  row={**{k:r[k] for k in ['id','case','arm','repetition','seconds','reviewSeconds','repairSeconds','usage','usageComplete','protectedUnchanged','unexpectedAddedFiles','unsafe','decisionsValid','changedSourceFiles','reviewAvailable','reviewRequested','repairTransportSuccess']},'knownDefects':known,'fixedKnownDefects':hit,'remainingKnownDefects':len(known)-len(hit),'hiddenPassed':len(passed),'hiddenFailed':hidden_failed,'visiblePassed':len(g['visible']['passed']) if g else 0,'visibleFailed':len(g['visible']['failed']) if g else None,'functionalPass':bool(g and g['hidden']['exitCode']==0 and g['visible']['exitCode']==0 and r['protectedUnchanged'] and not r['unsafe'] and not r['unexpectedAddedFiles'])}
  rows.append(row)
 summary={}
 for arm in ['self','terra','astra']:
  rs=[r for r in rows if r['arm']==arm];summary[arm]={'runs':len(rs),'functionalPass':sum(r['functionalPass'] for r in rs),'knownDefectOpportunities':sum(len(r['knownDefects']) for r in rs),'fixedKnownDefects':sum(len(r['fixedKnownDefects']) for r in rs),'remainingKnownDefects':sum(r['remainingKnownDefects'] for r in rs),'hiddenGroupsPassed':sum(r['hiddenPassed'] for r in rs),'hiddenGroupsTotal':8*len(rs),'visibleTestFailures':sum(r['visibleFailed'] or 0 for r in rs),'protectedViolations':sum(not r['protectedUnchanged'] or bool(r['unexpectedAddedFiles']) or r['unsafe'] for r in rs),'cleanCandidateSourceEdits':sum(bool(r['changedSourceFiles']) for r in rs if r['case']=='C03'),'medianSeconds':statistics.median(r['seconds'] for r in rs),'totalSeconds':sum(r['seconds'] for r in rs),'medianReviewSeconds':statistics.median(r['reviewSeconds'] for r in rs),'medianRepairSeconds':statistics.median(r['repairSeconds'] for r in rs),'tokens':sum(r['usage']['totalTokens'] for r in rs),'apiCostEstimateUSD':sum(r['usage']['apiCostEstimateUSD'] for r in rs),'allUsageComplete':all(r['usageComplete'] for r in rs),'reviewAvailable':sum(r['reviewAvailable'] for r in rs),'repairsTransportSuccess':sum(r['repairTransportSuccess'] for r in rs)}
 ratios={}
 for a,b in [('self','terra'),('self','astra'),('terra','astra')]:
  pairs=[(next(r for r in rows if r['arm']==a and r['case']==case and r['repetition']==rep),next(r for r in rows if r['arm']==b and r['case']==case and r['repetition']==rep)) for case in ['C01','C02','C03'] for rep in [1,2]]
  ratios[a+'->'+b]={'medianPairedTimeRatio':statistics.median(y['seconds']/x['seconds'] for x,y in pairs),'medianPairedApiCostRatio':statistics.median(y['usage']['apiCostEstimateUSD']/x['usage']['apiCostEstimateUSD'] for x,y in pairs)}
 return {'manifestSha256':sha((run/'manifest.json').read_bytes()),'rows':rows,'arms':summary,'pairedRatios':ratios}
if __name__=='__main__':
 run,m=active();v=metrics(run,m);save(HERE/'analysis.json',v);print(__import__('json').dumps(v['arms'],indent=2))
