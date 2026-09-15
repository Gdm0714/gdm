"""Create deterministic model-label-free packets only after every observation ends."""
import random
from common import HERE, active, hashes, load, save, sha

def main():
 run,m=active()
 entries=m['schedule'][:];random.Random(20260909).shuffle(entries);mapping={};packets=run/'assessment-packets';packets.mkdir(exist_ok=True)
 for i,e in enumerate(entries,1):
  label=f'B{i:02}';mapping[label]=e['id'];d=run/'runs'/e['id']
  if not(d/'result.json').exists():continue
  r=load(d/'result.json');case=run/'frozen/cases'/e['case'];before=case/'candidate';after=d/'final-snapshot';review=load(d/'review-input.json')
  patch=(d/'changes.diff').read_text().replace(str(before/'cli/src'),'candidate/cli/src').replace(str(after/'cli/src'),'final/cli/src')
  bh=hashes(before);ah=hashes(after);changed=[p for p in sorted(set(bh)|set(ah)) if bh.get(p)!=ah.get(p) and p not in ['REVIEW.json','DECISIONS.json']]
  try:decisions=load(after/'DECISIONS.json')
  except (OSError,ValueError):decisions=None
  v={'id':label,'contract':load(case/'meta.json')['contract'],'review':review,'decisions':decisions,'sourceDiff':patch,'changedPaths':changed,'protectedChanges':[p for p in changed if p in bh and not p.startswith('cli/src/')], 'sourceFiles':{p:{'before':(before/p).read_text() if (before/p).is_file() else None,'after':(after/p).read_text() if (after/p).is_file() else None} for p in sorted(set(changed)|{x.get('file','') for x in review.get('findings',[])}) if p and ((before/p).is_file() or (after/p).is_file())},'grading':r['grading']}
  target=packets/(label+'.json')
  if target.exists():assert load(target)==v
  else:save(target,v)
 save(run/'assessment-map.json',mapping);save(run/'assessment-packets-lock.json',hashes(packets));print('Prepared',len(list(packets.glob('B*.json'))),'model-label-free packets; mapping kept separately')
if __name__=='__main__':main()
