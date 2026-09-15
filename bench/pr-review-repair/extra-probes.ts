/** Uniform exploratory behavior probes, never supplied to model workspaces. */
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const [repo,kind]=process.argv.slice(2);
if (!repo || !['bom','merged'].includes(kind)) throw new Error('repo and bom|merged required');
const at=(n:string)=>pathToFileURL(resolve(repo,'cli/src',n+'.ts')).href;
const state=await import(at('state'));const store=await import(at('store'));
const stamp='2026-09-09T00:00:00.000Z';
if(kind==='bom'){
 const cwd=mkdtempSync(join(tmpdir(),'gdm-replay-bom-'));const slug='bom-probe';
 try {
  store.saveWork(cwd,state.initWork(slug,'valid payload',stamp));const path=join(cwd,'.gdm',slug,'checks.json');const damaged=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),readFileSync(path),Buffer.from([0])]);writeFileSync(path,damaged);
  let accepted=false,error:string|null=null,loadable=false;
  try {store.repairTrailingNulWork(cwd,slug);accepted=true}catch(e){error=(e as Error).message}
  try {store.loadWork(cwd,slug);loadable=true}catch{}
  const bytesUnchanged=readFileSync(path).equals(damaged);
  console.log(JSON.stringify({kind,accepted,bytesUnchanged,loadable,error,refusesWithoutWrite:!accepted&&bytesUnchanged}));
 } finally {rmSync(cwd,{recursive:true,force:true})}
}else{
 const delivery=await import(at('delivery'));const contract=await import(at('contract'));const {cmdDelivery}=await import(at('delivery-cli'));const results=[];
 for(const change of ['none','branch','head']){
  const cwd=mkdtempSync(join(tmpdir(),'gdm-replay-merged-'));
  const git=(...args:string[])=>{const p=Bun.spawnSync(['git',...args],{cwd,stdout:'pipe',stderr:'pipe'});if(p.exitCode!==0)throw new Error(new TextDecoder().decode(p.stderr));return new TextDecoder().decode(p.stdout).trim()};
  try {
   git('init','-q','-b','feature/replay');git('config','user.name','Fixture');git('config','user.email','fixture@localhost');writeFileSync(join(cwd,'product.txt'),'one\n');git('add','product.txt');git('-c','commit.gpgsign=false','commit','-qm','isolated fixture');const head=git('rev-parse','HEAD');
   let w=state.initWork('merge-probe','merge metadata',stamp);w=state.addCheck(w,{desc:'ready',cmd:'true',expect:'exit 0'}).work;w=state.passCheck(w,'c1',{observed:'.gdm/merge-probe/out/c1.txt',sha256:'d'.repeat(64),manual:false,exitCode:0},stamp);w=state.closeWork(w,stamp);w=contract.transitionCommit(w,'explicitly-approved','record authorized merge',stamp).work;w=delivery.prepareDelivery(w,'#1','feature/replay',head,stamp);w=delivery.recordDeliveryPr(w,'#2',head,stamp);w=delivery.recordDeliveryCi(w,'passed',head,'run-1',stamp);w=delivery.approveDeliveryMerge(w,head,'record authorized merge',stamp);store.saveWork(cwd,w);
   if(change==='branch')git('checkout','-qb','main');
   if(change==='head'){writeFileSync(join(cwd,'product.txt'),'merged\n');git('add','product.txt');git('-c','commit.gpgsign=false','commit','-qm','isolated post-merge state')}
   let accepted=false,error:string|null=null;const log=console.log;console.log=()=>{};
   try{cmdDelivery(cwd,['merged','--slug','merge-probe','--head',head,'--merge-sha','c'.repeat(40)],stamp);accepted=true}catch(e){error=(e as Error).message}finally{console.log=log}
   results.push({change,accepted,error,mergedRecorded:!!store.loadWork(cwd,'merge-probe').delivery?.merged});
  }finally{rmSync(cwd,{recursive:true,force:true})}
 }
 console.log(JSON.stringify({kind,results}));
}
