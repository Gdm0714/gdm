#!/usr/bin/env python3
"""Recompute experiment records, replay hidden tests, and check the installed candidate."""
import argparse
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from run import HERE, ROOT, ARMS, file_hashes, load, parse_events, save, sha, run_test, complete_usage
from adjudicate import validate as validate_correction, adjudicate

def self_test():
    usage={'input':10,'output':3,'cacheRead':2,'cacheWrite':0,'totalTokens':15,'reasoning':1,'cost':{'total':0.031}}
    message={'role':'assistant','provider':'openai-codex','model':'gpt-5.6-terra','content':[{'type':'text','text':'done'}],'stopReason':'stop','usage':usage}
    events=[{'type':'message_update','message':message},{'type':'message_end','message':message},{'type':'turn_end','message':message},{'type':'tool_execution_end','toolName':'gdm_delegate','result':{'details':{'results':[{'role':'scout','model':'openai-codex/gpt-5.6-luna','thinking':'medium','ok':True,'usageComplete':True,'usage':usage}]}}},{'type':'agent_end','messages':[message]}]
    with tempfile.TemporaryDirectory(prefix='gdm-routing-parser-test-') as d:
        p=Path(d)/'events.jsonl';p.write_text('\n'.join(json.dumps(e) for e in events))
        r=parse_events(p)
        assert r['assistantTurns']==1 and r['mainUsage']['totalTokens']==15 and r['totalUsage']['totalTokens']==30
        assert r['totalUsage']['reasoning']==2 and math.isclose(r['totalUsage']['apiCostEstimateUSD'],0.062)
        assert r['final']=='done' and r['usageComplete'] and r['reportedModels']==['openai-codex/gpt-5.6-terra']
        finished={**r,'exitCode':0,'timeout':False}
        assert complete_usage(finished)
        for changes in [{'timeout':True},{'stopReason':'error'},{'exitCode':1},{'agentEnded':False}]:
            assert not complete_usage({**finished,**changes}), 'failed or unfinished stream is partial usage'
    print('parser self-test passed: no delta/agent_end duplication; child usage included')

def test_count(path):
    text=path.read_text()
    p=re.search(r'\b(\d+) pass\b',text);f=re.search(r'\b(\d+) fail\b',text)
    return {'pass':int(p[1]) if p else None,'fail':int(f[1]) if f else None}

def verify(run, installed=True):
    active=load(HERE/'active-run.json');manifest=load(run/'manifest.json');frozen=run/'frozen'
    assert sha((run/'manifest.json').read_bytes())==active['manifestSha256'],'manifest changed'
    assert file_hashes(frozen)==manifest['frozenSha256'],'frozen source changed'
    for name in ['run.py','fixtures.py']:
        assert sha((HERE/name).read_bytes())==manifest['frozenSha256'][name],('runner source changed',name)
    assert len(manifest['schedule'])==64 and len({e['id'] for e in manifest['schedule']})==64
    assert len(list((run/'runs').glob('*/result.json')))==64,'comparison is not complete'
    outcomes=[]
    with tempfile.TemporaryDirectory(prefix='gdm-routing-regrade-') as td:
        temp=Path(td)
        for entry in manifest['schedule']:
            log=run/'runs'/entry['id'];r=load(log/'result.json');arm=manifest['arms'][entry['arm']]
            for k in ['id','task','arm','trial']:assert r[k]==entry[k]
            for name,digest in r['artifacts'].items():assert sha((log/name).read_bytes())==digest,(entry['id'],name)
            recorded_diff=subprocess.check_output(['git','diff','HEAD'],cwd=log/'workspace',stdin=subprocess.DEVNULL)
            assert sha(recorded_diff)==r['artifacts']['changes.diff'],(entry['id'],'workspace changed after observation')
            protected=all((log/'workspace'/name).is_file() and sha((log/'workspace'/name).read_bytes())==digest
                for name,digest in manifest['fixtureSha256'][entry['task']].items() if not name.startswith('src/'))
            assert protected==r['protectedUnchanged'],(entry['id'],'protected-file record mismatch')
            observed=parse_events(log/'events.jsonl')
            for key in ['assistantTurns','reportedModels','mainUsage','totalUsage','usageComplete','children','invalidJsonLines','agentEnded','stopReason']:
                assert observed[key]==r[key],(entry['id'],key)
            assert observed['final']==(log/'final.md').read_text()
            assert not r['reportedModels'] or r['reportedModels']==[arm['model']],(entry['id'],'main model mismatch')
            if not arm['delegate']:assert not r['children'],entry['id']
            for c in r['children']:
                expected=arm.get('childModel') or ('openai-codex/gpt-5.6-luna' if c['role']=='scout' else 'openai-codex/gpt-6-astra')
                assert c['model']==expected,(entry['id'],'child route mismatch')
                if c.get('reportedModels'):assert c['reportedModels']==[expected],(entry['id'],'reported child mismatch')
                assert c['role'] in ['scout','design','reviewer']
                if not c['ok']:assert not c['usageComplete']
            expected_success=(r['exitCode']==0 and not r['timeout'] and r['agentEnded'] and r['stopReason']=='stop' and r['hidden']['exitCode']==0 and r['visible']['exitCode']==0 and r['protectedUnchanged'] and r['doneMarker'] and r['workDone'])
            assert r['success']==expected_success,entry['id']
            # Independent replay: original tests are restored from frozen data. No model tests are trusted as the judge.
            w=temp/entry['id'];shutil.copytree(log/'workspace',w,ignore=shutil.ignore_patterns('.git','.gdm'))
            shutil.copyfile(frozen/'fixtures'/entry['task']/'test/visible.test.ts',w/'test/visible.test.ts')
            shutil.copyfile(frozen/'fixtures'/entry['task']/'package.json',w/'package.json')
            (w/'benchmark-hidden.test.ts').write_bytes((frozen/'grading'/f"{entry['task']}.test.ts").read_bytes())
            h=run_test(w,'./benchmark-hidden.test.ts',temp/'hidden.txt');v=run_test(w,'./test/visible.test.ts',temp/'visible.txt')
            assert h['exitCode']==r['hidden']['exitCode'] and v['exitCode']==r['visible']['exitCode'],(entry['id'],'non-reproducible grade')
            counts=test_count(temp/'hidden.txt')
            expected_tests=len(re.findall(r'\btest\s*\(', (frozen/'grading'/f"{entry['task']}.test.ts").read_text()))
            if h['exitCode']==0:assert counts['pass']==expected_tests and counts['fail']==0,(entry['id'],'missing test execution')
            outcomes.append({'id':entry['id'],'success':r['success'],'hidden':counts,'resultSha256':sha((log/'result.json').read_bytes())})
            shutil.rmtree(w)
    validate_correction(run)
    original_rows=[load(run/'runs'/entry['id']/'result.json') for entry in manifest['schedule']]
    corrected_rows=adjudicate(run,original_rows)
    assert len(corrected_rows)==64 and sum(r['task']=='t4' for r in corrected_rows)==8
    installation=None
    if installed:
        installation=load(HERE/'installation.json')
        for item in installation['files']:assert sha(Path(item['path']).read_bytes())==item['sha256'],item['path']
        settings=load(Path.home()/'.pi/agent/settings.json')
        assert settings['defaultProvider']=='openai-codex' and settings['defaultModel']=='gpt-5.6-terra' and settings['defaultThinkingLevel']=='high'
        assert subprocess.check_output([str(Path.home()/'.local/bin/gdm'),'--version'],stdin=subprocess.DEVNULL).decode().strip()==load(ROOT/'cli/package.json')['version']
        probe=load(HERE/'live-role-probe.json')
        assert probe['success'] and probe['sourceUnchanged'],'live role dispatch not verified'
        probe_events=Path(probe['path'])/'events.jsonl'
        assert sha(probe_events.read_bytes())==probe['eventsSha256']
        observed_probe=parse_events(probe_events)
        assert observed_probe['children']==probe['children'] and observed_probe['totalUsage']==probe['totalUsage']
        assert observed_probe['reportedModels']==['openai-codex/gpt-5.6-terra']
        for child in probe['children']:
            assert child['reportedModels']==[child['model']],('live reported model mismatch',child['role'])
        assert [(c['role'],c['model'],c['thinking']) for c in probe['children']]==[
            ('scout','openai-codex/gpt-5.6-luna','medium'),('design','openai-codex/gpt-6-astra','medium'),('reviewer','openai-codex/gpt-6-astra','high')]
    receipt={'schema':'gdm-pi-model-routing-verification/v1','run':str(run),'verifiedRuns':len(outcomes),'successes':sum(x['success'] for x in outcomes),'correctedSuccesses':sum(r['success'] for r in corrected_rows),'gradingCorrectionChecked':True,'outcomes':outcomes,'installationChecked':installed,'limitations':['Model-reported token counts are not provider billing receipts','GDM state is checked by experiment outcome; hidden replay is the independent correctness check','One documented post-hoc grading correction accepts valid write-through cache updates; original outcomes remain preserved','No LLM judge or production repository replay']}
    save(HERE/'verification.json',receipt)
    print(json.dumps({k:v for k,v in receipt.items() if k!='outcomes'},ensure_ascii=False))

if __name__ == "__main__":
    raise SystemExit('Retired benchmark: Pi integration was removed. Historical results are preserved; use the native GDM/gid benchmarks for new runs.')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--self-test',action='store_true');p.add_argument('--no-install',action='store_true');args=p.parse_args()
    self_test()
    if not args.self_test:verify(Path(load(HERE/'active-run.json')['path']),not args.no_install)
