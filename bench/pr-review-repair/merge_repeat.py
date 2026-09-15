import json,subprocess
from common import HERE,active,hashes,load,save,sha
run,m=active();targets=[('C02-'+v,run/'frozen/cases/C02'/v) for v in ['reference','candidate']]+[(e['id'],run/'runs'/e['id']/'final-snapshot') for e in m['schedule'] if e['case']=='C02'];assert all(p.is_dir() for _,p in targets);rows=[]
for label,snapshot in targets:
 p=subprocess.run(['bun',str(HERE/'merge-repeat-probe.ts'),str(snapshot)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15);assert p.returncode==0,p.stderr
 rows.append({'label':label,'sourceSha256':{n:h for n,h in hashes(snapshot).items() if n.startswith('cli/src/')},'result':json.loads(p.stdout)})
save(HERE/'merge-repeat-verification.json',{'manifestSha256':sha((run/'manifest.json').read_bytes()),'probeSha256':sha((HERE/'merge-repeat-probe.ts').read_bytes()),'classification':'Behavioral change only; quality unresolved because duplicate recording policy is unspecified','observations':rows,'success':True});print('Repeated merge behavior recorded:',len(rows),'snapshots')
