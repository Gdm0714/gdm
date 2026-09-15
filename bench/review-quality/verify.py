import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from common import HERE, active, hashes, load, save, sha
from run import parse
from analyze import LABELS, metrics

def fixtures(run,m):
    rows=[]
    for t in load(run/'frozen/truth.json'):
        with tempfile.TemporaryDirectory(prefix='gdm-review-fixture-') as tmp:
            work=Path(tmp)/'work';shutil.copytree(run/'frozen/fixtures'/t['case'],work)
            p=subprocess.run(['bun','test','./probe.test.ts'],cwd=work,stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=75)
            body=p.stdout.decode(errors='replace')
            target=('(fail) known:' in body) if t['defective'] else ('(pass) known:' in body)
            okay=target and '(pass) control:' in body and '(fail) control:' not in body and ((p.returncode!=0)==t['defective'])
            log=run/'validation'/f"{t['case']}.log";log.parent.mkdir(exist_ok=True)
            # Verification reruns keep individual logs instead of overwriting evidence.
            index=1
            while log.exists():log=run/'validation'/f"{t['case']}-{index}.log";index+=1
            log.write_bytes(p.stdout)
            rows.append({'case':t['case'],'family':t['family'],'defective':t['defective'],
                         'exitCode':p.returncode,'success':okay,'log':str(log),'sha256':sha(p.stdout)})
            print(f"FIXTURE {t['case']} expected={'fail' if t['defective'] else 'pass'} observed={p.returncode} valid={okay}",flush=True)
    result={'manifestSha256':sha((run/'manifest.json').read_bytes()),'success':all(r['success'] for r in rows),'cases':rows}
    save(HERE/'fixtures-validation.json',result)
    assert result['success'],'fixture validation failed; inspect logs before any model execution'

def results(run,m):
    lock=load(HERE/'adjudication-lock.json')
    assert lock['manifestSha256']==sha((run/'manifest.json').read_bytes())
    for name,h in lock['sha256'].items():assert sha((HERE/name).read_bytes())==h,(name,'adjudication bytes changed')
    blinded=load(HERE/'blind-reviews.json');mapping=load(run/'blind-map.json')
    assert blinded['manifestSha256']==sha((run/'manifest.json').read_bytes())
    entries={e['id']:e for e in m['schedule']};observations={}
    for e in m['schedule']:
        dest=run/'reviews'/e['id'];r=load(dest/'result.json');raw=parse(dest/'events.jsonl')
        for key,value in raw.items():assert r[key]==value,(e['id'],key)
        for name,h in r['artifactSha256'].items():assert sha((dest/name).read_bytes())==h,(e['id'],name)
        inv=load(dest/'invocation.json')
        assert inv['model']==e['model'] and inv['thinking']==m['thinking']
        assert inv['packetSha256']==sha((run/'frozen/packets'/f"{e['case']}.md").read_bytes())
        assert inv['systemSha256']==sha((run/'frozen/system.txt').read_bytes())
        assert r['id']==e['id'] and r['case']==e['case'] and r['repetition']==e['repetition']
        assert r['toolCalls']==0 and r['workspaceUnchanged'] and not any((dest/'workspace').iterdir())
        observations[e['id']]={**r,'arm':e['arm'],'latencyExcluded':e['id'] in m.get('amendment',{}).get('latencyExcluded',[])}
    assert len(mapping)==len(set(mapping.values()))==len(entries)==32 and set(mapping.values())==set(entries)
    adj=load(HERE/'adjudications.json');truth={t['case']:t for t in load(run/'frozen/truth.json')}
    expected=set()
    for b in blinded['reviews']:
        r=observations[mapping[b['blindId']]]
        assert b['case']==r['case'] and b['response']==r['response']
        if b['usable']:
            for finding in b['response']['findings']:expected.add((b['blindId'],finding['id']))
    actual=set()
    for a in adj['findings']:
        key=(a['blindId'],a['findingId']);assert key not in actual;actual.add(key)
        assert a['label'] in LABELS and a['reason'].strip() and a['evidence'].strip()
        r=observations[mapping[a['blindId']]]
        if a['label']=='known_true_positive':assert truth[r['case']]['defective']
        if a['label']=='additional_confirmed':
            proof=HERE/a['reproduction'];assert proof.is_file() and sha(proof.read_bytes())==a['reproductionSha256']
    assert expected==actual,{'missing':sorted(expected-actual),'extra':sorted(actual-expected)}
    for r in observations.values():
        assert sum(a['label']=='known_true_positive' and mapping[a['blindId']]==r['id'] for a in adj['findings'])<=1,'deduplicate known root causes'
    calculated=metrics(list(observations.values()),truth,[{**a,'review':mapping[a['blindId']]} for a in adj['findings']])
    analysis=load(HERE/'analysis.json')
    for key,val in calculated.items():assert analysis[key]==val,key
    assert analysis['manifestSha256']==sha((run/'manifest.json').read_bytes())
    test=subprocess.run(['python3','-m','unittest','test_analysis.py'],cwd=HERE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    assert test.returncode==0,test.stdout.decode()
    assert (HERE/'results-2026-09-09.md').is_file() and (HERE/'outcome-2026-09-09.md').is_file()
    save(HERE/'verification.json',{'success':True,'manifestSha256':analysis['manifestSha256'],
      'observations':len(observations),'adjudicatedFindings':len(actual),'adjudicationsSha256':sha((HERE/'adjudications.json').read_bytes()),
      'resultsSha256':sha((HERE/'results-2026-09-09.md').read_bytes()),'outcomeSha256':sha((HERE/'outcome-2026-09-09.md').read_bytes()),
      'independentHumanReview':False,'transportSuccesses':sum(r['transportSuccess'] for r in observations.values())})
    print('VERIFIED: 32 raw observations, all anonymous finding dispositions, paired metrics and artifact hashes')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--fixtures',action='store_true');p.add_argument('--results',action='store_true');o=p.parse_args()
    run,m=active();assert hashes(run/'frozen')==m['frozenSha256'],'frozen bytes changed'
    for name in ['common.py','prepare.py','run.py','verify.py','analyze.py','test_analysis.py','README.md']:
        assert sha((HERE/name).read_bytes())==m['frozenSha256'][name],f'live/frozen mismatch: {name}'
    if o.fixtures:fixtures(run,m)
    if o.results:results(run,m)
