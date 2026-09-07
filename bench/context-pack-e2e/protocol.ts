import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const SUMMARY_SCHEMA = "gdm-context-pack-e2e/v1" as const;
export const RECEIPT_SCHEMA = "gdm-context-pack-e2e-receipt/v1" as const;
export const SIDE_SCHEMA = "gdm-context-pack-e2e-side/v1" as const;
export const POINTER_SCHEMA = "gdm-context-pack-e2e-pointer/v1" as const;
export const MANIFEST_SCHEMA = "gdm-context-pack-e2e-manifest/v1" as const;
export const INSTALL_SCHEMA = "gdm-context-pack-e2e-install/v1" as const;
export const RECEIPT_PREFIX = "GDM_BENCH_RECEIPT_V1=" as const;
export const PROTOCOL = "allowlisted-io-receipts/v2" as const;
export const ARMS = ["control", "graph", "context"] as const;
export const TASKS = ["ownership", "budget"] as const;
export type Arm = typeof ARMS[number];
export type Task = typeof TASKS[number];
export type Operation = "anchor" | "read" | "search" | "provider";

export interface Usage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export interface FileProjection {
  readonly pathSha256: string;
  readonly contentSha256: string;
  readonly bytes: number;
}

export interface SideRecord {
  readonly schemaVersion: typeof SIDE_SCHEMA;
  readonly runToken: string;
  readonly op: Operation;
  readonly task: Task;
  readonly arm: Arm;
  readonly providerKind: "graph" | "context" | null;
  readonly argvPathSha256s: readonly string[];
  readonly files: readonly FileProjection[];
  readonly scannedPathSha256s: readonly string[];
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly requestSha256: string | null;
  readonly requestProjectionSha256: string | null;
  readonly resultSchema: "graph-v2" | "context-v1" | null;
  readonly resultStatus: string | null;
  readonly resultFreshness: string | null;
  readonly exitCode: number;
}

export interface AcceptedSideRecord extends Omit<SideRecord, "runToken"> {
  readonly seq: number;
}

export interface FinalAnswer {
  readonly task: Task;
  readonly paths: readonly string[];
  readonly facts: readonly { readonly id: string; readonly value: string }[];
  readonly limitations: readonly string[];
}

export interface ExpectedAnswer {
  readonly paths: readonly string[];
  readonly facts: Readonly<Record<string, string>>;
}

const FACT_IDS = ["implementation", "dependency", "test", "package", "owner", "work", "check", "evidence", "maxBytes"] as const;
const HEX64 = /^[0-9a-f]{64}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pathDigest(path: string): string {
  return sha256(`path:${path}`);
}

export function taskAnchor(task: Task): { readonly path: string; readonly heading: string } {
  return task === "ownership"
    ? { path: "docs/architecture.md", heading: "Validation Ownership" }
    : { path: "docs/decisions.md", heading: "Token Budget Route" };
}

export function contextRequest(root: string, task: Task) {
  const anchor = taskAnchor(task);
  return {
    schemaVersion: "gdm-context-query/v1",
    root,
    op: "pack",
    terms: anchor.heading.toLowerCase().split(" "),
    seeds: [],
    edgeTypes: ["imports", "mentions", "contains", "owns", "touches", "verifies", "evidenced_by", "tests"],
    maxDepth: 2,
    budget: { maxBytes: 4096, maxNodes: 24, maxEdges: 48, maxSnippets: 5 },
  } as const;
}

export function graphRequest(root: string, task: Task) {
  return {
    schemaVersion: "gdm-graph-query/v1",
    root,
    entry: task === "ownership" ? "src/boundary.ts" : "src/router.ts",
    direction: "dependents",
    maxDepth: 2,
  } as const;
}

export function canonicalCommand(
  operation: Pick<AcceptedSideRecord, "op" | "task" | "providerKind" | "argvPathSha256s">,
  pathByDigest: ReadonlyMap<string, string>,
): string | null {
  if (operation.op === "anchor") return `$GDM_BENCH_IO anchor ${operation.task}`;
  if (operation.op === "search") return `$GDM_BENCH_IO search ${operation.task}`;
  if (operation.op === "provider") {
    if (operation.providerKind !== "graph" && operation.providerKind !== "context") return null;
    return `$GDM_BENCH_IO provider ${operation.providerKind} ${operation.task}`;
  }
  if (operation.op !== "read" || operation.argvPathSha256s.length === 0) return null;
  const paths = operation.argvPathSha256s.map((digest) => pathByDigest.get(digest));
  if (paths.some((path) => path === undefined)) return null;
  return `$GDM_BENCH_IO read ${operation.task} ${paths.join(" ")}`;
}

export function canonicalEventCommand(
  operation: Pick<AcceptedSideRecord, "op" | "task" | "providerKind" | "argvPathSha256s">,
  pathByDigest: ReadonlyMap<string, string>,
): string | null {
  const inner = canonicalCommand(operation, pathByDigest);
  return inner === null || inner.includes("'") ? null : `/bin/zsh -lc '${inner}'`;
}

export function canonicalRepositoryPath(value: string): string {
  if (value.length === 0 || value.length > 200 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.includes("//")) {
    throw new Error("invalid repository path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new Error("invalid repository path");
  return value;
}

export function regularContainedFile(root: string, repositoryPath: string): string {
  const canonical = canonicalRepositoryPath(repositoryPath);
  const realRoot = realpathSync(root);
  let cursor = realRoot;
  for (const segment of canonical.split("/")) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("symlink path is forbidden");
  }
  const real = realpathSync(cursor);
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) throw new Error("path escaped fixture root");
  const stat = lstatSync(real);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("path is not a regular file");
  return real;
}

export interface ManifestEntry {
  readonly path: string;
  readonly pathSha256: string;
  readonly contentSha256: string;
  readonly bytes: number;
}

export function fixtureManifest(root: string): { readonly sha256: string; readonly entries: readonly ManifestEntry[] } {
  const realRoot = realpathSync(root);
  const entries: ManifestEntry[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git" || name.startsWith(".pilot-final-") || name.startsWith(".e2e-final-")) continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("fixture symlink is forbidden");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const repositoryPath = relative(realRoot, path).replaceAll("\\", "/");
        const bytes = readFileSync(path);
        entries.push({
          path: repositoryPath,
          pathSha256: pathDigest(repositoryPath),
          contentSha256: sha256(bytes),
          bytes: bytes.byteLength,
        });
      }
    }
  };
  walk(realRoot);
  return { sha256: sha256(JSON.stringify(entries)), entries };
}

export function directoryManifest(root: string): string {
  const realRoot = realpathSync(root);
  const entries: { readonly path: string; readonly sha256: string; readonly bytes: number }[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("manifest symlink is forbidden");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        entries.push({ path: relative(realRoot, path).replaceAll("\\", "/"), sha256: sha256(bytes), bytes: bytes.byteLength });
      }
    }
  };
  walk(realRoot);
  return sha256(JSON.stringify(entries));
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function acceptSideRecord(
  raw: unknown,
  expected: { readonly runToken: string; readonly arm: Arm; readonly nextSeq: number },
): AcceptedSideRecord | null {
  if (!isRecord(raw) || !exactKeys(raw, [
    "schemaVersion", "runToken", "op", "task", "arm", "providerKind", "argvPathSha256s", "files",
    "scannedPathSha256s", "outputSha256", "outputBytes", "requestSha256", "requestProjectionSha256", "resultSchema", "resultStatus",
    "resultFreshness", "exitCode",
  ])) return null;
  if (raw.schemaVersion !== SIDE_SCHEMA || raw.runToken !== expected.runToken || raw.arm !== expected.arm ||
      !TASKS.includes(raw.task as Task) || !["anchor", "read", "search", "provider"].includes(String(raw.op)) ||
      !Array.isArray(raw.argvPathSha256s) || !Array.isArray(raw.files) || !Array.isArray(raw.scannedPathSha256s) ||
      typeof raw.outputSha256 !== "string" || !HEX64.test(raw.outputSha256) || !Number.isInteger(raw.outputBytes) || (raw.outputBytes as number) < 0 ||
      !Number.isInteger(raw.exitCode)) return null;
  const argvPathSha256s = raw.argvPathSha256s as unknown[];
  const scannedPathSha256s = raw.scannedPathSha256s as unknown[];
  if (argvPathSha256s.some((value) => typeof value !== "string" || !HEX64.test(value)) ||
      scannedPathSha256s.some((value) => typeof value !== "string" || !HEX64.test(value))) return null;
  const files: FileProjection[] = [];
  for (const file of raw.files as unknown[]) {
    if (!isRecord(file) || !exactKeys(file, ["pathSha256", "contentSha256", "bytes"]) ||
        typeof file.pathSha256 !== "string" || !HEX64.test(file.pathSha256) ||
        typeof file.contentSha256 !== "string" || !HEX64.test(file.contentSha256) ||
        !Number.isInteger(file.bytes) || (file.bytes as number) < 0) return null;
    files.push(file as unknown as FileProjection);
  }
  const providerKind = raw.providerKind;
  if (providerKind !== null && providerKind !== "graph" && providerKind !== "context") return null;
  if ((raw.op === "provider") !== (providerKind !== null)) return null;
  const requestSha256 = raw.requestSha256;
  if (requestSha256 !== null && (typeof requestSha256 !== "string" || !HEX64.test(requestSha256))) return null;
  const requestProjectionSha256 = raw.requestProjectionSha256;
  if (requestProjectionSha256 !== null && (typeof requestProjectionSha256 !== "string" || !HEX64.test(requestProjectionSha256))) return null;
  const resultSchema = raw.resultSchema;
  if (resultSchema !== null && resultSchema !== "graph-v2" && resultSchema !== "context-v1") return null;
  if ((raw.resultStatus !== null && typeof raw.resultStatus !== "string") ||
      (raw.resultFreshness !== null && typeof raw.resultFreshness !== "string")) return null;
  return {
    schemaVersion: SIDE_SCHEMA,
    seq: expected.nextSeq,
    op: raw.op as Operation,
    task: raw.task as Task,
    arm: raw.arm as Arm,
    providerKind,
    argvPathSha256s: argvPathSha256s as string[],
    files,
    scannedPathSha256s: scannedPathSha256s as string[],
    outputSha256: raw.outputSha256,
    outputBytes: raw.outputBytes as number,
    requestSha256: requestSha256 as string | null,
    requestProjectionSha256: requestProjectionSha256 as string | null,
    resultSchema,
    resultStatus: raw.resultStatus as string | null,
    resultFreshness: raw.resultFreshness as string | null,
    exitCode: raw.exitCode as number,
  };
}

export function signedSideEnvelope(record: SideRecord, nonce: string): string {
  if (!/^[0-9a-f]{64}$/u.test(nonce)) throw new Error("invalid receipt nonce");
  const payload = Buffer.from(JSON.stringify(record)).toString("base64url");
  const signature = createHmac("sha256", nonce).update(payload).digest("hex");
  return `${RECEIPT_PREFIX}${payload}.${signature}`;
}

export function decodeSideEnvelope(
  output: string,
  expected: { readonly nonce: string; readonly runToken: string; readonly arm: Arm; readonly nextSeq: number },
): { readonly record: AcceptedSideRecord; readonly bodySha256: string; readonly bodyBytes: number } | null {
  const newline = output.indexOf("\n");
  if (newline < 0) return null;
  const marker = output.slice(0, newline);
  if (!marker.startsWith(RECEIPT_PREFIX)) return null;
  const encoded = marker.slice(RECEIPT_PREFIX.length);
  const dot = encoded.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = encoded.slice(0, dot);
  const signature = encoded.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/u.test(payload) || !/^[0-9a-f]{64}$/u.test(signature) || !/^[0-9a-f]{64}$/u.test(expected.nonce)) return null;
  const actual = Buffer.from(signature, "hex");
  const wanted = createHmac("sha256", expected.nonce).update(payload).digest();
  if (actual.byteLength !== wanted.byteLength || !timingSafeEqual(actual, wanted)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const record = acceptSideRecord(raw, expected);
  if (record === null) return null;
  const body = output.slice(newline + 1);
  const bodyBytes = Buffer.byteLength(body);
  const bodySha256 = sha256(body);
  if (record.outputSha256 !== bodySha256 || record.outputBytes !== bodyBytes) return null;
  return { record, bodySha256, bodyBytes };
}

export function scoreAnswer(answer: FinalAnswer, expected: ExpectedAnswer) {
  const pathCounts = new Map<string, number>();
  for (const path of answer.paths) pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  const paths = new Set(pathCounts.keys());
  const expectedPaths = new Set(expected.paths);
  const missingPaths = expected.paths.filter((path) => !paths.has(path));
  const extraPathSha256s = [...paths].filter((path) => !expectedPaths.has(path)).map(pathDigest).sort();
  const reportedPathSha256s = [...paths].map(pathDigest).sort();
  const factCounts = new Map<string, number>();
  const reportedFacts = answer.facts.map(({ id, value }) => ({
    id: FACT_IDS.includes(id as typeof FACT_IDS[number]) ? id : `other-${sha256(id)}`,
    valueSha256: sha256(value),
  })).sort((left, right) => left.id.localeCompare(right.id) || left.valueSha256.localeCompare(right.valueSha256));
  const factValues = new Map<string, string[]>();
  for (const fact of reportedFacts) {
    factCounts.set(fact.id, (factCounts.get(fact.id) ?? 0) + 1);
    factValues.set(fact.id, [...(factValues.get(fact.id) ?? []), fact.valueSha256]);
  }
  const expectedFactIds = Object.keys(expected.facts);
  const missingFactIds = expectedFactIds.filter((id) => !factValues.has(id));
  const mismatchedFactIds = expectedFactIds.filter((id) => factValues.has(id) && !factValues.get(id)!.includes(sha256(expected.facts[id]!)));
  const extraFactIdSha256s = [...factValues.keys()].filter((id) => !(id in expected.facts)).map((id) => sha256(`fact-id:${id}`)).sort();
  const duplicatePathCount = [...pathCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const duplicateFactIdCount = [...factCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const matchedPaths = expected.paths.length - missingPaths.length;
  const matchedFacts = expectedFactIds.length - missingFactIds.length - mismatchedFactIds.length;
  const expectedTask: Task = expectedFactIds.includes("maxBytes") ? "budget" : "ownership";
  const qualityValid = answer.task === expectedTask && missingPaths.length === 0 && missingFactIds.length === 0 &&
    mismatchedFactIds.length === 0 && extraPathSha256s.length === 0 && extraFactIdSha256s.length === 0 &&
    duplicatePathCount === 0 && duplicateFactIdCount === 0;
  return {
    expectedPaths: expected.paths.length,
    matchedPaths,
    expectedFacts: expectedFactIds.length,
    matchedFacts,
    missingPathSha256s: missingPaths.map(pathDigest).sort(),
    missingFactIds,
    mismatchedFactIds,
    extraPathSha256s,
    extraFactIdSha256s,
    reportedPathSha256s,
    reportedFacts,
    duplicatePathCount,
    duplicateFactIdCount,
    limitationsCount: answer.limitations.length,
    taskValid: answer.task === expectedTask,
    qualityValid,
    pathRecall: matchedPaths / expected.paths.length,
    factRecall: matchedFacts / expectedFactIds.length,
    recall: (matchedPaths + matchedFacts) / (expected.paths.length + expectedFactIds.length),
  };
}

export function resolvePointer(pointerPath: string): { readonly pointerPath: string; readonly runDirectory: string; readonly pointer: Readonly<Record<string, unknown>> } {
  const absolute = resolve(pointerPath);
  const pointer = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  if (!isRecord(pointer) || pointer.schemaVersion !== POINTER_SCHEMA || typeof pointer.runId !== "string" || !HEX32.test(pointer.runId) ||
      typeof pointer.runDirectory !== "string" || pointer.runDirectory !== `runs/${pointer.runId}` ||
      typeof pointer.manifestSha256 !== "string" || !HEX64.test(pointer.manifestSha256) ||
      typeof pointer.summarySha256 !== "string" || !HEX64.test(pointer.summarySha256)) throw new Error("invalid e2e pointer");
  const resultsRoot = realpathSync(dirname(absolute));
  const runDirectory = realpathSync(join(resultsRoot, pointer.runDirectory));
  if (!runDirectory.startsWith(`${resultsRoot}${sep}`)) throw new Error("run directory escaped results root");
  return { pointerPath: absolute, runDirectory, pointer };
}
