#!/usr/bin/env python3
"""Preregistered sequential pilot. Recorded or interrupted observations are never rerun."""
import argparse
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
from fixtures import TASK_IDS, materialize
from common import HERE, ROOT, load, save, hashes, sha, parse_events, phase_evidence, grade_snapshot, trace_records

MAIN='openai-codex/gpt-5.6-terra'
ARMS={'solo':None,'terra_team':MAIN,'astra_team':'openai-codex/gpt-6-astra'}
COMMON='''
# Controlled experiment instructions (explicit user override of general defaults)
Implement TASK.md completely, preserving exported APIs and the original visible tests and package.json.
Use the full gdm-go procedure below, with gdm on PATH and --slug task. This is an authorized noninteractive local synthetic programming task. Choose ordinary implementation details yourself. Use short safe text in CLI contract fields. No deployment, external service, production data or human approval is involved.
Read and write only your working directory. Do not inspect sibling directories, harness scripts, grading files, private task definitions or other runs. Do not use external network/search. Running installed gdm and bun and their CLI help is allowed. Do not commit, push or create PRs. Keep all implementation under src, tests under test. TASK.md, test/visible.test.ts and package.json are protected.
Complete implementation, tests and required specialist work. Run gdm done successfully before printing HARNESS_DONE: on the final line. A passing local check is not proof that every brief requirement is satisfied.
'''
TEAM='''
# Required experimental collaboration
Use gdm_delegate with exactly one design task BEFORE any src edit, and reviewer AFTER implementation. Both roles use configured specialist model with thinking medium. Do not use scout or other roles. Only you can edit. No discretionary high effort overrides.
Every specialist must use read on TASK.md AND EVERY src file, then produce only JSON as described below. Include these instructions in its task and deliverable. Give concrete review scope and checkable contract criteria.
Design output: {"summary":"reasoned design","plan":["concrete step with invariant", "..."]}.
Reviewer output: {"summary":"reasoned review result","findings":[{"id":"R1","file":"src/example.ts","issue":"specific defect and triggering condition","check":"reproduction or assertion"}]}.
An empty findings array is valid only with a reasoned summary after source inspection. Rejected, failed, empty or wrong-role calls do not satisfy a role. If a request is rejected, correct it; if service fails, report it without unbounded retries.
Disposition each finding from every successful reviewer in DECISIONS.json: {"dispositions":[{"review":1,"finding":"R1","decision":"fixed","reason":"specific fix and test"}]} (decision may be rejected with concrete reasoning). Reviews are numbered in successful reviewer execution order. Use an empty dispositions array when no findings. Fix warranted findings and run affected tests. If src changes after review, ask reviewer to inspect the final source again. Finish only after the final source content has been reviewed.
'''
SOLO='''
# Standalone control
For this experimental arm, explicitly do all design and code review yourself. Do not delegate or request unavailable tools. This overrides the general specialist requirement; all implementation and acceptance requirements remain identical.
'''

def cmd(args,cwd=None):return subprocess.check_output(args,cwd=cwd,stdin=subprocess.DEVNULL,stderr=subprocess.PIPE)
def prepare():
    base=Path.home()/'projects/harness-bench-runs';base.mkdir(exist_ok=True)
    run=Path(tempfile.mkdtemp(prefix='gdm-pi-astra-quality-20260909-',dir=base));f=run/'frozen';f.mkdir()
    cmd(['bun',str(ROOT/'install/render-skills.ts'),'--target','pi','--source-root',str(ROOT/'skills'),'--agents-root',str(ROOT/'agents'),'--output',str(f/'skills')])
    (f/'bin').mkdir();shutil.copy2(ROOT/'cli/dist/gdm',f/'bin/gdm')
    assert cmd([str(f/'bin/gdm'),'--version']).decode().strip().endswith(load(ROOT/'cli/package.json')['version'])
    for name in ['run.py','common.py','trace.ts','fixtures.py','validate_fixtures.py','fixtures-validation.json','README.md']:
        shutil.copy2(HERE/name,f/name)
    shutil.copytree(HERE/'tasks',f/'tasks',ignore=shutil.ignore_patterns('__pycache__'))
    validation=load(HERE/'fixtures-validation.json')
    assert validation['sourceSha256']=={p:h for p,h in hashes(HERE).items() if p=='fixtures.py' or p.startswith('tasks/') and p.endswith('.py')}
    (f/'policy.md').write_text((f/'skills/gdm-go/SKILL.md').read_text()+COMMON)
    (f/'grading').mkdir();fixture_hashes={}
    for task in TASK_IDS:
        w=f/'fixtures'/task;_,hidden=materialize(task,w);(f/'grading'/f'{task}.test.ts').write_text(hidden);fixture_hashes[task]=hashes(w)
    order=list(ARMS);schedule=[]
    for i,task in enumerate(TASK_IDS):
        schedule += [{'task':task,'arm':arm,'trial':1,'id':f'{task}-{arm}-1'} for arm in order[i%3:]+order[:i%3]]
    pi=str(Path(shutil.which('pi')).resolve())
    manifest={'schema':'gdm-astra-quality/v1','createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
      'repoHead':cmd(['git','rev-parse','HEAD'],ROOT).decode().strip(),'pi':pi,'piVersion':cmd([pi,'--version']).decode().strip(),
      'piEntrySha256':sha(Path(pi).read_bytes()),'gdmVersion':cmd([str(f/'bin/gdm'),'--version']).decode().strip(),
      'mainModel':MAIN,'mainThinking':'high','specialistThinking':'medium','arms':ARMS,'schedule':schedule,
      'timeoutSeconds':600,'childTimeoutMs':240000,'fixtureSha256':fixture_hashes,'frozenSha256':hashes(f),
      'primary':'Final hidden requirement groups and original visible compatibility; functional quality separate from role compliance',
      'secondary':['Actual completed specialist roles and final-source review','Post-review repair improvement','All wall time and reported main plus child token usage and API list cost estimate'],
      'limitations':['Four synthetic tasks and one observation per arm per task; no stable ranking or significance claim',
      'Terra team versus Astra team holds role workflow constant; solo versus teams changes both workflow and compute',
      'Sequential rotated arm order; provider load and warm caches uncontrolled','Pre-review to final is post-review repair, not causal proof of each finding',
      'Filesystem boundaries are contractual; snapshots observe tool boundaries, not transient edit-revert inside one shell command',
      'Model identity and usage are Pi-reported metadata, not remote attestation or OAuth billing',
      'No hidden feedback until each parent exits; failures are retained without rerunning observations',
      'Uses frozen gdm-go and delegation directly without interactive UI, memory or Computer Use extensions']}
    save(run/'manifest.json',manifest);save(HERE/'active-run.json',{'path':str(run),'manifestSha256':sha((run/'manifest.json').read_bytes())})
    print('PREPARED '+str(run)+' observations='+str(len(schedule)),flush=True);return run

def processes():
    rows={}
    for line in subprocess.check_output(['ps','-axo','pid=,ppid=,pgid=,stat=,lstart='],text=True).splitlines():
        fields=line.split(maxsplit=4)
        if len(fields)==5: rows[int(fields[0])]=(int(fields[1]),int(fields[2]),fields[4].strip(),fields[3])
    return rows

def owned_groups(pid, known):
    rows=processes(); descendants={pid}; changed=True
    while changed:
        new={p for p,(parent,_,_,_) in rows.items() if parent in descendants}-descendants
        changed=bool(new);descendants.update(new)
    for p in descendants:
        if p in rows and rows[p][1]==p: known[p]=rows[p][2]
    return known

def cleanup_groups(known):
    # Verify PID, group leadership and creation time before every signal so an
    # unrelated process reusing a PID is never treated as owned.
    terminated=[]
    for sig in [signal.SIGTERM,signal.SIGKILL]:
        rows=processes()
        for pid,birth in known.items():
            if pid in rows and rows[pid][1:3]==(pid,birth) and any(r[1]==pid and not r[3].startswith('Z') for r in rows.values()):
                try:os.killpg(pid,sig);terminated.append({'pid':pid,'signal':int(sig)})
                except ProcessLookupError:pass
        if sig==signal.SIGTERM and terminated:time.sleep(0.3)
    return terminated

def stop(p):
    cleanup_groups(owned_groups(p.pid,{}));p.wait(timeout=5)

def supervise(p, seconds):
    start=time.monotonic();known={};timeout=False
    while p.poll() is None:
        owned_groups(p.pid,known)
        if time.monotonic()-start>=seconds:timeout=True;break
        try:p.wait(timeout=0.5)
        except subprocess.TimeoutExpired:pass
    if timeout:owned_groups(p.pid,known)
    terminated=cleanup_groups(known);p.wait(timeout=5)
    return timeout,terminated

def run_one(run,entry):
    m=load(run/'manifest.json');f=run/'frozen';log=run/'runs'/entry['id'];specialist=m['arms'][entry['arm']]
    if (log/'result.json').exists():return load(log/'result.json')
    if log.exists():raise RuntimeError('Interrupted observation requires assessment, never automatic rerun: '+str(log))
    log.mkdir(parents=True);work=log/'workspace';shutil.copytree(f/'fixtures'/entry['task'],work)
    cmd(['git','init','-q',str(work)]);cmd(['git','add','.'],work)
    cmd(['git','-c','user.name=Benchmark','-c','user.email=benchmark@localhost','commit','-qm','fixture baseline'],work)
    prompt=(work/'TASK.md').read_text()+'\n'+(f/'policy.md').read_text()+'\n'+(TEAM if specialist else SOLO)
    (log/'prompt.md').write_text(prompt)
    args=[m['pi'],'--offline','--mode','json','--print','--no-session','--no-extensions',
      '--extension',str(f/'skills/gdm-agents/pi/gdm-delegate.ts'),'--extension',str(f/'trace.ts'),
      '--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve',
      '--append-system-prompt',str(f/'skills/gdm-agents/pi/coordinator.md'),
      '--append-system-prompt',f'GDM Pi active profile: go. Main {MAIN}:high. Experimental specialist: {specialist or "unavailable"}:medium.',
      '--tools','read,bash,edit,write,grep,find,ls'+(',gdm_delegate' if specialist else ''),
      '--model',MAIN,'--models',MAIN+':high','--thinking','high',prompt]
    env={k:v for k,v in os.environ.items() if not k.startswith('GDM_')}
    env.update({'PI_OFFLINE':'1','GDM_PI_MODEL':MAIN,'GDM_PI_THINKING':'high','GDM_PI_EXECUTABLE':m['pi'],
      'GDM_PI_PROFILE':'go','GDM_EXECUTABLE':str(f/'bin/gdm'),'GDM_PI_IMPLEMENTATION_MODEL':MAIN+':high',
      'GDM_PI_AUDIT_MODEL':'openai-codex/gpt-6-astra:medium','GDM_PI_CHILD_TIMEOUT_MS':str(m['childTimeoutMs']),
      'GDM_QUALITY_TRACE_DIR':str(log/'trace'),'PATH':str(f/'bin')+os.pathsep+os.environ['PATH']})
    if specialist:
        for role in ['DESIGN','REVIEW']:env.update({f'GDM_PI_{role}_MODEL':specialist,f'GDM_PI_{role}_THINKING':'medium'})
    save(log/'invocation.json',{'argvWithoutPrompt':args[:-1],'promptSha256':sha(prompt.encode()),
      'configuration':{k:v for k,v in env.items() if k.startswith('GDM_')},'startedAt':time.time()})
    print('START '+entry['id'],flush=True);started=time.monotonic();timeout=False
    with (log/'events.jsonl').open('wb') as out,(log/'stderr.log').open('wb') as err:
        p=subprocess.Popen(args,cwd=work,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True)
        timeout,terminated=supervise(p,m['timeoutSeconds'])
    seconds=round(time.monotonic()-started,3);parsed=parse_events(log/'events.jsonl');(log/'final.md').write_text(parsed['final'])
    records=trace_records(log)
    # Final snapshot is independently captured even if the process did not settle.
    final=log/'final-snapshot';final.mkdir()
    for name in ['src','test','package.json','TASK.md','DECISIONS.json']:
        path=work/name
        if path.is_symlink():continue
        if path.is_dir():shutil.copytree(path,final/name,symlinks=True)
        elif path.is_file():shutil.copy2(path,final/name)
    unsafe=any(p.is_symlink() for p in final.rglob('*'))
    phases=phase_evidence(log,parsed,specialist)
    grading={}
    if not unsafe:
        grading['final']=grade_snapshot(final,f/'fixtures'/entry['task'],f/'grading'/f"{entry['task']}.test.ts",log/'grades/final')
        if phases.get('preReviewSnapshot'):
            grading['preReview']=grade_snapshot(log/'trace/snapshots'/phases['preReviewSnapshot'],f/'fixtures'/entry['task'],f/'grading'/f"{entry['task']}.test.ts",log/'grades/preReview')
    protected=all((work/name).is_file() and not(work/name).is_symlink() and sha((work/name).read_bytes())==h for name,h in m['fixtureSha256'][entry['task']].items() if not name.startswith('src/'))
    cmd(['git','add','-N','.'],work);(log/'changes.diff').write_bytes(cmd(['git','diff','HEAD'],work))
    states=[]
    for path in work.glob('.gdm/*/checks.json'):
        try:states.append(load(path))
        except ValueError:pass
    functional=bool(grading) and grading['final']['hidden']['exitCode']==grading['final']['visible']['exitCode']==0 and protected
    result={**entry,'exitCode':p.returncode,'timeout':timeout,'seconds':seconds,**parsed,'phaseEvidence':phases,'cleanupSignals':terminated,
      'grading':grading,'protectedUnchanged':protected,'unsafe':unsafe,'functionalPass':functional,
      'doneMarker':'HARNESS_DONE:' in parsed['final'],'workDone':any(s.get('done') for s in states),
      'finalSnapshotSha256':hashes(final),'traceComplete':bool(records) and records[-1]['kind']=='settled'}
    result['success']=bool(functional and phases['compliant'] and result['traceComplete'] and p.returncode==0 and not timeout and parsed['agentEnded'] and parsed['stopReason']=='stop' and result['doneMarker'] and result['workDone'])
    result['artifacts']={name:sha((log/name).read_bytes()) for name in ['events.jsonl','stderr.log','prompt.md','invocation.json','changes.diff','final.md','trace/trace.jsonl'] if (log/name).exists()}
    save(log/'result.json',result)
    print(f"END {entry['id']} functional={functional} compliant={phases['compliant']} success={result['success']} seconds={seconds} children={len(parsed['children'])}",flush=True)
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepare',action='store_true');parser.add_argument('--execute',action='store_true');parser.add_argument('--run');parser.add_argument('--limit',type=int);o=parser.parse_args()
    run=prepare() if o.prepare else Path(o.run or load(HERE/'active-run.json')['path'])
    if o.execute:
        m=load(run/'manifest.json');assert hashes(run/'frozen')==m['frozenSha256'],'frozen inputs changed'
        for name in ['run.py','common.py','fixtures.py']:
            assert sha((HERE/name).read_bytes())==m['frozenSha256'][name], 'live execution module differs from frozen input: '+name
        pending=[e for e in m['schedule'] if not(run/'runs'/e['id']/'result.json').exists()]
        for entry in pending[:o.limit] if o.limit else pending:
            if (run/'pause').exists():print('PAUSED before next observation',flush=True);break
            run_one(run,entry)
if __name__=='__main__':main()
