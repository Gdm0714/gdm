"""Exploratory probe prompted by a real review finding; never changes primary scores."""
from pathlib import Path
import shutil
import tempfile
from common import HERE, load, save, sha, grade

PROBE="""import {expect,test} from 'bun:test';
import {Store} from './src/store';
import {Reservations} from './src/service';
test('exploratory runtime non-string identities are rejected without state changes',()=>{
  for (const id of [1, {}, ['id']] as any[]) {
    const store=new Store([{sku:'s',available:1,version:0}]);const r=new Reservations(store);
    const before=store.snapshot();expect(()=>r.hold(id,'s',1,0,0,1)).toThrow();expect(store.snapshot()).toEqual(before);
  }
});
"""
def main():
    run=Path(load(HERE/'active-run.json')['path']);trigger=run/'runs/reservation-lifecycle-terra_team-1';r=load(trigger/'result.json')
    reviews=[p for p in r['phaseEvidence']['phases'] if p['role']=='reviewer'];assert reviews[0]['response']['findings'][0]['id']=='R1'
    root=Path(tempfile.mkdtemp(prefix='gdm-quality-exploratory-identity-'))
    receipt={'schema':'gdm-quality-exploratory-review/v1','root':str(root),'triggerRun':r['id'],'triggerEventsSha256':sha((trigger/'events.jsonl').read_bytes()),
      'probe':PROBE,'probeSha256':sha(PROBE.encode()),'primaryScoreChanged':False,
      'interpretation':'Added after observing Terra reviewer R1. Tests runtime rejection beyond the static string signature; this is an exploratory robustness check, not a new preregistered requirement group. All three arms receive the same probe. R2 overflow uses arithmetic outside the explicitly bounded task domain and earns no defect-removal credit.',
      'results':[]}
    for arm in ['solo','terra_team','astra_team']:
        log=run/'runs'/f'reservation-lifecycle-{arm}-1';result=load(log/'result.json')
        snapshots=[('final',log/'final-snapshot')]
        if result['phaseEvidence'].get('preReviewSnapshot'):snapshots.append(('preReview',log/'trace/snapshots'/result['phaseEvidence']['preReviewSnapshot']))
        for label,snapshot in snapshots:
            work=root/arm/label;shutil.copytree(snapshot,work)
            (work/'exploratory.test.ts').write_text(PROBE)
            observed=grade(work,'./exploratory.test.ts',work.parent/f'{label}.log')
            receipt['results'].append({'arm':arm,'snapshot':label,'sourceSnapshot':str(snapshot),'result':observed})
    save(HERE/'exploratory-review.json',receipt)
    print([(r['arm'],r['snapshot'],r['result']['exitCode']) for r in receipt['results']])
if __name__=='__main__':main()
