"""Installed live role/error smoke. These calls are never pooled with quality observations."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from common import HERE, hashes, sha, save, parse_events
from run import stop

def main():
    root=Path(tempfile.mkdtemp(prefix='gdm-pi-quality-role-probe-',dir=Path.home()/'projects/harness-bench-runs'))
    work=root/'workspace';(work/'src').mkdir(parents=True)
    (work/'src/cache.ts').write_text("export class Cache { private values = new Map<string, string>(); get(tenant: string, key: string) { return this.values.get(key); } put(tenant: string, key: string, value: string) { this.values.set(key, value); } }\n")
    before=hashes(work);pi=str(Path(shutil.which('pi')).resolve());ext=Path.home()/'.pi/agent/skills/gdm-agents/pi/gdm-delegate.ts'
    prompt='''Authorized installed runtime smoke. Read-only; no Work or edits. Make exactly four sequential gdm_delegate calls, one task each, without extra calls.
First intentionally exercise application validation: role scout, thinking medium, scope src, task Inspect the cache, deliverable empty string, verify Check source. This must be rejected; do not treat it as specialist participation.
Then scout thinking medium: read src/cache.ts and identify key contract. Then design thinking medium: read src/cache.ts and propose tenant isolation. Then reviewer thinking medium: read src/cache.ts and give a concrete isolation counterexample. For these three supply all five required fields with nonempty strings and concise deliverable and verify instructions. Every child must actually read src/cache.ts. Report the rejected attempt separately from completed roles. No outside files, network, shell, credentials or extra delegation.'''
    args=[pi,'--offline','--mode','json','--print','--no-session','--no-extensions','--extension',str(ext),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--tools','read,grep,find,ls,gdm_delegate','--model','openai-codex/gpt-5.6-terra','--thinking','high',prompt]
    env={k:v for k,v in os.environ.items() if not k.startswith('GDM_')};env.update(GDM_PI_MODEL='openai-codex/gpt-5.6-terra',GDM_PI_THINKING='high',GDM_PI_EXECUTABLE=pi,PI_OFFLINE='1',GDM_PI_CHILD_TIMEOUT_MS='180000')
    started=time.monotonic();timedout=False
    with (root/'events.jsonl').open('wb') as out,(root/'stderr.log').open('wb') as err:
        p=subprocess.Popen(args,cwd=work,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True)
        try:p.wait(timeout=600)
        except subprocess.TimeoutExpired:timedout=True;stop(p)
    r=parse_events(root/'events.jsonl');r.update(path=str(root),exitCode=p.returncode,timeout=timedout,seconds=round(time.monotonic()-started,3),sourceUnchanged=before==hashes(work),eventsSha256=sha((root/'events.jsonl').read_bytes()),extensionSha256=sha(ext.read_bytes()))
    expected=[('scout','openai-codex/gpt-5.6-luna','medium'),('design','openai-codex/gpt-6-astra','medium'),('reviewer','openai-codex/gpt-6-astra','medium')]
    r['success']=bool(p.returncode==0 and not timedout and r['sourceUnchanged'] and r['agentEnded'] and r['stopReason']=='stop' and len(r['delegateAttempts'])==4 and sum(a.get('rejected',False) for a in r['delegateAttempts'])==1 and all(a.get('error') for a in r['delegateAttempts'] if a.get('rejected')) and [(c['role'],c['model'],c['thinking']) for c in r['children']]==expected and all(c['ok'] and c['reportedModels']==[c['model']] and any(t['name']=='read' and not t['isError'] for t in c['toolCalls']) for c in r['children']))
    save(HERE/'live-role-probe.json',r);print({k:r[k] for k in ['path','success','seconds','sourceUnchanged']},flush=True)
    assert r['success'],'preserved live probe failed'
if __name__=='__main__':main()
