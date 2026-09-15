"""Deterministic multi-module workflow quality benchmark."""

TASK = {
    'id': 'snapshot-pagination-lifecycle',
    'brief': """Repair the four-module activity feed implementation while preserving all public exports and method signatures. ActivityStore allocates globally increasing positive sequence ids. append requires a nonempty feed and finite timestamp; failed appends do not consume a sequence. Feed.page(limit, cursor?) orders ascending by (at, seq), even for backdated insertion and timestamp ties. limit must be a positive safe integer and may change during traversal. A first page fixes append membership at that feed's current high-water sequence; subsequent pages exclude all later appends regardless of timestamp. Tombstones are evaluated at each page request: currently deleted rows are skipped, including rows deleted after the traversal began. The cursor carries the last returned (at, seq) key, so deleting that boundary never restarts or shifts traversal. A fresh traversal sees later appends and current tombstones. Return next only when an eligible row remains beyond the returned page; empty and exact-size terminal pages have no next. Replaying a cursor is allowed and reflects current tombstones with unchanged append membership.
Cursors are opaque to callers; encoding layout is not prescribed. Preserve exported Cursor fields, encode, and decode, which must round-trip valid fields and reject invalid semantics (either encoder or decoder may reject). Require nonempty feed, order='at-seq-v1', finite boundary timestamp, positive safe integer snapshot and boundary sequence, and boundary sequence <= snapshot. Feed.page rejects cross-feed cursors and snapshots above the current feed high-water mark. Malformed cursor input and invalid limits throw RangeError. No cryptographic integrity or resistance to semantically valid forged cursors is required. append, snapshot, eligible and page return detached records. Groups: snapshot membership; chronological boundaries/ties; tombstone boundaries; cursor scope; cursor/limit contract; termination; copy isolation; cursor replay and changing limits.""",
    'files': {
        'src/types.ts': """export type Activity = {
  seq: number;
  feed: string;
  at: number;
  message: string;
  deleted: boolean;
};
export type Boundary = { at: number; seq: number };
export type Cursor = {
  feed: string;
  after: Boundary;
  snapshot: number;
  order: 'at-seq-v1';
};
export type Page = { items: Activity[]; next?: string };

export function compare(a: Boundary, b: Boundary): number {
  return a.at - b.at || a.seq - b.seq;
}
""",
        'src/store.ts': """import type { Activity } from './types';

export class ActivityStore {
  private nextSeq = 1;
  private rows: Activity[] = [];

  append(feed: string, at: number, message: string): Activity {
    if (!feed || !Number.isFinite(at)) throw new RangeError('activity');
    const row: Activity = {
      seq: this.nextSeq++, feed, at, message, deleted: false,
    };
    this.rows.push(row);
    return { ...row };
  }

  remove(seq: number): void {
    const row = this.rows.find(row => row.seq === seq);
    if (row) row.deleted = true;
  }

  highWater(feed: string): number {
    return this.rows.reduce((max, row) =>
      row.feed === feed ? Math.max(max, row.seq) : max, 0);
  }

  snapshot(feed: string): Activity[] {
    return this.rows.filter(row => row.feed === feed);
  }

  // A deletion is a current-time tombstone, even during an older traversal.
  eligible(feed: string, highWater: number): Activity[] {
    return this.snapshot(feed).filter(row => !row.deleted);
  }
}
""",
        'src/cursor.ts': """import type { Cursor } from './types';

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validate(value: unknown): Cursor {
  if (!value || typeof value !== 'object') throw new RangeError('cursor');
  const c = value as Cursor;
  if (typeof c.feed !== 'string' || c.feed.length === 0) {
    throw new RangeError('cursor');
  }
  if (!positive(c.snapshot) || !c.after || typeof c.after !== 'object') {
    throw new RangeError('cursor');
  }
  if (!Number.isFinite(c.after.at) || !positive(c.after.seq)) {
    throw new RangeError('cursor');
  }
  return {
    feed: c.feed, snapshot: c.snapshot, order: c.order,
    after: { at: c.after.at, seq: c.after.seq },
  };
}

export function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(validate(cursor))).toString('base64url');
}

export function decode(raw: string): Cursor {
  try {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) {
      throw new RangeError('cursor');
    }
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw new RangeError('cursor');
    return validate(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new RangeError('cursor');
  }
}
""",
        'src/feed.ts': """import { decode, encode } from './cursor';
import { ActivityStore } from './store';
import { compare, type Boundary, type Page } from './types';

export class Feed {
  constructor(public store: ActivityStore, public name: string) {}

  page(limit: number, cursor?: string): Page {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit');
    let highWater = this.store.highWater(this.name);
    let after: Boundary | undefined;
    if (cursor !== undefined) {
      const decoded = decode(cursor);
      if (decoded.snapshot > highWater) throw new RangeError('snapshot');
      highWater = decoded.snapshot;
      after = decoded.after;
    }
    // The key is stored in the cursor: the boundary row need not still be visible.
    const remaining = this.store.eligible(this.name, highWater)
      .sort(compare)
      .filter(row => !after || row.seq > after.seq);
    const items = remaining.slice(0, limit).map(row => ({ ...row }));
    if (remaining.length < limit) return { items };
    const last = items[items.length - 1];
    return {
      items,
      next: encode({
        feed: this.name, snapshot: highWater, order: 'at-seq-v1',
        after: { at: last.at, seq: last.seq },
      }),
    };
  }
}
""",
    },
    'visible': """import { expect, test } from 'bun:test';
import { ActivityStore } from '../src/store';
import { Feed } from '../src/feed';
test('basic ordered first page and continuation', () => {
  const s = new ActivityStore();
  s.append('f', 1, 'a'); s.append('f', 2, 'b'); s.append('f', 3, 'c');
  const f = new Feed(s, 'f'), first = f.page(1);
  expect(first.items.map(x => x.message)).toEqual(['a']);
  expect(f.page(1, first.next).items.map(x => x.message)).toEqual(['b']);
});
test('tombstones and invalid limits', () => {
  const s = new ActivityStore(), a = s.append('f', 1, 'a');
  s.remove(a.seq); expect(new Feed(s, 'f').page(2).items).toEqual([]);
  expect(() => new Feed(s, 'f').page(0)).toThrow();
});
""",
    'hidden': """import { expect, test } from 'bun:test';
import { ActivityStore } from './src/store';
import { Feed } from './src/feed';
import { decode, encode } from './src/cursor';
const messages = (p: ReturnType<Feed['page']>) => p.items.map(x => x.message);
function make(times = [10, 20, 30, 40]) {
  const s = new ActivityStore();
  const rows = times.map((at, i) => s.append('f', at, String(i)));
  return { s, rows, f: new Feed(s, 'f') };
}
test('snapshot-membership: excludes both forward and backdated appends', () => {
  const { s, f } = make(), first = f.page(1);
  s.append('f', 15, 'backdated'); s.append('f', 50, 'future');
  expect(messages(f.page(10, first.next))).toEqual(['1', '2', '3']);
  expect(messages(f.page(10))).toEqual(['0', 'backdated', '1', '2', '3', 'future']);
});
test('order-boundary: chronological keys survive nonmonotonic insertion and ties', () => {
  const { f } = make([30, 10, 20, 20, 40]);
  const a = f.page(1), b = f.page(2, a.next), c = f.page(5, b.next);
  expect([...messages(a), ...messages(b), ...messages(c)]).toEqual(['1', '2', '3', '0', '4']);
  expect(c.next).toBeUndefined();
});
test('tombstone-boundary: deletion of boundary and unseen rows skips without restart', () => {
  const { s, f, rows } = make([30, 10, 20, 40]);
  const first = f.page(1); s.remove(rows[1].seq); s.remove(rows[2].seq);
  expect(messages(f.page(8, first.next))).toEqual(['0', '3']);
  expect(messages(f.page(8))).toEqual(['0', '3']);
});
test('cursor-scope: feed binding and impossible future snapshots', () => {
  const { s, f } = make(); s.append('g', 1, 'g1'); s.append('g', 2, 'g2');
  const next = f.page(1).next!;
  expect(() => new Feed(s, 'g').page(2, next)).toThrow(RangeError);
  const c = decode(next); c.snapshot += 100;
  expect(() => f.page(1, encode(c))).toThrow(RangeError);
});
test('cursor-contract: malformed input and semantic validation independent of wire format', () => {
  const { f } = make();
  for (const raw of ['', '?', 'null', '\\n']) expect(() => f.page(1, raw)).toThrow(RangeError);
  const c = decode(f.page(1).next!);
  expect(decode(encode(c))).toEqual(c);
  for (const patch of [{ order: 'obsolete' }, { snapshot: 0 }, { feed: '' },
    { after: { at: NaN, seq: 1 } }, { after: { at: 10, seq: c.snapshot + 1 } },
    { after: { at: 10, seq: 1.5 } }]) {
    expect(() => { f.page(1, encode({ ...c, ...patch } as any)); }).toThrow(RangeError);
  }
  for (const n of [0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => f.page(n)).toThrow(RangeError);
  }
});
test('termination: exact-size final page and all remaining rows deleted', () => {
  const { s, rows, f } = make();
  const first = f.page(2); expect(f.page(2, first.next).next).toBeUndefined();
  s.remove(rows[2].seq); s.remove(rows[3].seq);
  const end = f.page(1, first.next); expect(end.items).toEqual([]); expect(end.next).toBeUndefined();
  expect(new Feed(new ActivityStore(), 'empty').page(1).next).toBeUndefined();
});
test('copy-isolation: store snapshots append results and pages cannot mutate storage', () => {
  const { s, f } = make();
  expect(() => s.append('f', NaN, 'bad')).toThrow(RangeError);
  expect(() => s.append('', 60, 'bad')).toThrow(RangeError);
  const a = s.append('f', 50, 'last'); expect(a.seq).toBe(5); a.message = 'bad';
  s.snapshot('f')[0].message = 'bad'; s.eligible('f', s.highWater('f'))[1].deleted = true;
  const page = f.page(9); page.items[2].at = -100;
  expect(messages(f.page(9))).toEqual(['0', '1', '2', '3', 'last']);
});
test('replay-and-limit: reusable cursor keeps boundary while limits change', () => {
  const { s, f, rows } = make([5, 5, 5, 5]); const c = f.page(1).next!;
  expect(messages(f.page(1, c))).toEqual(['1']);
  expect(messages(f.page(3, c))).toEqual(['1', '2', '3']);
  s.remove(rows[1].seq); s.append('f', 5, 'new');
  expect(messages(f.page(9, c))).toEqual(['2', '3']);
});
""",
    'oracle': {
        'src/types.ts': """export type Activity = {
  seq: number;
  feed: string;
  at: number;
  message: string;
  deleted: boolean;
};
export type Boundary = { at: number; seq: number };
export type Cursor = {
  feed: string;
  after: Boundary;
  snapshot: number;
  order: 'at-seq-v1';
};
export type Page = { items: Activity[]; next?: string };

export function compare(a: Boundary, b: Boundary): number {
  return a.at - b.at || a.seq - b.seq;
}
""",
        'src/store.ts': """import type { Activity } from './types';

export class ActivityStore {
  private nextSeq = 1;
  private rows: Activity[] = [];

  append(feed: string, at: number, message: string): Activity {
    if (!feed || !Number.isFinite(at)) throw new RangeError('activity');
    const row: Activity = {
      seq: this.nextSeq++, feed, at, message, deleted: false,
    };
    this.rows.push(row);
    return { ...row };
  }

  remove(seq: number): void {
    const row = this.rows.find(row => row.seq === seq);
    if (row) row.deleted = true;
  }

  highWater(feed: string): number {
    return this.rows.reduce((max, row) =>
      row.feed === feed ? Math.max(max, row.seq) : max, 0);
  }

  snapshot(feed: string): Activity[] {
    return this.rows.filter(row => row.feed === feed).map(row => ({ ...row }));
  }

  // A deletion is a current-time tombstone, even during an older traversal.
  eligible(feed: string, highWater: number): Activity[] {
    return this.snapshot(feed).filter(row => !row.deleted && row.seq <= highWater);
  }
}
""",
        'src/cursor.ts': """import type { Cursor } from './types';

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validate(value: unknown): Cursor {
  if (!value || typeof value !== 'object') throw new RangeError('cursor');
  const c = value as Cursor;
  if (typeof c.feed !== 'string' || c.feed.length === 0 || c.order !== 'at-seq-v1') {
    throw new RangeError('cursor');
  }
  if (!positive(c.snapshot) || !c.after || typeof c.after !== 'object') {
    throw new RangeError('cursor');
  }
  if (!Number.isFinite(c.after.at) || !positive(c.after.seq) || c.after.seq > c.snapshot) {
    throw new RangeError('cursor');
  }
  return {
    feed: c.feed, snapshot: c.snapshot, order: c.order,
    after: { at: c.after.at, seq: c.after.seq },
  };
}

export function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(validate(cursor))).toString('base64url');
}

export function decode(raw: string): Cursor {
  try {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) {
      throw new RangeError('cursor');
    }
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw new RangeError('cursor');
    return validate(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new RangeError('cursor');
  }
}
""",
        'src/feed.ts': """import { decode, encode } from './cursor';
import { ActivityStore } from './store';
import { compare, type Boundary, type Page } from './types';

export class Feed {
  constructor(public store: ActivityStore, public name: string) {}

  page(limit: number, cursor?: string): Page {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit');
    let highWater = this.store.highWater(this.name);
    let after: Boundary | undefined;
    if (cursor !== undefined) {
      const decoded = decode(cursor);
      if (decoded.feed !== this.name) throw new RangeError('feed');
      if (decoded.snapshot > highWater) throw new RangeError('snapshot');
      highWater = decoded.snapshot;
      after = decoded.after;
    }
    // The key is stored in the cursor: the boundary row need not still be visible.
    const remaining = this.store.eligible(this.name, highWater)
      .sort(compare)
      .filter(row => !after || compare(row, after) > 0);
    const items = remaining.slice(0, limit).map(row => ({ ...row }));
    if (remaining.length <= limit) return { items };
    const last = items[items.length - 1];
    return {
      items,
      next: encode({
        feed: this.name, snapshot: highWater, order: 'at-seq-v1',
        after: { at: last.at, seq: last.seq },
      }),
    };
  }
}
""",
    },
    'mutants': {
        'dynamic-membership': {
            'src/store.ts': [(' && row.seq <= highWater', '')],
        },
        'sequence-boundary': {
            'src/feed.ts': [('compare(row, after) > 0', 'row.seq > after.seq')],
        },
        'cross-feed': {
            'src/feed.ts': [("      if (decoded.feed !== this.name) throw new RangeError('feed');\n", '')],
        },
        'exact-page-cursor': {
            'src/feed.ts': [('remaining.length <= limit', 'remaining.length < limit')],
        },
        'live-snapshots': {
            'src/store.ts': [('.map(row => ({ ...row }))', '')],
        },
        'old-order-accepted': {
            'src/cursor.ts': [(" || c.order !== 'at-seq-v1'", '')],
        },
        'deleted-visible': {
            'src/store.ts': [('!row.deleted && ', '')],
        },
    },
}
