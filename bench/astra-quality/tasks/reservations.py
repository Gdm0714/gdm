"""Deterministic multi-module workflow quality benchmark."""

TASK = {
    'id': 'reservation-lifecycle',
    'brief': """Repair the four-module inventory reservation workflow. Preserve all exported types, functions and Store/Reservations method signatures. Tests construct Store with nonnegative safe integer inventory and versions; all resulting inventory and version arithmetic stays within the safe integer range. hold(id,sku,count,expected,now,life) creates a pending hold, checks the SKU's current version and available stock, deducts count and increments item version exactly once. Hold.version permanently records that resulting creation version; expiresAt=now+life. Validate nonempty id/SKU, positive safe integer count/life, nonnegative safe integer expected/now, and safe expiresAt. Invalid/missing/stale/insufficient requests throw. Failed operations must leave the ENTIRE state unchanged, including inventory, holds and receipt ledger; a failed id remains reusable.
Each successful request stores a detached immutable original creation response. Reusing its id with identical (sku,count,expected,life) returns that original response, even after other inventory activity, confirmation, cancellation or expiry. Retry now is validated but excluded from payload identity and cannot change the original deadline. Changed payload fields throw. Retry lookup precedes checking the current inventory version, since expected belongs to the original request.
confirm/cancel return true for a pending transition and false for repetition of the SAME terminal target. Opposite terminal transitions and missing hold ids throw without changes; expired holds cannot be confirmed or cancelled. Confirmation keeps stock and item version unchanged. Cancellation/expiry release exactly once and each released hold increments its SKU version once, using current inventory so interleaved holds on the same SKU conserve stock. expire(now) validates a nonnegative safe integer clock, expires all pending holds with expiresAt <= now, and ignores terminal holds. Only an explicit expiry sweep enforces deadlines; confirm/cancel use no wall clock and do not implicitly expire holds. Caller time is deterministic, with no monotonicity requirement.
Store constructor input, item/hold/receipt/pending/snapshot getters, commit inputs, and hold responses must all be detached, including nested receipt request/result records. Internal layout may change without changing exported signatures or behavior. Groups: atomic allocation; idempotent original response; complete request identity; terminal transitions; inclusive exact-once expiry; inventory/version conservation; nested copy isolation; clock validation and explicit sweep.""",
    'files': {
        'src/types.ts': """export type Item = { sku: string; available: number; version: number };
export type State = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export type Hold = {
  id: string; sku: string; quantity: number; version: number;
  expiresAt: number; state: State;
};
export type Request = {
  id: string; sku: string; count: number; expected: number; life: number;
};
export type Receipt = { request: Request; result: Hold };
export type Snapshot = { items: Item[]; holds: Hold[]; receipts: Receipt[] };
""",
        'src/store.ts': """import type { Item, Hold, Receipt, Snapshot } from './types';

function copyReceipt(receipt: Receipt): Receipt {
  return { request: { ...receipt.request }, result: receipt.result };
}

export class Store {
  private items = new Map<string, Item>();
  private holds = new Map<string, Hold>();
  private receipts = new Map<string, Receipt>();

  constructor(seed: Item[]) {
    for (const item of seed) this.items.set(item.sku, { ...item });
  }

  item(sku: string): Item | undefined {
    const value = this.items.get(sku);
    return value && { ...value };
  }

  hold(id: string): Hold | undefined {
    const value = this.holds.get(id);
    return value && { ...value };
  }

  receipt(id: string): Receipt | undefined {
    const value = this.receipts.get(id);
    return value && copyReceipt(value);
  }

  pending(): Hold[] {
    return [...this.holds.values()].filter(h => h.state === 'pending').map(h => ({ ...h }));
  }

  // Synchronous in-memory transaction: callers validate before this commit point.
  commit(item: Item, hold: Hold, receipt?: Receipt): void {
    this.items.set(item.sku, { ...item });
    this.holds.set(hold.id, { ...hold });
    if (receipt) this.receipts.set(hold.id, copyReceipt(receipt));
  }

  snapshot(): Snapshot {
    return {
      items: [...this.items.values()].map(item => ({ ...item })),
      holds: [...this.holds.values()].map(hold => ({ ...hold })),
      receipts: [...this.receipts.values()].map(copyReceipt),
    };
  }
}
""",
        'src/policy.ts': """import type { Hold, Item, Request, State } from './types';

export function validateRequest(request: Request, now: number): void {
  if (!request.id || !request.sku) throw new RangeError('identity');
  for (const n of [request.count, request.life]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError('positive integer');
  }
  if (!Number.isSafeInteger(request.expected) || request.expected < 0) {
    throw new RangeError('version');
  }
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + request.life)) {
    throw new RangeError('clock');
  }
}

export function sameRequest(a: Request, b: Request): boolean {
  return a.id === b.id && a.sku === b.sku && a.count === b.count
    && a.expected === b.expected;
}

export function allocate(item: Item | undefined, request: Request, now: number): { item: Item; hold: Hold } {
  if (!item || item.version !== request.expected) throw new Error('stale or missing item');
  if (item.available < request.count) throw new Error('stock');
  const next = { ...item, available: item.available - request.count, version: item.version + 1 };
  return {
    item: next,
    hold: {
      id: request.id, sku: request.sku, quantity: request.count,
      version: next.version, expiresAt: now + request.life, state: 'pending',
    },
  };
}

export function transition(hold: Hold, state: Exclude<State, 'pending'>): boolean {
  if (hold.state === state) return false;
  if (hold.state !== 'pending') return false;
  return true;
}

export function release(item: Item, hold: Hold, state: State): Item {
  if (state === 'confirmed') return { ...item };
  return { ...item, available: item.available + hold.quantity, version: item.version + 1 };
}
""",
        'src/service.ts': """import { Store } from './store';
import type { Hold, Request, State } from './types';
import { allocate, release, sameRequest, transition, validateRequest } from './policy';

export class Reservations {
  constructor(public store: Store) {}

  hold(id: string, sku: string, count: number, expected: number, now: number, life: number): Hold {
    const request: Request = { id, sku, count, expected, life };
    validateRequest(request, now);
    if (this.store.item(sku)?.version !== expected) throw new Error('stale');
    const previous = this.store.receipt(id);
    if (previous) {
      if (!sameRequest(previous.request, request)) throw new Error('request id conflict');
      // The creation response is immutable even if its live hold is now terminal.
      return this.store.hold(id)!;
    }
    const current = this.store.item(sku);
    if (current && current.available < count) {
      const failed = { id, sku, quantity: count, version: current.version + 1, expiresAt: now + life, state: 'pending' as const };
      this.store.commit({ ...current, available: current.available - count }, failed);
      throw new Error('stock');
    }
    const result = allocate(current, request, now);
    this.store.commit(result.item, result.hold, { request, result: result.hold });
    return { ...result.hold };
  }

  confirm(id: string): boolean {
    return this.apply(id, 'confirmed');
  }

  cancel(id: string): boolean {
    return this.apply(id, 'cancelled');
  }

  expire(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('clock');
    for (const hold of this.store.pending()) {
      if (hold.expiresAt < now) this.apply(hold.id, 'expired');
    }
  }

  private apply(id: string, state: Exclude<State, 'pending'>): boolean {
    const hold = this.store.hold(id);
    if (!hold) throw new Error('missing hold');
    if (!transition(hold, state)) return false;
    const item = this.store.item(hold.sku)!;
    const nextItem = release(item, hold, state);
    const nextHold = { ...hold, state };
    this.store.commit(nextItem, nextHold);
    return true;
  }
}
""",
    },
    'visible': """import { expect, test } from 'bun:test';
import { Store } from '../src/store';
import { Reservations } from '../src/service';
test('hold and cancel restore stock', () => {
  const s = new Store([{ sku: 'x', available: 5, version: 1 }]);
  const r = new Reservations(s), h = r.hold('a', 'x', 2, 1, 10, 20);
  expect(h.state).toBe('pending'); expect(s.item('x')?.available).toBe(3);
  expect(r.cancel('a')).toBe(true); expect(s.item('x')?.available).toBe(5);
});
test('confirmation consumes reserved stock', () => {
  const s = new Store([{ sku: 'x', available: 5, version: 1 }]);
  const r = new Reservations(s); r.hold('a', 'x', 1, 1, 0, 10);
  expect(r.confirm('a')).toBe(true); expect(r.confirm('a')).toBe(false);
  expect(s.item('x')?.available).toBe(4);
});
""",
    'hidden': """import { expect, test } from 'bun:test';
import { Store } from './src/store';
import { Reservations } from './src/service';
function make() {
  const s = new Store([{ sku: 'x', available: 8, version: 1 }, { sku: 'y', available: 4, version: 10 }]);
  return { s, r: new Reservations(s) };
}
function unchanged(s: Store, action: () => unknown) {
  const before = s.snapshot(); expect(action).toThrow(); expect(s.snapshot()).toEqual(before);
}
test('atomic-allocation: stale missing insufficient and invalid requests preserve all state', () => {
  const { s, r } = make();
  unchanged(s, () => r.hold('stale', 'x', 1, 0, 0, 10));
  unchanged(s, () => r.hold('missing', 'z', 1, 1, 0, 10));
  unchanged(s, () => r.hold('large', 'x', 9, 1, 0, 10));
  for (const n of [0, -1, 1.5, NaN, Infinity]) unchanged(s, () => r.hold('bad', 'x', n, 1, 0, 10));
  unchanged(s, () => r.hold('bad', 'x', 1, 1, 0, 0));
  expect(r.hold('large', 'x', 2, 1, 0, 10).quantity).toBe(2);
});
test('idempotent-retry: receipt survives unrelated activity and terminal transition', () => {
  const { s, r } = make(), original = r.hold('a', 'x', 2, 1, 10, 20);
  r.hold('b', 'x', 1, 2, 11, 20); r.cancel('a');
  const before = s.snapshot();
  expect(r.hold('a', 'x', 2, 1, 999, 20)).toEqual(original);
  expect(s.hold('a')?.state).toBe('cancelled'); expect(s.snapshot()).toEqual(before);
  for (const target of ['confirm', 'expire'] as const) {
    const other = make(), created = other.r.hold('a', 'x', 2, 1, 0, 10);
    if (target === 'confirm') other.r.confirm('a'); else other.r.expire(10);
    const terminal = other.s.snapshot();
    expect(other.r.hold('a', 'x', 2, 1, 100, 10)).toEqual(created);
    expect(other.s.snapshot()).toEqual(terminal);
  }
});
test('request-conflicts: every payload field except retry clock participates', () => {
  const { s, r } = make(); r.hold('a', 'x', 2, 1, 0, 10);
  for (const args of [['y', 2, 1, 10], ['x', 3, 1, 10], ['x', 2, 2, 10], ['x', 2, 1, 11]] as const) {
    unchanged(s, () => r.hold('a', args[0], args[1], args[2], 5, args[3]));
  }
});
test('terminal-transitions: same target is no-op and conflicting targets are atomic errors', () => {
  const { s, r } = make(); r.hold('a', 'x', 2, 1, 0, 10); r.confirm('a');
  const before = s.snapshot(); expect(r.confirm('a')).toBe(false); expect(s.snapshot()).toEqual(before);
  unchanged(s, () => r.cancel('a')); unchanged(s, () => r.confirm('missing'));
  r.hold('b', 'x', 1, 2, 0, 10); r.cancel('b');
  expect(r.cancel('b')).toBe(false); unchanged(s, () => r.confirm('b'));
});
test('expiry-boundary: inclusive deadline with exact once release and terminal conflicts', () => {
  const { s, r } = make(); r.hold('a', 'x', 2, 1, 10, 5);
  r.expire(14); expect(s.hold('a')?.state).toBe('pending');
  r.expire(15); expect(s.hold('a')?.state).toBe('expired');
  expect(s.item('x')).toEqual({ sku: 'x', available: 8, version: 3 });
  const before = s.snapshot(); r.expire(100); expect(s.snapshot()).toEqual(before);
  unchanged(s, () => r.confirm('a')); unchanged(s, () => r.cancel('a'));
});
test('inventory-versions: interleaved shared SKU releases conserve stock and invalidate stale writes', () => {
  const { s, r } = make();
  r.hold('a', 'x', 2, 1, 0, 10); r.hold('b', 'x', 3, 2, 0, 5);
  r.hold('c', 'x', 1, 3, 0, 5); r.hold('d', 'y', 2, 10, 0, 5);
  r.confirm('a'); r.cancel('b'); r.expire(5);
  expect(s.item('x')).toEqual({ sku: 'x', available: 6, version: 6 });
  expect(s.item('y')).toEqual({ sku: 'y', available: 4, version: 12 });
  unchanged(s, () => r.hold('e', 'x', 1, 5, 20, 10));
  expect(s.hold('a')?.version).toBe(2);
});
test('copy-isolation: nested receipts live holds and snapshots remain detached', () => {
  const seed = [{ sku: 'x', available: 8, version: 1 }], s = new Store(seed), r = new Reservations(s);
  seed[0].available = 0; const original = r.hold('a', 'x', 2, 1, 0, 10);
  original.quantity = 99; s.hold('a')!.quantity = 98; s.item('x')!.available = 97;
  s.pending()[0].quantity = 93;
  s.receipt('a')!.result.quantity = 96; s.receipt('a')!.request.count = 95;
  const snap = s.snapshot(); snap.receipts[0].result.quantity = 94; snap.holds[0].state = 'expired';
  expect(s.hold('a')?.quantity).toBe(2); expect(s.item('x')?.available).toBe(6);
  expect(s.receipt('a')!.result.quantity).toBe(2); expect(s.receipt('a')!.request.count).toBe(2);
  const item = s.item('x')!, hold = s.hold('a')!, receipt = s.receipt('a')!;
  s.commit(item, hold, receipt);
  item.available = 81; hold.quantity = 82;
  receipt.request.count = 83; receipt.result.quantity = 84;
  expect(s.item('x')!.available).toBe(6); expect(s.hold('a')!.quantity).toBe(2);
  expect(s.receipt('a')!.request.count).toBe(2); expect(s.receipt('a')!.result.quantity).toBe(2);
});
test('clock-contract: deterministic caller time validation and explicit expiry sweep', () => {
  const { s, r } = make();
  for (const now of [-1, 0.5, NaN, Infinity]) {
    unchanged(s, () => r.hold('a', 'x', 1, 1, now, 10));
    unchanged(s, () => r.expire(now));
  }
  unchanged(s, () => r.hold('a', 'x', 1, 1, Number.MAX_SAFE_INTEGER, 10));
  r.hold('a', 'x', 1, 1, 0, 1); r.hold('b', 'y', 1, 10, 100, 1);
  expect(r.confirm('a')).toBe(true); // Time advances only through explicit expire calls.
  r.expire(1000); expect(s.hold('a')?.state).toBe('confirmed');
});
""",
    'oracle': {
        'src/types.ts': """export type Item = { sku: string; available: number; version: number };
export type State = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export type Hold = {
  id: string; sku: string; quantity: number; version: number;
  expiresAt: number; state: State;
};
export type Request = {
  id: string; sku: string; count: number; expected: number; life: number;
};
export type Receipt = { request: Request; result: Hold };
export type Snapshot = { items: Item[]; holds: Hold[]; receipts: Receipt[] };
""",
        'src/store.ts': """import type { Item, Hold, Receipt, Snapshot } from './types';

function copyReceipt(receipt: Receipt): Receipt {
  return { request: { ...receipt.request }, result: { ...receipt.result } };
}

export class Store {
  private items = new Map<string, Item>();
  private holds = new Map<string, Hold>();
  private receipts = new Map<string, Receipt>();

  constructor(seed: Item[]) {
    for (const item of seed) this.items.set(item.sku, { ...item });
  }

  item(sku: string): Item | undefined {
    const value = this.items.get(sku);
    return value && { ...value };
  }

  hold(id: string): Hold | undefined {
    const value = this.holds.get(id);
    return value && { ...value };
  }

  receipt(id: string): Receipt | undefined {
    const value = this.receipts.get(id);
    return value && copyReceipt(value);
  }

  pending(): Hold[] {
    return [...this.holds.values()].filter(h => h.state === 'pending').map(h => ({ ...h }));
  }

  // Synchronous in-memory transaction: callers validate before this commit point.
  commit(item: Item, hold: Hold, receipt?: Receipt): void {
    this.items.set(item.sku, { ...item });
    this.holds.set(hold.id, { ...hold });
    if (receipt) this.receipts.set(hold.id, copyReceipt(receipt));
  }

  snapshot(): Snapshot {
    return {
      items: [...this.items.values()].map(item => ({ ...item })),
      holds: [...this.holds.values()].map(hold => ({ ...hold })),
      receipts: [...this.receipts.values()].map(copyReceipt),
    };
  }
}
""",
        'src/policy.ts': """import type { Hold, Item, Request, State } from './types';

export function validateRequest(request: Request, now: number): void {
  if (!request.id || !request.sku) throw new RangeError('identity');
  for (const n of [request.count, request.life]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError('positive integer');
  }
  if (!Number.isSafeInteger(request.expected) || request.expected < 0) {
    throw new RangeError('version');
  }
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + request.life)) {
    throw new RangeError('clock');
  }
}

export function sameRequest(a: Request, b: Request): boolean {
  return a.id === b.id && a.sku === b.sku && a.count === b.count
    && a.expected === b.expected && a.life === b.life;
}

export function allocate(item: Item | undefined, request: Request, now: number): { item: Item; hold: Hold } {
  if (!item || item.version !== request.expected) throw new Error('stale or missing item');
  if (item.available < request.count) throw new Error('stock');
  const next = { ...item, available: item.available - request.count, version: item.version + 1 };
  return {
    item: next,
    hold: {
      id: request.id, sku: request.sku, quantity: request.count,
      version: next.version, expiresAt: now + request.life, state: 'pending',
    },
  };
}

export function transition(hold: Hold, state: Exclude<State, 'pending'>): boolean {
  if (hold.state === state) return false;
  if (hold.state !== 'pending') throw new Error('terminal conflict');
  return true;
}

export function release(item: Item, hold: Hold, state: State): Item {
  if (state === 'confirmed') return { ...item };
  return { ...item, available: item.available + hold.quantity, version: item.version + 1 };
}
""",
        'src/service.ts': """import { Store } from './store';
import type { Hold, Request, State } from './types';
import { allocate, release, sameRequest, transition, validateRequest } from './policy';

export class Reservations {
  constructor(public store: Store) {}

  hold(id: string, sku: string, count: number, expected: number, now: number, life: number): Hold {
    const request: Request = { id, sku, count, expected, life };
    validateRequest(request, now);
    const previous = this.store.receipt(id);
    if (previous) {
      if (!sameRequest(previous.request, request)) throw new Error('request id conflict');
      // The creation response is immutable even if its live hold is now terminal.
      return { ...previous.result };
    }
    const result = allocate(this.store.item(sku), request, now);
    this.store.commit(result.item, result.hold, { request, result: result.hold });
    return { ...result.hold };
  }

  confirm(id: string): boolean {
    return this.apply(id, 'confirmed');
  }

  cancel(id: string): boolean {
    return this.apply(id, 'cancelled');
  }

  expire(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('clock');
    for (const hold of this.store.pending()) {
      if (hold.expiresAt <= now) this.apply(hold.id, 'expired');
    }
  }

  private apply(id: string, state: Exclude<State, 'pending'>): boolean {
    const hold = this.store.hold(id);
    if (!hold) throw new Error('missing hold');
    if (!transition(hold, state)) return false;
    const item = this.store.item(hold.sku)!;
    const nextItem = release(item, hold, state);
    const nextHold = { ...hold, state };
    this.store.commit(nextItem, nextHold);
    return true;
  }
}
""",
    },
    'mutants': {
        'aliased-commit-inputs': {
            'src/store.ts': [('this.items.set(item.sku, { ...item });\n    this.holds.set(hold.id, { ...hold });\n    if (receipt) this.receipts.set(hold.id, copyReceipt(receipt));', 'this.items.set(item.sku, item);\n    this.holds.set(hold.id, hold);\n    if (receipt) this.receipts.set(hold.id, receipt);')],
        },
        'current-version-before-retry': {
            'src/service.ts': [('    const previous = this.store.receipt(id);', "    if (this.store.item(sku)?.version !== expected) throw new Error('stale');\n    const previous = this.store.receipt(id);")],
        },
        'live-retry-response': {
            'src/service.ts': [('return { ...previous.result };', 'return this.store.hold(id)!;')],
        },
        'ignored-ttl-identity': {
            'src/policy.ts': [(' && a.life === b.life', '')],
        },
        'quiet-terminal-conflict': {
            'src/policy.ts': [("if (hold.state !== 'pending') throw new Error('terminal conflict');", "if (hold.state !== 'pending') return false;")],
        },
        'exclusive-expiry': {
            'src/service.ts': [('hold.expiresAt <= now', 'hold.expiresAt < now')],
        },
        'no-release-version': {
            'src/policy.ts': [('available: item.available + hold.quantity, version: item.version + 1', 'available: item.available + hold.quantity, version: item.version')],
        },
        'aliased-receipt': {
            'src/store.ts': [('result: { ...receipt.result }', 'result: receipt.result')],
        },
        'oversell': {
            'src/policy.ts': [("  if (item.available < request.count) throw new Error('stock');\n", '')],
        },
    },
}
