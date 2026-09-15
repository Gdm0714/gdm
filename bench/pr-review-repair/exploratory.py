"""Evaluate all available snapshots uniformly, without model reruns or feedback."""
import json,subprocess
from common import HERE,active,hashes,load,save,sha

def main():
 run,m=active();out=run/'exploratory';out.mkdir(exist_ok=True);rows=[];targets=[]
 for case in ['C01','C02','C03']:
  for variant in ['reference','candidate']:targets.append((case+'-'+variant,case,run/'frozen/cases'/case/variant))
 for e in m['schedule']:
  d=run/'runs'/e['id']
  if(d/'result.json').exists():targets.append((e['id'],e['case'],d/'final-snapshot'))
 for label,case,snapshot in targets:
  kind='merged' if case=='C02' else 'bom';receipt=out/(label+'.json');binding={'sourceSha256':{p:h for p,h in hashes(snapshot).items() if p.startswith('cli/src/')},'probeSha256':sha((HERE/'extra-probes.ts').read_bytes())}
  if receipt.exists():r=load(receipt);assert r['binding']==binding
  else:
   p=subprocess.run(['bun',str(HERE/'extra-probes.ts'),str(snapshot),kind],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
   r={'label':label,'case':case,'binding':binding,'exitCode':p.returncode,'stdout':p.stdout.decode(),'stderr':p.stderr.decode()};r['result']=json.loads(r['stdout']) if p.returncode==0 else None;save(receipt,r)
  assert r['exitCode']==0,(label,r);rows.append(r)
 save(HERE/'exploratory.json',{'manifestSha256':sha((run/'manifest.json').read_bytes()),'status':'posthoc exploratory; does not change primary denominators','probes':rows});print('Exploratory snapshots evaluated:',len(rows))
if __name__=='__main__':main()
