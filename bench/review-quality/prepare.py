"""Build real-source reconstructions and freeze the protocol before model calls."""
import difflib
import random
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from common import HERE, ROOT, active, function, hashes, save, sha

SYSTEM = '''You are a read-only code reviewer. Review the supplied candidate against
its stated contract. All relevant source and dependency contracts are in the packet.
No tools are available. Do not request other files, write code, or delegate.
Report actionable correctness defects with a concrete triggering condition, source
location, and impact. Do not report style preferences, speculative hardening outside
the stated contract, or dependencies explicitly assumed correct. Do not presume a bug
exists. Return JSON only: {"summary":"brief assessment", "findings":[{"id":"R1",
"file":"candidate/path", "line":1, "severity":"high|medium|low",
"issue":"root cause and impact", "trigger":"concrete reproduction",
"fix":"minimal correction"}]}. Use an empty findings array when appropriate.
Severity: high means data loss, security failure, or blocked core workflow; medium
means incorrect supported behavior or observability; low means minor functional harm.
'''

def git(path, rev='732177b'):
    return subprocess.check_output(['git', 'show', f'{rev}:{path}'], cwd=ROOT).decode()

def put(root, name, text):
    p = root / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)

def historical(root):
    names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', '732177b', 'cli/src'], cwd=ROOT).decode().splitlines()
    for name in names:
        put(root, name, git(name))

POLICY_TEST = '''import {expect,test} from 'bun:test';
import {validateDelegationRequest} from './candidate/policy.mjs';
const base={scope:'src',task:'Inspect source',deliverable:'Findings',verify:'Reproduce'};
test('known: all supported roles accept explicit medium and high',()=>{
 for(const role of ['scout','design','reviewer']) for(const thinking of ['medium','high'])
   expect(validateDelegationRequest({tasks:[{...base,role,thinking}]})).toBeNull();
});
test('control: defaults and validation boundaries',()=>{
 for(const role of ['scout','design','reviewer']) expect(validateDelegationRequest({tasks:[{...base,role}]})).toBeNull();
 for(const thinking of ['low','max','']) expect(validateDelegationRequest({tasks:[{...base,role:'scout',thinking}]})).not.toBeNull();
 expect(validateDelegationRequest({tasks:[]})).not.toBeNull();
 expect(validateDelegationRequest({tasks:[{...base,role:'scout',extra:1}]})).not.toBeNull();
});
'''

SPAWN_TEST = '''import {expect,test} from 'bun:test';
import {runBoundedChild} from './candidate/delegate-runner.mjs';
import {summarize} from './candidate/summary.mjs';
test('known: nonexistent executable has no launched child',async()=>{
 const result=await runBoundedChild({executable:'/gdm-review-nonexistent/executable',cwd:process.cwd(),
 model:'local/test',thinking:'medium',systemPrompt:'review',taskText:'inspect',timeoutMs:2000,
 metadata:{role:'reviewer',scope:'src'}});
 expect(result.spawned).toBe(false); expect(result.ok).toBe(false);
 const summary=summarize([{}],[result],{snapshot:()=>({active:0,total:1})});
 expect(summary.details.delegation).toMatchObject({attempted:1,launched:0,succeeded:0,failed:1});
},10000);
test('control: launched success and runtime failure both count as launches',()=>{
 const rows=[{spawned:true,ok:true,output:'OK',role:'reviewer',scope:'src'},
 {spawned:true,ok:false,error:'runtime error',role:'reviewer',scope:'src'}];
 expect(summarize([{},{}],rows,{snapshot:()=>({})}).details.delegation)
 .toMatchObject({attempted:2,launched:2,succeeded:1,failed:1});
});
'''

AUDIT_TEST = r'''import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os'; import {join} from 'node:path';
const cli=join(import.meta.dir,'cli/src/cli.ts');
function execute(cwd:string,args:string[]){const r=Bun.spawnSync(['bun',cli,...args],{cwd,stdout:'pipe',stderr:'pipe'});
return {exit:r.exitCode,out:new TextDecoder().decode(r.stdout),err:new TextDecoder().decode(r.stderr)};}
test('known: done preserves approved evidence despite nondeterministic output',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'review-audit-')); const slug='review-audit';
 try {
 for(const args of [
 ['plan','init','--slug',slug,'--brief','Review evidence','--audit','--require','Preserve','--forbid','Commit'],
 ['plan','add','--slug',slug,'--desc','Evidence','--cmd',"printf 'x' >> count.txt; cat count.txt",'--expect','exit zero'],
 ['pass','c1','--slug',slug]]) { const r=execute(cwd,args); expect(r.exit,r.err).toBe(0); }
 const dir=join(cwd,'.gdm',slug); const report=join(dir,'audit.md'); writeFileSync(report,'[APPROVE]\n');
 expect(execute(cwd,['audit','verdict','--pass','--report',report,'--slug',slug]).exit).toBe(0);
 const before=JSON.parse(readFileSync(join(dir,'checks.json'),'utf8'));
 const evidence=readFileSync(join(dir,'out/c1.txt'),'utf8');
 const done=execute(cwd,['done','--slug',slug]);
 expect(readFileSync(join(cwd,'count.txt'),'utf8')).toBe('xx');
 expect(done.exit,done.err).toBe(0);
 const after=JSON.parse(readFileSync(join(dir,'checks.json'),'utf8'));
 expect(after.done).toBe(true); expect(after.checks).toEqual(before.checks);
 expect(readFileSync(join(dir,'out/c1.txt'),'utf8')).toBe(evidence);
 } finally {rmSync(cwd,{recursive:true,force:true});}
},30000);
test('control: failing revalidation blocks completion',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'review-audit-control-')); const slug='review-audit';
 try {
 writeFileSync(join(cwd,'okay'),'yes');
 for(const args of [
 ['plan','init','--slug',slug,'--brief','Review evidence','--require','Preserve','--forbid','Commit'],
 ['plan','add','--slug',slug,'--desc','Evidence','--cmd','test -f okay','--expect','exit zero'],
 ['pass','c1','--slug',slug]]) expect(execute(cwd,args).exit).toBe(0);
 rmSync(join(cwd,'okay')); expect(execute(cwd,['done','--slug',slug]).exit).not.toBe(0);
 } finally {rmSync(cwd,{recursive:true,force:true});}
},30000);
'''

ATOMIC_TEST = '''import {expect,test,mock} from 'bun:test';
import * as fs from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path';
const original={...fs}; let interleave:(()=>void)|undefined;
mock.module('node:fs',()=>({...original,writeFileSync(path:any,body:any,options:any){
 original.writeFileSync(path,body,options);
 if(String(path).includes('.tmp')&&interleave){const callback=interleave;interleave=undefined;callback();}
}}));
const {savePresets,loadPresets}=await import('./cli/src/store.ts');
test('known: overlapping writes have separate temporary paths',()=>{
 const cwd=original.mkdtempSync(join(tmpdir(),'review-atomic-'));
 try {
 interleave=()=>savePresets(cwd,{value:'B'});
 expect(()=>savePresets(cwd,{value:'A'})).not.toThrow();
 expect(loadPresets(cwd)).toEqual({value:'A'});
 expect(original.readdirSync(join(cwd,'.gdm')).some(p=>p.includes('.tmp'))).toBe(false);
 } finally {interleave=undefined;original.rmSync(cwd,{recursive:true,force:true});}
});
test('control: sequential writes replace a whole JSON value',()=>{
 const cwd=original.mkdtempSync(join(tmpdir(),'review-atomic-control-'));
 try {savePresets(cwd,{long:'a'.repeat(1000)});savePresets(cwd,{short:'b'});
 expect(loadPresets(cwd)).toEqual({short:'b'});
 } finally {original.rmSync(cwd,{recursive:true,force:true});}
});
'''

def sources_for(family, defective, root):
    provenance = []
    if family == 'effort':
        source=(ROOT/'agents/pi/delegate-policy.mjs').read_text()
        old=Path('/Users/godongmin/projects/harness-bench-runs/gdm-pi-model-routing-20260908-7bd72wn6/frozen/skills/gdm-agents/pi/delegate-policy.mjs').read_text()
        if defective:
            source=source.replace(function(source,'validateDelegationRequest'),function(old,'validateDelegationRequest'))
        put(root,'candidate/policy.mjs',source)
        # Only the validation subsystem is newly introduced. Model-routing values
        # and unrelated budget code are not part of the review context or target.
        prefix=source[source.index('const CREDENTIAL_PATTERNS'):source.index('function textBytes')]
        candidate='const MAX_CONCURRENT_CHILDREN = 3;\nconst MAX_TASK_BYTES = 16 * 1024;\nconst ROLE_NAMES = new Set(["scout", "design", "reviewer"]);\n'+prefix
        candidate+='\n'.join(function(source,n) for n in ['textBytes','exactKeys','credentialSignature','validateDelegationRequest'])
        contract='''Introduce the delegation request validator. Inputs are plain JSON objects
from a validated JSON transport (no cyclic values, proxies, custom prototypes or
undefined-valued own properties). The top-level object contains exactly tasks, an
array of 1 to 3 objects. Each task has role (scout/design/reviewer), scope, task,
deliverable and verify (nonempty strings), and may set thinking to medium or high.
All three roles share this public optional effort field. Extra keys are rejected.
Enforce a 16 KiB serialized UTF-8 task limit and the supplied credential-signature
heuristic. That heuristic is a deliberately bounded detector, not a universal secret
scanner. Return null on valid requests and an explanatory string otherwise.'''
        tests=POLICY_TEST
        packets={'candidate/policy.mjs':candidate}
        provenance=[{'path':'agents/pi/delegate-policy.mjs','fixedSha256':sha((ROOT/'agents/pi/delegate-policy.mjs').read_bytes()),
                     'faultSourceSha256':sha(old.encode()),'origin':'Preserved 2026-09-08 routing experiment; 0.12.0 validator fix'}]
    elif family == 'launch':
        for name in ['delegate-policy.mjs','delegate-runner.mjs']:
            put(root,'candidate/'+name,(ROOT/'agents/pi'/name).read_text())
        ext=(ROOT/'agents/pi/gdm-delegate.ts').read_text()
        start=ext.index('        const succeeded = results.filter')
        end=ext.index('\n      } finally {',start)
        body=ext[start:end]
        if defective:
            body=body.replace('launched: results.filter((result) => result.spawned).length','launched: results.length')
        summary='export function summarize(tasks, results, budget) {\n'+body+'\n}\n'
        put(root,'candidate/summary.mjs',summary)
        runner=(ROOT/'agents/pi/delegate-runner.mjs').read_text()
        # All lifecycle logic is supplied; bounded parser helpers are unchanged.
        support=function(runner,'runBoundedChild')
        contract='''Introduce the result summarizer for a coordinator. tasks are already
validated; results contain exactly one settled child result for each task, in order.
The supplied runner is existing supporting code, not changed in this patch.
runChild keeps the runner fields and sets ok=false for empty substantive output.
Record attempts, processes actually started, successful substantive responses, and
failed tasks separately. A started process can fail later. Structured status and
isError must reflect failure; source text is advisory, not proof of completion.
budget.snapshot() returns immutable counters. All strings and booleans have their
declared types. createEventReader, process group helpers, argument validation and
timeouts are already tested supporting components and are outside review scope.
The host uses Node-compatible child_process spawn event/error/close semantics.'''
        tests=SPAWN_TEST
        packets={'candidate/summary.mjs':summary}
        provenance=[{'path':'agents/pi/gdm-delegate.ts','sha256':sha(ext.encode()),'origin':'0.12.0 -> 0.12.1 launched counter fix; runner stays at 0.12.1'}]
        return packets,{'support/delegate-runner.mjs':support},contract,tests,provenance
    else:
        historical(root)
        cli=git('cli/src/cli.ts'); state=git('cli/src/state.ts'); store=git('cli/src/store.ts')
        if family=='audit':
            if defective:
                cli=cli.replace('runRecheck(cwd, work, ts, autoTargets, "validate")','runRecheck(cwd, work, ts, autoTargets)')
            put(root,'cli/src/cli.ts',cli)
            packets={'candidate/completion.ts':'\n'.join(function(cli,n) for n in ['buildAutoEvidence','validateAutoCommand','runRecheck','verifyEvidence','cmdDone'])}
            support={'support/state.ts':'\n'.join(function(state,n) for n in ['checksHash','recordAudit','refreshEvidence','closeWork'])}
            contract='''Introduce the completion/revalidation subsystem shown below.
Work and Check values are validated before these functions. Completion must rerun
every proven automatic check, reject any failing command, verify saved evidence,
and enforce an approved audit tied to the checks state. Passing commands may emit
different logs on successive invocations. Existing approved evidence bytes and
metadata must remain the evidence on which the audit was based. A separate explicit
recheck command may refresh evidence and invalidate an audit. Calling done on an
already completed work may rerun validations before rejecting; that is allowed.
Underlying work storage, flag parsing, monotonic check IDs, path containment and
journal append are existing tested dependencies. The cwd is a trusted local
repository with no concurrent mutation during this command; saved evidence consists
of regular files and prior validated relative paths. Configured validation commands
are trusted and do not deliberately edit evidence or state files. Evidence at is an
ISO timestamp and checksHash includes the entire checks array. refreshEvidence and
revertChecks return immutable state copies; a revert clears the affected evidence.
Use standard Node fs/path/crypto/child_process imports; now, sha256 and tailLines
are existing helpers; CMD_TIMEOUT_MS is 300000. Unshown helpers are unchanged.'''
            tests=AUDIT_TEST
            provenance=[{'commit':subprocess.check_output(['git','rev-parse','732177b'],cwd=ROOT).decode().strip(),'path':'cli/src/cli.ts',
                         'origin':'Completion call restores the parent revision refresh-mode invocation; all other 0.8.2 code retained'}]
            return packets,support,contract,tests,provenance
        assert family=='atomic'
        if defective:
            store=store.replace(function(store,'savePresets'),function(git('cli/src/store.ts','732177b^'),'savePresets'))
        put(root,'cli/src/store.ts',store)
        packets={'candidate/presets.ts':'\n'.join(function(store,n) for n in ['atomicWriteFile','savePresets','loadPresets'])}
        contract='''Introduce the preset persistence subsystem. Use standard Node fs,
path and crypto imports, ROOT=".gdm", and GdmError as a typed Error. cwd exists and
is a trusted local filesystem directory; .gdm is a regular directory or absent,
and stored presets are valid Record<string,string> objects from the CLI parser.
Multiple OS processes may replace presets in the same repository concurrently.
Each successful save must atomically publish one complete JSON value, without
sharing a writer's temporary file. Last completed rename wins. Lost read-modify-write
updates are allowed: locking/merging, cross-file transactions, hostile directory
replacement and power-loss durability are outside this contract. No disk exhaustion
or permission failures are assumed. Interrupted processes and abnormal cleanup are
not the target; ordinary overlapping successful writers must not interfere.
randomUUID provides unique values for these processes. The unchanged loader must
continue to reject corrupt/non-string-valued JSON and return {} for a missing file.'''
        tests=ATOMIC_TEST
        provenance=[{'commit':subprocess.check_output(['git','rev-parse','732177b'],cwd=ROOT).decode().strip(),'path':'cli/src/store.ts',
                     'origin':'savePresets body from parent revision restores shared temporary-file collision; other 0.8.2 code retained'}]
    return packets,{},contract,tests,provenance

def main():
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--amend-uncalled-context',action='store_true');opts=parser.parse_args()
    previous=None
    if opts.amend_uncalled_context:
        previous,previousManifest=active()
        assert not (HERE/'blind-reviews.json').exists(),'no post-adjudication input changes'
        save(HERE/'pre-amendment-run.json',{'path':str(previous),'manifestSha256':sha((previous/'manifest.json').read_bytes())})
    else:
        assert not (HERE/'active-run.json').exists(),'preserve existing run; do not overwrite'
    run=Path(tempfile.mkdtemp(prefix='gdm-review-quality-20260909-',dir=Path.home()/'projects/harness-bench-runs'))
    frozen=run/'frozen';frozen.mkdir()
    for name in ['README.md','common.py','prepare.py','run.py','verify.py','analyze.py','test_analysis.py']:
        shutil.copy2(HERE/name,frozen/name)
    cases=[(family,defective) for family in ['effort','launch','audit','atomic'] for defective in [False,True]]
    random.Random(90417).shuffle(cases)
    truth=[]
    for i,(family,defective) in enumerate(cases,1):
        case=f'C{i:02d}';root=frozen/'fixtures'/case;root.mkdir(parents=True)
        candidates,support,contract,tests,provenance=sources_for(family,defective,root)
        put(root,'probe.test.ts',tests)
        prompt='# Review packet\n\n'+contract+'\n\nThe following reconstructed addition contains the review scope.\n'
        for name,source in candidates.items():
            patch=''.join(difflib.unified_diff([],source.splitlines(True),fromfile='/dev/null',tofile=name))
            prompt+='\n```diff\n'+patch+'```\n'
        for name,source in support.items():
            prompt+='\nUnchanged supporting context: '+name+'\n```typescript\n'+source+'```\n'
        put(frozen,'packets/'+case+'.md',prompt)
        save(frozen/'source-map'/f'{case}.json',{'candidates':candidates,'support':support})
        truth.append({'case':case,'family':family,'defective':defective,'severity':'high' if family in ['audit','atomic'] else 'medium',
                      'provenance':provenance,'packetSha256':sha(prompt.encode())})
    save(frozen/'truth.json',truth);put(frozen,'system.txt',SYSTEM)
    schedule=[];rng=random.Random(92731)
    models={'terra':'openai-codex/gpt-5.6-terra','astra':'openai-codex/gpt-6-astra'}
    for repetition in [1,2]:
        ordered=[t['case'] for t in truth];rng.shuffle(ordered)
        for ordinal,case in enumerate(ordered):
            arms=['terra','astra'] if (ordinal+repetition)%2 else ['astra','terra']
            for arm in arms:
                schedule.append({'id':f'R{len(schedule)+1:02d}','case':case,'repetition':repetition,'arm':arm,'model':models[arm]})
    pi=str(Path(shutil.which('pi')).resolve())
    manifest={'schema':'gdm-review-quality/v1','createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
      'pi':pi,'piVersion':subprocess.check_output([pi,'--version']).decode().strip(),
      'piEntrySha256':sha(Path(pi).read_bytes()),'thinking':'medium','timeoutSeconds':180,
      'schedule':schedule,'frozenSha256':hashes(frozen),'knownDefectFamilies':4,'cases':8,'observations':32,
      'execution':'Sequential direct tool-free Pi reviewer calls; no coordinator model or gdm_delegate invocation'}
    if previous:
        carried=[]
        for old in sorted((previous/'reviews').glob('*/result.json')):
            import json
            result=json.loads(old.read_text());entry=next(e for e in schedule if e['id']==result['id'])
            inv=json.loads((old.parent/'invocation.json').read_text())
            assert inv['packetSha256']==sha((frozen/'packets'/f"{entry['case']}.md").read_bytes()),'cannot carry a changed input'
            assert inv['systemSha256']==sha((frozen/'system.txt').read_bytes())
            assert entry==next(e for e in previousManifest['schedule'] if e['id']==entry['id'])
            shutil.copytree(old.parent,run/'reviews'/entry['id']);carried.append(entry['id'])
        assert carried==[f'R{i:02d}' for i in range(1,9)]
        manifest['amendment']={'previousRun':str(previous),'previousManifestSha256':sha((previous/'manifest.json').read_bytes()),
          'reason':'Before C01/C03 were called, fix truncated destructured runner function in supporting context; no response contents read or adjudicated.',
          'carriedUnchanged':carried,'changedPackets':['C01','C03'],
          'latencyExcluded':['R07','R08'],'latencyReason':'R08 supervisor was paused to stop at an observation boundary; exclude its matched pair from latency medians. Raw wall time and usage retained.'}
    save(run/'manifest.json',manifest)
    save(HERE/'active-run.json',{'path':str(run),'manifestSha256':sha((run/'manifest.json').read_bytes())})
    print(str(run),flush=True)

if __name__=='__main__':main()
