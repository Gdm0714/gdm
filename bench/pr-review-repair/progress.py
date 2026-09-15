import time
from common import active,load
run,m=active();finished=[]
for e in m['schedule']:
 d=run/'runs'/e['id'];p=d/'result.json'
 if p.exists():
  r=load(p);g=r['grading'];finished.append(r)
for p in sorted((run/'runs').glob('*/*/invocation.json')):
 if not(p.parent/'result.json').exists():print('RUNNING',p.parent.parent.name,p.parent.name,round(time.time()-load(p)['startedAt']),'seconds')
calls=[load(p) for p in (run/'runs').glob('*/*/result.json')]
print('CALLS',len(calls),'/',m['plannedCalls'],'transport successes',sum(c['transportSuccess'] for c in calls),'usage complete',sum(c['usageComplete'] and c['transportSuccess'] for c in calls))
print('PIPELINES',len(finished),'/',len(m['schedule']))
for r in finished:
 g=r['grading'];print(r['id'],r['case'],r['arm'], 'hidden',str(len(g['hidden']['passed']))+'/8' if g else 'ungraded','public failures',len(g['visible']['failed']) if g else '?')
