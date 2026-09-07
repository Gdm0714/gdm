#!/usr/bin/env bun
import { readFileSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createPilotFixture } from "../context-pack-pilot/fixture.ts";
import {
  type AcceptedSideRecord,
  type Arm,
  type Task,
  ARMS,
  MANIFEST_SCHEMA,
  PROTOCOL,
  RECEIPT_SCHEMA,
  SIDE_SCHEMA,
  SUMMARY_SCHEMA,
  acceptSideRecord,
  canonicalEventCommand,
  contextRequest,
  directoryManifest,
  fixtureManifest,
  graphRequest,
  isRecord,
  pathDigest,
  resolvePointer,
  sha256,
  taskAnchor,
} from "./protocol.ts";

const pointerArgument = process.argv[2];
if (process.argv.length !== 3 || pointerArgument === undefined) {
  console.error("usage: verify-e2e.ts <results/current.json>");
  process.exit(2);
}
const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../..");
const PILOT_RESULTS = join(ROOT, "bench/context-pack-pilot/results");
const HEX64 = /^[0-9a-f]{64}$/u;

function fail(message: string): never {
  throw new Error(`context-pack e2e verification failed: ${message}`);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) fail(`invalid digest ${label}`);
  return value;
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`mismatch ${label}`);
}

function readJson(path: string): Readonly<Record<string, unknown>> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(raw)) fail(`invalid JSON object ${basename(path)}`);
  return raw;
}

function sourceCommitment() {
  const files = {
    runnerSha256: "run-e2e.ts",
    protocolSha256: "protocol.ts",
    benchIoSha256: "bench-io.ts",
    verifierSha256: "verify-e2e.ts",
    assessorSha256: "assess-e2e.ts",
    staticCheckSha256: "static-check.ts",
  } as const;
  return {
    ...Object.fromEntries(Object.entries(files).map(([field, path]) => [field, sha256(readFileSync(join(HERE, path)))])),
    outputSchemaSha256: sha256(readFileSync(join(ROOT, "bench/context-pack-pilot/output.schema.json"))),
    fixtureSourceSha256: sha256(readFileSync(join(ROOT, "bench/context-pack-pilot/fixture.ts"))),
  };
}

const resolved = resolvePointer(pointerArgument);
const summaryPath = join(resolved.runDirectory, "summary.json");
const manifestPath = join(resolved.runDirectory, "MANIFEST.json");
const summaryBytes = readFileSync(summaryPath);
const manifestBytes = readFileSync(manifestPath);
if (sha256(summaryBytes) !== resolved.pointer.summarySha256 || sha256(manifestBytes) !== resolved.pointer.manifestSha256) {
  fail("pointer hash commitment");
}
const summary = readJson(summaryPath);
const manifest = readJson(manifestPath);
if (summary.schemaVersion !== SUMMARY_SCHEMA || summary.protocol !== PROTOCOL || summary.scale !== "smoke" ||
    summary.runId !== resolved.pointer.runId || summary.trialsPerTaskArm !== 3 ||
    summary.navigationStartPolicy !== "allowlisted-anchor-first" || summary.commandPolicy !== "allowlisted-io-only" ||
    summary.retention !== "hashes-metrics-structured-score-no-raw-body" ||
    summary.priorP1Conclusion !== "invalid-not-evidence-no-promotion" || summary.promotionEligible !== false ||
    summary.defaultActivation !== "blocked") fail("summary contract");
const expectedSource = sourceCommitment();
same(summary.source, expectedSource, "source commitment");
if (summary.sourceSha256 !== sha256(JSON.stringify(expectedSource))) fail("source aggregate hash");
if (!isRecord(summary.runtime) || summary.runtimeSha256 !== sha256(JSON.stringify(summary.runtime))) fail("runtime commitment");
for (const name of ["codex", "gdm", "bun"] as const) {
  const artifact = summary.runtime[name];
  if (!isRecord(artifact) || typeof artifact.path !== "string" || typeof artifact.version !== "string") fail(`runtime ${name}`);
  const real = realpathSync(artifact.path);
  const stat = lstatSync(real);
  if (!stat.isFile() || stat.isSymbolicLink() || digest(artifact.sha256, `runtime ${name}`) !== sha256(readFileSync(real))) {
    fail(`runtime bytes ${name}`);
  }
  const version = name === "bun" ? `Bun ${Bun.version}` : new TextDecoder().decode(Bun.spawnSync([real, "--version"], { stdout: "pipe" }).stdout).trim();
  if (version !== artifact.version) fail(`runtime version ${name}`);
}
for (const name of ["graph", "benchIo"] as const) {
  const artifact = summary.runtime[name];
  if (!isRecord(artifact) || typeof artifact.path !== "string" || artifact.path.startsWith("/") ||
      digest(artifact.sha256, `runtime ${name}`) !== sha256(readFileSync(join(ROOT, artifact.path)))) fail(`source runtime ${name}`);
}
if (summary.runtime.model !== "gpt-5.6-sol" || summary.runtime.reasoning !== "xhigh" || summary.runtime.sandbox !== "read-only" ||
    summary.runtime.ephemeral !== true || summary.runtime.userConfig !== "ignored" || summary.runtime.rules !== "ignored") {
  fail("runtime policy");
}
if (summary.pilotBaselineSha256 !== directoryManifest(PILOT_RESULTS)) fail("legacy pilot results changed");

const fixture = createPilotFixture();
let generatedFixture: ReturnType<typeof fixtureManifest>;
try {
  generatedFixture = fixtureManifest(fixture.root);
  if (summary.fixtureManifestSha256 !== generatedFixture.sha256 || summary.fixtureFileCount !== generatedFixture.entries.length ||
      summary.fixtureExpectedSha256 !== sha256(JSON.stringify(fixture.expected))) fail("fixture commitment");
} finally {
  rmSync(fixture.root, { recursive: true, force: true });
}
const pathByDigest = new Map(generatedFixture.entries.map((entry) => [entry.pathSha256, entry.path]));
const manifestByDigest = new Map(generatedFixture.entries.map((entry) => [entry.pathSha256, entry]));

if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.runId !== summary.runId || manifest.protocol !== PROTOCOL ||
    manifest.sourceSha256 !== summary.sourceSha256 || manifest.runtimeSha256 !== summary.runtimeSha256 ||
    manifest.fixtureManifestSha256 !== summary.fixtureManifestSha256 || !Array.isArray(manifest.artifacts)) fail("manifest contract");
const expectedArtifactNames = ["summary.json", ...((summary.runs as unknown[]) ?? []).map((run) => {
  if (!isRecord(run) || !isRecord(run.receipt) || typeof run.receipt.path !== "string") fail("summary receipt reference");
  return run.receipt.path;
})].sort();
const artifactNames: string[] = [];
for (const artifact of manifest.artifacts as unknown[]) {
  if (!isRecord(artifact) || typeof artifact.path !== "string" || artifact.path.startsWith("/") || artifact.path.includes("..") ||
      typeof artifact.bytes !== "number") fail("manifest artifact");
  const path = join(resolved.runDirectory, artifact.path);
  const bytes = readFileSync(path);
  if (digest(artifact.sha256, artifact.path) !== sha256(bytes) || artifact.bytes !== bytes.byteLength || (lstatSync(path).mode & 0o222) !== 0) {
    fail(`artifact bytes or mode ${artifact.path}`);
  }
  artifactNames.push(artifact.path);
}
same(artifactNames.sort(), expectedArtifactNames, "manifest artifact set");
if ((lstatSync(manifestPath).mode & 0o222) !== 0) fail("manifest is writable");

if (!Array.isArray(summary.runs) || summary.runs.length !== 18) fail("run count");
const tuples = new Set<string>();
const expectedFactsByTask = {
  ownership: fixture.expected.ownership.facts,
  budget: fixture.expected.budget.facts,
};
const recomputedRuns: Readonly<Record<string, unknown>>[] = [];
for (const run of summary.runs) {
  if (!isRecord(run) || !isRecord(run.receipt) || (run.task !== "ownership" && run.task !== "budget") ||
      !ARMS.includes(run.arm as Arm) || ![1, 2, 3].includes(run.trial as number)) fail("run identity");
  const task = run.task as Task;
  const arm = run.arm as Arm;
  const trial = run.trial as 1 | 2 | 3;
  const tuple = `${task}/${arm}/${trial}`;
  if (tuples.has(tuple)) fail(`duplicate tuple ${tuple}`);
  tuples.add(tuple);
  if (typeof run.receipt.path !== "string" || run.receipt.path !== `receipts/${task}-${arm}-t${trial}.json`) fail(`receipt path ${tuple}`);
  const receiptPath = join(resolved.runDirectory, run.receipt.path);
  const receiptBytes = readFileSync(receiptPath);
  if (digest(run.receipt.sha256, `${tuple} receipt`) !== sha256(receiptBytes)) fail(`receipt hash ${tuple}`);
  const receipt = readJson(receiptPath);
  if (receipt.schemaVersion !== RECEIPT_SCHEMA || receipt.protocol !== PROTOCOL || receipt.runId !== summary.runId ||
      receipt.task !== task || receipt.arm !== arm || receipt.trial !== trial || receipt.sourceSha256 !== summary.sourceSha256 ||
      receipt.runtimeSha256 !== summary.runtimeSha256 || receipt.fixtureManifestSha256 !== summary.fixtureManifestSha256) fail(`receipt identity ${tuple}`);
  if (!Array.isArray(receipt.trace) || receipt.traceSha256 !== sha256(JSON.stringify(receipt.trace)) || !isRecord(receipt.usage) ||
      receipt.usageProjectionSha256 !== sha256(JSON.stringify(receipt.usage)) || receipt.usageEventCount !== 1 ||
      typeof receipt.usageEventSha256 !== "string" || !HEX64.test(receipt.usageEventSha256)) fail(`event commitment ${tuple}`);
  const commandTrace = receipt.trace.filter((entry): entry is Readonly<Record<string, unknown>> =>
    isRecord(entry) && entry.type === "item.completed" && entry.itemType === "command_execution");
  for (const command of commandTrace) {
    digest(command.commandSha256, `${tuple} command`);
    digest(command.outputSha256, `${tuple} output`);
    if (!Number.isInteger(command.exitCode)) fail(`command exit ${tuple}`);
  }
  if (!Array.isArray(receipt.sideRecords) || !Array.isArray(receipt.bindings)) fail(`side records ${tuple}`);
  const records: AcceptedSideRecord[] = [];
  for (const [index, projected] of receipt.sideRecords.entries()) {
    if (!isRecord(projected) || projected.seq !== index + 1) fail(`side sequence ${tuple}`);
    const { seq: _seq, ...withoutSeq } = projected;
    const accepted = acceptSideRecord({
      schemaVersion: SIDE_SCHEMA,
      runToken: "b".repeat(32),
      ...withoutSeq,
    }, { runToken: "b".repeat(32), arm, nextSeq: index + 1 });
    if (accepted === null) fail(`side schema ${tuple}`);
    records.push(accepted);
  }
  const bindings = records.map((record) => {
    const canonical = canonicalEventCommand(record, pathByDigest);
    const expectedCommandSha256 = canonical === null ? null : sha256(canonical);
    const commandIndex = commandTrace.findIndex((command) => command.receiptSeq === record.seq);
    const command = commandIndex < 0 ? null : commandTrace[commandIndex]!;
    return {
      seq: record.seq,
      commandIndex,
      commandSha256: command?.commandSha256 ?? null,
      commandOutputSha256: command?.outputSha256 ?? null,
      bodyOutputSha256: record.outputSha256,
      expectedCommandSha256,
      valid: command !== null && expectedCommandSha256 !== null && command.commandSha256 === expectedCommandSha256 &&
        command.exitCode === record.exitCode,
    };
  });
  same(receipt.bindings, bindings, `${tuple} bindings`);
  const commandPolicyValid = receipt.rejectedSideRecordCount === 0 && commandTrace.length === records.length &&
    bindings.every((binding) => binding.valid) && new Set(bindings.map((binding) => binding.commandIndex)).size === bindings.length &&
    commandTrace.length >= 1 && commandTrace.length <= (arm === "control" ? 4 : 5) &&
    receipt.trace.every((entry) => !isRecord(entry) || entry.itemType !== "other");
  const directFiles = records.filter((record) => record.op === "anchor" || record.op === "read").flatMap((record) => record.files);
  const directSet = new Set(directFiles.filter((file) => {
    const expected = manifestByDigest.get(file.pathSha256);
    return expected !== undefined && expected.contentSha256 === file.contentSha256 && expected.bytes === file.bytes;
  }).map((file) => file.pathSha256));
  const reported = Array.isArray(receipt.reportedReadPathSha256s)
    ? receipt.reportedReadPathSha256s.map((value) => digest(value, `${tuple} reported path`)).sort() : fail(`reported reads ${tuple}`);
  const directReadsValid = reported.every((value) => directSet.has(value));
  const expectedReadPaths = fixture.expected[task].paths.map(pathDigest).sort();
  same(receipt.expectedReadPathSha256s, expectedReadPaths, `${tuple} expected reads`);
  same(receipt.directReadPathSha256s, [...directSet].sort(), `${tuple} direct reads`);
  const first = records[0];
  const providers = records.filter((record) => record.op === "provider");
  const anchorDigest = pathDigest(taskAnchor(task).path);
  const anchorFirstValid = first?.op === "anchor" && first.task === task && first.argvPathSha256s.length === 1 &&
    first.argvPathSha256s[0] === anchorDigest && first.files.length === 1 && first.files[0]?.pathSha256 === anchorDigest &&
    (arm === "control" || (providers.length === 1 && first.seq < providers[0]!.seq));
  const providerCalls = {
    graph: providers.filter((record) => record.providerKind === "graph").length,
    context: providers.filter((record) => record.providerKind === "context").length,
  };
  const expectedCalls = arm === "control" ? { graph: 0, context: 0 }
    : arm === "graph" ? { graph: 1, context: 0 } : { graph: 0, context: 1 };
  const selected = arm === "control" ? undefined : providers[0];
  const semanticRequest = arm === "control" ? null : arm === "graph" ? graphRequest("$FIXTURE_ROOT", task) : contextRequest("$FIXTURE_ROOT", task);
  const providerContractValid = providerCalls.graph === expectedCalls.graph && providerCalls.context === expectedCalls.context &&
    (arm === "control" || (selected !== undefined && selected.task === task && selected.arm === arm && selected.exitCode === 0 &&
      selected.requestProjectionSha256 === sha256(`${JSON.stringify(semanticRequest)}\n`) && typeof selected.requestSha256 === "string" &&
      (arm === "graph" ? selected.resultSchema === "graph-v2" && selected.resultStatus === "na" && selected.resultFreshness === "na"
        : selected.resultSchema === "context-v1" && selected.resultStatus === "ok" && selected.resultFreshness === "fresh" &&
          selected.outputBytes > 0 && selected.outputBytes <= 4096)));
  const contextPackBytes = arm === "context" ? selected?.outputBytes ?? null : null;
  const input = Number(receipt.usage.input);
  const cached = Number(receipt.usage.cached);
  const output = Number(receipt.usage.output);
  const usageValid = Number.isFinite(input) && input > 0 && Number.isFinite(cached) && cached >= 0 && cached <= input &&
    Number.isFinite(output) && output > 0;
  if (!isRecord(receipt.score) || !Array.isArray(receipt.score.reportedFacts)) fail(`score projection ${tuple}`);
  const expectedFacts = expectedFactsByTask[task];
  const expectedFactProjection = Object.entries(expectedFacts).map(([id, value]) => ({ id, valueSha256: sha256(value) }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.valueSha256.localeCompare(right.valueSha256));
  const qualityValid = JSON.stringify([...reported].sort()) === JSON.stringify(expectedReadPaths) &&
    JSON.stringify(receipt.score.reportedFacts) === JSON.stringify(expectedFactProjection) &&
    receipt.score.duplicatePathCount === 0 && receipt.score.duplicateFactIdCount === 0 && receipt.score.taskValid === true;
  const recall = (Number(receipt.score.matchedPaths) + Number(receipt.score.matchedFacts)) /
    (expectedReadPaths.length + Object.keys(expectedFacts).length);
  const measurementValid = commandPolicyValid && directReadsValid && anchorFirstValid && providerContractValid && usageValid && qualityValid &&
    (arm !== "context" || (contextPackBytes !== null && contextPackBytes <= 4096));
  for (const [field, value] of Object.entries({ commandPolicyValid, directReadsValid, anchorFirstValid, providerContractValid, usageValid, qualityValid, measurementValid })) {
    if (receipt[field] !== value || run[field] !== value) fail(`${tuple} validity ${field}`);
  }
  same(receipt.providerCalls, providerCalls, `${tuple} provider calls receipt`);
  same(run.providerCalls, providerCalls, `${tuple} provider calls summary`);
  if (receipt.contextPackBytes !== contextPackBytes || run.contextPackBytes !== contextPackBytes || run.recall !== recall ||
      run.inputTokens !== input || run.cachedInputTokens !== cached || run.freshInputTokens !== Math.max(0, input - cached) ||
      run.outputTokens !== output || run.commandCount !== commandTrace.length || run.exitCode !== receipt.exitCode || run.elapsedMs !== receipt.elapsedMs) {
    fail(`summary projection ${tuple}`);
  }
  recomputedRuns.push({ task, arm, trial, measurementValid, recall, freshInputTokens: Math.max(0, input - cached) });
}
if (tuples.size !== 18) fail("tuple set");

const indexPath = join(dirname(resolved.pointerPath), "index.jsonl");
const index = readFileSync(indexPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
const started = index.find((entry) => isRecord(entry) && entry.runId === summary.runId && entry.event === "started");
const completed = index.find((entry) => isRecord(entry) && entry.runId === summary.runId && entry.event === "completed");
if (!isRecord(started) || !isRecord(completed) || started.protocol !== PROTOCOL || started.sourceSha256 !== summary.sourceSha256 ||
    started.runtimeSha256 !== summary.runtimeSha256 || started.fixtureManifestSha256 !== summary.fixtureManifestSha256 ||
    completed.completedRuns !== 18 || completed.summarySha256 !== sha256(summaryBytes) || completed.manifestSha256 !== sha256(manifestBytes)) {
  fail("append-only index commitment");
}

console.log(JSON.stringify({
  verified: true,
  runId: summary.runId,
  runs: recomputedRuns.length,
  validRuns: recomputedRuns.filter((run) => run.measurementValid).length,
  pilotBaselinePreserved: true,
  promotionEligible: false,
  defaultActivation: "blocked",
}));
