#!/usr/bin/env python3
"""Frozen, sequential Pi model/routing experiment. Never reruns a recorded observation."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import statistics
import subprocess
import tempfile
import time
from fixtures import TASK_IDS, materialize

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
ARMS = {
    'legacy': {'model':'openai-codex/gpt-5.6-sol', 'thinking':'xhigh', 'delegate':True, 'childModel':'openai-codex/gpt-5.6-sol', 'childThinking':'xhigh'},
    'terra': {'model':'openai-codex/gpt-5.6-terra', 'thinking':'high', 'delegate':False},
    'routed': {'model':'openai-codex/gpt-5.6-terra', 'thinking':'high', 'delegate':True},
    'astra': {'model':'openai-codex/gpt-6-astra', 'thinking':'low', 'delegate':False},
}

def sha(data): return hashlib.sha256(data).hexdigest()
def save(path, value): path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
def load(path): return json.loads(path.read_text())
def cmd(args, cwd=None): return subprocess.check_output(args, cwd=cwd, stdin=subprocess.DEVNULL, stderr=subprocess.PIPE)
def file_hashes(root): return {str(p.relative_to(root)):sha(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file()}
def finite(n): return isinstance(n,(int,float)) and not isinstance(n,bool) and math.isfinite(n) and n>=0

def complete_usage(result):
    return result['usageComplete'] and result['agentEnded'] and result['stopReason']=='stop' and result['exitCode']==0 and not result['timeout']

def totals(usages):
    out={k:sum(u[k] for u in usages) for k in FIELDS}
    out['reasoning']=sum(u['reasoning'] for u in usages) if all(finite(u.get('reasoning')) for u in usages) else None
    out['apiCostEstimateUSD']=sum(u['cost']['total'] for u in usages)
    return out

def parse_events(path):
    usages=[]; children=[]; messages=[]; tools=[]; invalid=0; assistants=0; models=set(); ended=False; final=''; stop=None
    with path.open() as f:
        for line in f:
            if not line.strip(): continue
            try: e=json.loads(line)
            except ValueError: invalid+=1;continue
            kind=e.get('type')
            if kind=='message_end' and e.get('message',{}).get('role')=='assistant':
                m=e['message']; assistants+=1;models.add(m.get('provider','')+'/'+m.get('model',''))
                stop=m.get('stopReason'); final='\n'.join(c.get('text','') for c in m.get('content',[]) if c.get('type')=='text')
                messages.append({'stopReason':stop,'error':m.get('errorMessage'),'model':m.get('model')})
                u=m.get('usage')
                if isinstance(u,dict) and all(finite(u.get(k)) for k in FIELDS) and finite(u.get('cost',{}).get('total')): usages.append(u)
            if kind=='tool_execution_end':
                tools.append({'name':e.get('toolName'),'error':e.get('isError',False)})
                if e.get('toolName')=='gdm_delegate':
                    for child in e.get('result',{}).get('details',{}).get('results',[]):
                        children.append({k:child.get(k) for k in ['role','model','thinking','elapsedMs','ok','exitCode','assistantTurns','reportedModels','usage','usageComplete','error']})
            if kind=='agent_end' and not e.get('willRetry',False): ended=True
    complete=assistants>0 and len(usages)==assistants and all(c['usageComplete'] for c in children)
    child_usages=[c['usage'] for c in children if c.get('usage') and all(finite(c['usage'].get(k)) for k in FIELDS) and finite(c['usage'].get('cost',{}).get('total'))]
    return {'assistantTurns':assistants,'reportedModels':sorted(models),'mainUsage':totals(usages),'totalUsage':totals(usages+child_usages),'usageComplete':complete,'children':children,'tools':tools,'invalidJsonLines':invalid,'agentEnded':ended,'stopReason':stop,'messages':messages,'final':final}

COMMON = """
# 공통 실행 조건
이것은 승인된 비대화형 로컬 소프트웨어 벤치마크다. 주어진 기능을 직접 수정하고 테스트하라.
아래에 전문으로 제공한 gdm-go 절차를 적용한다. gdm CLI는 PATH에 있으며 --slug task를 사용한다.
로컬 합성 데이터와 함수 계약을 다루므로 배포, 운영 DB, 외부 네트워크, 별도 도메인 승인 절차는 없다.
필요한 일반 구현 선택은 스스로 판단한다. init의 --require/--forbid는 짧은 문장으로 나누고 슬래시나 인용부호를 넣지 않는다.
기존 test/visible.test.ts와 package.json을 수정하지 않는다. src와 새 테스트만 변경한다. 기존 공개 API를 보존한다.
작업 디렉터리 밖 파일 읽기·쓰기와 다른 과제/실험 로그 탐색, 외부 검색·네트워크는 금지한다. PATH의 gdm, bun 및 CLI 도움말 실행은 허용한다.
gdm_delegate가 노출된 구성에서는 독립된 조사, 설계 또는 중요한 검토가 도움이 될 때만 사용한다. 하위 작업자는 읽기 전용이다.
단순한 과제에 역할 호출을 의무적으로 추가하지 않는다. 도구가 없는 구성에서는 직접 처리한다.
모든 변경과 검증 및 자문 반영을 끝내고 gdm done이 실제 성공한 경우에만 마지막 줄에 HARNESS_DONE: 결과 요약을 출력한다.
commit, push, PR은 하지 않는다. 이 사용자 지시는 일반 스킬 기본값보다 우선한다.
"""

def prepare():
    run=Path(tempfile.mkdtemp(prefix='gdm-pi-model-routing-20260908-',dir=str(Path.home()/'projects/harness-bench-runs')))
    frozen=run/'frozen';frozen.mkdir()
    cmd(['bun',str(ROOT/'install/render-skills.ts'),'--target','pi','--source-root',str(ROOT/'skills'),'--agents-root',str(ROOT/'agents'),'--output',str(frozen/'skills')])
    candidate=ROOT/'cli/dist/gdm'
    assert cmd([str(candidate),'--version']).decode().strip().endswith(load(ROOT/'cli/package.json')['version']), 'build candidate CLI before freezing'
    (frozen/'bin').mkdir();shutil.copy2(candidate,frozen/'bin/gdm')
    for name in ['run.py','fixtures.py','fixture-validation.json']:shutil.copy2(HERE/name,frozen/name)
    prompt=(frozen/'skills/gdm-go/SKILL.md').read_text()
    assert '`scout|design|reviewer`만 허용' in prompt and '`scout|reviewer`만 허용' not in prompt, 'rendered role contract is stale'
    (frozen/'policy.md').write_text(prompt+COMMON)
    fixture_hashes={}
    for task in TASK_IDS:
        w=frozen/'fixtures'/task;brief,hidden=materialize(task,w)
        (frozen/'briefs').mkdir(exist_ok=True);(frozen/'grading').mkdir(exist_ok=True)
        (frozen/'briefs'/f'{task}.md').write_text(brief);(frozen/'grading'/f'{task}.test.ts').write_text(hidden)
        fixture_hashes[task]=file_hashes(w)
    order=list(ARMS);schedule=[]
    for trial in [1,2]:
        for i,task in enumerate(TASK_IDS):
            seq=order[i%len(order):]+order[:i%len(order)]
            if trial==2:seq=seq[::-1]
            schedule += [{'task':task,'arm':arm,'trial':trial,'id':f'{task}-{arm}-{trial}'} for arm in seq]
    pi=str(Path(shutil.which('pi')).resolve())
    manifest={'schema':'gdm-pi-model-routing/v1','createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'repoHead':cmd(['git','rev-parse','HEAD'],ROOT).decode().strip(),'pi':pi,'piVersion':cmd([pi,'--version']).decode().strip(),'piEntrySha256':sha(Path(pi).read_bytes()),'gdmVersion':cmd([str(frozen/'bin/gdm'),'--version']).decode().strip(),'arms':ARMS,'schedule':schedule,'timeoutSeconds':420,'frozenSha256':file_hashes(frozen),'fixtureSha256':fixture_hashes,'primaryOutcome':'hidden tests and original visible tests pass, protected files unchanged, CLI gdm done plus final marker','secondaryOutcomes':['elapsed seconds including delegates','all assistant and child token usage','API catalogue cost estimate, not OAuth billing','delegation count and role/model/effort','failed tool calls'],'limitations':['Eight small synthetic fixtures, three reused; not production-repository proof','Sequential runs with reversed second-trial arm order; provider load and warm shared caches remain uncontrolled','Uses frozen Pi gdm-go/delegate assets directly, without memory/computer-use extensions or interactive UI','Delegated review is advisory; this experiment does not measure gdm-full formal audit','Pi usage/model fields are self-reported metadata, not billing or remote identity attestation','Hidden tests withheld until main exits; filesystem boundary is contractual, not OS-enforced','No LLM quality score; hidden tests and invariant checks are primary','Luna standalone is not a main arm; its bounded scout role is measured when actually selected','Same new runtime/prompt in legacy arm with prior Sol child settings, isolating routing rather than replaying old harness bugs']}
    save(run/'manifest.json',manifest);save(HERE/'active-run.json',{'path':str(run),'manifestSha256':sha((run/'manifest.json').read_bytes())})
    print(json.dumps({'run':str(run),'plannedRuns':len(schedule)},ensure_ascii=False),flush=True)
    return run

def run_test(workspace,target,out):
    try:
        p=subprocess.run(['bun','test',target],cwd=workspace,stdin=subprocess.DEVNULL,capture_output=True,timeout=45)
        data=p.stdout+p.stderr;code=p.returncode
    except subprocess.TimeoutExpired as e:data=(e.stdout or b'')+(e.stderr or b'')+b'\nGRADING_TIMEOUT';code=124
    out.write_bytes(data)
    return {'exitCode':code,'sha256':sha(data)}

def stop_group(p):
    try:os.killpg(p.pid,signal.SIGTERM)
    except ProcessLookupError:return
    try:p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        p.wait()

def run_one(run,entry):
    manifest=load(run/'manifest.json');arm=manifest['arms'][entry['arm']];frozen=run/'frozen';log=run/'runs'/entry['id']
    if (log/'result.json').exists(): return load(log/'result.json')
    if log.exists():raise RuntimeError(f'Incomplete observation already exists: {log}; assess it, do not rerun')
    log.mkdir(parents=True);work=log/'workspace';shutil.copytree(frozen/'fixtures'/entry['task'],work)
    cmd(['git','init','-q',str(work)]);cmd(['git','add','.'],work);cmd(['git','-c','user.name=Benchmark','-c','user.email=benchmark@localhost','commit','-qm','fixture baseline'],work)
    prompt='# 작업 브리프\n'+(frozen/'briefs'/f"{entry['task']}.md").read_text()+'\n# 적용 지침\n'+(frozen/'policy.md').read_text()
    (log/'prompt.md').write_text(prompt)
    extension=frozen/'skills/gdm-agents/pi/gdm-delegate.ts'
    routing=(f"scout={arm['childModel']}:{arm['childThinking']}; design={arm['childModel']}:{arm['childThinking']}; reviewer={arm['childModel']}:{arm['childThinking']}" if 'childModel' in arm else 'scout=openai-codex/gpt-5.6-luna:medium; design=openai-codex/gpt-6-astra:medium; reviewer=openai-codex/gpt-6-astra:medium') if arm['delegate'] else 'Delegation is unavailable in this single-model arm.'
    args=[manifest['pi'],'--offline','--mode','json','--print','--no-session','--no-extensions','--extension',str(extension),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--append-system-prompt',str(frozen/'skills/gdm-agents/pi/coordinator.md'),'--append-system-prompt','GDM Pi active profile: go. Implementation model: '+arm['model']+':'+arm['thinking']+'. GDM delegate routing: '+routing,'--tools','read,bash,edit,write,grep,find,ls'+(',gdm_delegate' if arm['delegate'] else ''),'--model',arm['model'],'--models',arm['model']+':'+arm['thinking'],'--thinking',arm['thinking'],prompt]
    env={k:v for k,v in os.environ.items() if not k.startswith('GDM_')}
    env.update({'PI_OFFLINE':'1','GDM_PI_MODEL':arm['model'],'GDM_PI_THINKING':arm['thinking'],'GDM_PI_EXECUTABLE':manifest['pi'],'GDM_PI_PROFILE':'go','GDM_EXECUTABLE':str(frozen/'bin/gdm'),'GDM_PI_IMPLEMENTATION_MODEL':arm['model']+':'+arm['thinking'],'GDM_PI_AUDIT_MODEL':('openai-codex/gpt-5.6-terra:high' if entry['arm']=='astra' else 'openai-codex/gpt-6-astra:medium'),'GDM_PI_CHILD_TIMEOUT_MS':'180000','PATH':str(frozen/'bin')+os.pathsep+os.environ['PATH']})
    if 'childModel' in arm:env.update({'GDM_PI_CHILD_MODEL':arm['childModel'],'GDM_PI_CHILD_THINKING':arm['childThinking']})
    save(log/'invocation.json',{'argvWithoutPrompt':args[:-1],'promptSha256':sha(prompt.encode()),'configuration':{k:v for k,v in env.items() if k.startswith('GDM_')},'startedAt':time.time()})
    print('START '+entry['id'],flush=True);started=time.monotonic();timeout=False
    with (log/'events.jsonl').open('wb') as out,(log/'stderr.log').open('wb') as err:
        p=subprocess.Popen(args,cwd=work,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True)
        try:p.wait(timeout=manifest['timeoutSeconds'])
        except subprocess.TimeoutExpired:timeout=True;stop_group(p)
    seconds=round(time.monotonic()-started,3)
    parsed=parse_events(log/'events.jsonl');(log/'final.md').write_text(parsed.pop('final'))
    protected=all((work/name).is_file() and sha((work/name).read_bytes())==digest for name,digest in manifest['fixtureSha256'][entry['task']].items() if not name.startswith('src/'))
    cmd(['git','add','-N','.'],work);diff=cmd(['git','diff','HEAD'],work);(log/'changes.diff').write_bytes(diff)
    hidden=work/'benchmark-hidden.test.ts';assert not hidden.exists();hidden.write_bytes((frozen/'grading'/f"{entry['task']}.test.ts").read_bytes())
    try:hidden_result=run_test(work,'./benchmark-hidden.test.ts',log/'hidden.txt')
    finally:hidden.unlink()
    visible=run_test(work,'./test/visible.test.ts',log/'visible.txt')
    states=[]
    for path in work.glob('.gdm/*/checks.json'):
        try:states.append(load(path))
        except ValueError:pass
    result={**entry,'exitCode':p.returncode,'timeout':timeout,'seconds':seconds,**parsed,'hidden':hidden_result,'visible':visible,'protectedUnchanged':protected,'doneMarker':'HARNESS_DONE:' in (log/'final.md').read_text(),'workDone':any(s.get('done') for s in states),'artifacts':{name:sha((log/name).read_bytes()) for name in ['events.jsonl','stderr.log','prompt.md','invocation.json','changes.diff','final.md','hidden.txt','visible.txt']}}
    result['success']=p.returncode==0 and not timeout and result['agentEnded'] and result['stopReason']=='stop' and hidden_result['exitCode']==0 and visible['exitCode']==0 and protected and result['doneMarker'] and result['workDone']
    save(log/'result.json',result)
    print(f"END {entry['id']} success={result['success']} seconds={seconds} children={len(result['children'])} tokens={result['totalUsage']['totalTokens']} usageComplete={result['usageComplete']}",flush=True)
    summarize(run)
    return result

def summarize(run):
    manifest=load(run/'manifest.json');rows=[load(p) for p in sorted((run/'runs').glob('*/result.json'))]
    summary={}
    for arm in manifest['arms']:
        selected=[r for r in rows if r['arm']==arm];valid=[r for r in selected if complete_usage(r)]
        if not selected:continue
        summary[arm]={'runs':len(selected),'successes':sum(r['success'] for r in selected),'timeouts':sum(r['timeout'] for r in selected),'usageCompleteRuns':len(valid),'medianSecondsAll':statistics.median(r['seconds'] for r in selected),'medianSecondsSuccess':statistics.median([r['seconds'] for r in selected if r['success']]) if any(r['success'] for r in selected) else None,'medianTokens':statistics.median(r['totalUsage']['totalTokens'] for r in valid) if valid else None,'medianApiCostEstimateUSD':statistics.median(r['totalUsage']['apiCostEstimateUSD'] for r in valid) if valid else None,'children':sum(len(r['children']) for r in selected),'childFailures':sum(not c['ok'] for r in selected for c in r['children'])}
    save(run/'summary.json',{'completed':len(rows),'planned':len(manifest['schedule']),'arms':summary})

def main():
    raise SystemExit('Retired benchmark: Pi integration was removed. Historical results are preserved; use the native GDM/gid benchmarks for new runs.')
    p=argparse.ArgumentParser();p.add_argument('--prepare',action='store_true');p.add_argument('--execute',action='store_true');p.add_argument('--run');p.add_argument('--limit',type=int);opts=p.parse_args()
    run=prepare() if opts.prepare else Path(opts.run or load(HERE/'active-run.json')['path'])
    if opts.execute:
        manifest=load(run/'manifest.json');assert manifest['frozenSha256']==file_hashes(run/'frozen'),'frozen input changed'
        pending=[e for e in manifest['schedule'] if not (run/'runs'/e['id']/'result.json').exists()]
        for entry in pending[:opts.limit] if opts.limit else pending:
            if (run/'pause').exists():
                print('PAUSED between observations; remove pause to resume without rerunning recorded results',flush=True)
                break
            run_one(run,entry)
        summarize(run)
    elif not opts.prepare:summarize(run)

if __name__=='__main__':main()
