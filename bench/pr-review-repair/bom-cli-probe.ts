import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo=process.argv[2];if(!repo)throw new Error('snapshot required');
const state=await import(pathToFileURL(resolve(repo,'cli/src/state.ts')).href);
const store=await import(pathToFileURL(resolve(repo,'cli/src/store.ts')).href);
const cwd=mkdtempSync(join(tmpdir(),'gdm-replay-bom-cli-'));const slug='bom-cli-probe';
try{
 store.saveWork(cwd,state.initWork(slug,'valid payload','2026-09-09T00:00:00.000Z'));
 const path=join(cwd,'.gdm',slug,'checks.json');const damaged=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),readFileSync(path),Buffer.from([0])]);writeFileSync(path,damaged);
 const p=Bun.spawnSync(['bun',resolve(repo,'cli/src/cli.ts'),'repair','state','--slug',slug,'--trailing-nul'],{cwd,stdout:'pipe',stderr:'pipe'});
 const bytesUnchanged=readFileSync(path).equals(damaged);const successJournals=store.readJournal(cwd,slug).filter((e:any)=>e.event==='state.repair').length;
 let loadable=false;try{store.loadWork(cwd,slug);loadable=true}catch{}
 console.log(JSON.stringify({exitCode:p.exitCode,bytesUnchanged,successJournals,loadable,stdout:new TextDecoder().decode(p.stdout),stderr:new TextDecoder().decode(p.stderr),refusesWithoutWriteOrSuccessJournal:p.exitCode!==0&&bytesUnchanged&&successJournals===0}));
}finally{rmSync(cwd,{recursive:true,force:true})}
