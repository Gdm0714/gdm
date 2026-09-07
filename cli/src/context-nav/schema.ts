import { isAbsolute, posix } from "node:path";

export const CONTEXT_QUERY_SCHEMA = "gdm-context-query/v1" as const;
export const CONTEXT_PACK_SCHEMA = "gdm-context-pack/v1" as const;
export const CONTEXT_STATUS_SCHEMA = "gdm-context-status/v1" as const;
export const DEFAULT_MAX_BYTES = 4096;
export const ABSOLUTE_MAX_BYTES = 12_288;
export const ROUTE_MAX_BYTES = 1024;

export const EDGE_TYPES = [
  "imports",
  "mentions",
  "contains",
  "owns",
  "touches",
  "verifies",
  "evidenced_by",
  "tests",
] as const;

export type ContextEdgeType = typeof EDGE_TYPES[number];
export type ContextNodeKind = "file" | "test" | "heading" | "package" | "owner" | "work" | "check" | "evidence_ref";

export interface ContextBudget {
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxSnippets: number;
}

export interface ContextQuery {
  readonly schemaVersion: typeof CONTEXT_QUERY_SCHEMA;
  readonly root: string;
  readonly op: "route" | "pack";
  readonly terms: readonly string[];
  readonly seeds: readonly string[];
  readonly edgeTypes: readonly ContextEdgeType[];
  readonly maxDepth: number;
  readonly budget: ContextBudget;
}

export type ContextNodeTuple = readonly [key: string, kind: ContextNodeKind, hash8: string, line: number];
export type ContextEdgeTuple = readonly [from: number, to: number, type: ContextEdgeType, line: number];
export type ContextSnippetTuple = readonly [node: number, startLine: number, endLine: number, text: string];

export interface ContextPack {
  readonly s: typeof CONTEXT_PACK_SCHEMA;
  readonly st: "ok" | "stale" | "untrusted" | "unsupported" | "error";
  readonly fr: "fresh" | "synced" | "stale";
  readonly fp: string;
  readonly n: readonly ContextNodeTuple[];
  readonly e: readonly ContextEdgeTuple[];
  readonly sn: readonly ContextSnippetTuple[];
  readonly u: { readonly count: number; readonly why: readonly string[] };
  readonly tr: null | { readonly why: "byte-budget" | "node-budget" | "edge-budget" | "snippet-budget"; readonly dropped: number; readonly hint: "narrow-terms-seeds-or-depth" };
  readonly lim: { readonly b: number; readonly n: number; readonly e: number; readonly sn: number; readonly d: number };
}

export interface ContextStatus {
  readonly schemaVersion: typeof CONTEXT_STATUS_SCHEMA;
  readonly provider: "gdm-local-context";
  readonly version: 1;
  readonly mode: "one-shot";
  readonly cache: "disabled";
  readonly querySchema: typeof CONTEXT_QUERY_SCHEMA;
  readonly packSchema: typeof CONTEXT_PACK_SCHEMA;
  readonly defaultMaxBytes: typeof DEFAULT_MAX_BYTES;
  readonly absoluteMaxBytes: typeof ABSOLUTE_MAX_BYTES;
}

export class ContextError extends Error {}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function looksAssignmentLike(value: string): boolean {
  return /[:=]\s*\S/u.test(value.normalize("NFKC"));
}

export function looksSecret(value: string): boolean {
  const cloudAccessPrefix = ["AK", "IA"].join("");
  const authorizationScheme = ["Bear", "er"].join("");
  const authorizationField = ["author", "ization"].join("");
  const sensitiveFieldPattern = [
    authorizationField,
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "api[-_ ]?key",
    "access[-_ ]?(?:key|token)",
    "auth[-_ ]?token",
    "client[-_ ]?secret",
    "refresh[-_ ]?token",
    "private[-_ ]?key",
    "credential(?:s)?",
    "session[-_ ]?(?:key|token)",
    "signing[-_ ]?key",
    "encryption[-_ ]?key",
    "webhook[-_ ]?secret",
  ].join("|");
  const normalized = value.normalize("NFKC");
  const encodedOrInvisible = /\\(?:u(?:[0-9a-f]{4}|\{[0-9a-f]{4,6}\})|x[0-9a-f]{2}|[0-7]{1,3}|["'\/bfnrt])|%[0-9a-f]{2}|&#(?:x[0-9a-f]+|[0-9]+);|&[a-z][a-z0-9]{1,31};|\p{Cf}/iu;
  return encodedOrInvisible.test(normalized) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|xox[baprs]|ghp|github_pat)-?[A-Za-z0-9_-]{16,}\b/iu.test(normalized) ||
    new RegExp(`\\b${cloudAccessPrefix}[A-Z0-9]{16}\\b`, "u").test(normalized) ||
    new RegExp(`\\b${authorizationScheme}\\s+[A-Za-z0-9._~+/-]+`, "iu").test(normalized) ||
    new RegExp(`\\b(?:${sensitiveFieldPattern})\\b[^\\p{L}\\p{N}\\r\\n]*[:=]\\s*\\S+`, "iu").test(normalized) ||
    /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(normalized) ||
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]{1,64}:[^\s@]+@[^\s]+/iu.test(normalized) ||
    /\b(?:[A-F0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})\b/u.test(normalized);
}

export function canonicalRepositoryPath(value: string, field: string): string {
  if (
    value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("\\") ||
    value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("//")
  ) {
    throw new ContextError(`${field} must be a canonical repository-relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ContextError(`${field} must not contain empty, dot, or parent segments`);
  }
  if (posix.normalize(value) !== value) throw new ContextError(`${field} must be normalized`);
  return value;
}

function stringArray(raw: unknown, field: string, minimum: number, maximum: number): readonly string[] {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum) {
    throw new ContextError(`${field} must contain ${minimum} to ${maximum} strings`);
  }
  const values = raw.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 200 || value !== value.trim() || value.includes("\0")) {
      throw new ContextError(`${field} contains an invalid string`);
    }
    if (looksSecret(value) || looksAssignmentLike(value)) throw new ContextError(`${field} contains a secret-shaped value`);
    return value;
  });
  if (new Set(values).size !== values.length) throw new ContextError(`${field} must not contain duplicates`);
  return values;
}

function integer(raw: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(raw) || (raw as number) < minimum || (raw as number) > maximum) {
    throw new ContextError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return raw as number;
}

function parseBudget(raw: unknown): ContextBudget {
  if (!isRecord(raw)) throw new ContextError("budget must be an object");
  const allowed = new Set(["maxBytes", "maxNodes", "maxEdges", "maxSnippets"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new ContextError(`budget has unknown field: ${unknown[0]}`);
  return {
    maxBytes: integer(raw.maxBytes, "budget.maxBytes", 512, ABSOLUTE_MAX_BYTES),
    maxNodes: integer(raw.maxNodes, "budget.maxNodes", 1, 64),
    maxEdges: integer(raw.maxEdges, "budget.maxEdges", 0, 128),
    maxSnippets: integer(raw.maxSnippets, "budget.maxSnippets", 0, 12),
  };
}

export function parseContextQuery(raw: unknown): ContextQuery {
  if (!isRecord(raw)) throw new ContextError("request must be a JSON object");
  const allowed = new Set(["schemaVersion", "root", "op", "terms", "seeds", "edgeTypes", "maxDepth", "budget"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new ContextError(`request has unknown field: ${unknown[0]}`);
  if (raw.schemaVersion !== CONTEXT_QUERY_SCHEMA) {
    throw new ContextError(`schemaVersion must be ${CONTEXT_QUERY_SCHEMA}`);
  }
  if (typeof raw.root !== "string" || !isAbsolute(raw.root) || raw.root.includes("\0")) {
    throw new ContextError("root must be an absolute path");
  }
  if (raw.op !== "route" && raw.op !== "pack") throw new ContextError("op must be route or pack");
  const terms = stringArray(raw.terms, "terms", 1, 8);
  const seeds = stringArray(raw.seeds, "seeds", 0, 4);
  for (const seed of seeds) {
    if (seed.includes("/") || /^[^:]+\.[A-Za-z0-9]+$/u.test(seed)) canonicalRepositoryPath(seed, "seed");
    else if (!/^(?:w|c|ev|pkg|owner):[^\0]{1,190}$/u.test(seed)) throw new ContextError("seed must be a repository path or node key");
  }
  const edgeTypes = stringArray(raw.edgeTypes, "edgeTypes", 0, EDGE_TYPES.length);
  if (edgeTypes.some((value) => !EDGE_TYPES.includes(value as ContextEdgeType))) {
    throw new ContextError("edgeTypes contains an unsupported edge type");
  }
  return {
    schemaVersion: CONTEXT_QUERY_SCHEMA,
    root: raw.root,
    op: raw.op,
    terms,
    seeds,
    edgeTypes: edgeTypes as readonly ContextEdgeType[],
    maxDepth: integer(raw.maxDepth, "maxDepth", 0, 4),
    budget: parseBudget(raw.budget),
  };
}
