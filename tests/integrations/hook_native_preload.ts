// Keep original Bun assertions and schema reader, replace only execution policy.
import { mock } from "bun:test";
import { resolve } from "node:path";
const path=resolve(import.meta.dir,"../../cli/src/codex-agent-hook.ts");
const oracle=await import(path);
const driver=process.env.GDM_HOOK_TEST_DRIVER;
if(!driver) throw new Error("GDM_HOOK_TEST_DRIVER required");
mock.module(path,()=>({...oracle,runCodexAgentHook(cwd:string,stdin:string,env:Record<string,string>,timestamp=Date.now()){
 const result=Bun.spawnSync([driver,cwd,String(timestamp)],{env,stdin:Buffer.from(stdin),stdout:"pipe",stderr:"pipe"});
 if(result.exitCode!==0)throw new Error(new TextDecoder().decode(result.stderr));
 return JSON.parse(new TextDecoder().decode(result.stdout));
}}));
