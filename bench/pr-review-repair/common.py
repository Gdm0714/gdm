import hashlib, json, math, re, shutil, subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
def sha(b):return hashlib.sha256(b).hexdigest()
def load(p):return json.loads(Path(p).read_text())
def save(p,v):
 p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def hashes(p):return {str(x.relative_to(p)):sha(x.read_bytes()) for x in sorted(p.rglob('*')) if x.is_file() and not x.is_symlink() and '__pycache__' not in x.parts}
def active():
 a=load(HERE/'active-run.json');p=Path(a['path']);assert sha((p/'manifest.json').read_bytes())==a['manifestSha256'];return p,load(p/'manifest.json')
def cmd(args,cwd=None):return subprocess.check_output(args,cwd=cwd,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL)
def obj(t):
 t=t.strip();t=re.sub(r'^```(?:json)?\s*|\s*```$','',t)
 try:return json.loads(t)
 except ValueError:return None
def parse(path):
 messages=[];calls=[];ended=False;invalid=0
 for line in path.read_text().splitlines():
  if not line.strip():continue
  try:e=json.loads(line)
  except ValueError:invalid+=1;continue
  if e.get('type')=='message_end' and e.get('message',{}).get('role')=='assistant':messages.append(e['message'])
  if e.get('type')=='tool_execution_start':calls.append({'name':e.get('toolName'),'args':e.get('args'),'id':e.get('toolCallId')})
  if e.get('type')=='agent_end' and not e.get('willRetry',False):ended=True
 final='\n'.join(p.get('text','') for p in (messages[-1].get('content',[]) if messages else []) if p.get('type')=='text')
 fields=['input','output','cacheRead','cacheWrite','totalTokens','apiCostEstimateUSD'];usage=dict.fromkeys(fields,0);complete=bool(messages)
 for m in messages:
  u=m.get('usage',{});v={k:u.get(k) for k in fields};v['apiCostEstimateUSD']=u.get('cost',{}).get('total')
  good=all(type(n) in [int,float] and math.isfinite(n) and n>=0 for n in v.values());complete &=good
  if good:
   for k,n in v.items():usage[k]+=n
 return {'final':final,'object':obj(final),'usage':usage,'usageComplete':complete,'reportedModels':sorted({m.get('provider','')+'/'+m.get('model','') for m in messages}),'assistantMessages':len(messages),'calls':calls,'agentEnded':ended,'stopReason':messages[-1].get('stopReason') if messages else None,'invalidJsonLines':invalid}
def test_run(work,args,out,timeout=150):
 try:
  p=subprocess.run(['bun','test',*args],cwd=work,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout);code=p.returncode;data=p.stdout
 except subprocess.TimeoutExpired as e:code=124;data=(e.stdout or b'')+b'\nGRADING_TIMEOUT'
 out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data);s=data.decode(errors='replace')
 return {'exitCode':code,'passed':re.findall(r'^\(pass\) (.*?)(?: \[[\d.]+ms\])?$',s,re.M),'failed':re.findall(r'^\(fail\) (.*?)(?: \[[\d.]+ms\])?$',s,re.M),'logSha256':sha(data)}
def grade(snapshot,frozen,case,dest):
 dest.mkdir(parents=True,exist_ok=False);work=dest/'workspace';shutil.copytree(snapshot,work,symlinks=True)
 # Always restore original public tests/config; additions are evaluated separately by the repairer.
 for p in (frozen/'cases'/case/'candidate'/'cli/test').glob('*.test.ts'):shutil.copy2(p,work/'cli/test'/p.name)
 shutil.copy2(frozen/'cases'/case/'candidate/cli/package.json',work/'cli/package.json')
 shutil.copy2(frozen/'hidden'/f'{case}.test.ts',work/'held-out.test.ts')
 visible=load(frozen/'cases'/case/'meta.json')['visibleTests']
 result={'hidden':test_run(work,['./held-out.test.ts'],dest/'hidden.log'),'visible':test_run(work,visible,dest/'visible.log')}
 # Avoid retaining duplicated large working trees after grading; logs and source snapshots are enough to reproduce.
 shutil.rmtree(work);return result
