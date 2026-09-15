import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  MANIFEST_SCHEMA,
  POINTER_SCHEMA,
  PROTOCOL,
  acceptStage0Summary,
  isRecord,
  scanSensitive,
  sha256,
  type Stage0Summary,
} from "./protocol.ts";

const HEX32 = /^[0-9a-f]{32}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface Stage0Pointer {
  readonly schemaVersion: typeof POINTER_SCHEMA;
  readonly protocol: typeof PROTOCOL;
  readonly runId: string;
  readonly createdAt: string;
  readonly runDirectory: string;
  readonly summarySha256: string;
  readonly manifestSha256: string;
}

export interface Stage0Manifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA;
  readonly protocol: typeof PROTOCOL;
  readonly runId: string;
  readonly summarySha256: string;
  readonly artifacts: readonly [{ readonly id: "summary"; readonly sha256: string; readonly bytes: number }];
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parsePointer(value: unknown): Stage0Pointer {
  scanSensitive(value);
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "protocol", "runId", "createdAt", "runDirectory", "summarySha256", "manifestSha256",
  ]) || value.schemaVersion !== POINTER_SCHEMA || value.protocol !== PROTOCOL || typeof value.runId !== "string" || !HEX32.test(value.runId) ||
      typeof value.createdAt !== "string" || !ISO.test(value.createdAt) || value.runDirectory !== `runs/${value.runId}` ||
      typeof value.summarySha256 !== "string" || !HEX64.test(value.summarySha256) ||
      typeof value.manifestSha256 !== "string" || !HEX64.test(value.manifestSha256)) throw new Error("invalid Stage 0 pointer");
  return value as unknown as Stage0Pointer;
}

function parseManifest(value: unknown, pointer: Stage0Pointer): Stage0Manifest {
  scanSensitive(value);
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "protocol", "runId", "summarySha256", "artifacts"]) ||
      value.schemaVersion !== MANIFEST_SCHEMA || value.protocol !== PROTOCOL || value.runId !== pointer.runId ||
      value.summarySha256 !== pointer.summarySha256 || !Array.isArray(value.artifacts) || value.artifacts.length !== 1) {
    throw new Error("invalid Stage 0 manifest");
  }
  const artifact = value.artifacts[0];
  if (!isRecord(artifact) || !exactKeys(artifact, ["id", "sha256", "bytes"]) || artifact.id !== "summary" ||
      artifact.sha256 !== pointer.summarySha256 || !Number.isInteger(artifact.bytes) || (artifact.bytes as number) <= 0) {
    throw new Error("invalid Stage 0 manifest artifact");
  }
  return value as unknown as Stage0Manifest;
}

function assertDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe result directory: ${path}`);
}

function assertRegular(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe result file: ${path}`);
}

export function writeExclusive(path: string, bytes: string | Uint8Array, mode = 0o444): void {
  writeFileSync(path, bytes, { flag: "wx", mode });
  chmodSync(path, mode);
}

export function publishSummary(summary: Stage0Summary, resultsRoot: string, createPointer = summary.measurementValid): {
  readonly runDirectory: string;
  readonly pointerPath?: string;
} {
  if (acceptStage0Summary(summary) === null) throw new Error("refusing invalid Stage 0 summary");
  const absoluteRoot = resolve(resultsRoot);
  mkdirSync(absoluteRoot, { recursive: true, mode: 0o755 });
  assertDirectory(absoluteRoot);
  const runsRoot = join(absoluteRoot, "runs");
  const pointersRoot = join(absoluteRoot, "pointers");
  mkdirSync(runsRoot, { recursive: true, mode: 0o755 });
  mkdirSync(pointersRoot, { recursive: true, mode: 0o755 });
  assertDirectory(runsRoot);
  assertDirectory(pointersRoot);

  const runDirectory = join(runsRoot, summary.runId);
  mkdirSync(runDirectory, { recursive: false, mode: 0o755 });
  const summaryBytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`);
  const summarySha256 = sha256(summaryBytes);
  const summaryPath = join(runDirectory, "summary.json");
  writeExclusive(summaryPath, summaryBytes);
  const manifest: Stage0Manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    protocol: PROTOCOL,
    runId: summary.runId,
    summarySha256,
    artifacts: [{ id: "summary", sha256: summarySha256, bytes: summaryBytes.byteLength }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = join(runDirectory, "MANIFEST.json");
  writeExclusive(manifestPath, manifestBytes);
  const pointer: Stage0Pointer = {
    schemaVersion: POINTER_SCHEMA,
    protocol: PROTOCOL,
    runId: summary.runId,
    createdAt: summary.createdAt,
    runDirectory: `runs/${summary.runId}`,
    summarySha256,
    manifestSha256: sha256(manifestBytes),
  };
  if (!createPointer) return { runDirectory };
  const pointerPath = join(pointersRoot, `${summary.runId}.json`);
  writeExclusive(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  return { runDirectory, pointerPath };
}

export function listPointers(resultsRoot: string): readonly string[] {
  const pointersRoot = join(resolve(resultsRoot), "pointers");
  try {
    assertDirectory(pointersRoot);
  } catch {
    return [];
  }
  return readdirSync(pointersRoot).filter((name) => /^[0-9a-f]{32}\.json$/u.test(name)).sort().map((name) => join(pointersRoot, name));
}

export function readPointer(path: string): Stage0Pointer {
  assertRegular(path);
  return parsePointer(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function currentPointer(resultsRoot: string): string {
  const candidates = listPointers(resultsRoot).map((path) => ({ path, pointer: readPointer(path) }))
    .sort((left, right) => right.pointer.createdAt.localeCompare(left.pointer.createdAt) || right.pointer.runId.localeCompare(left.pointer.runId));
  if (candidates.length === 0) throw new Error("no published Stage 0 pointer");
  return candidates[0]!.path;
}

export function readPublished(pointerPath: string, resultsRoot: string): {
  readonly pointer: Stage0Pointer;
  readonly manifest: Stage0Manifest;
  readonly summary: Stage0Summary;
  readonly runDirectory: string;
} {
  const root = realpathSync(resolve(resultsRoot));
  assertRegular(resolve(pointerPath));
  const pointerReal = realpathSync(pointerPath);
  if (!pointerReal.startsWith(`${root}${sep}`)) throw new Error("Stage 0 pointer escaped result root");
  assertRegular(pointerReal);
  const pointerBytes = readFileSync(pointerReal);
  const pointer = parsePointer(JSON.parse(pointerBytes.toString("utf8")) as unknown);
  const runDirectory = realpathSync(join(root, pointer.runDirectory));
  if (!runDirectory.startsWith(`${root}${sep}`)) throw new Error("Stage 0 run directory escaped result root");
  assertDirectory(runDirectory);
  const summaryPath = join(runDirectory, "summary.json");
  const manifestPath = join(runDirectory, "MANIFEST.json");
  assertRegular(summaryPath);
  assertRegular(manifestPath);
  if ((lstatSync(summaryPath).mode & 0o222) !== 0 || (lstatSync(manifestPath).mode & 0o222) !== 0 ||
      (lstatSync(pointerReal).mode & 0o222) !== 0) throw new Error("published Stage 0 artifact is writable");
  const summaryBytes = readFileSync(summaryPath);
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(summaryBytes) !== pointer.summarySha256 || sha256(manifestBytes) !== pointer.manifestSha256) {
    throw new Error("Stage 0 pointer hash mismatch");
  }
  const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown, pointer);
  if (manifest.artifacts[0].bytes !== summaryBytes.byteLength) throw new Error("Stage 0 summary byte mismatch");
  const summary = acceptStage0Summary(JSON.parse(summaryBytes.toString("utf8")) as unknown);
  if (summary === null || summary.runId !== pointer.runId || summary.createdAt !== pointer.createdAt) throw new Error("invalid published Stage 0 summary");
  return { pointer, manifest, summary, runDirectory };
}

export function resultsRootFromPointer(pointerPath: string): string {
  return dirname(dirname(resolve(pointerPath)));
}
