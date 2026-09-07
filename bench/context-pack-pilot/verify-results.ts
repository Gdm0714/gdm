#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createPilotFixture } from "./fixture.ts";

const path = process.argv[2];
if (process.argv.length !== 3 || path === undefined) {
  console.error("usage: verify-results.ts <summary.json>");
  process.exit(2);
}

function fail(message: string): never {
  throw new Error(`context-pack pilot verification failed: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) fail(`invalid digest ${field}`);
  return value;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`invalid numeric field ${field}`);
  return value;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) fail(`invalid string array ${field}`);
  return value;
}

function digests(value: unknown, field: string): string[] {
  return strings(value, field).map((entry, index) => digest(entry, `${field}/${index}`));
}

function same(left: unknown, right: unknown, field: string): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) fail(`receipt mismatch ${field}`);
}

function approximately(left: unknown, right: number, field: string): void {
  if (typeof left !== "number" || !Number.isFinite(left) ||
      Math.abs(left - right) > Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8) {
    fail(`numeric mismatch ${field}`);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...allowed].sort())) fail(`unknown or missing field ${field}`);
}

const summaryPath = resolve(path);
const summaryDirectory = dirname(summaryPath);
const summaryText = readFileSync(summaryPath, "utf8");
const raw = JSON.parse(summaryText) as unknown;
if (!record(raw) || raw.schemaVersion !== "gdm-context-pack-pilot/v14") fail("schema mismatch");
exactKeys(raw, [
  "schemaVersion", "protocol", "runId", "runnerSha256", "verifierSha256", "assessorSha256",
  "outputSchemaSha256", "fixtureSourceSha256", "runtimeSha256", "runtime", "fixtureManifestSha256",
  "fixtureFileCount", "staticGateSha256", "staticGate", "attemptStartSha256", "navigationStartPolicy",
  "followupShellCommandLimit", "contextTermSource", "contextSeedCount", "generatedAt", "model", "reasoning",
  "trialsPerTaskArm", "retention", "attemptPolicy", "fixtureSha256", "runs", "byArm",
], "summary");
if (raw.protocol !== "fair-anchor-receipts/v12") fail("pilot protocol mismatch");
if (raw.navigationStartPolicy !== "direct-doc-anchor-first" || raw.followupShellCommandLimit !== 3 ||
    raw.contextTermSource !== "common-anchor-heading-only" || raw.contextSeedCount !== 0) {
  fail("navigation policy mismatch");
}
if (raw.retention !== "metrics-hashes-and-structured-score-only" ||
    raw.attemptPolicy !== "append-only-zero-run-preflight-retry-no-tuple-replacement") {
  fail("retention or attempt policy mismatch");
}
if (raw.trialsPerTaskArm !== 3) fail("three crossed trials per task and arm are required");
if (typeof raw.runId !== "string" || !/^[0-9a-f]{32}$/u.test(raw.runId)) fail("invalid run id");
if (!Array.isArray(raw.runs) || raw.runs.length !== 18) fail("exactly eighteen runs are required");

const expectedSources = {
  runnerSha256: sha256(readFileSync(join(import.meta.dir, "run-pilot-v12.ts"))),
  verifierSha256: sha256(readFileSync(join(import.meta.dir, "verify-results-v12.ts"))),
  assessorSha256: sha256(readFileSync(join(import.meta.dir, "assess-results-v12.ts"))),
  outputSchemaSha256: sha256(readFileSync(join(import.meta.dir, "output.schema.json"))),
  fixtureSourceSha256: sha256(readFileSync(join(import.meta.dir, "fixture.ts"))),
};
for (const [field, expected] of Object.entries(expectedSources)) {
  if (raw[field] !== expected) fail(`source commitment mismatch ${field}`);
}
digest(raw.fixtureSha256, "fixtureSha256");
digest(raw.runtimeSha256, "runtimeSha256");
digest(raw.attemptStartSha256, "attemptStartSha256");
if (!record(raw.runtime) || raw.runtimeSha256 !== sha256(JSON.stringify(raw.runtime))) fail("runtime commitment mismatch");
exactKeys(raw.runtime, ["codex", "gdm", "graph", "graphScanner", "bun", "model", "reasoning", "sandbox", "ephemeral", "userConfig", "rules"], "runtime");
for (const name of ["codex", "gdm", "graph", "graphScanner", "bun"]) {
  const value = raw.runtime[name];
  if (!record(value) || typeof value.path !== "string" || typeof value.version !== "string") {
    fail(`runtime artifact missing ${name}`);
  }
  exactKeys(value, ["path", "sha256", "version"], `runtime/${name}`);
  const stat = lstatSync(value.path);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      digest(value.sha256, `runtime/${name}`) !== sha256(readFileSync(value.path))) {
    fail(`runtime artifact mismatch ${name}`);
  }
}
if (!record(raw.runtime.codex) || raw.runtime.codex.sha256 !== "8194ea3181f330e63023b234b0b231855e5874e0331c5ef7cbc490591497a7bf" ||
    raw.runtime.codex.version !== "codex-cli 0.152.1") fail("unapproved Codex runtime");
for (const name of ["codex", "gdm"]) {
  const value = raw.runtime[name] as Record<string, unknown>;
  const outcome = Bun.spawnSync([value.path as string, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (outcome.exitCode !== 0 || new TextDecoder().decode(outcome.stdout).trim() !== value.version) {
    fail(`runtime version mismatch ${name}`);
  }
}
if (raw.runtime.model !== "gpt-5.6-sol" || raw.runtime.reasoning !== "xhigh" || raw.runtime.sandbox !== "read-only" ||
    raw.runtime.ephemeral !== true || raw.runtime.userConfig !== "ignored" || raw.runtime.rules !== "ignored") {
  fail("runtime policy mismatch");
}
if (!record(raw.staticGate) || !record(raw.runtime.bun) || typeof raw.runtime.bun.path !== "string") {
  fail("static gate commitment missing");
}
const staticCommand = [raw.runtime.bun.path, "test", "test/context-nav-adversarial.test.ts"];
const staticOutcome = Bun.spawnSync(staticCommand, { cwd: resolve(import.meta.dir, "../../cli"), stdout: "pipe", stderr: "pipe" });
const expectedStaticGate = {
  commandSha256: sha256(JSON.stringify(staticCommand)),
  testSourceSha256: sha256(readFileSync(resolve(import.meta.dir, "../../cli/test/context-nav-adversarial.test.ts"))),
  exitCode: staticOutcome.exitCode,
  passed: staticOutcome.exitCode === 0,
};
if (digest(raw.staticGateSha256, "staticGateSha256") !== sha256(JSON.stringify(raw.staticGate)) ||
    JSON.stringify(raw.staticGate) !== JSON.stringify(expectedStaticGate)) fail("static gate mismatch");

function fixtureManifest(root: string): { readonly sha256: string; readonly files: number } {
  const entries: { readonly path: string; readonly sha256: string }[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git" || name.startsWith(".pilot-final-")) continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`fixture symlink ${relative(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) entries.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: sha256(readFileSync(path)) });
    }
  };
  walk(root);
  return { sha256: sha256(JSON.stringify(entries)), files: entries.length };
}

function cleanup(path: string): void {
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (statSync(child).isDirectory()) cleanup(child);
    else unlinkSync(child);
  }
  rmdirSync(path);
}

const generatedFixture = createPilotFixture();
const expectedByTask = generatedFixture.expected;
let generatedManifest: { readonly sha256: string; readonly files: number };
try {
  generatedManifest = fixtureManifest(generatedFixture.root);
} finally {
  cleanup(generatedFixture.root);
}
if (raw.fixtureSha256 !== sha256(JSON.stringify(expectedByTask)) ||
    raw.fixtureManifestSha256 !== generatedManifest.sha256 || raw.fixtureFileCount !== generatedManifest.files) {
  fail("generated fixture commitment mismatch");
}

if (JSON.stringify(readdirSync(summaryDirectory).sort()) !== JSON.stringify(["attempts.jsonl", "receipts", "summary.json"])) {
  fail("results artifact set mismatch");
}
const attemptLines = readFileSync(join(summaryDirectory, "attempts.jsonl"), "utf8").trimEnd().split("\n");
if (attemptLines.length < 2 || attemptLines.length % 2 !== 0) fail("attempt ledger must contain complete event pairs");
for (let index = 0; index < attemptLines.length; index += 2) {
  const start = JSON.parse(attemptLines[index]!) as unknown;
  const outcome = JSON.parse(attemptLines[index + 1]!) as unknown;
  if (!record(start) || !record(outcome)) fail(`invalid attempt pair ${index / 2}`);
  exactKeys(start, ["at", "event", "fixtureManifestSha256", "protocol", "runId", "runnerSha256", "runtimeSha256"], `attempt start ${index / 2}`);
  if (start.event !== "started" || typeof start.at !== "string" || typeof start.protocol !== "string" ||
      typeof start.runId !== "string" || !/^[0-9a-f]{32}$/u.test(start.runId)) fail(`invalid attempt start ${index / 2}`);
  digest(start.runnerSha256, `attempt/${index}/runner`);
  digest(start.runtimeSha256, `attempt/${index}/runtime`);
  digest(start.fixtureManifestSha256, `attempt/${index}/fixture`);
  const finalPair = index === attemptLines.length - 2;
  if (!finalPair) {
    exactKeys(outcome, ["at", "completedRuns", "errorSha256", "event", "runId"], `attempt failure ${index / 2}`);
    if (outcome.event !== "failed" || outcome.runId !== start.runId || outcome.completedRuns !== 0 ||
        typeof outcome.at !== "string") fail(`retryable attempt was not a zero-run preflight failure ${index / 2}`);
    digest(outcome.errorSha256, `attempt/${index}/error`);
    continue;
  }
  exactKeys(outcome, ["at", "completedRuns", "event", "runId", "summarySha256"], "final attempt completion");
  if (start.protocol !== raw.protocol || start.runId !== raw.runId || start.runnerSha256 !== raw.runnerSha256 ||
      start.runtimeSha256 !== raw.runtimeSha256 || start.fixtureManifestSha256 !== raw.fixtureManifestSha256 ||
      outcome.event !== "completed" || outcome.runId !== raw.runId || outcome.completedRuns !== 18 ||
      outcome.summarySha256 !== sha256(summaryText) || typeof outcome.at !== "string" ||
      raw.attemptStartSha256 !== sha256(attemptLines[index]!)) fail("final attempt ledger mismatch");
}

const receiptsDirectory = join(summaryDirectory, "receipts");
const receiptDirectoryStat = lstatSync(receiptsDirectory);
if (!receiptDirectoryStat.isDirectory() || receiptDirectoryStat.isSymbolicLink()) fail("unsafe receipt directory");
const expectedReceiptNames = raw.runs.map((value) => {
  if (!record(value)) fail("run must be an object");
  return `${String(value.task)}-${String(value.arm)}-t${String(value.trial)}.json`;
}).sort();
if (JSON.stringify(readdirSync(receiptsDirectory).sort()) !== JSON.stringify(expectedReceiptNames)) {
  fail("receipt set does not exactly match runs");
}

const receiptContents: string[] = [];
const runs = raw.runs.map((value) => {
  if (!record(value)) fail("run must be an object");
  const task = value.task;
  const arm = value.arm;
  const trial = value.trial;
  if ((task !== "ownership" && task !== "budget") || (arm !== "control" && arm !== "graph" && arm !== "context") ||
      (trial !== 1 && trial !== 2 && trial !== 3)) fail("invalid trial, task, or arm");

  if (!record(value.receipt)) fail(`${task}/${arm} receipt reference missing`);
  exactKeys(value.receipt, ["path", "sha256"], `${task}/${arm}/receipt reference`);
  const expectedReceiptPath = `receipts/${task}-${arm}-t${trial}.json`;
  if (value.receipt.path !== expectedReceiptPath) fail(`${task}/${arm} receipt path mismatch`);
  const receiptPath = join(summaryDirectory, expectedReceiptPath);
  const receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) fail(`${task}/${arm} unsafe receipt`);
  const receiptBytes = readFileSync(receiptPath);
  if (digest(value.receipt.sha256, `${task}/${arm} receipt`) !== sha256(receiptBytes)) {
    fail(`${task}/${arm} receipt hash mismatch`);
  }
  const receiptText = new TextDecoder().decode(receiptBytes);
  receiptContents.push(receiptText);
  const receipt = JSON.parse(receiptText) as unknown;
  if (!record(receipt) || receipt.schemaVersion !== "gdm-context-pack-pilot-receipt/v12") {
    fail(`${task}/${arm} receipt schema mismatch`);
  }
  exactKeys(receipt, [
    "schemaVersion", "runId", "task", "arm", "trial", "runnerSha256", "verifierSha256", "assessorSha256",
    "outputSchemaSha256", "fixtureSourceSha256", "runtimeSha256", "fixtureManifestSha256", "fixtureFileCount",
    "staticGateSha256", "attemptStartSha256", "eventStreamSha256", "usageEventSha256", "usageProjectionSha256",
    "traceRootSha256", "trace", "expectedReadPathSha256s", "directReadPathSha256s", "directReadsValid",
    "anchorFirstValid", "commandPolicyValid", "answerSha256", "exitCode", "elapsedMs", "commands", "usage",
    "provider", "contextPackBytes", "score",
  ], `${task}/${arm}/receipt`);
  if (receipt.runId !== raw.runId || receipt.task !== task || receipt.arm !== arm || receipt.trial !== trial) {
    fail(`${task}/${arm} receipt identity mismatch`);
  }
  for (const [field, expected] of Object.entries(expectedSources)) {
    if (receipt[field] !== expected) fail(`${task}/${arm} receipt source mismatch ${field}`);
  }
  if (receipt.runtimeSha256 !== raw.runtimeSha256 || receipt.fixtureManifestSha256 !== raw.fixtureManifestSha256 ||
      receipt.fixtureFileCount !== raw.fixtureFileCount || receipt.staticGateSha256 !== raw.staticGateSha256 ||
      receipt.attemptStartSha256 !== raw.attemptStartSha256) {
    fail(`${task}/${arm} runtime, fixture, or static gate receipt mismatch`);
  }
  digest(receipt.eventStreamSha256, `${task}/${arm} event stream`);
  const usageEventSha256 = digest(receipt.usageEventSha256, `${task}/${arm} usage event`);
  digest(receipt.usageProjectionSha256, `${task}/${arm} usage projection`);
  digest(receipt.answerSha256, `${task}/${arm} answer`);
  if (!Array.isArray(receipt.trace) || receipt.trace.length === 0) fail(`${task}/${arm} trace missing`);
  const commandTraceHashes = new Set<string>();
  const outputTraceHashes = new Set<string>();
  const commandOutputPairs = new Set<string>();
  const traceReadPaths = new Set<string>();
  const startedCommandIds = new Set<string>();
  const completedCommandIds = new Set<string>();
  let startedCommands = 0;
  let usageEventPresent = false;
  let traceUsage: { readonly input: number; readonly cached: number; readonly output: number } | null = null;
  for (const entry of receipt.trace) {
    if (!record(entry) || typeof entry.type !== "string" ||
        !["thread.started", "turn.started", "turn.completed", "item.started", "item.completed", "error", "other"].includes(entry.type)) {
      fail(`${task}/${arm} invalid trace entry`);
    }
    exactKeys(entry, ["type", "eventSha256", "itemType", "itemIdSha256", "commandSha256", "outputSha256", "readPathSha256s", "usage"]
      .filter((key) => entry[key] !== undefined), `${task}/${arm}/trace entry`);
    const eventSha256 = digest(entry.eventSha256, `${task}/${arm} trace event`);
    if (entry.type === "turn.completed" && eventSha256 === usageEventSha256) usageEventPresent = true;
    if (entry.usage !== undefined) {
      if (!record(entry.usage) || entry.type !== "turn.completed" || eventSha256 !== usageEventSha256) {
        fail(`${task}/${arm} invalid trace usage projection`);
      }
      exactKeys(entry.usage, ["input", "cached", "output"], `${task}/${arm}/trace usage`);
      traceUsage = {
        input: finite(entry.usage.input, `${task}/${arm}/trace usage input`),
        cached: finite(entry.usage.cached, `${task}/${arm}/trace usage cached`),
        output: finite(entry.usage.output, `${task}/${arm}/trace usage output`),
      };
    }
    if (entry.itemType !== undefined && !["command_execution", "agent_message", "reasoning", "other"].includes(String(entry.itemType))) {
      fail(`${task}/${arm} invalid item type`);
    }
    const itemIdSha256 = entry.itemIdSha256 === undefined ? undefined
      : digest(entry.itemIdSha256, `${task}/${arm}/itemId`);
    if (entry.type === "item.started" && entry.itemType === "command_execution") {
      startedCommands++;
      if (itemIdSha256 !== undefined) startedCommandIds.add(itemIdSha256);
    }
    if (entry.type === "item.completed" && entry.itemType === "command_execution" && itemIdSha256 !== undefined) {
      completedCommandIds.add(itemIdSha256);
    }
    if ((entry.commandSha256 === undefined) !== (entry.outputSha256 === undefined)) {
      fail(`${task}/${arm} incomplete command trace`);
    }
    if (entry.commandSha256 !== undefined) {
      const commandSha256 = digest(entry.commandSha256, `${task}/${arm} trace command`);
      const outputSha256 = digest(entry.outputSha256, `${task}/${arm} trace output`);
      commandTraceHashes.add(commandSha256);
      outputTraceHashes.add(outputSha256);
      commandOutputPairs.add(`${commandSha256}:${outputSha256}`);
    }
    if (entry.readPathSha256s !== undefined) {
      if (entry.type !== "item.completed" || entry.itemType !== "command_execution" || entry.commandSha256 === undefined) {
        fail(`${task}/${arm} read paths are not bound to a completed command`);
      }
      const readPaths = digests(entry.readPathSha256s, `${task}/${arm}/traceRead`);
      if (new Set(readPaths).size !== readPaths.length || JSON.stringify(readPaths) !== JSON.stringify([...readPaths].sort())) {
        fail(`${task}/${arm} invalid trace read paths`);
      }
      for (const readPath of readPaths) traceReadPaths.add(readPath);
    }
  }
  if (!usageEventPresent || traceUsage === null || startedCommands !== receipt.commands ||
      [...completedCommandIds].some((id) => !startedCommandIds.has(id)) ||
      digest(receipt.traceRootSha256, `${task}/${arm} trace root`) !== sha256(JSON.stringify(receipt.trace))) {
    fail(`${task}/${arm} trace commitment mismatch`);
  }
  if (!record(receipt.score) || !Array.isArray(receipt.expectedReadPathSha256s) ||
      !Array.isArray(receipt.directReadPathSha256s) || !Array.isArray(receipt.score.reportedPathSha256s)) {
    fail(`${task}/${arm} score or direct-read commitments missing`);
  }
  const expectedReadPaths = receipt.expectedReadPathSha256s.map((entry, index) =>
    digest(entry, `${task}/${arm}/expectedRead/${index}`));
  const directReadPaths = receipt.directReadPathSha256s.map((entry, index) =>
    digest(entry, `${task}/${arm}/directRead/${index}`));
  const reportedReadPaths = receipt.score.reportedPathSha256s.map((entry, index) =>
    digest(entry, `${task}/${arm}/reportedRead/${index}`));
  const expectedFixturePaths = expectedByTask[task]!.paths.map((entry) => sha256(`path:${entry}`)).sort();
  const directReadPathSet = new Set(directReadPaths);
  const directReadsValid = reportedReadPaths.every((entry) => directReadPathSet.has(entry));
  for (const entries of [expectedReadPaths, directReadPaths, reportedReadPaths]) {
    if (new Set(entries).size !== entries.length || JSON.stringify(entries) !== JSON.stringify([...entries].sort())) {
      fail(`${task}/${arm} unordered or duplicate read commitments`);
    }
  }
  if (JSON.stringify(expectedReadPaths) !== JSON.stringify(expectedFixturePaths) ||
      JSON.stringify(directReadPaths) !== JSON.stringify([...traceReadPaths].sort()) ||
      receipt.directReadsValid !== directReadsValid || value.directReadsValid !== directReadsValid) {
    fail(`${task}/${arm} direct-read proof mismatch`);
  }

  for (const field of [
    "exitCode", "elapsedMs", "commands", "inputTokens", "cachedInputTokens", "freshInputTokens", "outputTokens",
    "pathRecall", "factRecall", "recall", "expectedPaths", "matchedPaths", "expectedFacts", "matchedFacts",
  ]) finite(value[field], `${task}/${arm}/${field}`);
  if (!record(receipt.usage)) fail(`${task}/${arm} receipt usage missing`);
  exactKeys(receipt.usage, ["input", "cached", "output"], `${task}/${arm}/usage`);
  const usage = {
    input: finite(receipt.usage.input, `${task}/${arm}/usage.input`),
    cached: finite(receipt.usage.cached, `${task}/${arm}/usage.cached`),
    output: finite(receipt.usage.output, `${task}/${arm}/usage.output`),
  };
  if (receipt.exitCode !== value.exitCode || receipt.elapsedMs !== value.elapsedMs || receipt.commands !== value.commands ||
      usage.input !== value.inputTokens || usage.cached !== value.cachedInputTokens || usage.output !== value.outputTokens ||
      JSON.stringify(traceUsage) !== JSON.stringify(usage) ||
      receipt.usageProjectionSha256 !== sha256(JSON.stringify(usage)) ||
      value.freshInputTokens !== usage.input - usage.cached) fail(`${task}/${arm} usage receipt mismatch`);
  if (value.exitCode !== 0 || (value.inputTokens as number) <= 0 || (value.outputTokens as number) <= 0) {
    fail(`${task}/${arm} invalid exit or usage`);
  }

  if (!record(value.providerCalls) || !record(receipt.provider) || !record(receipt.provider.calls) ||
      !Array.isArray(receipt.provider.observations)) fail(`${task}/${arm} provider proof missing`);
  exactKeys(value.providerCalls, ["graph", "context"], `${task}/${arm}/summary provider calls`);
  exactKeys(receipt.provider.calls, ["graph", "context"], `${task}/${arm}/receipt provider calls`);
  exactKeys(receipt.provider, [
    "calls", "observations", "valid", "commandSha256", "requestSha256", "resultSha256", "resultBytes",
    "resultSchema", "resultStatus", "resultFreshness",
  ], `${task}/${arm}/provider`);
  const observations = receipt.provider.observations.map((observation, index) => {
    if (!record(observation) || (observation.kind !== "graph" && observation.kind !== "context") ||
        typeof observation.contractValid !== "boolean" || typeof observation.commandObserved !== "boolean" ||
        typeof observation.traceBound !== "boolean") {
      fail(`${task}/${arm} invalid provider observation ${index}`);
    }
    exactKeys(observation, [
      "kind", "contractValid", "commandObserved", "traceBound", "commandSha256", "requestSha256", "resultSha256",
      "resultBytes", "resultSchema", "resultStatus", "resultFreshness",
    ], `${task}/${arm}/observation/${index}`);
    const projected = {
      kind: observation.kind,
      contractValid: observation.contractValid,
      commandObserved: observation.commandObserved,
      traceBound: observation.traceBound,
      commandSha256: digest(observation.commandSha256, `${task}/${arm}/observation/${index}/command`),
      requestSha256: digest(observation.requestSha256, `${task}/${arm}/observation/${index}/request`),
      resultSha256: digest(observation.resultSha256, `${task}/${arm}/observation/${index}/result`),
      resultBytes: finite(observation.resultBytes, `${task}/${arm}/observation/${index}/bytes`),
      resultSchema: observation.resultSchema,
      resultStatus: observation.resultStatus,
      resultFreshness: observation.resultFreshness,
    };
    if (!Number.isInteger(projected.resultBytes) || projected.resultBytes < 0 ||
        (projected.traceBound && !commandOutputPairs.has(`${projected.commandSha256}:${projected.resultSha256}`))) {
      fail(`${task}/${arm} unbound provider observation ${index}`);
    }
    if ((projected.kind === "graph" && projected.resultSchema !== "graph-v2") ||
        (projected.kind === "context" && projected.resultSchema !== "context-v1") ||
        typeof projected.resultStatus !== "string" || typeof projected.resultFreshness !== "string") {
      fail(`${task}/${arm} invalid provider observation projection ${index}`);
    }
    return projected;
  });
  const recomputedCalls = {
    graph: observations.filter((observation) => observation.kind === "graph").length,
    context: observations.filter((observation) => observation.kind === "context").length,
  };
  same(receipt.provider.calls, recomputedCalls, `${task}/${arm}/provider receipt calls`);
  same(value.providerCalls, recomputedCalls, `${task}/${arm}/provider summary calls`);
  const graphCalls = finite(value.providerCalls.graph, `${task}/${arm}/graph calls`);
  const contextCalls = finite(value.providerCalls.context, `${task}/${arm}/context calls`);
  if (!Number.isInteger(graphCalls) || !Number.isInteger(contextCalls) || graphCalls < 0 || contextCalls < 0) {
    fail(`${task}/${arm} invalid provider call counts`);
  }
  const expectedCalls = arm === "control" ? { graph: 0, context: 0 }
    : arm === "graph" ? { graph: 1, context: 0 }
    : { graph: 0, context: 1 };
  const expectedKindObservation = arm === "control" ? undefined : observations.find((observation) => observation.kind === arm);
  const recomputedProviderValid = JSON.stringify(recomputedCalls) === JSON.stringify(expectedCalls) &&
    observations.every((observation) => observation.contractValid && observation.commandObserved && observation.traceBound) &&
    (arm === "control" || expectedKindObservation !== undefined);
  if (receipt.provider.valid !== recomputedProviderValid || value.providerContractValid !== recomputedProviderValid) {
    fail(`${task}/${arm} provider validity projection mismatch`);
  }
  const commitmentFields = ["commandSha256", "requestSha256", "resultSha256"] as const;
  const expectedKindObserved = arm !== "control" && finite(value.providerCalls[arm], `${task}/${arm}/expected calls`) > 0;
  if (expectedKindObserved && expectedKindObservation !== undefined) {
    for (const field of [
      "commandSha256", "requestSha256", "resultSha256", "resultBytes", "resultSchema", "resultStatus", "resultFreshness",
    ] as const) same(receipt.provider[field], expectedKindObservation[field], `${task}/${arm}/selected provider/${field}`);
  }
  if (!expectedKindObserved) {
    for (const field of commitmentFields) if (receipt.provider[field] !== null) fail(`${task}/${arm} unexpected ${field}`);
    for (const field of ["resultSchema", "resultStatus", "resultFreshness"]) {
      if (receipt.provider[field] !== null) fail(`${task}/${arm} unexpected ${field}`);
    }
    if (receipt.provider.resultBytes !== null || value.contextPackBytes !== null || receipt.contextPackBytes !== null) {
      fail(`${task}/${arm} unexpected provider result`);
    }
  } else {
    for (const field of commitmentFields) digest(receipt.provider[field], `${task}/${arm}/${field}`);
    if (expectedKindObservation?.traceBound === true &&
        (!commandTraceHashes.has(receipt.provider.commandSha256 as string) ||
         !outputTraceHashes.has(receipt.provider.resultSha256 as string))) {
      fail(`${task}/${arm} provider command or result is not bound to the event trace`);
    }
    const resultBytes = finite(receipt.provider.resultBytes, `${task}/${arm}/resultBytes`);
    if (!Number.isInteger(resultBytes) || resultBytes < 0) fail(`${task}/${arm} invalid provider result bytes`);
    if (arm === "context") {
      if (receipt.provider.resultSchema !== "context-v1" || value.contextPackBytes !== resultBytes ||
          receipt.contextPackBytes !== resultBytes) fail(`${task}/${arm} Context Pack projection mismatch`);
      if (receipt.provider.valid === true && (receipt.provider.resultStatus !== "ok" ||
          receipt.provider.resultFreshness !== "fresh" || resultBytes <= 0 || resultBytes > 4096)) {
        fail(`${task}/${arm} valid Context Pack invariant mismatch`);
      }
    } else {
      if (receipt.provider.resultSchema !== "graph-v2" || receipt.provider.resultStatus !== "na" ||
          receipt.provider.resultFreshness !== "na" || value.contextPackBytes !== null ||
          receipt.contextPackBytes !== null) fail(`${task}/${arm} graph result projection mismatch`);
    }
  }

  const anchorPath = task === "ownership" ? "docs/architecture.md" : "docs/decisions.md";
  const anchorSha256 = sha256(`path:${anchorPath}`);
  const anchorIndex = receipt.trace.findIndex((entry) =>
    record(entry) && Array.isArray(entry.readPathSha256s) && entry.readPathSha256s.includes(anchorSha256));
  const selectedCommandSha256 = typeof receipt.provider.commandSha256 === "string" ? receipt.provider.commandSha256 : null;
  const providerIndex = selectedCommandSha256 === null ? -1 : receipt.trace.findIndex((entry) =>
    record(entry) && entry.commandSha256 === selectedCommandSha256);
  const anchorFirstValid = anchorIndex >= 0 && (arm === "control" || (providerIndex >= 0 && anchorIndex < providerIndex));
  if (receipt.anchorFirstValid !== anchorFirstValid || value.anchorFirstValid !== anchorFirstValid) {
    fail(`${task}/${arm} anchor ordering projection mismatch`);
  }

  const commandLimit = arm === "control" ? 4 : 5;
  if (!Number.isInteger(value.commands) || (value.commands as number) < 0) fail(`${task}/${arm} invalid command count`);
  const commandPolicyValid = (value.commands as number) >= 1 && (value.commands as number) <= commandLimit;
  if (receipt.commandPolicyValid !== commandPolicyValid || value.commandPolicyValid !== commandPolicyValid) {
    fail(`${task}/${arm} command policy projection mismatch`);
  }
  const fixtureExpected = expectedByTask[task]!;
  const expectedPaths = fixtureExpected.paths;
  const expectedFactEntries = Object.entries(fixtureExpected.facts);
  const expectedFactIds = expectedFactEntries.map(([id]) => id);
  const pathOccurrences = digests(receipt.score.reportedPathOccurrenceSha256s, `${task}/${arm}/pathOccurrences`);
  if (JSON.stringify(pathOccurrences) !== JSON.stringify([...pathOccurrences].sort())) {
    fail(`${task}/${arm} unordered path occurrences`);
  }
  const reportedPathSha256s = [...new Set(pathOccurrences)].sort();
  const expectedPathByHash = new Map(expectedPaths.map((entry) => [sha256(`path:${entry}`), entry]));
  const reportedPathSet = new Set(reportedPathSha256s);
  const missingPaths = expectedPaths.filter((entry) => !reportedPathSet.has(sha256(`path:${entry}`)));
  const extraPathSha256s = reportedPathSha256s.filter((entry) => !expectedPathByHash.has(entry));
  const duplicatePathCount = pathOccurrences.length - reportedPathSha256s.length;

  if (!Array.isArray(receipt.score.reportedFacts)) fail(`${task}/${arm} reported fact occurrences missing`);
  const reportedFacts = receipt.score.reportedFacts.map((fact, index) => {
    if (!record(fact) || typeof fact.id !== "string" ||
        (![
          "implementation", "dependency", "test", "package", "owner", "work", "check", "evidence", "maxBytes",
        ].includes(fact.id) && !/^other:[0-9a-f]{64}$/u.test(fact.id))) {
      fail(`${task}/${arm} invalid fact occurrence ${index}`);
    }
    exactKeys(fact, ["id", "valueSha256"], `${task}/${arm}/fact occurrence/${index}`);
    return { id: fact.id, valueSha256: digest(fact.valueSha256, `${task}/${arm}/factOccurrence/${index}`) };
  });
  if (JSON.stringify(reportedFacts) !== JSON.stringify([...reportedFacts].sort((left, right) =>
      left.id.localeCompare(right.id) || left.valueSha256.localeCompare(right.valueSha256)))) {
    fail(`${task}/${arm} unordered fact occurrences`);
  }
  const factsById = new Map<string, string[]>();
  for (const fact of reportedFacts) factsById.set(fact.id, [...(factsById.get(fact.id) ?? []), fact.valueSha256]);
  const missingFactIds = expectedFactIds.filter((id) => !factsById.has(id));
  const mismatchedFactIds = expectedFactEntries.filter(([id, expectedValue]) =>
    factsById.has(id) && !factsById.get(id)!.includes(sha256(expectedValue))).map(([id]) => id);
  const extraFactIds = [...factsById.keys()].filter((id) => !expectedFactIds.includes(id));
  const extraFactIdSha256s = extraFactIds.map((id) => sha256(`fact-id:${id}`)).sort();
  const duplicateFactIdCount = reportedFacts.length - factsById.size;
  const reportedFactSha256s = reportedFacts.map(({ id, valueSha256 }) => sha256(`fact:${id}\0${valueSha256}`)).sort();
  const matchedPaths = expectedPaths.length - missingPaths.length;
  const matchedFacts = expectedFactIds.length - missingFactIds.length - mismatchedFactIds.length;
  const limitationsCount = finite(receipt.score.limitationsCount, `${task}/${arm}/limitationsCount`);
  if (!Number.isInteger(limitationsCount) || limitationsCount < 0) fail(`${task}/${arm} invalid limitation count`);
  const pathRecall = matchedPaths / expectedPaths.length;
  const factRecall = matchedFacts / expectedFactIds.length;
  const recall = (matchedPaths + matchedFacts) / (expectedPaths.length + expectedFactIds.length);
  const reportedTask = receipt.score.reportedTask;
  if (reportedTask !== "ownership" && reportedTask !== "budget") fail(`${task}/${arm} invalid reported task`);
  const taskValid = reportedTask === task;
  const qualityValid = taskValid && missingPaths.length === 0 && missingFactIds.length === 0 &&
    mismatchedFactIds.length === 0 && extraPathSha256s.length === 0 && extraFactIdSha256s.length === 0 &&
    duplicatePathCount === 0 && duplicateFactIdCount === 0;
  const recomputedScore = {
    expectedPaths: expectedPaths.length, matchedPaths, expectedFacts: expectedFactIds.length, matchedFacts,
    missingPaths, missingFactIds, mismatchedFactIds, extraPathSha256s, extraFactIdSha256s,
    reportedPathSha256s, reportedPathOccurrenceSha256s: pathOccurrences, reportedFacts, reportedFactSha256s,
    duplicatePathCount, duplicateFactIdCount, limitationsCount, reportedTask, taskValid, qualityValid,
    pathRecall, factRecall, recall,
  };
  same(Object.keys(receipt.score).sort(), Object.keys(recomputedScore).sort(), `${task}/${arm}/score keys`);
  for (const [field, projected] of Object.entries(recomputedScore)) {
    same(receipt.score[field], projected, `${task}/${arm}/recomputed score/${field}`);
    same(value[field], projected, `${task}/${arm}/score/${field}`);
  }
  exactKeys(value, [
    "task", "arm", "trial", "exitCode", "elapsedMs", "commands", "inputTokens", "cachedInputTokens",
    "freshInputTokens", "outputTokens", "contextPackBytes", "providerCalls", "providerContractValid",
    "directReadsValid", "anchorFirstValid", "commandPolicyValid", "receipt", ...Object.keys(recomputedScore),
  ], `${task}/${arm}/summary run`);
  return value as typeof value & { task: "ownership" | "budget"; arm: "control" | "graph" | "context" };
});

const keys = new Set(runs.map((run) => `${run.trial}/${run.task}/${run.arm}`));
if (keys.size !== 18) fail("trial, task, and arm tuples must be unique");
const meanFresh = (arm: "control" | "graph" | "context"): number => {
  const selected = runs.filter((run) => run.arm === arm);
  return selected.reduce((sum, run) => sum + (run.freshInputTokens as number), 0) / selected.length;
};
if (!record(raw.byArm)) fail("aggregate object missing");
exactKeys(raw.byArm, ["control", "graph", "context"], "aggregates");
for (const arm of ["control", "graph", "context"] as const) {
  if (!record(raw.byArm) || !record(raw.byArm[arm])) fail(`missing aggregate ${arm}`);
  exactKeys(raw.byArm[arm], ["meanRecall", "meanFreshInputTokens", "meanInputTokens"], `aggregate/${arm}`);
  const selected = runs.filter((run) => run.arm === arm);
  const expected = {
    meanRecall: selected.reduce((sum, run) => sum + (run.recall as number), 0) / selected.length,
    meanFreshInputTokens: meanFresh(arm),
    meanInputTokens: selected.reduce((sum, run) => sum + (run.inputTokens as number), 0) / selected.length,
  };
  for (const [field, projected] of Object.entries(expected)) {
    approximately(raw.byArm[arm][field], projected, `aggregate/${arm}/${field}`);
  }
}

const retained = `${JSON.stringify(raw)}\n${receiptContents.join("\n")}`;
for (const forbidden of [
  "prompt", "toolArguments", "toolResults", "sessionFile", "rawEvents", "providerQuery", "providerInput",
  "providerOutput", "commandText", "answerText", "eventStream",
]) {
  if (retained.includes(`"${forbidden}"`)) fail(`forbidden retained field: ${forbidden}`);
}

console.log(JSON.stringify({
  verified: true,
  runs: runs.length,
  receipts: receiptContents.length,
  meanFreshInput: {
    control: meanFresh("control"),
    graph: meanFresh("graph"),
    context: meanFresh("context"),
  },
  maxContextPackBytes: Math.max(...runs.filter((run) => run.arm === "context").map((run) => run.contextPackBytes as number)),
}));
