"""Synthetic, credential-free routing fixtures. Hidden tests never enter a live model workspace."""
from pathlib import Path
import io
import subprocess
import tarfile

BASE = Path.home() / "projects/harness-bench"
HIDDEN = Path.home() / "projects/harness-bench-hidden"
OLD = {"t1": "t1-bugs", "t2": "t2-feature", "t3": "t3-hardening"}
NEW = {}

NEW["t4"] = {
"brief": """여러 tenant가 같은 사용자 id를 사용할 때 권한 캐시가 섞입니다. API getRole/setRole을 수정하세요.
tenant와 id는 콜론을 포함한 임의 문자열입니다. 둘을 함께 식별해야 하며 다른 tenant의 데이터에 영향을 주면 안 됩니다.
setRole 이후 같은 tenant/id의 getRole은 새 역할을 반환해야 합니다. 없는 사용자는 undefined를 반환하고 새 사용자 추가도 지원합니다.
기존 공개 API와 테스트를 보존하세요. 캐시 제거로 문제를 숨기지 말고 repository read 횟수 최적화를 유지하세요.""",
"files": {
"src/repository.ts": """export type User = { tenant: string; id: string; role: string };
export class Repository {
  reads = 0;
  constructor(public rows: User[]) {}
  get(tenant: string, id: string) { this.reads++; return this.rows.find(r => r.tenant === tenant && r.id === id); }
  put(tenant: string, id: string, role: string) {
    const row = this.rows.find(r => r.tenant === tenant && r.id === id);
    if (row) row.role = role; else this.rows.push({tenant, id, role});
  }
}
""",
"src/cache.ts": """export class RoleCache {
  private data = new Map<string, string | undefined>();
  key(tenant: string, id: string) { return id; }
  has(tenant: string, id: string) { return this.data.has(this.key(tenant, id)); }
  get(tenant: string, id: string) { return this.data.get(this.key(tenant, id)); }
  put(tenant: string, id: string, role: string | undefined) { this.data.set(this.key(tenant, id), role); }
  invalidate(tenant: string, id: string) { this.data.delete(id); }
}
""",
"src/api.ts": """import {Repository} from './repository';
import {RoleCache} from './cache';
export class Roles {
  constructor(public repo: Repository, public cache = new RoleCache()) {}
  getRole(tenant: string, id: string) {
    if (this.cache.has(tenant, id)) return this.cache.get(tenant, id);
    const role = this.repo.get(tenant, id)?.role;
    this.cache.put(tenant, id, role); return role;
  }
  setRole(tenant: string, id: string, role: string) { this.repo.put(tenant, id, role); this.cache.invalidate(tenant, id); }
}
"""},
"visible": """import {expect,test} from 'bun:test'; import {Roles} from '../src/api'; import {Repository} from '../src/repository';
test('single user and cache hit',()=>{ const r=new Repository([{tenant:'A',id:'1',role:'reader'}]); const a=new Roles(r); expect(a.getRole('A','1')).toBe('reader'); expect(a.getRole('A','1')).toBe('reader'); expect(r.reads).toBe(1); });
""",
"hidden": """import {expect,test} from 'bun:test'; import {Roles} from './src/api'; import {Repository} from './src/repository';
test('tenants isolate identical ids',()=>{ const a=new Roles(new Repository([{tenant:'A',id:'1',role:'admin'},{tenant:'B',id:'1',role:'reader'}])); expect(a.getRole('A','1')).toBe('admin'); expect(a.getRole('B','1')).toBe('reader'); });
test('separator collisions',()=>{const a=new Roles(new Repository([{tenant:'a:b',id:'c',role:'x'},{tenant:'a',id:'b:c',role:'y'}])); expect(a.getRole('a:b','c')).toBe('x'); expect(a.getRole('a','b:c')).toBe('y');});
test('write invalidates only exact key',()=>{const r=new Repository([{tenant:'A',id:'1',role:'x'},{tenant:'B',id:'1',role:'y'}]); const a=new Roles(r); a.getRole('A','1'); a.getRole('B','1'); a.setRole('A','1','z'); expect(a.getRole('A','1')).toBe('z'); expect(a.getRole('B','1')).toBe('y'); expect(r.reads).toBe(3);});
test('missing cache does not leak',()=>{const r=new Repository([{tenant:'A',id:'1',role:'x'}]); const a=new Roles(r); expect(a.getRole('B','1')).toBeUndefined(); expect(a.getRole('A','1')).toBe('x'); a.getRole('B','1'); expect(r.reads).toBe(2); a.setRole('B','1','new'); expect(a.getRole('B','1')).toBe('new');});
""",
"replacements": {"src/cache.ts": [("return id;", "return JSON.stringify([tenant, id]);"), ("this.data.delete(id)", "this.data.delete(this.key(tenant, id))")]}}

NEW["t5"] = {
"brief": """송금 라이브러리의 원자성과 멱등성을 수정하세요. 금액은 양의 정수, 송금 계정 두 개가 존재하며 서로 달라야 하고 잔액이 충분해야 합니다.
실패 시 잔액과 receipt를 모두 보존해야 하며, 같은 request id를 고쳐 다시 요청할 수 있어야 합니다.
성공한 id를 같은 from/to/amount로 재요청하면 추가 송금 없이 최초 receipt를 반환합니다. 같은 id의 다른 payload는 오류여야 합니다.
receipt의 fromBalance/toBalance는 최초 성공 직후 스냅샷입니다. 반환 객체를 호출자가 바꿔도 내부 기록이 변하면 안 됩니다. 동기 API는 유지하세요.""",
"files": {
"src/store.ts": """export type Receipt = { id: string; from: string; to: string; amount: number; fromBalance: number; toBalance: number };
export class Store { balances = new Map<string,number>(); receipts = new Map<string,Receipt>(); constructor(rows: [string,number][]) { this.balances = new Map(rows); } }
""",
"src/validate.ts": """export function validateAmount(amount: number) { if (amount < 0) throw new Error('amount'); }
""",
"src/transfer.ts": """import {Store, type Receipt} from './store'; import {validateAmount} from './validate';
export function transfer(s: Store, id: string, from: string, to: string, amount: number): Receipt {
  const previous = s.receipts.get(id); if (previous) return previous;
  validateAmount(amount);
  const before = s.balances.get(from); if (before === undefined) throw new Error('source');
  s.balances.set(from, before - amount);
  const target = s.balances.get(to); if (target === undefined) throw new Error('target');
  if (before < amount) throw new Error('funds');
  s.balances.set(to, target + amount);
  const receipt = {id, from, to, amount, fromBalance: before-amount, toBalance: target+amount};
  s.receipts.set(id, receipt); return receipt;
}
"""},
"visible": """import {expect,test} from 'bun:test'; import {Store} from '../src/store'; import {transfer} from '../src/transfer';
test('transfer and exact retry',()=>{const s=new Store([['a',10],['b',0]]); expect(transfer(s,'r','a','b',3).toBalance).toBe(3); transfer(s,'r','a','b',3); expect(s.balances.get('a')).toBe(7); });
""",
"hidden": """import {expect,test} from 'bun:test'; import {Store} from './src/store'; import {transfer} from './src/transfer';
test('unknown target rolls back',()=>{const s=new Store([['a',10]]); expect(()=>transfer(s,'r','a','b',3)).toThrow(); expect(s.balances.get('a')).toBe(10); expect(s.receipts.size).toBe(0); s.balances.set('b',0); expect(transfer(s,'r','a','b',3).fromBalance).toBe(7);});
test('insufficient funds atomic',()=>{const s=new Store([['a',2],['b',0]]); expect(()=>transfer(s,'r','a','b',3)).toThrow(); expect([...s.balances]).toEqual([['a',2],['b',0]]); expect(s.receipts.size).toBe(0);});
test('amount and self validation',()=>{for(const amount of [0,-1,1.5,NaN,Infinity]){const s=new Store([['a',10],['b',0]]); expect(()=>transfer(s,'r','a','b',amount)).toThrow(); expect(s.balances.get('a')).toBe(10);} const s=new Store([['a',10]]); expect(()=>transfer(s,'r','a','a',1)).toThrow(); expect(s.balances.get('a')).toBe(10);});
test('conflicting replay',()=>{const s=new Store([['a',10],['b',0],['c',0]]); transfer(s,'r','a','b',3); for(const args of [['a','b',4],['a','c',3],['b','a',3]] as const) expect(()=>transfer(s,'r',...args)).toThrow(); expect([...s.balances]).toEqual([['a',7],['b',3],['c',0]]);});
test('receipt snapshots and copies',()=>{const s=new Store([['a',10],['b',0]]); const r=transfer(s,'r','a','b',3); r.amount=99; r.fromBalance=-9; transfer(s,'r2','a','b',2); expect(transfer(s,'r','a','b',3)).toEqual({id:'r',from:'a',to:'b',amount:3,fromBalance:7,toBalance:3});});
""",
"oracle": {"src/validate.ts": "export function validateAmount(n:number){if(!Number.isInteger(n)||n<=0)throw new Error('amount');}\n",
"src/transfer.ts": """import {Store,type Receipt} from './store'; import {validateAmount} from './validate';
export function transfer(s:Store,id:string,from:string,to:string,amount:number):Receipt {
 const old=s.receipts.get(id); if(old){if(old.from!==from||old.to!==to||old.amount!==amount)throw new Error('conflict');return {...old};}
 validateAmount(amount);const a=s.balances.get(from),b=s.balances.get(to);if(a===undefined||b===undefined||from===to||a<amount)throw new Error('invalid');
 const r={id,from,to,amount,fromBalance:a-amount,toBalance:b+amount};s.balances.set(from,a-amount);s.balances.set(to,b+amount);s.receipts.set(id,r);return {...r};
}
"""}}

NEW["t6"] = {
"brief": """재시도 큐의 lease 상태 전이를 수정하세요. claim(now)은 due <= now인 pending 작업 중 가장 먼저 enqueue한 것을 선택합니다.
claim 성공 때마다 attempts를 1 올리고 작업별로 단조 증가하는 token을 반환합니다. running 작업은 다시 claim할 수 없습니다.
fail(id, token, now)은 현재 running token과 맞을 때만 상태를 변경합니다. attempts >= maxAttempts이면 dead, 아니면 pending과 due=now+min(cap,base*2**(attempts-1))입니다.
complete(id,token)도 현재 running token에만 적용합니다. 오래된 token과 알 수 없는 id는 무시하고 false를 반환합니다. 성공한 fail/complete는 true입니다.
dead/done은 재실행하면 안 됩니다. enqueue의 기본값과 공개 API를 유지하세요.""",
"files": {
"src/backoff.ts": "export function backoff(attempts:number,base:number,cap:number){return Math.min(cap,base*2**attempts);}\n",
"src/job.ts": "export type Job={id:string; state:'pending'|'running'|'done'|'dead';attempts:number;token:number;due:number;maxAttempts:number;base:number;cap:number};\n",
"src/queue.ts": """import {backoff} from './backoff';import type {Job} from './job';
export class Queue {
 jobs=new Map<string,Job>();
 enqueue(id:string,now:number,maxAttempts=3,base=10,cap=100){this.jobs.set(id,{id,state:'pending',attempts:0,token:0,due:now,maxAttempts,base,cap});}
 claim(now:number){const j=[...this.jobs.values()].find(j=>j.state==='pending'&&j.due<=now);if(!j)return; j.state='running'; j.attempts++; j.token++; return {...j};}
 fail(id:string,token:number,now:number){const j=this.jobs.get(id);if(!j)return false;j.state=j.attempts>j.maxAttempts?'dead':'pending';j.due=now+backoff(j.attempts,j.base,j.cap);return true;}
 complete(id:string,token:number){const j=this.jobs.get(id);if(!j)return false;j.state='done';return true;}
}
"""},
"visible": """import {expect,test} from 'bun:test';import {Queue} from '../src/queue';
test('enqueue and successful completion',()=>{const q=new Queue();q.enqueue('a',10);expect(q.claim(9)).toBeUndefined();const a=q.claim(10)!;expect(a.attempts).toBe(1);expect(q.complete('a',a.token)).toBe(true);expect(q.claim(20)).toBeUndefined();});
""",
"hidden": """import {expect,test} from 'bun:test';import {Queue} from './src/queue';
test('backoff boundaries and max attempts',()=>{const q=new Queue();q.enqueue('a',0,3,10,15);let j=q.claim(0)!;expect(q.fail('a',j.token,0)).toBe(true);expect(q.claim(9)).toBeUndefined();j=q.claim(10)!;expect(j.attempts).toBe(2);q.fail('a',j.token,10);expect(q.claim(24)).toBeUndefined();j=q.claim(25)!;q.fail('a',j.token,25);expect(q.jobs.get('a')!.state).toBe('dead');expect(q.claim(1000)).toBeUndefined();});
test('stale fail or complete cannot affect replacement lease',()=>{const q=new Queue();q.enqueue('a',0);const first=q.claim(0)!;q.fail('a',first.token,0);const second=q.claim(100)!;expect(second.token).toBeGreaterThan(first.token);expect(q.fail('a',first.token,100)).toBe(false);expect(q.complete('a',first.token)).toBe(false);expect(q.jobs.get('a')!.state).toBe('running');expect(q.complete('a',second.token)).toBe(true);expect(q.fail('a',second.token,100)).toBe(false);});
test('pending and done are not running',()=>{const q=new Queue();q.enqueue('a',0);expect(q.complete('a',0)).toBe(false);expect(q.fail('a',0,0)).toBe(false);const j=q.claim(0)!;expect(q.claim(0)).toBeUndefined();q.complete('a',j.token);expect(q.complete('a',j.token)).toBe(false);expect(q.fail('missing',0,0)).toBe(false);});
test('fifo eligible and attempts count claims',()=>{const q=new Queue();q.enqueue('later',50);q.enqueue('a',0);q.enqueue('b',0);expect(q.claim(0)?.id).toBe('a');expect(q.claim(0)?.id).toBe('b');expect(q.jobs.get('later')!.attempts).toBe(0);expect(q.claim(50)?.id).toBe('later');});
""",
"replacements": {"src/backoff.ts": [("2**attempts", "2**(attempts-1)")], "src/queue.ts": [("if(!j)return false;", "if(!j||j.state!=='running'||j.token!==token)return false;"), ("j.attempts>j.maxAttempts", "j.attempts>=j.maxAttempts")]}}

NEW["t7"] = {
"brief": """회의실 예약 가능 시간 계산을 고치세요. slots(resource,start,end,duration,step,capacity,reservations)는 start부터 step 간격의 후보 중 종료가 end 이하인 것만 반환합니다.
모든 시간은 같은 단위의 정수, 구간은 [start,end)입니다. 같은 resource의 기존 예약과 후보의 합산 동시 사용량이 어느 순간에도 capacity를 넘지 않아야 합니다. 후보는 1명을 추가합니다.
서로 겹치지 않는 기존 예약의 인원수를 단순 합산하면 안 됩니다. 인접 구간은 겹치지 않습니다. 다른 resource는 무시합니다.
duration/step은 양의 정수, capacity는 양의 정수, end>=start이어야 하며 위반 시 RangeError입니다. 기존 reservations는 유효하며 입력 배열을 변경하지 마세요.""",
"files": {
"src/types.ts": "export type Reservation={resource:string;start:number;end:number;count:number};\n",
"src/overlap.ts": "export function overlaps(a:number,b:number,c:number,d:number){return a<=d&&c<=b;}\n",
"src/slots.ts": """import type {Reservation} from './types';import {overlaps} from './overlap';
export function slots(resource:string,start:number,end:number,duration:number,step:number,capacity:number,reservations:Reservation[]):number[]{
 if(duration<=0||step<=0)throw new RangeError();
 const out:number[]=[];for(let s=start;s+duration<=end;s+=step){const used=reservations.filter(r=>overlaps(s,s+duration,r.start,r.end)).reduce((n,r)=>n+r.count,0);if(used+1<=capacity)out.push(s);}return out;
}
"""},
"visible": """import {expect,test} from 'bun:test';import {slots} from '../src/slots';
test('empty room grid',()=>{expect(slots('r',0,30,15,10,1,[])).toEqual([0,10]);expect(()=>slots('r',0,30,0,10,1,[])).toThrow(RangeError);});
""",
"hidden": """import {expect,test} from 'bun:test';import {slots} from './src/slots';
test('half open adjacent reservations',()=>{expect(slots('r',0,30,10,10,1,[{resource:'r',start:10,end:20,count:1}])).toEqual([0,20]);});
test('other resource ignored',()=>{expect(slots('r',0,20,10,10,1,[{resource:'x',start:0,end:100,count:99}])).toEqual([0,10]);});
test('disjoint busy spans do not add',()=>{const rs=[{resource:'r',start:0,end:5,count:1},{resource:'r',start:5,end:10,count:1}];const before=JSON.stringify(rs);expect(slots('r',0,10,10,10,2,rs)).toEqual([0]);expect(JSON.stringify(rs)).toBe(before);});
test('actual peak rejects',()=>{expect(slots('r',0,10,10,1,2,[{resource:'r',start:0,end:6,count:1},{resource:'r',start:5,end:10,count:1}])).toEqual([]);});
test('containment and counts',()=>{expect(slots('r',5,15,5,5,3,[{resource:'r',start:0,end:10,count:2}])).toEqual([5,10]);});
test('validation',()=>{for(const [end,d,s,c] of [[-1,1,1,1],[10,1.5,1,1],[10,1,1.5,1],[10,1,1,0],[10,1,1,1.5]])expect(()=>slots('r',0,end,d,s,c,[])).toThrow(RangeError); expect(slots('r',0,0,1,1,1,[])).toEqual([]);});
""",
"oracle": {"src/overlap.ts": "export function overlaps(a:number,b:number,c:number,d:number){return a<d&&c<b;}\n", "src/slots.ts": """import type {Reservation} from './types';import {overlaps} from './overlap';
export function slots(resource:string,start:number,end:number,duration:number,step:number,capacity:number,reservations:Reservation[]):number[]{
 if(![duration,step,capacity].every(n=>Number.isInteger(n)&&n>0)||end<start)throw new RangeError();const out:number[]=[];
 for(let s=start;s+duration<=end;s+=step){const events:[number,number][]=[];for(const r of reservations)if(r.resource===resource&&overlaps(s,s+duration,r.start,r.end)){events.push([Math.max(s,r.start),r.count],[Math.min(s+duration,r.end),-r.count]);} events.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let n=1,ok=true;for(const [,delta] of events){n+=delta;if(n>capacity)ok=false;}if(ok)out.push(s);}return out;
}
"""}}

NEW["t8"] = {
"brief": """AsyncMemo의 동시성 버그를 고치세요. get(tenant,id,loader)는 같은 키의 진행 중 Promise를 동일 객체로 공유하고 성공 값도 캐시합니다. tenant/id는 콜론 포함 임의 문자열입니다.
loader가 reject하거나 동기 throw하면 get은 reject되는 Promise를 반환하며, 이후 새 호출은 재시도할 수 있어야 합니다.
invalidate는 성공 값과 진행 중 항목을 무효화합니다. 무효화 전에 시작한 요청은 자신의 호출자에게 원래 결과를 반환할 수 있지만, 그 완료가 무효화 후 시작한 새 요청의 캐시를 덮거나 지우면 안 됩니다.
invalidate 후 새 get은 새 loader를 실행합니다. 다른 키와 tenant에 영향을 주지 않으며 기존 동기 메서드 시그니처와 Promise API를 유지하세요.""",
"files": {
"src/key.ts": "export const key=(tenant:string,id:string)=>tenant+':'+id;\n",
"src/memo.ts": """import {key} from './key';
export class AsyncMemo<T> {
 private values=new Map<string,T>();private pending=new Map<string,Promise<T>>();
 get(tenant:string,id:string,loader:()=>Promise<T>):Promise<T>{
  const k=key(tenant,id);if(this.values.has(k))return Promise.resolve(this.values.get(k)!);const active=this.pending.get(k);if(active)return active;
  const p=loader().then(v=>{this.values.set(k,v);return v;}).finally(()=>this.pending.delete(k));this.pending.set(k,p);return p;
 }
 invalidate(tenant:string,id:string){const k=key(tenant,id);this.values.delete(k);this.pending.delete(k);}
}
"""},
"visible": """import {expect,test} from 'bun:test';import {AsyncMemo} from '../src/memo';
test('cache and same pending promise',async()=>{const m=new AsyncMemo<number>();let calls=0;const loader=async()=>{calls++;return 7;};const a=m.get('a','1',loader),b=m.get('a','1',loader);expect(a).toBe(b);expect(await a).toBe(7);expect(await m.get('a','1',loader)).toBe(7);expect(calls).toBe(1);});
""",
"hidden": """import {expect,test} from 'bun:test';import {AsyncMemo} from './src/memo';
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
test('key collisions and unrelated invalidation',async()=>{const m=new AsyncMemo<number>();expect(await m.get('a:b','c',async()=>1)).toBe(1);expect(await m.get('a','b:c',async()=>2)).toBe(2);m.invalidate('a:b','c');expect(await m.get('a','b:c',async()=>3)).toBe(2);});
test('late old success cannot overwrite new value',async()=>{const m=new AsyncMemo<number>(),old=deferred<number>();const a=m.get('a','1',()=>old.promise);m.invalidate('a','1');expect(await m.get('a','1',async()=>2)).toBe(2);old.resolve(1);expect(await a).toBe(1);expect(await m.get('a','1',async()=>3)).toBe(2);});
test('old completion cannot erase new pending',async()=>{const m=new AsyncMemo<number>(),old=deferred<number>(),next=deferred<number>();const a=m.get('a','1',()=>old.promise);m.invalidate('a','1');const b=m.get('a','1',()=>next.promise);old.resolve(1);await a;const c=m.get('a','1',async()=>99);expect(c).toBe(b);next.resolve(2);expect(await c).toBe(2);});
test('old failure cannot erase new pending',async()=>{const m=new AsyncMemo<number>(),old=deferred<number>(),next=deferred<number>();const a=m.get('a','1',()=>old.promise);const handled=a.catch(()=>-1);m.invalidate('a','1');const b=m.get('a','1',()=>next.promise);old.reject(new Error('old'));await handled;expect(m.get('a','1',async()=>99)).toBe(b);next.resolve(2);await b;});
test('ordinary rejection retried',async()=>{const m=new AsyncMemo<number>();await expect(m.get('a','1',async()=>{throw new Error('bad');})).rejects.toThrow('bad');expect(await m.get('a','1',async()=>4)).toBe(4);});
test('synchronous throw becomes rejected promise',async()=>{const m=new AsyncMemo<number>();let p:Promise<number>|undefined;expect(()=>{p=m.get('a','1',()=>{throw new Error('sync');});}).not.toThrow();await expect(p!).rejects.toThrow('sync');expect(await m.get('a','1',async()=>5)).toBe(5);});
""",
"oracle": {"src/key.ts": "export const key=(tenant:string,id:string)=>JSON.stringify([tenant,id]);\n", "src/memo.ts": """import {key} from './key';export class AsyncMemo<T>{private values=new Map<string,T>();private pending=new Map<string,Promise<T>>();
get(tenant:string,id:string,loader:()=>Promise<T>):Promise<T>{const k=key(tenant,id);if(this.values.has(k))return Promise.resolve(this.values.get(k)!);const active=this.pending.get(k);if(active)return active;const p=Promise.resolve().then(loader).then(v=>{if(this.pending.get(k)===p)this.values.set(k,v);return v;}).finally(()=>{if(this.pending.get(k)===p)this.pending.delete(k);});this.pending.set(k,p);return p;}
invalidate(tenant:string,id:string){const k=key(tenant,id);this.values.delete(k);this.pending.delete(k);}}
"""}}

TASK_IDS = list(OLD) + list(NEW)

def materialize(task, directory):
    directory.mkdir(parents=True, exist_ok=True)
    if task in OLD:
        raw = subprocess.check_output(["git", "-C", str(BASE), "archive", OLD[task]])
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            archive.extractall(directory, filter="data")
        return (HIDDEN / "briefs" / f"{task}.md").read_text(), (HIDDEN / f"{task}.hidden.test.ts").read_text()
    spec = NEW[task]
    files = {"package.json": '{"name":"routing-fixture","type":"module","scripts":{"test":"bun test"}}\n', **spec["files"], "test/visible.test.ts": spec["visible"]}
    for name, text in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return spec["brief"], spec["hidden"]

def apply_oracle(task, directory):
    spec = NEW[task]
    for name, pairs in spec.get("replacements", {}).items():
        p = directory / name
        text = p.read_text()
        for old, new in pairs:
            assert old in text, (task, name, old)
            text = text.replace(old, new)
        p.write_text(text)
    for name, text in spec.get("oracle", {}).items():
        (directory / name).write_text(text)
