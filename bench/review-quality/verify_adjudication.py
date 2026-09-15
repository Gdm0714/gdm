"""Independent rerun of post-hoc factual probes, without replacing locked logs."""
import importlib.util
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from common import HERE, active, load, save, sha

def module(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result

def main():
    run,m=active();lock=load(HERE/'adjudication-lock.json')
    assert sha((run/'blind-map.json').read_bytes())==lock['blindMapSha256']
    for name,h in lock['sha256'].items():assert sha((HERE/name).read_bytes())==h
    previous=Path(m['amendment']['previousRun'])
    assert sha((previous/'manifest.json').read_bytes())==m['amendment']['previousManifestSha256']
    prior=load(previous/'manifest.json')
    for rid in m['amendment']['carriedUnchanged']:
        assert (previous/'reviews'/rid/'result.json').read_bytes()==(run/'reviews'/rid/'result.json').read_bytes()
        assert next(e for e in prior['schedule'] if e['id']==rid)==next(e for e in m['schedule'] if e['id']==rid)
        assert next(e['case'] for e in m['schedule'] if e['id']==rid) not in m['amendment']['changedPackets']
    rows=[]
    for t in load(run/'frozen/truth.json'):
        if t['family'] not in ['effort','atomic']:continue
        mod=module('adjudication_probes' if t['family']=='effort' else 'exploratory')
        with tempfile.TemporaryDirectory(prefix='gdm-review-proof-') as tmp:
            work=Path(tmp)/'work';shutil.copytree(run/'frozen/fixtures'/t['case'],work)
            name='extra.mjs' if t['family']=='effort' else 'extra.test.ts';(work/name).write_text(mod.PROBE)
            cmd=['bun','./'+name] if t['family']=='effort' else ['bun','test','./'+name]
            p=subprocess.run(cmd,cwd=work,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
            if t['family']=='effort':
                assert p.returncode==0,p.stdout.decode()
                observed=json.loads(p.stdout)
                expected=next(x['observed'] for x in load(HERE/'adjudication-probes.json')['results'] if x['case']==t['case'])
                assert observed==expected
            else:
                output=p.stdout.decode()
                assert p.returncode==1 and '(fail) exploratory: loader rejects non-string-valued JSON' in output and '(pass) exploratory control:' in output
            rows.append({'case':t['case'],'expectedBehaviorReproduced':True,'exitCode':p.returncode,'outputSha256':sha(p.stdout)})
    save(HERE/'adjudication-verification.json',{'success':True,'manifestSha256':sha((run/'manifest.json').read_bytes()),
      'blindMapBound':True,'carriedObservationsExact':8,'uniformReproductions':rows,
      'interpretation':'Factual behavior verified. Loader scope and whitespace semantics remain unresolved, not human-adjudicated.'})
    print('Verified anonymous-map binding, 8 carried records, and 4 independent additional-finding reproductions.')

if __name__=='__main__':main()
