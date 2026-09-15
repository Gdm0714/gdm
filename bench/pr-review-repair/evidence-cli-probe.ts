import { resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo=process.argv[2]; if(!repo)throw new Error('snapshot required');
const decoder=new TextDecoder(); const results=[];
for(const mode of ['intact','deleted','tampered','new-output']){
 const cwd=mkdtempSync(join(tmpdir(),'gdm-replay-evidence-'));const slug='evidence-probe';
 const cli=(args:string[])=>{const p=Bun.spawnSync(['bun',resolve(repo,'cli/src/cli.ts'),...args],{cwd,stdout:'pipe',stderr:'pipe'});return {exitCode:p.exitCode,stdout:decoder.decode(p.stdout),stderr:decoder.decode(p.stderr)}};
 try{
  writeFileSync(join(cwd,'value.txt'),'initial\n');
  const setup=[cli(['plan','init','--slug',slug,'--brief','completion evidence integrity','--require','preserve evidence','--forbid','publication']),cli(['plan','add','--slug',slug,'--desc','successful command','--cmd','cat value.txt','--expect','exit zero']),cli(['pass','c1','--slug',slug])];
  if(setup.some(r=>r.exitCode!==0))throw new Error(JSON.stringify(setup));
  const statePath=join(cwd,'.gdm',slug,'checks.json');const before=JSON.parse(readFileSync(statePath,'utf8'));
  const evidencePath=join(cwd,'.gdm',slug,'out','c1.txt');const original=readFileSync(evidencePath,'utf8');
  if(mode==='deleted')rmSync(evidencePath);
  if(mode==='tampered')writeFileSync(evidencePath,'tampered\n');
  if(mode==='new-output')writeFileSync(join(cwd,'value.txt'),'changed but command still succeeds\n');
  const done=cli(['done','--slug',slug]);const after=JSON.parse(readFileSync(statePath,'utf8'));
  const journals=readFileSync(join(cwd,'.gdm',slug,'journal.jsonl'),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
  results.push({mode,...done,done:after.done,checkStatus:after.checks[0].status,evidenceExistedAfter:existsSync(evidencePath),evidenceBefore:before.checks[0].evidence,evidenceAfter:after.checks[0].evidence,originalOutput:original,outputAfter:existsSync(evidencePath)?readFileSync(evidencePath,'utf8'):null,staleEvents:journals.filter(e=>e.event==='evidence_stale').length,recheckEvents:journals.filter(e=>e.event==='recheck')});
 }finally{rmSync(cwd,{recursive:true,force:true})}
}
console.log(JSON.stringify({results,protectsStaleEvidence:results.filter(r=>['deleted','tampered'].includes(r.mode)).every(r=>r.exitCode!==0&&!r.done&&r.staleEvents>0),ordinaryCompletion:results.filter(r=>['intact','new-output'].includes(r.mode)).every(r=>r.exitCode===0&&r.done)}));
