#!/usr/bin/env bun
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  type Arm,
  type FileProjection,
  type SideRecord,
  type Task,
  ARMS,
  SIDE_SCHEMA,
  TASKS,
  canonicalRepositoryPath,
  contextRequest,
  graphRequest,
  isRecord,
  pathDigest,
  regularContainedFile,
  sha256,
  signedSideEnvelope,
  taskAnchor,
} from "./protocol.ts";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing benchmark environment ${name}`);
  return value;
}

const root = requiredEnv("GDM_BENCH_ROOT");
const nonce = requiredEnv("GDM_BENCH_NONCE");
const runToken = requiredEnv("GDM_BENCH_RUN_TOKEN");
const arm = requiredEnv("GDM_BENCH_ARM") as Arm;
if (!ARMS.includes(arm) || !/^[0-9a-f]{64}$/u.test(nonce) || !/^[0-9a-f]{32}$/u.test(runToken)) {
  throw new Error("invalid benchmark identity");
}

function parseTask(value: string | undefined): Task {
  if (value === undefined || !TASKS.includes(value as Task)) throw new Error("invalid benchmark task");
  return value as Task;
}

function fileProjection(repositoryPath: string): { readonly projection: FileProjection; readonly text: string } {
  if (/^\.gdm\/[^/]+\/out\//u.test(repositoryPath)) throw new Error("evidence bodies are not readable in the benchmark");
  const path = regularContainedFile(root, repositoryPath);
  const bytes = readFileSync(path);
  return {
    projection: { pathSha256: pathDigest(repositoryPath), contentSha256: sha256(bytes), bytes: bytes.byteLength },
    text: new TextDecoder().decode(bytes),
  };
}

function fileOutput(entries: readonly { readonly path: string; readonly text: string }[]): string {
  return entries.map(({ path, text }) => `--- ${path} ---\n${text}${text.endsWith("\n") ? "" : "\n"}`).join("");
}

function searchablePaths(): readonly string[] {
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const repositoryPath = relative(root, path).replaceAll("\\", "/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("search symlink is forbidden");
      if (stat.isDirectory()) {
        if (!/^\.gdm\/[^/]+\/out$/u.test(repositoryPath)) walk(path);
      } else if (stat.isFile() && !/^\.gdm\/[^/]+\/out\//u.test(repositoryPath)) {
        paths.push(repositoryPath);
      }
    }
  };
  walk(root);
  return paths;
}

function search(task: Task): { readonly output: string; readonly scanned: readonly string[] } {
  const anchor = taskAnchor(task);
  const anchorText = fileProjection(anchor.path).text;
  const linked = anchorText.match(/\.\.\/(src\/[A-Za-z0-9._/-]+)/u)?.[1];
  if (linked === undefined) throw new Error("anchor has no source link");
  const terms = new Set([
    ...anchor.heading.toLowerCase().split(/\s+/u),
    basename(linked).replace(/\.[^.]+$/u, "").toLowerCase(),
  ]);
  const lines: string[] = [];
  const scanned: string[] = [];
  for (const repositoryPath of searchablePaths()) {
    scanned.push(pathDigest(repositoryPath));
    const text = readFileSync(regularContainedFile(root, repositoryPath), "utf8");
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const lower = line.toLowerCase();
      if ([...terms].some((term) => lower.includes(term))) lines.push(`${repositoryPath}:${index + 1}:${line}`);
    }
  }
  return { output: `${lines.join("\n")}\n`, scanned: scanned.sort() };
}

function provider(kind: "graph" | "context", task: Task): {
  readonly output: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
  readonly requestSha256: string;
  readonly requestProjectionSha256: string;
  readonly resultSchema: "graph-v2" | "context-v1";
  readonly resultStatus: string;
  readonly resultFreshness: string;
} {
  if (arm === "control" || arm !== kind) throw new Error("provider does not match benchmark arm");
  const request = kind === "graph" ? graphRequest(root, task) : contextRequest(root, task);
  const input = new TextEncoder().encode(`${JSON.stringify(request)}\n`);
  const requestProjection = { ...request, root: "$FIXTURE_ROOT" };
  const target = kind === "graph" ? requiredEnv("GDM_BENCH_GRAPH") : requiredEnv("GDM_BENCH_GDM");
  const command = kind === "graph" ? [process.execPath, target, "query"] : [target, "context", "query"];
  const outcome = Bun.spawnSync(command, {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    env: kind === "context" ? { ...process.env, GDM_CONTEXT_TRUSTED_ROOT: root } : process.env,
  });
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder().decode(outcome.stdout));
  } catch {
    result = null;
  }
  const value = isRecord(result) ? result : {};
  const graphValid = kind === "graph" && value.schemaVersion === "gdm-graph-result/v2";
  const contextValid = kind === "context" && value.s === "gdm-context-pack/v1" && typeof value.st === "string" && typeof value.fr === "string";
  return {
    output: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    requestSha256: sha256(input),
    requestProjectionSha256: sha256(`${JSON.stringify(requestProjection)}\n`),
    resultSchema: kind === "graph" ? "graph-v2" : "context-v1",
    resultStatus: graphValid ? "na" : contextValid ? String(value.st) : "invalid",
    resultFreshness: graphValid ? "na" : contextValid ? String(value.fr) : "invalid",
  };
}

async function main(): Promise<void> {
  const [op, ...args] = process.argv.slice(2);
  let task: Task;
  let providerKind: "graph" | "context" | null = null;
  let argvPathSha256s: string[] = [];
  let files: FileProjection[] = [];
  let scannedPathSha256s: readonly string[] = [];
  let output = new Uint8Array();
  let stderr = new Uint8Array();
  let exitCode = 0;
  let requestSha256: string | null = null;
  let requestProjectionSha256: string | null = null;
  let resultSchema: "graph-v2" | "context-v1" | null = null;
  let resultStatus: string | null = null;
  let resultFreshness: string | null = null;

  if (op === "anchor") {
    if (args.length !== 1) throw new Error("anchor requires a task");
    task = parseTask(args[0]);
    const path = taskAnchor(task).path;
    const entry = fileProjection(path);
    argvPathSha256s = [pathDigest(path)];
    files = [entry.projection];
    output = new TextEncoder().encode(fileOutput([{ path, text: entry.text }]));
  } else if (op === "read") {
    if (args.length < 2 || args.length > 9) throw new Error("read requires a task and one to eight paths");
    task = parseTask(args[0]);
    const paths = args.slice(1).map(canonicalRepositoryPath);
    if (new Set(paths).size !== paths.length) throw new Error("duplicate read path");
    const entries = paths.map((path) => ({ path, ...fileProjection(path) }));
    argvPathSha256s = paths.map(pathDigest);
    files = entries.map((entry) => entry.projection);
    output = new TextEncoder().encode(fileOutput(entries.map((entry) => ({ path: entry.path, text: entry.text }))));
  } else if (op === "search") {
    if (args.length !== 1) throw new Error("search requires a task");
    task = parseTask(args[0]);
    const result = search(task);
    output = new TextEncoder().encode(result.output);
    scannedPathSha256s = result.scanned;
  } else if (op === "provider") {
    if (args.length !== 2 || (args[0] !== "graph" && args[0] !== "context")) throw new Error("provider requires a kind and task");
    providerKind = args[0];
    task = parseTask(args[1]);
    const result = provider(providerKind, task);
    output = result.output;
    stderr = result.stderr;
    exitCode = result.exitCode;
    requestSha256 = result.requestSha256;
    requestProjectionSha256 = result.requestProjectionSha256;
    resultSchema = result.resultSchema;
    resultStatus = result.resultStatus;
    resultFreshness = result.resultFreshness;
  } else {
    throw new Error("unsupported benchmark operation");
  }

  const record: SideRecord = {
    schemaVersion: SIDE_SCHEMA,
    runToken,
    op,
    task,
    arm,
    providerKind,
    argvPathSha256s,
    files,
    scannedPathSha256s,
    outputSha256: sha256(output),
    outputBytes: output.byteLength,
    requestSha256,
    requestProjectionSha256,
    resultSchema,
    resultStatus,
    resultFreshness,
    exitCode,
  };
  process.stdout.write(`${signedSideEnvelope(record, nonce)}\n`);
  process.stdout.write(output);
  process.stderr.write(stderr);
  process.exit(exitCode);
}

await main();
