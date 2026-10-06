import {mock} from 'bun:test';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dir,'../..');
const binary=process.env.GDM_NATIVE_TEST_BINARY??join(root,'target/debug/gdm');
mock.module(join(root,'tests/legacy/pi/delegate-runner.mjs'),()=>({async runBoundedChild(options:any){
 const {signal,...input}=options;
 const p=Bun.spawn([binary,'delegate','rpc'],{cwd:options.cwd,stdin:Buffer.from(JSON.stringify({action:'run',...input})),stdout:'pipe',stderr:'pipe'});
 const abort=()=>p.kill('SIGTERM');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);signal?.removeEventListener('abort',abort);
 if(code!==0)throw new Error(stderr);return JSON.parse(stdout);
}}));
