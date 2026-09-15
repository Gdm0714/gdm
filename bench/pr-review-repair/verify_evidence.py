"""Uniform posthoc CLI evidence-integrity probes; no model calls or primary-score changes."""
import json, subprocess
from common import HERE,active,hashes,save,sha

def main():
 run,m=active(); targets=[]; rows=[]
 for case in ['C01','C02','C03']:
  for variant in ['reference','candidate']:targets.append((case+'-'+variant,case,run/'frozen/cases'/case/variant))
 for e in m['schedule']:targets.append((e['id'],e['case'],run/'runs'/e['id']/'final-snapshot'))
 for label,case,snapshot in targets:
  p=subprocess.run(['bun',str(HERE/'evidence-cli-probe.ts'),str(snapshot)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
  assert p.returncode==0,(label,p.stderr.decode())
  result=json.loads(p.stdout);assert result['ordinaryCompletion'],label
  rows.append({'label':label,'case':case,'sourceSha256':{n:h for n,h in hashes(snapshot).items() if n.startswith('cli/src/')},'result':result})
 save(HERE/'evidence-cli-verification.json',{'manifestSha256':sha((run/'manifest.json').read_bytes()),'probeSha256':sha((HERE/'evidence-cli-probe.ts').read_bytes()),'observations':rows,'success':True})
 print('Evidence CLI probe completed:',len(rows),'snapshots; stale-evidence failures:',[r['label'] for r in rows if not r['result']['protectsStaleEvidence']])
if __name__=='__main__':main()
