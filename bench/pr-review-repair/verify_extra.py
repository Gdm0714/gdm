"""Final whole-CLI corroboration of the exploratory BOM observation, no model calls."""
import json,subprocess
from common import HERE,active,hashes,load,save,sha

def main():
 run,m=active();targets=[];rows=[]
 for case in ['C01','C03']:
  for variant in ['reference','candidate']:targets.append((case+'-'+variant,case,run/'frozen/cases'/case/variant))
 for e in m['schedule']:
  if e['case'] in ['C01','C03']:targets.append((e['id'],e['case'],run/'runs'/e['id']/'final-snapshot'))
 assert all(p.is_dir() for _,_,p in targets)
 for label,case,snapshot in targets:
  p=subprocess.run(['bun',str(HERE/'bom-cli-probe.ts'),str(snapshot)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15);assert p.returncode==0,p.stderr
  r={'label':label,'case':case,'sourceSha256':{n:h for n,h in hashes(snapshot).items() if n.startswith('cli/src/')},'result':json.loads(p.stdout)}
  exploratory=load(run/'exploratory'/f'{label}.json')['result'];assert r['result']['refusesWithoutWriteOrSuccessJournal']==exploratory['refusesWithoutWrite'],label;rows.append(r)
 save(HERE/'bom-cli-verification.json',{'manifestSha256':sha((run/'manifest.json').read_bytes()),'probeSha256':sha((HERE/'bom-cli-probe.ts').read_bytes()),'observations':rows,'success':True});print('BOM CLI corroboration passed:',len(rows),'snapshots')
if __name__=='__main__':main()
