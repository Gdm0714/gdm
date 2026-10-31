"""One immutable observation per scheduled invocation; never retry for a better score."""
import json
import math
import os
import signal
import subprocess
import time
from common import HERE, active, hashes, load, save, sha

def parse(path):
    messages=[];invalid=0;ended=False;tools=0
    for line in path.read_text().splitlines():
        if not line.strip():continue
        try:e=json.loads(line)
        except ValueError:invalid+=1;continue
        if e.get('type')=='message_end' and e.get('message',{}).get('role')=='assistant':messages.append(e['message'])
        if e.get('type')=='agent_end' and not e.get('willRetry',False):ended=True
        if e.get('type')=='tool_execution_start':tools+=1
    final='\n'.join(p.get('text','') for p in (messages[-1].get('content',[]) if messages else []) if p.get('type')=='text')
    value=final.strip()
    if value.startswith('```json\n') and value.endswith('```'):value=value[8:-3].strip()
    elif value.startswith('```\n') and value.endswith('```'):value=value[4:-3].strip()
    try:response=json.loads(value)
    except ValueError:response=None
    valid=isinstance(response,dict) and isinstance(response.get('summary'),str) and bool(response['summary'].strip()) and isinstance(response.get('findings'),list)
    if valid:
        ids=[]
        for f in response['findings']:
            valid=valid and isinstance(f,dict) and all(isinstance(f.get(k),str) and bool(f[k].strip()) for k in ['id','file','severity','issue','trigger','fix'])
            valid=valid and type(f.get('line')) is int and f['line']>0 and f['severity'] in ['high','medium','low']
            if isinstance(f,dict):ids.append(f.get('id'))
        valid=valid and len(ids)==len(set(ids))
    totals={k:0 for k in ['input','output','cacheRead','cacheWrite','totalTokens','apiCostEstimateUSD']};usageComplete=bool(messages)
    for m in messages:
        u=m.get('usage',{});values={k:u.get(k) for k in totals if k!='apiCostEstimateUSD'}
        values['apiCostEstimateUSD']=u.get('cost',{}).get('total')
        good=all(type(v) in [int,float] and math.isfinite(v) and v>=0 for v in values.values())
        usageComplete=usageComplete and good
        if good:
            for k,v in values.items():totals[k]+=v
    return {'final':final,'response':response,'responseValid':bool(valid),'agentEnded':ended,
      'stopReason':messages[-1].get('stopReason') if messages else None,
      'reportedModels':sorted({m.get('provider','')+'/'+m.get('model','') for m in messages}),
      'invalidJsonLines':invalid,'toolCalls':tools,'assistantMessages':len(messages),
      'usage':totals,'usageComplete':usageComplete}

def main():
    run,m=active();f=run/'frozen'
    assert hashes(f)==m['frozenSha256'],'frozen artifacts changed'
    assert sha((HERE/'run.py').read_bytes())==m['frozenSha256']['run.py']
    assert sha(__import__('pathlib').Path(m['pi']).read_bytes())==m['piEntrySha256']
    validation=load(HERE/'fixtures-validation.json');assert validation['manifestSha256']==sha((run/'manifest.json').read_bytes()) and validation['success']
    for entry in m['schedule']:
        dest=run/'reviews'/entry['id']
        if (dest/'result.json').exists():continue
        assert not dest.exists(),'interrupted observation; preserve and classify manually, never auto rerun'
        dest.mkdir(parents=True);(dest/'workspace').mkdir()
        packet=(f/'packets'/f"{entry['case']}.md").read_text();system=(f/'system.txt').read_text()
        args=[m['pi'],'--offline','--mode','json','--print','--no-session','--no-extensions',
          '--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--no-tools',
          '--system-prompt',system,'--model',entry['model'],'--thinking',m['thinking'],packet]
        save(dest/'invocation.json',{'id':entry['id'],'model':entry['model'],'thinking':m['thinking'],
          'packetSha256':sha(packet.encode()),'systemSha256':sha(system.encode()),'startedAt':time.time(),
          'flags':args[1:args.index('--system-prompt')]})
        env={k:v for k,v in os.environ.items() if not k.startswith('GDM_')};env['PI_OFFLINE']='1'
        print('START '+entry['id'],flush=True);start=time.monotonic();timedout=False;oversized=False;launched=False;launchError=None;code=None
        with (dest/'events.jsonl').open('wb') as out,(dest/'stderr.log').open('wb') as err:
            try:
                p=subprocess.Popen(args,cwd=dest/'workspace',stdin=subprocess.DEVNULL,stdout=out,stderr=err,env=env,start_new_session=True)
                launched=True
                while p.poll() is None:
                    timedout=time.monotonic()-start>m['timeoutSeconds']
                    oversized=out.tell()>8*1024*1024 or err.tell()>1024*1024
                    if timedout or oversized:
                        os.killpg(p.pid,signal.SIGTERM)
                        try:p.wait(timeout=3)
                        except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
                        break
                    try:p.wait(timeout=0.5)
                    except subprocess.TimeoutExpired:pass
                code=p.returncode
            except OSError as e:launchError=str(e)
        result=parse(dest/'events.jsonl')
        result.update(id=entry['id'],case=entry['case'],repetition=entry['repetition'],
          exitCode=code,launched=launched,launchError=launchError,timeout=timedout,oversized=oversized,
          seconds=round(time.monotonic()-start,3),workspaceUnchanged=not any((dest/'workspace').iterdir()))
        result['transportSuccess']=bool(launched and code==0 and not timedout and not oversized and result['agentEnded'] and
          result['stopReason']=='stop' and result['reportedModels']==[entry['model']] and not result['invalidJsonLines'] and result['toolCalls']==0 and result['workspaceUnchanged'])
        (dest/'final.txt').write_text(result['final'])
        result['artifactSha256']={name:sha((dest/name).read_bytes()) for name in ['events.jsonl','stderr.log','final.txt','invocation.json']}
        save(dest/'result.json',result)
        print(f"END {entry['id']} transport={result['transportSuccess']} response={result['responseValid']} seconds={result['seconds']}",flush=True)

if __name__ == "__main__":
    raise SystemExit('Retired benchmark: Pi integration was removed. Historical results are preserved; use the native GDM/gid benchmarks for new runs.')
if __name__=='__main__':main()
