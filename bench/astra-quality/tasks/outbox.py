"""Customer-scoped transactional outbox and lease repair fixture."""

TASK = {
"id": "customer-outbox-leases",
"brief": """Repair the synchronous in-memory order and outbox workflow without changing its exported classes. Customer, request, SKU, worker, and event identifiers are nonempty primitive strings; separators are valid data and identity is the exact `(customer, requestId)` pair. `Orders.submit(customer, requestId, sku, quantity, now?)` accepts a positive integer quantity and commits exactly one customer-scoped order with exactly one `order.submitted` outbox event. Replaying the same request and payload for that customer returns the original order; `now` is not part of that replay payload. Changing SKU or quantity is a conflict, while another customer may use the same request id. `Store.failNextEventCommit()` simulates an event-write failure: it must leave every pre-existing record unchanged, add neither half of the new pair, and a later retry must add exactly that pair. Event claim order is due time followed by store-wide successful commit order, including ties from multiple `Orders` instances. All returned records and lists are snapshots. `Publisher.claim(worker, now, leaseMs)` may claim due pending/retry events and expired leases, creates a new claim token, and consumes an attempt on every claim. When a final live lease expires, it becomes terminal rather than being reclaimed again. `ack` has no time parameter, so its current owner/token remains valid until a replacement claim occurs; `retry` and `ack` otherwise accept only the current worker and token. Retried events become due after the configured delay; attempting beyond an event's maximum makes it terminal. `cancel` invalidates a live lease and terminal events cannot be claimed or cancelled again. Hidden tests cover separator-safe customer identity, replay conflicts, validation and atomic preservation, event consistency and copy isolation, expired-lease reclaim and exhaustion, stale claim ownership, retry scheduling and attempt limits, cancellation, terminal behavior, and store-wide claim ordering.""",
"files": {
"src/types.ts": """export type Order = {
  customer: string;
  requestId: string;
  sku: string;
  quantity: number;
  createdAt: number;
};

export type EventState = 'pending' | 'leased' | 'sent' | 'dead' | 'cancelled';
export type OutboxEvent = {
  id: string;
  customer: string;
  orderRequestId: string;
  kind: 'order.submitted';
  state: EventState;
  attempts: number;
  token: number;
  dueAt: number;
  leaseUntil: number;
  leaseOwner?: string;
  maxAttempts: number;
  retryDelay: number;
  sequence: number;
};

export const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
""",
"src/keys.ts": """export const orderKey = (customer: string, requestId: string) => requestId;
export const eventId = (customer: string, requestId: string) => `order:${customer}:${requestId}`;
""",
"src/store.ts": """import type { Order, OutboxEvent } from './types';
import { orderKey } from './keys';

const copyOrder = (order: Order): Order => ({ ...order });
const copyEvent = (event: OutboxEvent): OutboxEvent => ({ ...event });

export class Store {
  private orders = new Map<string, Order>();
  private events = new Map<string, OutboxEvent>();
  private failEvent = false;

  failNextEventCommit() { this.failEvent = true; }
  get orderCount() { return this.orders.size; }
  get eventCount() { return this.events.size; }

  findOrder(customer: string, requestId: string) {
    const order = this.orders.get(orderKey(customer, requestId));
    return order && copyOrder(order);
  }

  getEvent(id: string) { const event = this.events.get(id); return event && copyEvent(event); }
  listEvents() { return [...this.events.values()].sort((a, b) => a.sequence - b.sequence).map(copyEvent); }

  commit(order: Order, event: OutboxEvent) {
    this.orders.set(orderKey(order.customer, order.requestId), copyOrder(order));
    if (this.failEvent) { this.failEvent = false; throw new Error('outbox unavailable'); }
    this.events.set(event.id, copyEvent(event));
  }

  replaceEvent(event: OutboxEvent) {
    if (!this.events.has(event.id)) throw new Error('event');
    this.events.set(event.id, copyEvent(event));
  }
}
""",
"src/orders.ts": """import { eventId } from './keys';
import { Store } from './store';
import type { Order, OutboxEvent } from './types';

export class Orders {
  private sequence = 0;
  constructor(public store: Store) {}

  submit(customer: string, requestId: string, sku: string, quantity: number, now = 0): Order {
    const previous = this.store.findOrder(customer, requestId);
    if (previous) return previous;
    if (!customer || !requestId || !sku || !Number.isInteger(quantity) || quantity <= 0) throw new Error('order');
    const order = { customer, requestId, sku, quantity, createdAt: now };
    const event: OutboxEvent = {
      id: eventId(customer, requestId), customer, orderRequestId: requestId, kind: 'order.submitted',
      state: 'pending', attempts: 0, token: 0, dueAt: now, leaseUntil: 0,
      maxAttempts: 3, retryDelay: 10, sequence: this.sequence++,
    };
    this.store.commit(order, event);
    return order;
  }
}
""",
"src/publisher.ts": """import { Store } from './store';
import type { OutboxEvent } from './types';

const copy = (event: OutboxEvent) => ({ ...event });

export class Publisher {
  constructor(public store: Store) {}

  claim(worker: string, now: number, leaseMs: number): OutboxEvent | undefined {
    if (!worker || !Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error('lease');
    const event = this.store.listEvents().filter(candidate =>
      (candidate.state === 'pending' && candidate.dueAt <= now))
      .sort((a, b) => a.dueAt - b.dueAt || a.sequence - b.sequence)[0];
    if (!event) return undefined;
    const leased = { ...event, state: 'leased' as const, attempts: event.attempts + 1, token: event.token + 1, leaseOwner: worker, leaseUntil: now + leaseMs };
    this.store.replaceEvent(leased);
    return copy(leased);
  }

  ack(id: string, worker: string, token: number) {
    const event = this.store.getEvent(id);
    if (!event) return false;
    this.store.replaceEvent({ ...event, state: 'sent', leaseUntil: 0, leaseOwner: undefined });
    return true;
  }

  retry(id: string, worker: string, token: number, now: number) {
    const event = this.store.getEvent(id);
    if (!event) return false;
    const state = event.attempts >= event.maxAttempts ? 'dead' : 'pending';
    this.store.replaceEvent({ ...event, state, dueAt: now + event.retryDelay, leaseUntil: 0, leaseOwner: undefined });
    return true;
  }

  cancel(id: string) {
    const event = this.store.getEvent(id);
    if (!event) return false;
    this.store.replaceEvent({ ...event, state: 'cancelled', leaseUntil: 0, leaseOwner: undefined });
    return true;
  }
}
"""},
"visible": """import {expect,test} from 'bun:test';import {Store} from '../src/store';import {Orders} from '../src/orders';import {Publisher} from '../src/publisher';
test('submits and publishes one order',()=>{const store=new Store(),orders=new Orders(store),publisher=new Publisher(store);expect(orders.submit('c','r','sku',2).sku).toBe('sku');const claim=publisher.claim('w',0,5)!;expect(publisher.ack(claim.id,'w',claim.token)).toBe(true);expect(store.getEvent(claim.id)?.state).toBe('sent');});
""",
"hidden": """import {expect,test} from 'bun:test';import {Store} from './src/store';import {Orders} from './src/orders';import {Publisher} from './src/publisher';
const setup=()=>{const store=new Store(),orders=new Orders(store),publisher=new Publisher(store);return {store,orders,publisher}};
test('customer request identity is separator safe',()=>{const x=setup();x.orders.submit('a:b','c','sku',1);x.orders.submit('a','b:c','other',2);expect(x.store.orderCount).toBe(2);expect(x.store.eventCount).toBe(2);const y=setup();y.orders.submit('left','same','sku',1);y.orders.submit('right','same','sku',1);expect(y.store.orderCount).toBe(2);expect(y.store.eventCount).toBe(2);});
test('same customer replay is idempotent and conflicts reject',()=>{const x=setup();const first=x.orders.submit('a','r','sku',1);expect(x.orders.submit('a','r','sku',1)).toEqual(first);expect(()=>x.orders.submit('a','r','other',1)).toThrow();expect(()=>x.orders.submit('a','r','sku',2)).toThrow();expect(x.store.eventCount).toBe(1);});
test('invalid submission changes no state',()=>{for(const args of [['','r','s',1],['a','','s',1],['a','r','',1],['a','r','s',0],['a','r','s',1.2],[{} as any,'r','s',1]] as [string,string,string,number][]){const x=setup();expect(()=>x.orders.submit(...args)).toThrow();expect(x.store.orderCount).toBe(0);expect(x.store.eventCount).toBe(0);}});
test('event failure preserves existing records and retry adds one pair',()=>{const x=setup();x.orders.submit('a','kept','sku',1);const before=x.store.listEvents();x.store.failNextEventCommit();expect(()=>x.orders.submit('a','new','sku',1)).toThrow();expect(x.store.orderCount).toBe(1);expect(x.store.listEvents()).toEqual(before);expect(x.orders.submit('a','new','sku',1).requestId).toBe('new');expect(x.store.orderCount).toBe(2);expect(x.store.listEvents().map(e=>e.orderRequestId)).toEqual(['kept','new']);});
test('returned records are isolated and event matches order',()=>{const x=setup();const order=x.orders.submit('a','r','sku',1);order.sku='changed';expect(x.orders.submit('a','r','sku',1).sku).toBe('sku');const event=x.store.listEvents()[0];event.state='sent';expect(x.store.getEvent(event.id)).toMatchObject({customer:'a',orderRequestId:'r',kind:'order.submitted',state:'pending'});});
test('expired leases reclaim once and then become terminal at the attempt limit',()=>{const x=setup();x.orders.submit('a','r','sku',1);const first=x.publisher.claim('one',0,5)!;expect(x.publisher.claim('two',4,5)).toBeUndefined();const second=x.publisher.claim('two',5,5)!;expect(second.token).toBeGreaterThan(first.token);expect(second.leaseOwner).toBe('two');x.orders.submit('a','ack','sku',1);const owner=x.publisher.claim('owner',0,5)!;expect(x.publisher.ack(owner.id,'owner',owner.token)).toBe(true);x.orders.submit('a','exhaust','sku',1);const exhausted=x.publisher.claim('w',0,1)!;x.publisher.claim('w',1,1);const third=x.publisher.claim('w',2,1)!;expect(third.attempts).toBe(3);expect(x.publisher.claim('w',3,1)).toBeUndefined();expect(x.store.getEvent(exhausted.id)?.state).toBe('dead');expect(x.publisher.ack(exhausted.id,'w',third.token)).toBe(false);});
test('ack and retry require current claim ownership',()=>{const x=setup();x.orders.submit('a','r','sku',1);const first=x.publisher.claim('one',0,5)!;const second=x.publisher.claim('two',5,5)!;expect(x.publisher.ack(first.id,'one',first.token)).toBe(false);expect(x.publisher.retry(second.id,'one',second.token,5)).toBe(false);expect(x.store.getEvent(second.id)?.state).toBe('leased');expect(x.publisher.ack(second.id,'two',second.token)).toBe(true);});
test('retry waits, increments attempts, and becomes dead at limit',()=>{const x=setup();x.orders.submit('a','r','sku',1);let claim=x.publisher.claim('w',0,5)!;x.publisher.retry(claim.id,'w',claim.token,0);expect(x.publisher.claim('w',9,5)).toBeUndefined();claim=x.publisher.claim('w',10,5)!;x.publisher.retry(claim.id,'w',claim.token,10);claim=x.publisher.claim('w',20,5)!;expect(x.publisher.retry(claim.id,'w',claim.token,20)).toBe(true);expect(x.store.getEvent(claim.id)?.state).toBe('dead');expect(x.publisher.claim('w',100,5)).toBeUndefined();});
test('cancel invalidates lease and terminal states stay terminal',()=>{const x=setup();x.orders.submit('a','r','sku',1);const claim=x.publisher.claim('w',0,5)!;expect(x.publisher.cancel(claim.id)).toBe(true);expect(x.publisher.ack(claim.id,'w',claim.token)).toBe(false);expect(x.publisher.retry(claim.id,'w',claim.token,0)).toBe(false);expect(x.publisher.cancel(claim.id)).toBe(false);expect(x.publisher.claim('w',100,5)).toBeUndefined();});
test('claims use due time then store-wide commit order',()=>{const x=setup(),one=new Orders(x.store),two=new Orders(x.store);one.submit('a','first','sku',1,0);one.submit('a','second','sku',1,0);two.submit('a','third','sku',1,0);const claimed:string[]=[];for(let i=0;i<3;i++){const event=x.publisher.claim('w',0,20)!;claimed.push(event.orderRequestId);x.publisher.ack(event.id,'w',event.token);}expect(claimed).toEqual(['first','second','third']);const y=setup();y.orders.submit('a','later','sku',1,20);y.orders.submit('a','earlier','sku',1,10);expect(y.publisher.claim('w',20,5)!.orderRequestId).toBe('earlier');});
""",
"oracle": {
"src/keys.ts": """export const orderKey = (customer: string, requestId: string) => JSON.stringify([customer, requestId]);
export const eventId = (customer: string, requestId: string) => `order:${JSON.stringify([customer, requestId])}`;
""",
"src/store.ts": """import type { Order, OutboxEvent } from './types';
import { orderKey } from './keys';

const copyOrder = (order: Order): Order => ({ ...order });
const copyEvent = (event: OutboxEvent): OutboxEvent => ({ ...event });

export class Store {
  private orders = new Map<string, Order>();
  private events = new Map<string, OutboxEvent>();
  private failEvent = false;
  private nextSequence = 0;
  failNextEventCommit() { this.failEvent = true; }
  get orderCount() { return this.orders.size; }
  get eventCount() { return this.events.size; }
  findOrder(customer: string, requestId: string) { const order = this.orders.get(orderKey(customer, requestId)); return order && copyOrder(order); }
  getEvent(id: string) { const event = this.events.get(id); return event && copyEvent(event); }
  listEvents() { return [...this.events.values()].sort((a, b) => a.sequence - b.sequence).map(copyEvent); }
  commit(order: Order, event: OutboxEvent) {
    if (this.failEvent) { this.failEvent = false; throw new Error('outbox unavailable'); }
    this.orders.set(orderKey(order.customer, order.requestId), copyOrder(order));
    this.events.set(event.id, copyEvent({ ...event, sequence: this.nextSequence++ }));
  }
  replaceEvent(event: OutboxEvent) { if (!this.events.has(event.id)) throw new Error('event'); this.events.set(event.id, copyEvent(event)); }
}
""",
"src/orders.ts": """import { eventId } from './keys';
import { Store } from './store';
import { isIdentifier, type Order, type OutboxEvent } from './types';

export class Orders {
  constructor(public store: Store) {}
  submit(customer: string, requestId: string, sku: string, quantity: number, now = 0): Order {
    if (!isIdentifier(customer) || !isIdentifier(requestId) || !isIdentifier(sku) || !Number.isInteger(quantity) || quantity <= 0) throw new Error('order');
    const previous = this.store.findOrder(customer, requestId);
    if (previous) {
      if (previous.sku !== sku || previous.quantity !== quantity) throw new Error('request conflict');
      return { ...previous };
    }
    const order = { customer, requestId, sku, quantity, createdAt: now };
    const event: OutboxEvent = { id: eventId(customer, requestId), customer, orderRequestId: requestId, kind: 'order.submitted', state: 'pending', attempts: 0, token: 0, dueAt: now, leaseUntil: 0, maxAttempts: 3, retryDelay: 10, sequence: 0 };
    this.store.commit(order, event);
    return { ...order };
  }
}
""",
"src/publisher.ts": """import { Store } from './store';
import { isIdentifier, type OutboxEvent } from './types';
const copy = (event: OutboxEvent) => ({ ...event });

export class Publisher {
  constructor(public store: Store) {}
  claim(worker: string, now: number, leaseMs: number): OutboxEvent | undefined {
    if (!isIdentifier(worker) || !Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error('lease');
    const candidates = this.store.listEvents().filter(candidate =>
      (candidate.state === 'pending' && candidate.dueAt <= now) ||
      (candidate.state === 'leased' && candidate.leaseUntil <= now))
      .sort((a, b) => a.dueAt - b.dueAt || a.sequence - b.sequence);
    for (const event of candidates) {
      if (event.attempts >= event.maxAttempts) { this.store.replaceEvent({ ...event, state: 'dead', leaseUntil: 0, leaseOwner: undefined }); continue; }
      const leased = { ...event, state: 'leased' as const, attempts: event.attempts + 1, token: event.token + 1, leaseOwner: worker, leaseUntil: now + leaseMs };
      this.store.replaceEvent(leased); return copy(leased);
    }
    return undefined;
  }
  ack(id: string, worker: string, token: number) {
    if (!isIdentifier(id) || !isIdentifier(worker)) return false;
    const event = this.store.getEvent(id);
    if (!event || event.state !== 'leased' || event.leaseOwner !== worker || event.token !== token) return false;
    this.store.replaceEvent({ ...event, state: 'sent', leaseUntil: 0, leaseOwner: undefined }); return true;
  }
  retry(id: string, worker: string, token: number, now: number) {
    if (!isIdentifier(id) || !isIdentifier(worker)) return false;
    const event = this.store.getEvent(id);
    if (!event || event.state !== 'leased' || event.leaseOwner !== worker || event.token !== token) return false;
    if (event.attempts >= event.maxAttempts) this.store.replaceEvent({ ...event, state: 'dead', leaseUntil: 0, leaseOwner: undefined });
    else this.store.replaceEvent({ ...event, state: 'pending', dueAt: now + event.retryDelay, leaseUntil: 0, leaseOwner: undefined });
    return true;
  }
  cancel(id: string) {
    if (!isIdentifier(id)) return false;
    const event = this.store.getEvent(id);
    if (!event || event.state === 'sent' || event.state === 'dead' || event.state === 'cancelled') return false;
    this.store.replaceEvent({ ...event, state: 'cancelled', token: event.token + 1, leaseUntil: 0, leaseOwner: undefined }); return true;
  }
}
"""},
"mutants": {
"customer-id-collision": {"src/keys.ts": [("JSON.stringify([customer, requestId])", "`${customer}:${requestId}`")]},
"partial-commit-on-event-failure": {"src/store.ts": [("if (this.failEvent) { this.failEvent = false; throw new Error('outbox unavailable'); }", "if (this.failEvent) { this.failEvent = false; this.orders.set(orderKey(order.customer, order.requestId), copyOrder(order)); throw new Error('outbox unavailable'); }")]},
"replay-conflict-accepted": {"src/orders.ts": [("if (previous.sku !== sku || previous.quantity !== quantity) throw new Error('request conflict');\n      ", "")]},
"reverse-store-order": {"src/store.ts": [("sequence: this.nextSequence++", "sequence: -this.nextSequence++")]},
"expired-lease-not-reclaimed": {"src/publisher.ts": [(" ||\n      (candidate.state === 'leased' && candidate.leaseUntil <= now)", "")]},
"final-lease-reclaimed": {"src/publisher.ts": [("if (event.attempts >= event.maxAttempts) { this.store.replaceEvent({ ...event, state: 'dead', leaseUntil: 0, leaseOwner: undefined }); continue; }", "if (false) { this.store.replaceEvent({ ...event, state: 'dead', leaseUntil: 0, leaseOwner: undefined }); continue; }")]},
"stale-ack-accepted": {"src/publisher.ts": [(" || event.state !== 'leased' || event.leaseOwner !== worker || event.token !== token", "")]},
"retry-not-terminal": {"src/publisher.ts": [("if (event.attempts >= event.maxAttempts) this.store.replaceEvent({ ...event, state: 'dead', leaseUntil: 0, leaseOwner: undefined });", "if (false) this.store.replaceEvent({ ...event, state: 'dead', leaseUntil: 0, leaseOwner: undefined });")]},
"cancel-leaves-lease-actionable": {"src/publisher.ts": [("this.store.replaceEvent({ ...event, state: 'cancelled', token: event.token + 1, leaseUntil: 0, leaseOwner: undefined }); return true;", "this.store.replaceEvent({ ...event, state: 'leased', token: event.token, leaseUntil: event.leaseUntil, leaseOwner: event.leaseOwner }); return true;")]}
}}
