#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createPilotFixture } from "../context-pack-pilot/fixture.ts";
import {
  type AcceptedSideRecord,
  type Arm,
  type FinalAnswer,
  type Task,
  type Usage,
  ARMS,
  MANIFEST_SCHEMA,
  POINTER_SCHEMA,
  PROTOCOL,
  RECEIPT_SCHEMA,
  SUMMARY_SCHEMA,
  canonicalEventCommand,
  contextRequest,
  decodeSideEnvelope,
  directoryManifest,
  fixtureManifest,
  graphRequest,
  isRecord,
  pathDigest,
  scoreAnswer,
  sha256,
  taskAnchor,
} from "./protocol.ts";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../..");
const CODEX = "/opt/homebrew/bin/codex";
const APPROVED_CODEX_SHA256 = "8194ea3181f330e63023b234b0b231855e5874e0331c5ef7cbc490591497a7bf";
const APPROVED_CODEX_VERSION = "codex-cli 0.152.1";
const INSTALLED_GDM = resolve(process.env.HOME ?? "", ".local/bin/gdm");
const GRAPH = join(ROOT, "cli/src/graph-nav-provider.ts");
const BENCH_IO = join(HERE, "bench-io.ts");
const OUTPUT_SCHEMA = join(ROOT, "bench/context-pack-pilot/output.schema.json");
const FIXTURE_SOURCE = join(ROOT, "bench/context-pack-pilot/fixture.ts");
const PILOT_RESULTS = join(ROOT, "bench/context-pack-pilot/results");
const RESULTS = join(HERE, "results");
const RUNS = join(RESULTS, "runs");
const INDEX = join(RESULTS, "index.jsonl");
const CURRENT = join(RESULTS, "current-v2.json");
const MODEL = "gpt-5.6-sol";
const REASONING = "xhigh";

interface TraceEntry {
  readonly type: string;
  readonly eventSha256: string;
  readonly itemType?: string;
  readonly itemIdSha256?: string;
  readonly commandSha256?: string;
  readonly outputSha256?: string;
  readonly exitCode?: number;
  readonly usage?: Usage;
  readonly receiptSeq?: number;
}

interface EventEvidence {
  readonly usage: Usage;
  readonly usageEventSha256: string;
  readonly usageEventCount: number;
  readonly streamSha256: string;
  readonly traceSha256: string;
  readonly trace: readonly TraceEntry[];
  readonly commands: readonly { readonly commandSha256: string; readonly outputSha256: string; readonly exitCode: number; readonly receiptSeq: number | null }[];
  readonly sideRecords: readonly AcceptedSideRecord[];
  readonly rejectedSideRecordCount: number;
  readonly unknownItemCount: number;
}

interface RunResult {
  readonly task: Task;
  readonly arm: Arm;
  readonly trial: 1 | 2 | 3;
  readonly exitCode: number;
  readonly elapsedMs: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly freshInputTokens: number;
  readonly outputTokens: number;
  readonly commandCount: number;
  readonly providerCalls: { readonly graph: number; readonly context: number };
  readonly contextPackBytes: number | null;
  readonly providerContractValid: boolean;
  readonly directReadsValid: boolean;
  readonly anchorFirstValid: boolean;
  readonly commandPolicyValid: boolean;
  readonly usageValid: boolean;
  readonly qualityValid: boolean;
  readonly measurementValid: boolean;
  readonly recall: number;
  readonly receipt: { readonly path: string; readonly sha256: string };
}

function executableVersion(path: string): string {
  const outcome = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (outcome.exitCode !== 0) throw new Error(`cannot identify runtime ${basename(path)}`);
  return new TextDecoder().decode(outcome.stdout).trim();
}

function runtimeArtifact(path: string, version: string) {
  const real = realpathSync(path);
  const stat = lstatSync(real);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe runtime artifact ${basename(path)}`);
  return { path: real, sha256: sha256(readFileSync(real)), version };
}

function sourceArtifact(path: string, version: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe source artifact ${basename(path)}`);
  return { path: relative(ROOT, path).replaceAll("\\", "/"), sha256: sha256(readFileSync(path)), version };
}

const RUNTIME = {
  codex: runtimeArtifact(CODEX, executableVersion(CODEX)),
  gdm: runtimeArtifact(INSTALLED_GDM, executableVersion(INSTALLED_GDM)),
  graph: sourceArtifact(GRAPH, "gdm-graph-result-v2-source"),
  benchIo: sourceArtifact(BENCH_IO, "allowlisted-benchmark-io-v1"),
  bun: runtimeArtifact(process.execPath, `Bun ${Bun.version}`),
  model: MODEL,
  reasoning: REASONING,
  sandbox: "read-only",
  ephemeral: true,
  userConfig: "ignored",
  rules: "ignored",
} as const;
if (RUNTIME.codex.sha256 !== APPROVED_CODEX_SHA256 || RUNTIME.codex.version !== APPROVED_CODEX_VERSION) {
  throw new Error("Codex runtime is not the approved executable");
}
const SOURCE = {
  runnerSha256: sha256(readFileSync(import.meta.path)),
  protocolSha256: sha256(readFileSync(join(HERE, "protocol.ts"))),
  benchIoSha256: sha256(readFileSync(BENCH_IO)),
  verifierSha256: sha256(readFileSync(join(HERE, "verify-e2e.ts"))),
  assessorSha256: sha256(readFileSync(join(HERE, "assess-e2e.ts"))),
  staticCheckSha256: sha256(readFileSync(join(HERE, "static-check.ts"))),
  outputSchemaSha256: sha256(readFileSync(OUTPUT_SCHEMA)),
  fixtureSourceSha256: sha256(readFileSync(FIXTURE_SOURCE)),
} as const;
const RUNTIME_SHA256 = sha256(JSON.stringify(RUNTIME));
const SOURCE_SHA256 = sha256(JSON.stringify(SOURCE));

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFrom(event: Readonly<Record<string, unknown>>): Usage | null {
  if (event.type !== "turn.completed" || !isRecord(event.usage)) return null;
  return {
    input: number(event.usage.input_tokens ?? event.usage.inputTokens),
    cached: number(event.usage.cached_input_tokens ?? event.usage.cachedInputTokens),
    output: number(event.usage.output_tokens ?? event.usage.outputTokens),
  };
}

async function consumeEvents(
  stream: ReadableStream<Uint8Array>,
  expected: { readonly nonce: string; readonly runToken: string; readonly arm: Arm },
): Promise<EventEvidence> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const streamHash = createHash("sha256");
  const trace: TraceEntry[] = [];
  const commands: { commandSha256: string; outputSha256: string; exitCode: number; receiptSeq: number | null }[] = [];
  const sideRecords: AcceptedSideRecord[] = [];
  let rejectedSideRecordCount = 0;
  let buffer = "";
  let usage: Usage = { input: 0, cached: 0, output: 0 };
  let usageEventSha256 = "";
  let usageEventCount = 0;
  let unknownItemCount = 0;
  const processLine = (line: string): void => {
    if (line.length === 0) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    if (!isRecord(raw)) return;
    const rawType = typeof raw.type === "string" ? raw.type : "unknown";
    const type = ["thread.started", "turn.started", "turn.completed", "item.started", "item.completed", "error"].includes(rawType)
      ? rawType : "other";
    const item = isRecord(raw.item) ? raw.item : undefined;
    const rawItemType = typeof item?.type === "string" ? item.type : undefined;
    const itemType = rawItemType === undefined ? undefined
      : ["command_execution", "agent_message", "reasoning"].includes(rawItemType) ? rawItemType : "other";
    if (itemType === "other") unknownItemCount++;
    const currentUsage = usageFrom(raw);
    const base: TraceEntry = {
      type,
      eventSha256: sha256(line),
      ...(itemType === undefined ? {} : { itemType }),
      ...(typeof item?.id === "string" ? { itemIdSha256: sha256(item.id) } : {}),
      ...(currentUsage === null ? {} : { usage: currentUsage }),
    };
    if (currentUsage !== null) {
      usage = currentUsage;
      usageEventSha256 = base.eventSha256;
      usageEventCount++;
    }
    if (type === "item.completed" && itemType === "command_execution" && item !== undefined) {
      const command = typeof item.command === "string" ? item.command : "";
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const exitCode = number(item.exit_code ?? item.exitCode);
      const decoded = decodeSideEnvelope(output, { ...expected, nextSeq: sideRecords.length + 1 });
      if (decoded === null) rejectedSideRecordCount++;
      else sideRecords.push(decoded.record);
      const projected = {
        commandSha256: sha256(command),
        outputSha256: sha256(output),
        exitCode,
        receiptSeq: decoded?.record.seq ?? null,
      };
      commands.push(projected);
      trace.push({
        ...base,
        commandSha256: projected.commandSha256,
        outputSha256: projected.outputSha256,
        exitCode: projected.exitCode,
        ...(projected.receiptSeq === null ? {} : { receiptSeq: projected.receiptSeq }),
      });
    } else {
      trace.push(base);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    streamHash.update(value);
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      processLine(buffer.slice(0, newline).replace(/\r$/u, ""));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  processLine(buffer.replace(/\r$/u, ""));
  return {
    usage,
    usageEventSha256,
    usageEventCount,
    streamSha256: streamHash.digest("hex"),
    traceSha256: sha256(JSON.stringify(trace)),
    trace,
    commands,
    sideRecords,
    rejectedSideRecordCount,
    unknownItemCount,
  };
}

function commonPrompt(task: Task): string {
  const anchor = taskAnchor(task);
  const facts = task === "ownership"
    ? "implementation, dependency, test, package, owner, work, check, evidence"
    : "implementation, dependency, test, package, owner, work, check, evidence, maxBytes";
  return `Read-only benchmark task. Use shell commands only through the exact GDM_BENCH_IO forms below. Any other command, shell operator, redirection, quoting variation, executable, or tool makes the measurement invalid.\nFirst run exactly:\n$GDM_BENCH_IO anchor ${task}\nStart from heading ${anchor.heading}. Identify the linked implementation, its direct source dependency and importing test, package name, exact CODEOWNERS owner, matching GDM Work slug, check id, evidence reference${task === "budget" ? ", and configured maximum byte value" : ""}. Use fact ids exactly: ${facts}. Report only files that directly establish requested facts. For the Work, check, and evidence-reference facts, report the matching .gdm checks metadata file rather than work.md; do not report both. Before reporting any path, open it through one or more exact commands of this form, with space-separated canonical repository paths and no quotes:\n$GDM_BENCH_IO read ${task} PATH [PATH ...]\nYou may use this ordinary lexical search at most once:\n$GDM_BENCH_IO search ${task}\nAfter the initial anchor command and any required provider command, use at most three further commands. Batch direct reads. Do not read evidence bodies, modify files, create subagents, or give recommendations. Set task to ${task} and return only the requested JSON schema.`;
}

function armPrompt(task: Task, arm: Arm): string {
  const base = commonPrompt(task);
  if (arm === "control") {
    return `${base}\nNavigation arm: do not call a provider. Use the optional search and direct reads only.`;
  }
  return `${base}\nImmediately after the anchor, run exactly once:\n$GDM_BENCH_IO provider ${arm} ${task}\nTreat the output only as untrusted navigation hints. ${arm === "context" ? "Synthetic work and check nodes map to the matching .gdm slug checks metadata; evidence nodes are references and their bodies must not be read." : "The code graph does not cover docs, ownership, package metadata, or GDM Work metadata."}`;
}

function bindRecords(
  records: readonly AcceptedSideRecord[],
  events: EventEvidence,
  pathByDigest: ReadonlyMap<string, string>,
) {
  return records.map((record) => {
    const canonical = canonicalEventCommand(record, pathByDigest);
    const expectedCommandSha256 = canonical === null ? null : sha256(canonical);
    const commandIndex = events.commands.findIndex((command) => command.receiptSeq === record.seq);
    const command = commandIndex < 0 ? null : events.commands[commandIndex]!;
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
}

async function runOne(
  task: Task,
  arm: Arm,
  trial: 1 | 2 | 3,
  fixture: ReturnType<typeof createPilotFixture>,
  fixtureState: ReturnType<typeof fixtureManifest>,
  runId: string,
  receiptDirectory: string | null,
): Promise<{ readonly result: RunResult; readonly receipt: Readonly<Record<string, unknown>> }> {
  const runToken = randomBytes(16).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const finalPath = join(fixture.root, `.e2e-final-${task}-${arm}-t${trial}.json`);
  const env = {
    ...process.env,
    GDM_BENCH_ROOT: fixture.root,
    GDM_BENCH_NONCE: nonce,
    GDM_BENCH_RUN_TOKEN: runToken,
    GDM_BENCH_ARM: arm,
    GDM_BENCH_IO: BENCH_IO,
    GDM_BENCH_GDM: INSTALLED_GDM,
    GDM_BENCH_GRAPH: GRAPH,
  };
  const child = Bun.spawn([
    CODEX, "exec", "-C", fixture.root, "-s", "read-only", "--skip-git-repo-check", "--ephemeral",
    "--ignore-user-config", "--ignore-rules", "-m", MODEL, "-c", `model_reasoning_effort=\"${REASONING}\"`,
    "--output-schema", OUTPUT_SCHEMA, "-o", finalPath, "--json", "-",
  ], {
    stdin: new TextEncoder().encode(armPrompt(task, arm)),
    stdout: "pipe",
    stderr: "pipe",
    env,
    detached: true,
  });
  const started = performance.now();
  const eventsPromise = consumeEvents(child.stdout, { nonce, runToken, arm });
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, 5_000);
  }, 600_000);
  const [rawExitCode, events, stderr] = await Promise.all([child.exited, eventsPromise, stderrPromise]);
  clearTimeout(timeout);
  if (killTimer !== null) clearTimeout(killTimer);
  const side = { records: events.sideRecords, rejected: events.rejectedSideRecordCount };
  const exitCode = timedOut ? 124 : rawExitCode;
  if (exitCode !== 0 || !existsSync(finalPath)) throw new Error(`codex ${task}/${arm}/t${trial} exited ${exitCode}: ${stderr.slice(-1000)}`);
  const answerBytes = readFileSync(finalPath);
  const answer = JSON.parse(new TextDecoder().decode(answerBytes)) as FinalAnswer;
  unlinkSync(finalPath);
  const currentFixture = fixtureManifest(fixture.root);
  if (currentFixture.sha256 !== fixtureState.sha256) throw new Error(`fixture changed during ${task}/${arm}/t${trial}`);
  const pathByDigest = new Map(fixtureState.entries.map((entry) => [entry.pathSha256, entry.path]));
  const manifestByDigest = new Map(fixtureState.entries.map((entry) => [entry.pathSha256, entry]));
  const bindings = bindRecords(side.records, events, pathByDigest);
  const commandPolicyValid = side.rejected === 0 && events.unknownItemCount === 0 && events.commands.length === side.records.length &&
    bindings.every((binding) => binding.valid) && new Set(bindings.map((binding) => binding.commandIndex)).size === bindings.length &&
    events.commands.length >= 1 && events.commands.length <= (arm === "control" ? 4 : 5);
  const scored = scoreAnswer(answer, fixture.expected[task]!);
  const directFiles = side.records.filter((record) => record.op === "anchor" || record.op === "read").flatMap((record) => record.files);
  const directReadSet = new Set(directFiles.filter((file) => {
    const expected = manifestByDigest.get(file.pathSha256);
    return expected !== undefined && expected.contentSha256 === file.contentSha256 && expected.bytes === file.bytes;
  }).map((file) => file.pathSha256));
  const directReadsValid = scored.reportedPathSha256s.every((digest) => directReadSet.has(digest));
  const anchorDigest = pathDigest(taskAnchor(task).path);
  const anchorRecord = side.records[0];
  const providers = side.records.filter((record) => record.op === "provider");
  const anchorFirstValid = anchorRecord?.op === "anchor" && anchorRecord.task === task &&
    anchorRecord.argvPathSha256s.length === 1 && anchorRecord.argvPathSha256s[0] === anchorDigest &&
    anchorRecord.files.length === 1 && anchorRecord.files[0]?.pathSha256 === anchorDigest &&
    (arm === "control" || (providers.length === 1 && anchorRecord.seq < providers[0]!.seq));
  const providerCalls = {
    graph: providers.filter((record) => record.providerKind === "graph").length,
    context: providers.filter((record) => record.providerKind === "context").length,
  };
  const expectedProvider = arm === "control" ? { graph: 0, context: 0 }
    : arm === "graph" ? { graph: 1, context: 0 }
    : { graph: 0, context: 1 };
  const selectedProvider = arm === "control" ? undefined : providers[0];
  const expectedRequest = arm === "control" ? null : arm === "graph" ? graphRequest(fixture.root, task) : contextRequest(fixture.root, task);
  const expectedRequestSha256 = expectedRequest === null ? null : sha256(`${JSON.stringify(expectedRequest)}\n`);
  const expectedRequestProjectionSha256 = expectedRequest === null ? null
    : sha256(`${JSON.stringify({ ...expectedRequest, root: "$FIXTURE_ROOT" })}\n`);
  const providerContractValid = providerCalls.graph === expectedProvider.graph && providerCalls.context === expectedProvider.context &&
    (arm === "control" || (selectedProvider !== undefined && selectedProvider.task === task && selectedProvider.arm === arm &&
      selectedProvider.requestSha256 === expectedRequestSha256 &&
      selectedProvider.requestProjectionSha256 === expectedRequestProjectionSha256 && selectedProvider.exitCode === 0 &&
      (arm === "graph"
        ? selectedProvider.resultSchema === "graph-v2" && selectedProvider.resultStatus === "na" && selectedProvider.resultFreshness === "na"
        : selectedProvider.resultSchema === "context-v1" && selectedProvider.resultStatus === "ok" && selectedProvider.resultFreshness === "fresh" &&
          selectedProvider.outputBytes > 0 && selectedProvider.outputBytes <= 4096)));
  const contextPackBytes = arm === "context" ? selectedProvider?.outputBytes ?? null : null;
  const usageValid = events.usageEventCount === 1 && events.usageEventSha256.length === 64 && events.usage.input > 0 &&
    events.usage.cached >= 0 && events.usage.cached <= events.usage.input && events.usage.output > 0;
  const measurementValid = commandPolicyValid && directReadsValid && anchorFirstValid && providerContractValid &&
    usageValid && scored.qualityValid && (arm !== "context" || (contextPackBytes !== null && contextPackBytes <= 4096));
  const elapsedMs = Math.round(performance.now() - started);
  const receiptPath = `receipts/${task}-${arm}-t${trial}.json`;
  const sanitizedRecords = side.records.map(({ schemaVersion, ...record }) => record);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    protocol: PROTOCOL,
    runId,
    task,
    arm,
    trial,
    sourceSha256: SOURCE_SHA256,
    runtimeSha256: RUNTIME_SHA256,
    fixtureManifestSha256: fixtureState.sha256,
    eventStreamSha256: events.streamSha256,
    usageEventSha256: events.usageEventSha256,
    usageEventCount: events.usageEventCount,
    usageProjectionSha256: sha256(JSON.stringify(events.usage)),
    traceSha256: events.traceSha256,
    trace: events.trace,
    sideRecords: sanitizedRecords,
    rejectedSideRecordCount: side.rejected,
    bindings,
    expectedReadPathSha256s: fixture.expected[task]!.paths.map(pathDigest).sort(),
    reportedReadPathSha256s: scored.reportedPathSha256s,
    directReadPathSha256s: [...directReadSet].sort(),
    commandPolicyValid,
    directReadsValid,
    anchorFirstValid,
    providerContractValid,
    usageValid,
    qualityValid: scored.qualityValid,
    measurementValid,
    providerCalls,
    contextPackBytes,
    exitCode,
    elapsedMs,
    usage: events.usage,
    answerSha256: sha256(answerBytes),
    score: scored,
  } as const;
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptSha256 = sha256(receiptBytes);
  if (receiptDirectory !== null) writeFileSync(join(receiptDirectory, basename(receiptPath)), receiptBytes, { flag: "wx", mode: 0o600 });
  return {
    result: {
      task,
      arm,
      trial,
      exitCode,
      elapsedMs,
      inputTokens: events.usage.input,
      cachedInputTokens: events.usage.cached,
      freshInputTokens: Math.max(0, events.usage.input - events.usage.cached),
      outputTokens: events.usage.output,
      commandCount: events.commands.length,
      providerCalls,
      contextPackBytes,
      providerContractValid,
      directReadsValid,
      anchorFirstValid,
      commandPolicyValid,
      usageValid,
      qualityValid: scored.qualityValid,
      measurementValid,
      recall: scored.recall,
      receipt: { path: receiptPath, sha256: receiptSha256 },
    },
    receipt,
  };
}

function removeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function appendIndex(value: Readonly<Record<string, unknown>>): void {
  mkdirSync(RESULTS, { recursive: true, mode: 0o700 });
  appendFileSync(INDEX, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const fd = openSync(INDEX, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

async function probe(arm: Arm, task: Task): Promise<void> {
  const fixture = createPilotFixture();
  const state = fixtureManifest(fixture.root);
  try {
    const run = await runOne(task, arm, 1, fixture, state, "00000000000000000000000000000000", null);
    console.log(JSON.stringify({ result: run.result, receipt: run.receipt }, null, 2));
  } finally {
    removeFixture(fixture.root);
  }
}

async function official(): Promise<void> {
  if (existsSync(CURRENT)) throw new Error("official e2e pointer already exists; tuple replacement is forbidden");
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });
  const runId = randomBytes(16).toString("hex");
  const runDirectory = join(RUNS, runId);
  mkdirSync(runDirectory, { recursive: false, mode: 0o700 });
  const receiptDirectory = join(runDirectory, "receipts");
  mkdirSync(receiptDirectory, { mode: 0o700 });
  const fixture = createPilotFixture();
  const fixtureState = fixtureManifest(fixture.root);
  const pilotBaselineSha256 = directoryManifest(PILOT_RESULTS);
  const started = {
    schemaVersion: "gdm-context-pack-e2e-index/v1",
    event: "started",
    runId,
    protocol: PROTOCOL,
    sourceSha256: SOURCE_SHA256,
    runtimeSha256: RUNTIME_SHA256,
    fixtureManifestSha256: fixtureState.sha256,
    at: new Date().toISOString(),
  } as const;
  appendIndex(started);
  const results: RunResult[] = [];
  try {
    const order: readonly [1 | 2 | 3, Task, readonly Arm[]][] = [
      [1, "ownership", ["control", "graph", "context"]],
      [1, "budget", ["context", "graph", "control"]],
      [2, "ownership", ["context", "control", "graph"]],
      [2, "budget", ["control", "context", "graph"]],
      [3, "ownership", ["graph", "context", "control"]],
      [3, "budget", ["graph", "control", "context"]],
    ];
    for (const [trial, task, arms] of order) {
      for (const arm of arms) {
        process.stderr.write(`e2e t${trial} ${task}/${arm}\n`);
        const run = await runOne(task, arm, trial, fixture, fixtureState, runId, receiptDirectory);
        results.push(run.result);
      }
    }
  } catch (error) {
    appendIndex({
      schemaVersion: "gdm-context-pack-e2e-index/v1",
      event: "failed",
      runId,
      completedRuns: results.length,
      errorSha256: sha256(error instanceof Error ? error.message : String(error)),
      at: new Date().toISOString(),
    });
    throw error;
  } finally {
    removeFixture(fixture.root);
  }
  const sorted = results.sort((left, right) => left.trial - right.trial || left.task.localeCompare(right.task) || left.arm.localeCompare(right.arm));
  const summary = {
    schemaVersion: SUMMARY_SCHEMA,
    protocol: PROTOCOL,
    scale: "smoke",
    runId,
    source: SOURCE,
    sourceSha256: SOURCE_SHA256,
    runtime: RUNTIME,
    runtimeSha256: RUNTIME_SHA256,
    fixtureManifestSha256: fixtureState.sha256,
    fixtureFileCount: fixtureState.entries.length,
    fixtureExpectedSha256: sha256(JSON.stringify(fixture.expected)),
    pilotBaselineSha256,
    generatedAt: new Date().toISOString(),
    trialsPerTaskArm: 3,
    navigationStartPolicy: "allowlisted-anchor-first",
    commandPolicy: "allowlisted-io-only",
    retention: "hashes-metrics-structured-score-no-raw-body",
    priorP1Conclusion: "invalid-not-evidence-no-promotion",
    promotionEligible: false,
    defaultActivation: "blocked",
    runs: sorted,
  } as const;
  const summaryBytes = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(join(runDirectory, "summary.json"), summaryBytes, { flag: "wx", mode: 0o600 });
  const artifactEntries = ["summary.json", ...sorted.map((run) => run.receipt.path)].map((path) => {
    const bytes = readFileSync(join(runDirectory, path));
    return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    runId,
    protocol: PROTOCOL,
    sourceSha256: SOURCE_SHA256,
    runtimeSha256: RUNTIME_SHA256,
    fixtureManifestSha256: fixtureState.sha256,
    artifacts: artifactEntries,
  } as const;
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(runDirectory, "MANIFEST.json"), manifestBytes, { flag: "wx", mode: 0o600 });
  for (const entry of [...artifactEntries.map((entry) => entry.path), "MANIFEST.json"]) chmodSync(join(runDirectory, entry), 0o444);
  const completed = {
    schemaVersion: "gdm-context-pack-e2e-index/v1",
    event: "completed",
    runId,
    completedRuns: sorted.length,
    summarySha256: sha256(summaryBytes),
    manifestSha256: sha256(manifestBytes),
    at: new Date().toISOString(),
  } as const;
  appendIndex(completed);
  const pointer = {
    schemaVersion: POINTER_SCHEMA,
    runId,
    runDirectory: `runs/${runId}`,
    manifestSha256: completed.manifestSha256,
    summarySha256: completed.summarySha256,
  } as const;
  writeFileSync(CURRENT, `${JSON.stringify(pointer, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  console.log(JSON.stringify(pointer));
}

const args = process.argv.slice(2);
if (args[0] === "--probe" && args.length === 3 && ARMS.includes(args[1] as Arm) && (args[2] === "ownership" || args[2] === "budget")) {
  await probe(args[1] as Arm, args[2] as Task);
} else if (args.length === 0) {
  await official();
} else {
  throw new Error("usage: run-e2e.ts [--probe control|graph|context ownership|budget]");
}
