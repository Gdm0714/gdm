import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWork } from './cli/src/state.ts';
import { saveWork, repairTrailingNulWork, loadWork, readJournal } from './cli/src/store.ts';
const CLI=join(import.meta.dir,'cli/src/cli.ts');
function fixture(){const cwd=mkdtempSync(join(tmpdir(),'gdm-pr-recovery-'));const slug='repair-probe';saveWork(cwd,initWork(slug,'BYTE_SENTINEL','2026-07-15T00:00:00.000Z'));return {cwd,slug,path:join(cwd,'.gdm',slug,'checks.json')}}
function refuses(mutate:(b:Buffer)=>Buffer){const {cwd,slug,path}=fixture();try{const damaged=mutate(readFileSync(path));writeFileSync(path,damaged);expect(()=>repairTrailingNulWork(cwd,slug)).toThrow();expect(readFileSync(path).equals(damaged)).toBe(true)}finally{rmSync(cwd,{recursive:true,force:true})}}
test('D01 invalid UTF-8 inside otherwise valid JSON is rejected without a write',()=>refuses(b=>{const at=b.indexOf('BYTE_SENTINEL');return Buffer.concat([b.subarray(0,at),Buffer.from([0xff]),b.subarray(at+1),Buffer.from([0,0])])}));
test('D02 directory and decoded Work slug must match before any write',()=>refuses(b=>Buffer.from(b.toString().replace('"slug": "repair-probe"','"slug": "other-work"')+'\0')));
test('G01 explicit CLI repair preserves every non-NUL byte and journals once',()=>{const {cwd,slug,path}=fixture();try{const clean=readFileSync(path);appendFileSync(path,Buffer.from([0,0,0]));const p=Bun.spawnSync(['bun',CLI,'repair','state','--slug',slug,'--trailing-nul'],{cwd,stdout:'pipe',stderr:'pipe'});expect(p.exitCode).toBe(0);expect(readFileSync(path).equals(clean)).toBe(true);expect(loadWork(cwd,slug).brief).toBe('BYTE_SENTINEL');expect(readJournal(cwd,slug).filter(e=>e.event==='state.repair')).toHaveLength(1)}finally{rmSync(cwd,{recursive:true,force:true})}});
test('G02 an interior raw NUL is never stripped',()=>refuses(b=>Buffer.from(b.toString().replace('BYTE_SENTINEL','BYTE\0SENTINEL')+'\0')));
test('G03 a clean file is not rewritten',()=>refuses(b=>b));
test('G04 truncated JSON is never repaired',()=>refuses(b=>Buffer.concat([b.subarray(0,b.length-8),Buffer.from([0])])));
test('G05 schema-invalid JSON is refused',()=>refuses(()=>Buffer.from('{"slug":"repair-probe"}\0')));
test('G06 repair mode must be explicit',()=>{const {cwd,slug,path}=fixture();try{appendFileSync(path,Buffer.from([0]));const before=readFileSync(path);const p=Bun.spawnSync(['bun',CLI,'repair','state','--slug',slug],{cwd,stdout:'pipe',stderr:'pipe'});expect(p.exitCode).not.toBe(0);expect(readFileSync(path).equals(before)).toBe(true)}finally{rmSync(cwd,{recursive:true,force:true})}});
