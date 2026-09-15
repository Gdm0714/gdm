#!/usr/bin/env python3
"""Real installed read-only role dispatch smoke; separate from performance observations."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from fixtures import materialize
from run import HERE, file_hashes, parse_events, save, sha, stop_group

def main():
    root=Path(tempfile.mkdtemp(prefix='gdm-pi-role-live-',dir=str(Path.home()/'projects/harness-bench-runs')))
    work=root/'workspace';materialize('t8',work);before=file_hashes(work)
    pi=str(Path(shutil.which('pi')).resolve());extension=Path.home()/'.pi/agent/skills/gdm-agents/pi/gdm-delegate.ts'
    prompt='''This is an authorized read-only installed role-routing smoke. Do not implement or create GDM Work state.
Call gdm_delegate three times sequentially, one task per call. Do not batch or repeat calls.
All scopes are src within this directory. First role=scout, omit thinking: identify cache key and invalidation paths with file:line.
Second role=design, thinking=medium: propose a minimal way to prevent stale in-flight promises from overwriting or erasing replacement requests.
Third role=reviewer, thinking=high: inspect the current source for a concrete bug and provide a small counterexample.
For each call supply nonempty deliverable and verify text. Keep tasks concise and credential-free.
These are advisory read-only results, not formal audit evidence. After all three results, briefly report what completed.
Do not inspect parent directories, credentials, sessions, or external resources. Tools read/grep/find/ls and gdm_delegate are sufficient.'''
    args=[pi,'--offline','--mode','json','--print','--no-session','--no-extensions','--extension',str(extension),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--tools','read,grep,find,ls,gdm_delegate','--model','openai-codex/gpt-5.6-terra','--thinking','high',prompt]
    env={k:v for k,v in os.environ.items() if not k.startswith('GDM_')};env.update(GDM_PI_MODEL='openai-codex/gpt-5.6-terra',GDM_PI_THINKING='high',GDM_PI_EXECUTABLE=pi,PI_OFFLINE='1',GDM_PI_CHILD_TIMEOUT_MS='180000')
    started=time.monotonic();timed_out=False
    with (root/'events.jsonl').open('wb') as out,(root/'stderr.log').open('wb') as err:
        p=subprocess.Popen(args,cwd=work,env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True)
        try:p.wait(timeout=600)
        except subprocess.TimeoutExpired:timed_out=True;stop_group(p)
    result=parse_events(root/'events.jsonl');(root/'final.md').write_text(result.pop('final'))
    result.update(path=str(root),exitCode=p.returncode,timeout=timed_out,seconds=round(time.monotonic()-started,3),sourceUnchanged=before==file_hashes(work),eventsSha256=sha((root/'events.jsonl').read_bytes()))
    expected=[('scout','openai-codex/gpt-5.6-luna','medium'),('design','openai-codex/gpt-6-astra','medium'),('reviewer','openai-codex/gpt-6-astra','high')]
    actual=[(c['role'],c['model'],c['thinking']) for c in result['children']]
    result['success']=p.returncode==0 and not timed_out and result['sourceUnchanged'] and result['agentEnded'] and result['stopReason']=='stop' and actual==expected and result['reportedModels']==['openai-codex/gpt-5.6-terra'] and all(c['ok'] and c['usageComplete'] and c['reportedModels']==[c['model']] for c in result['children'])
    save(HERE/'live-role-probe.json',result)
    print(json.dumps({k:result[k] for k in ['path','success','seconds','sourceUnchanged','totalUsage']},ensure_ascii=False))
    assert result['success'], 'role dispatch smoke failed; inspect preserved events'

if __name__=='__main__':main()
