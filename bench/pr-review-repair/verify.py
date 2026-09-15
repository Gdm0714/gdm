import argparse, shutil, tempfile
from pathlib import Path
from common import HERE, active, grade, hashes, load, parse, save, sha
from prepare import mutate
from analyze import metrics

def build_fixtures(run,m):
 f=run/'frozen';results={};dest=run/'fixture-validation';dest.mkdir()
 for case in ['C01','C02','C03']:
  d=f/'cases'/case;meta=load(d/'meta.json')
  for name in ['reference','candidate']:
   results[case+'-'+name]=grade(d/name,f,case,dest/(case+'-'+name))
  for mutation in meta['mutations']:
   path=Path(tempfile.mkdtemp(prefix='gdm-pr-isolated-mutant-'));shutil.copytree(d/'reference',path/'workspace');mutate(path/'workspace',[mutation]);key=case+'-'+mutation['id'];results[key]=grade(path/'workspace',f,case,dest/key);shutil.rmtree(path)
 v={'manifestSha256':sha((run/'manifest.json').read_bytes()),'results':results,'logsSha256':hashes(dest),'success':False}
 save(HERE/'fixtures-validation.json',v);validate_fixtures(run,m,v,success_required=False);v['success']=True;save(HERE/'fixtures-validation.json',v);print('FIXTURES PASS 3 references, 3 candidates and 4 isolated mutations')
def validate_fixtures(run,m,v,success_required=True):
 assert v['manifestSha256']==sha((run/'manifest.json').read_bytes())
 if success_required:assert v['success']
 assert hashes(run/'fixture-validation')==v['logsSha256']
 for key,r in v['results'].items():
  expected=0 if key.endswith('reference') or key=='C03-candidate' else 2 if key.endswith('candidate') else 1
  assert r['visible']['exitCode']==0,(key,'visible',r['visible']['failed'])
  assert len(r['hidden']['failed'])==expected,(key,r['hidden'])
  assert len(r['hidden']['passed'])==8-expected,(key,r['hidden'])
  assert (r['hidden']['exitCode']==0)==(expected==0)
  if '-D' in key:assert any(key.split('-')[-1] in s for s in r['hidden']['failed'])
 assert len(v['results'])==10

def verify_results(run,m):
 calls=0
 for e in m['schedule']:
  d=run/'runs'/e['id'];r=load(d/'result.json');assert all(r[k]==v for k,v in e.items());assert hashes(d/'final-snapshot')==r['finalSha256']
  for n,h in r['artifacts'].items():assert sha((d/n).read_bytes())==h
  for role in (['repair'] if e['arm']=='self' else ['review','repair']):
   calls+=1;p=d/role;x=load(p/'result.json');y=parse(p/'events.jsonl')
   for k,v in y.items():assert x[k]==v,(e['id'],role,k)
   for n,h in x['artifactSha256'].items():assert sha((p/n).read_bytes())==h
   inv=load(p/'invocation.json');assert inv['model']==(m['mainModel'] if role=='repair' else m['reviewerModels'][e['arm']]);assert inv['thinking']==(m['mainThinking'] if role=='repair' else m['reviewThinking'])
   assert sha((p/'prompt.md').read_bytes())==inv['promptSha256'];assert sha((p/'system.txt').read_bytes())==inv['systemSha256']
   if role=='review':assert inv['workspaceBefore']==hashes(run/'frozen/cases'/e['case']/'candidate')
   else:
    expected=hashes(run/'frozen/cases'/e['case']/'candidate');expected['REVIEW.json']=sha((d/'review-input.json').read_bytes());assert inv['workspaceBefore']==expected
  if r['grading']:
   for phase in ['hidden','visible']:assert sha((d/'grade'/f'{phase}.log').read_bytes())==r['grading'][phase]['logSha256']
 assert calls==m['plannedCalls']==30
 current=metrics(run,m);assert current==load(HERE/'analysis.json')
 a=load(HERE/'change-assessment.json');assert a['manifestSha256']==sha((run/'manifest.json').read_bytes());assert sorted(x['id'] for x in a['runs'])==sorted(e['id'] for e in m['schedule'])
 for x in a['runs']:
  d=run/'runs'/x['id'];assert x['diffSha256']==sha((d/'changes.diff').read_bytes());assert x['reviewSha256']==sha((d/'review-input.json').read_bytes());assert x['assessment'] and isinstance(x['changes'],list)
 assert (HERE/'results-2026-09-09.md').is_file()
 print('RESULTS PASS 30 preserved calls, 18 final snapshots, held-out/public logs, metrics and change assessments')
def main():
 p=argparse.ArgumentParser();p.add_argument('--fixtures',action='store_true');p.add_argument('--build-fixtures',action='store_true');p.add_argument('--results',action='store_true');o=p.parse_args();run,m=active();assert hashes(run/'frozen')==m['frozenSha256']
 if o.build_fixtures:build_fixtures(run,m)
 if o.fixtures:validate_fixtures(run,m,load(HERE/'fixtures-validation.json'));print('FIXTURE RECEIPTS AND FROZEN INPUTS VERIFIED')
 if o.results:verify_results(run,m)
if __name__=='__main__':main()
