"""Tenant authorization cache-repair fixture."""

TASK = {
"id": "tenant-authorization-epochs",
"brief": """Repair the in-memory authorization boundary while preserving its exported classes and synchronous API. Every identifier is a nonempty primitive string; punctuation, separators, and prototype-looking strings such as `__proto__` are valid data, while other values are rejected by mutating APIs. Sessions belong to a tenant and expire according to the supplied deterministic `ManualClock`; expiry is exclusive, so a session at its exact `expiresAt` is unauthorized. Starting an existing session id replaces its identity and must not inherit a cached decision from the earlier subject. A resource belongs to exactly one tenant. A subject is authorized only through a current membership in a group granted that action on that resource, and an explicit subject deny for the same action takes precedence over every grant. Membership and resource-policy changes, including grants, revocations, and denies, must take effect immediately for cached decisions. Decisions must stay scoped to the current session identity, resource, and action, and tenant data must not cross boundaries. Methods that return sessions, memberships, resources, or policies must return copies so callers cannot mutate stored state. Hidden tests cover exact session expiry and replacement, separator-safe and prototype-looking identifiers, tenant membership isolation, resource tenancy, allow and deny precedence, action-scoped caching, membership invalidation, policy revocation invalidation, and return isolation.""",
"files": {
"src/types.ts": """export type Action = 'read' | 'write' | 'delete';

export type Session = {
  id: string;
  tenant: string;
  subject: string;
  expiresAt: number;
  version: number;
};

export type ResourcePolicy = {
  id: string;
  tenant: string;
  groups: Record<string, Action[]>;
  denied: Record<string, Action[]>;
};

export type CachedDecision = {
  allowed: boolean;
  membershipEpoch: number;
  policyEpoch: number;
};

export const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
""",
"src/clock.ts": """export class ManualClock {
  constructor(private nowValue = 0) {}

  now() { return this.nowValue; }

  advance(milliseconds: number) {
    if (!Number.isInteger(milliseconds) || milliseconds < 0) throw new RangeError('time');
    this.nowValue += milliseconds;
  }
}
""",
"src/sessions.ts": """import { isIdentifier, type Session } from './types';
import { ManualClock } from './clock';

export class Sessions {
  private rows = new Map<string, Session>();
  private versions = new Map<string, number>();
  constructor(private clock: ManualClock) {}

  start(id: string, tenant: string, subject: string, lifetime: number): Session {
    if (!isIdentifier(id) || !isIdentifier(tenant) || !isIdentifier(subject) || !Number.isInteger(lifetime) || lifetime <= 0) throw new Error('session');
    const version = (this.versions.get(id) ?? 0) + 1;
    const session = { id, tenant, subject, expiresAt: this.clock.now() + lifetime, version };
    this.rows.set(id, session);
    this.versions.set(id, version);
    return { ...session };
  }

  get(id: string): Session | undefined {
    const session = this.rows.get(id);
    return session && { ...session };
  }
}
""",
"src/groups.ts": """export class Groups {
  private rows = new Map<string, Set<string>>();
  private version = 0;

  get epoch() { return this.version; }

  add(tenant: string, group: string, subject: string) {
    const key = group;
    const members = this.rows.get(key) ?? new Set<string>();
    members.add(subject);
    this.rows.set(key, members);
    this.version++;
  }

  remove(tenant: string, group: string, subject: string) {
    this.rows.get(group)?.delete(subject);
    this.version++;
  }

  has(tenant: string, group: string, subject: string) {
    return this.rows.get(group)?.has(subject) ?? false;
  }

  members(tenant: string, group: string) {
    return [...(this.rows.get(group) ?? [])];
  }
}
""",
"src/policies.ts": """import type { Action, ResourcePolicy } from './types';

const clone = (policy: ResourcePolicy): ResourcePolicy => ({
  ...policy,
  groups: Object.fromEntries(Object.entries(policy.groups).map(([group, actions]) => [group, [...actions]])),
  denied: Object.fromEntries(Object.entries(policy.denied).map(([subject, actions]) => [subject, [...actions]])),
});

export class Policies {
  private rows = new Map<string, ResourcePolicy>();
  private version = 0;
  get epoch() { return this.version; }

  create(id: string, tenant: string) {
    if (!id || !tenant || this.rows.has(id)) throw new Error('resource');
    this.rows.set(id, { id, tenant, groups: {}, denied: {} });
    this.version++;
  }

  get(id: string) { const policy = this.rows.get(id); return policy && clone(policy); }

  grant(id: string, group: string, action: Action) {
    const policy = this.mustGet(id);
    const actions = policy.groups[group] ?? [];
    if (!actions.includes(action)) actions.push(action);
    policy.groups[group] = actions;
    this.version++;
  }

  revoke(id: string, group: string, action: Action) {
    const policy = this.mustGet(id);
    policy.groups[group] = (policy.groups[group] ?? []).filter(value => value !== action);
    this.version++;
  }

  deny(id: string, subject: string, action: Action) {
    const policy = this.mustGet(id);
    const actions = policy.denied[subject] ?? [];
    if (!actions.includes(action)) actions.push(action);
    policy.denied[subject] = actions;
    this.version++;
  }

  private mustGet(id: string) { const policy = this.rows.get(id); if (!policy) throw new Error('resource'); return policy; }
}
""",
"src/authorization.ts": """import { ManualClock } from './clock';
import { Groups } from './groups';
import { Policies } from './policies';
import { Sessions } from './sessions';
import type { Action, CachedDecision } from './types';

export class Authorization {
  private cache = new Map<string, CachedDecision>();
  constructor(public clock: ManualClock, public sessions: Sessions, public groups: Groups, public policies: Policies) {}

  can(sessionId: string, resourceId: string, action: Action): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= this.clock.now()) return false;
    const resource = this.policies.get(resourceId);
    if (!resource || resource.tenant !== session.tenant) return false;
    const key = JSON.stringify([sessionId, resourceId]);
    const cached = this.cache.get(key);
    if (cached) return cached.allowed;
    const denied = resource.denied[session.subject]?.includes(action) ?? false;
    const allowed = !denied && Object.entries(resource.groups).some(([group, actions]) =>
      actions.includes(action) && this.groups.has(session.tenant, group, session.subject));
    this.cache.set(key, { allowed, membershipEpoch: this.groups.epoch, policyEpoch: this.policies.epoch });
    return allowed;
  }
}
"""},
"visible": """import {expect,test} from 'bun:test';import {ManualClock} from '../src/clock';import {Sessions} from '../src/sessions';import {Groups} from '../src/groups';import {Policies} from '../src/policies';import {Authorization} from '../src/authorization';
test('a current group grant authorizes',()=>{const clock=new ManualClock(),sessions=new Sessions(clock),groups=new Groups(),policies=new Policies(),auth=new Authorization(clock,sessions,groups,policies);sessions.start('s','t','maya',10);groups.add('t','editors','maya');policies.create('doc','t');policies.grant('doc','editors','read');expect(auth.can('s','doc','read')).toBe(true);});
""",
"hidden": """import {expect,test} from 'bun:test';import {ManualClock} from './src/clock';import {Sessions} from './src/sessions';import {Groups} from './src/groups';import {Policies} from './src/policies';import {Authorization} from './src/authorization';
const setup=()=>{const clock=new ManualClock(),sessions=new Sessions(clock),groups=new Groups(),policies=new Policies(),auth=new Authorization(clock,sessions,groups,policies);sessions.start('a','north','alice',10);sessions.start('b','south','alice',10);policies.create('report','north');return {clock,sessions,groups,policies,auth}};
test('expired sessions lose cached authorization',()=>{const x=setup();x.groups.add('north','readers','alice');x.policies.grant('report','readers','read');expect(x.auth.can('a','report','read')).toBe(true);x.clock.advance(10);expect(x.auth.can('a','report','read')).toBe(false);});
test('a replaced session id cannot inherit the earlier subject cache',()=>{const x=setup();x.groups.add('north','readers','alice');x.policies.grant('report','readers','read');expect(x.auth.can('a','report','read')).toBe(true);x.sessions.start('a','north','mallory',10);expect(x.auth.can('a','report','read')).toBe(false);});
test('membership stays tenant scoped',()=>{const x=setup();x.groups.add('south','readers','alice');x.policies.grant('report','readers','read');expect(x.auth.can('a','report','read')).toBe(false);});
test('separator-rich and prototype-looking identifiers remain ordinary data',()=>{const x=setup(),g=new Groups();g.add('a:b','c','left');g.add('a','b:c','right');expect(g.has('a:b','c','left')).toBe(true);expect(g.has('a:b','c','right')).toBe(false);expect(g.has('a','b:c','right')).toBe(true);expect(()=>x.sessions.start({} as any,'north','x',1)).toThrow();expect(()=>x.groups.add('north',[] as any,'x')).toThrow();expect(()=>x.policies.create('new',{} as any)).toThrow();x.sessions.start('proto','north','__proto__',10);x.groups.add('north','__proto__','__proto__');x.policies.grant('report','__proto__','read');expect(x.auth.can('proto','report','read')).toBe(true);x.policies.deny('report','__proto__','read');expect(x.auth.can('proto','report','read')).toBe(false);const snapshot=x.policies.get('report')!;expect(snapshot.groups.__proto__).toEqual(['read']);expect(snapshot.denied.__proto__).toEqual(['read']);x.sessions.start('ctor','north','constructor',10);x.groups.add('north','constructor','constructor');x.policies.grant('report','constructor','write');expect(x.auth.can('ctor','report','write')).toBe(true);x.policies.deny('report','constructor','write');expect(x.auth.can('ctor','report','write')).toBe(false);});
test('resource tenancy is enforced',()=>{const x=setup();x.groups.add('south','readers','alice');x.policies.grant('report','readers','read');expect(x.auth.can('b','report','read')).toBe(false);});
test('subject deny overrides all group grants',()=>{const x=setup();x.groups.add('north','readers','alice');x.groups.add('north','writers','alice');x.policies.grant('report','readers','read');x.policies.grant('report','writers','read');x.policies.deny('report','alice','read');expect(x.auth.can('a','report','read')).toBe(false);});
test('cache decisions are action scoped',()=>{const x=setup();x.groups.add('north','writers','alice');x.policies.grant('report','writers','read');expect(x.auth.can('a','report','read')).toBe(true);expect(x.auth.can('a','report','write')).toBe(false);});
test('membership changes invalidate cached grant and denial',()=>{const x=setup();x.groups.add('north','readers','alice');x.policies.grant('report','readers','read');expect(x.auth.can('a','report','read')).toBe(true);x.groups.remove('north','readers','alice');expect(x.auth.can('a','report','read')).toBe(false);x.groups.add('north','readers','alice');expect(x.auth.can('a','report','read')).toBe(true);});
test('policy revocation invalidates cached grant',()=>{const x=setup();x.groups.add('north','readers','alice');x.policies.grant('report','readers','read');expect(x.auth.can('a','report','read')).toBe(true);x.policies.revoke('report','readers','read');expect(x.auth.can('a','report','read')).toBe(false);});
test('returned state is isolated',()=>{const x=setup();const session=x.sessions.get('a')!;session.tenant='south';expect(x.sessions.get('a')?.tenant).toBe('north');x.groups.add('north','readers','alice');const members=x.groups.members('north','readers');members.push('mallory');expect(x.groups.has('north','readers','mallory')).toBe(false);x.policies.grant('report','readers','read');const policy=x.policies.get('report')!;policy.groups.readers.push('write');expect(x.auth.can('a','report','write')).toBe(false);});
""",
"oracle": {
"src/groups.ts": """import { isIdentifier } from './types';
const key = (tenant: string, group: string) => JSON.stringify([tenant, group]);

export class Groups {
  private rows = new Map<string, Set<string>>();
  private version = 0;
  get epoch() { return this.version; }

  add(tenant: string, group: string, subject: string) {
    if (!isIdentifier(tenant) || !isIdentifier(group) || !isIdentifier(subject)) throw new Error('identifier');
    const members = this.rows.get(key(tenant, group)) ?? new Set<string>();
    members.add(subject); this.rows.set(key(tenant, group), members); this.version++;
  }
  remove(tenant: string, group: string, subject: string) { if (!isIdentifier(tenant) || !isIdentifier(group) || !isIdentifier(subject)) throw new Error('identifier'); this.rows.get(key(tenant, group))?.delete(subject); this.version++; }
  has(tenant: string, group: string, subject: string) { return this.rows.get(key(tenant, group))?.has(subject) ?? false; }
  members(tenant: string, group: string) { return [...(this.rows.get(key(tenant, group)) ?? [])]; }
}
""",
"src/policies.ts": """import { isIdentifier, type Action, type ResourcePolicy } from './types';

const emptyActions = (): Record<string, Action[]> => Object.create(null);
const copyActions = (source: Record<string, Action[]>): Record<string, Action[]> => {
  const result = emptyActions();
  for (const [identity, actions] of Object.entries(source)) result[identity] = [...actions];
  return result;
};
const clone = (policy: ResourcePolicy): ResourcePolicy => ({ ...policy, groups: copyActions(policy.groups), denied: copyActions(policy.denied) });
const validAction = (action: unknown): action is Action => action === 'read' || action === 'write' || action === 'delete';

export class Policies {
  private rows = new Map<string, ResourcePolicy>();
  private version = 0;
  get epoch() { return this.version; }
  create(id: string, tenant: string) { if (!isIdentifier(id) || !isIdentifier(tenant) || this.rows.has(id)) throw new Error('resource'); this.rows.set(id, { id, tenant, groups: emptyActions(), denied: emptyActions() }); this.version++; }
  get(id: string) { const policy = this.rows.get(id); return policy && clone(policy); }
  grant(id: string, group: string, action: Action) { if (!isIdentifier(id) || !isIdentifier(group) || !validAction(action)) throw new Error('policy'); const policy = this.mustGet(id), actions = policy.groups[group] ?? []; if (!actions.includes(action)) actions.push(action); policy.groups[group] = actions; this.version++; }
  revoke(id: string, group: string, action: Action) { if (!isIdentifier(id) || !isIdentifier(group) || !validAction(action)) throw new Error('policy'); const policy = this.mustGet(id); policy.groups[group] = (policy.groups[group] ?? []).filter(value => value !== action); this.version++; }
  deny(id: string, subject: string, action: Action) { if (!isIdentifier(id) || !isIdentifier(subject) || !validAction(action)) throw new Error('policy'); const policy = this.mustGet(id), actions = policy.denied[subject] ?? []; if (!actions.includes(action)) actions.push(action); policy.denied[subject] = actions; this.version++; }
  private mustGet(id: string) { const policy = this.rows.get(id); if (!policy) throw new Error('resource'); return policy; }
}
""",
"src/authorization.ts": """import { ManualClock } from './clock';
import { Groups } from './groups';
import { Policies } from './policies';
import { Sessions } from './sessions';
import { isIdentifier, type Action, type CachedDecision } from './types';

export class Authorization {
  private cache = new Map<string, CachedDecision>();
  constructor(public clock: ManualClock, public sessions: Sessions, public groups: Groups, public policies: Policies) {}

  can(sessionId: string, resourceId: string, action: Action): boolean {
    if (!isIdentifier(sessionId) || !isIdentifier(resourceId) || !['read', 'write', 'delete'].includes(action)) return false;
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= this.clock.now()) return false;
    const resource = this.policies.get(resourceId);
    if (!resource || resource.tenant !== session.tenant) return false;
    const key = JSON.stringify([sessionId, session.version, resourceId, action]);
    const cached = this.cache.get(key);
    if (cached && cached.membershipEpoch === this.groups.epoch && cached.policyEpoch === this.policies.epoch) return cached.allowed;
    const denied = resource.denied[session.subject]?.includes(action) ?? false;
    const allowed = !denied && Object.entries(resource.groups).some(([group, actions]) =>
      actions.includes(action) && this.groups.has(session.tenant, group, session.subject));
    this.cache.set(key, { allowed, membershipEpoch: this.groups.epoch, policyEpoch: this.policies.epoch });
    return allowed;
  }
}
"""},
"mutants": {
"expired-session-allowed": {"src/authorization.ts": [("if (!session || session.expiresAt <= this.clock.now()) return false;", "if (!session) return false;")]},
"session-replacement-cache-leak": {"src/authorization.ts": [("JSON.stringify([sessionId, session.version, resourceId, action])", "JSON.stringify([sessionId, resourceId, action])")]},
"action-cache-collision": {"src/authorization.ts": [("JSON.stringify([sessionId, session.version, resourceId, action])", "JSON.stringify([sessionId, session.version, resourceId])")]},
"membership-cache-stale": {"src/authorization.ts": [("if (cached && cached.membershipEpoch === this.groups.epoch && cached.policyEpoch === this.policies.epoch) return cached.allowed;", "if (cached) return cached.allowed;")]},
"policy-cache-stale": {"src/authorization.ts": [("cached.membershipEpoch === this.groups.epoch && cached.policyEpoch === this.policies.epoch", "cached.membershipEpoch === this.groups.epoch")]},
"tenantless-groups": {"src/groups.ts": [("JSON.stringify([tenant, group])", "group")]},
"prototype-backed-policy-dictionaries": {"src/policies.ts": [("Object.create(null)", "{}")]},
"deny-does-not-win": {"src/authorization.ts": [("const allowed = !denied && Object.entries(resource.groups).some", "const allowed = Object.entries(resource.groups).some")]}
}}
