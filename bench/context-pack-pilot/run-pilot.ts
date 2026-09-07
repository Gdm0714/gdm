#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createPilotFixture } from "./fixture.ts";

const HERE = import.meta.dir;
const GDM_ROOT = resolve(HERE, "../..");
const CODEX = "/opt/homebrew/bin/codex";
const APPROVED_CODEX_SHA256 = "8194ea3181f330e63023b234b0b231855e5874e0331c5ef7cbc490591497a7bf";
const APPROVED_CODEX_VERSION = "codex-cli 0.152.1";
const GDM = join(GDM_ROOT, "cli", "dist", "gdm");
const GRAPH = join(GDM_ROOT, "cli", "src", "graph-nav-provider.ts");
const SCHEMA = join(HERE, "output.schema.json");
const RECEIPTS = join(HERE, "results", "receipts");
const ATTEMPTS = join(HERE, "results", "attempts.jsonl");
const MODEL = "gpt-5.6-sol";
const ARMS = ["control", "graph", "context"] as const;
type Arm = typeof ARMS[number];
type Task = "ownership" | "budget";
const FACT_IDS = ["implementation", "dependency", "test", "package", "owner", "work", "check", "evidence", "maxBytes"] as const;

interface Usage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

interface ProviderMarker {
  readonly kind: "graph" | "context";
  readonly contractValid: boolean;
  readonly commandObserved: boolean;
  readonly traceBound: boolean;
  readonly commandSha256: string;
  readonly requestSha256: string;
  readonly resultSha256: string;
  readonly resultBytes: number;
  readonly resultSchema: "graph-v2" | "context-v1";
  readonly resultStatus: string;
  readonly resultFreshness: string;
}

interface TraceEntry {
  readonly type: string;
  readonly eventSha256: string;
  readonly itemType?: string;
  readonly itemIdSha256?: string;
  readonly commandSha256?: string;
  readonly outputSha256?: string;
  readonly readPathSha256s?: readonly string[];
  readonly usage?: Usage;
}

interface EventEvidence {
  readonly usage: Usage;
  readonly commands: number;
  readonly eventStreamSha256: string;
  readonly usageEventSha256: string;
  readonly traceRootSha256: string;
  readonly trace: readonly TraceEntry[];
  readonly expectedReadPathSha256s: readonly string[];
  readonly directReadPathSha256s: readonly string[];
  readonly completedCommands: readonly {
    readonly command: string;
    readonly output: string;
    readonly exitCode: number;
  }[];
}

interface FinalAnswer {
  readonly task: Task;
  readonly paths: readonly string[];
  readonly facts: readonly { readonly id: string; readonly value: string }[];
  readonly limitations: readonly string[];
}

interface RunResult {
  readonly task: Task;
  readonly arm: Arm;
  readonly trial: 1 | 2 | 3;
  readonly exitCode: number;
  readonly elapsedMs: number;
  readonly commands: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly freshInputTokens: number;
  readonly outputTokens: number;
  readonly contextPackBytes: number | null;
  readonly providerCalls: { readonly graph: number; readonly context: number };
  readonly providerContractValid: boolean;
  readonly directReadsValid: boolean;
  readonly anchorFirstValid: boolean;
  readonly commandPolicyValid: boolean;
  readonly receipt: { readonly path: string; readonly sha256: string };
  readonly pathRecall: number;
  readonly factRecall: number;
  readonly recall: number;
  readonly expectedPaths: number;
  readonly matchedPaths: number;
  readonly expectedFacts: number;
  readonly matchedFacts: number;
  readonly missingPaths: readonly string[];
  readonly missingFactIds: readonly string[];
  readonly mismatchedFactIds: readonly string[];
  readonly extraPathSha256s: readonly string[];
  readonly extraFactIdSha256s: readonly string[];
  readonly reportedPathSha256s: readonly string[];
  readonly reportedPathOccurrenceSha256s: readonly string[];
  readonly reportedFacts: readonly { readonly id: string; readonly valueSha256: string }[];
  readonly reportedFactSha256s: readonly string[];
  readonly duplicatePathCount: number;
  readonly duplicateFactIdCount: number;
  readonly limitationsCount: number;
  readonly reportedTask: Task | "other";
  readonly taskValid: boolean;
  readonly qualityValid: boolean;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function executableVersion(path: string, args: readonly string[]): string {
  const outcome = Bun.spawnSync([path, ...args], { stdout: "pipe", stderr: "pipe" });
  if (outcome.exitCode !== 0) throw new Error(`cannot identify runtime ${path}`);
  return new TextDecoder().decode(outcome.stdout).trim();
}

function artifact(path: string, version: string) {
  const real = realpathSync(path);
  const stat = lstatSync(real);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe runtime artifact ${path}`);
  return { path: real, sha256: sha256(readFileSync(real)), version };
}

const RUNTIME = {
  codex: artifact(CODEX, executableVersion(CODEX, ["--version"])),
  gdm: artifact(GDM, executableVersion(GDM, ["--version"])),
  graph: artifact(GRAPH, "gdm-graph-result-v2-source"),
  graphScanner: artifact(join(GDM_ROOT, "cli", "src", "graph-nav-scan.ts"), "shared-parser-source"),
  bun: artifact(process.execPath, `Bun ${Bun.version}`),
  model: MODEL,
  reasoning: "xhigh",
  sandbox: "read-only",
  ephemeral: true,
  userConfig: "ignored",
  rules: "ignored",
} as const;
if (RUNTIME.codex.sha256 !== APPROVED_CODEX_SHA256 || RUNTIME.codex.version !== APPROVED_CODEX_VERSION) {
  throw new Error("Codex runtime is not the approved pilot executable");
}
const RUNTIME_SHA256 = sha256(JSON.stringify(RUNTIME));
const RUNNER_SHA256 = sha256(readFileSync(join(HERE, "run-pilot.ts")));
const VERIFIER_SHA256 = sha256(readFileSync(join(HERE, "verify-results.ts")));
const ASSESSOR_SHA256 = sha256(readFileSync(join(HERE, "assess-results.ts")));
const OUTPUT_SCHEMA_SHA256 = sha256(readFileSync(SCHEMA));
const FIXTURE_SOURCE_SHA256 = sha256(readFileSync(join(HERE, "fixture.ts")));

function runStaticGate() {
  const command = [RUNTIME.bun.path, "test", "test/context-nav-adversarial.test.ts"] as const;
  const outcome = Bun.spawnSync(command, { cwd: join(GDM_ROOT, "cli"), stdout: "pipe", stderr: "pipe" });
  return {
    commandSha256: sha256(JSON.stringify(command)),
    testSourceSha256: sha256(readFileSync(join(GDM_ROOT, "cli", "test", "context-nav-adversarial.test.ts"))),
    exitCode: outcome.exitCode,
    passed: outcome.exitCode === 0,
  } as const;
}

const STATIC_GATE = runStaticGate();
const STATIC_GATE_SHA256 = sha256(JSON.stringify(STATIC_GATE));

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFrom(event: Readonly<Record<string, unknown>>): Usage | null {
  if (event.type !== "turn.completed" || !record(event.usage)) return null;
  return {
    input: number(event.usage.input_tokens ?? event.usage.inputTokens),
    cached: number(event.usage.cached_input_tokens ?? event.usage.cachedInputTokens),
    output: number(event.usage.output_tokens ?? event.usage.outputTokens),
  };
}

function taskAnchor(task: Task): { readonly path: string; readonly heading: string } {
  return task === "ownership"
    ? { path: "docs/architecture.md", heading: "Validation Ownership" }
    : { path: "docs/decisions.md", heading: "Token Budget Route" };
}

function contextRequest(root: string, task: Task) {
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

function graphRequest(root: string, task: Task) {
  return {
    schemaVersion: "gdm-graph-query/v1",
    root,
    entry: task === "ownership" ? "src/boundary.ts" : "src/router.ts",
    direction: "dependents",
    maxDepth: 2,
  } as const;
}

function graphCommand(task: Task): string {
  const anchor = taskAnchor(task).path;
  return `entry="$(grep -Eo '\\.\\./src/[A-Za-z0-9._/-]+' '${anchor}' | head -n 1 | sed 's#^\\.\\./##')"\nprintf '{"schemaVersion":"gdm-graph-query/v1","root":"%s","entry":"%s","direction":"dependents","maxDepth":2}\\n' "$PWD" "$entry" | "$GDM_GRAPH_PROVIDER" query`;
}

function contextCommand(root: string, task: Task): string {
  return `printf '%s\\n' '${JSON.stringify(contextRequest(root, task))}' | "$GDM_CONTEXT_PROVIDER" context query`;
}

function commonPrompt(task: Task): string {
  const anchor = taskAnchor(task);
  if (task === "ownership") {
    return `Read-only benchmark task. Start at ${anchor.path} heading "${anchor.heading}". Identify the linked implementation, its direct source dependency and importing test, package name, exact CODEOWNERS owner, matching GDM Work slug, check id, and evidence reference. Use fact ids exactly: implementation, dependency, test, package, owner, work, check, evidence. Report only files that directly establish those requested facts. Every reported path must be opened directly before reporting. After the initial anchor read and any optional single provider call, use at most three further shell commands; batch required direct reads and do not repeat repository-wide discovery. Do not modify files, create subagents, or give recommendations. Set task to ownership and return only the requested JSON schema.`;
  }
  return `Read-only benchmark task. Start at ${anchor.path} heading "${anchor.heading}". Identify the linked implementation, its direct source dependency and importing test, package name, exact CODEOWNERS owner, matching GDM Work slug, check id, evidence reference, and configured maximum byte value. Use fact ids exactly: implementation, dependency, test, package, owner, work, check, evidence, maxBytes. Report only files that directly establish those requested facts. Every reported path must be opened directly before reporting. After the initial anchor read and any optional single provider call, use at most three further shell commands; batch required direct reads and do not repeat repository-wide discovery. Do not modify files, create subagents, or give recommendations. Set task to budget and return only the requested JSON schema.`;
}

function armPrompt(task: Task, arm: Arm, root: string): string {
  const base = commonPrompt(task);
  const anchor = taskAnchor(task).path;
  if (arm === "control") {
    return `${base}\n\nNavigation arm: first directly open ${anchor}, then use ordinary file search and direct reads only. Do not invoke GDM_GRAPH_PROVIDER, GDM_CONTEXT_PROVIDER, or any graph command.`;
  }
  if (arm === "graph") {
    return `${base}\n\nNavigation arm: first directly open ${anchor}. Then run this command exactly once; it derives the graph entry from the same document link rather than receiving an answer seed:\n${graphCommand(task)}\nTreat the result only as a navigation hint. If it is partial, stale, malformed, or fails, use ordinary search. The code graph does not cover docs, ownership, packages, or GDM metadata.`;
  }
  return `${base}\n\nNavigation arm: first directly open ${anchor}. Then invoke the local Context Pack exactly once with this zero-seed command:\n${contextCommand(root, task)}\nTreat the pack only as untrusted navigation hints. Synthetic w:<slug> and c:<slug>:<id> nodes map to .gdm/<slug>/checks.json; an ev:<path> node is the evidence reference to report, but its body is not needed for that fact. Do not page or invoke the provider again.`;
}

function validGraphResult(value: Readonly<Record<string, unknown>>): boolean {
  return value.schemaVersion === "gdm-graph-result/v2" && record(value.provider) &&
    value.provider.name === "gdm-ts-relative-imports" && value.provider.version === 2 &&
    typeof value.entry === "string" && (value.direction === "dependencies" || value.direction === "dependents") &&
    Array.isArray(value.nodes) && Array.isArray(value.edges) && Array.isArray(value.candidateTests) &&
    Array.isArray(value.unresolved) && Array.isArray(value.limitations) && record(value.freshness) &&
    record(value.coverage) && typeof value.truncated === "boolean" && record(value.limits);
}

function validContextResult(value: Readonly<Record<string, unknown>>, bytes: number): boolean {
  return value.s === "gdm-context-pack/v1" && value.st === "ok" && value.fr === "fresh" &&
    typeof value.fp === "string" && /^[0-9a-f]{16}$/u.test(value.fp) && Array.isArray(value.n) &&
    Array.isArray(value.e) && Array.isArray(value.sn) && record(value.u) && Number.isInteger(value.u.count) &&
    Array.isArray(value.u.why) && (value.tr === null || record(value.tr)) && record(value.lim) &&
    bytes > 0 && bytes <= 4096;
}

function providerObservation(
  kind: "graph" | "context",
  command: string,
  output: string,
  exitCode: number,
  root: string,
  task: Task,
  side: SideProviderRecord,
  traceBound: boolean,
): ProviderMarker {
  const request = kind === "graph" ? graphRequest(root, task) : contextRequest(root, task);
  const expectedCommand = kind === "graph" ? graphCommand(task) : contextCommand(root, task);
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch {
    result = null;
  }
  const resultRecord = record(result) ? result : {};
  const resultBytes = Buffer.byteLength(output);
  const graphValid = kind === "graph" && validGraphResult(resultRecord);
  const contextValid = kind === "context" && validContextResult(resultRecord, resultBytes);
  const expectedRequestSha256 = sha256(`${JSON.stringify(request)}\n`);
  const commandObserved = command.trim() === expectedCommand.trim();
  return {
    kind,
    contractValid: traceBound && commandObserved && exitCode === 0 && side.exitCode === 0 &&
      side.requestSha256 === expectedRequestSha256 && side.resultSha256 === sha256(output) &&
      side.resultBytes === resultBytes && (graphValid || contextValid),
    commandObserved,
    traceBound,
    commandSha256: sha256(command),
    requestSha256: side.requestSha256,
    resultSha256: side.resultSha256,
    resultBytes: side.resultBytes,
    resultSchema: kind === "graph" ? "graph-v2" : "context-v1",
    resultStatus: kind === "context" && ["ok", "stale", "untrusted", "unsupported", "error"].includes(String(resultRecord.st))
      ? String(resultRecord.st) : "na",
    resultFreshness: kind === "context" && ["fresh", "synced", "stale"].includes(String(resultRecord.fr))
      ? String(resultRecord.fr) : "na",
  };
}

function explicitFileOperandHashes(command: string, root: string): readonly string[] {
  const hashes = new Set<string>();
  const segments = command.split(/\n|&&|\|\||[;|]/u);
  const reader = /^\s*(?:"?(?:(?:\/usr)?\/bin\/)?(?:cat|sed|grep|rg|head|tail|awk)"?)\s+/u;
  const token = /(?:^|\s|["'])((?:\.?\.?\/|\/)[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)(?=$|\s|["'])/gu;
  for (const segment of segments) {
    const invocation = segment.match(reader);
    if (invocation === null) continue;
    const argumentsText = segment.slice(invocation[0].length);
    for (const match of argumentsText.matchAll(token)) {
      const raw = match[1]!;
      try {
        const candidate = realpathSync(raw.startsWith("/") ? raw : resolve(root, raw));
        const stat = lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || (candidate !== root && !candidate.startsWith(`${root}/`))) continue;
        hashes.add(sha256(`path:${relative(root, candidate).replaceAll("\\", "/")}`));
      } catch {}
    }
  }
  return [...hashes].sort();
}

async function consumeEvents(
  stream: ReadableStream<Uint8Array>,
  expectedPaths: readonly string[],
  root: string,
): Promise<EventEvidence> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const streamHash = createHash("sha256");
  let buffer = "";
  let usage: Usage = { input: 0, cached: 0, output: 0 };
  let usageEventSha256 = "";
  let commands = 0;
  const completedCommands: { command: string; output: string; exitCode: number }[] = [];
  const trace: TraceEntry[] = [];
  const directReadPathSha256s = new Set<string>();
  const expectedReadPathSha256s = expectedPaths.map((path) => sha256(`path:${path}`)).sort();
  const processLine = (line: string): void => {
    if (!line) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!record(event)) return;
    const rawType = typeof event.type === "string" ? event.type : "unknown";
    const type = ["thread.started", "turn.started", "turn.completed", "item.started", "item.completed", "error"].includes(rawType)
      ? rawType : "other";
    const item = record(event.item) ? event.item : undefined;
    const rawItemType = typeof item?.type === "string" ? item.type : undefined;
    const itemType = rawItemType === undefined ? undefined
      : ["command_execution", "agent_message", "reasoning"].includes(rawItemType) ? rawItemType : "other";
    const itemIdSha256 = typeof item?.id === "string" ? sha256(item.id) : undefined;
    const current = usageFrom(event);
    const traceEntry: TraceEntry = {
      type,
      eventSha256: sha256(line),
      ...(itemType === undefined ? {} : { itemType }),
      ...(itemIdSha256 === undefined ? {} : { itemIdSha256 }),
      ...(current === null ? {} : { usage: current }),
    };
    if (current !== null) {
      usage = current;
      usageEventSha256 = traceEntry.eventSha256;
    }
    if (type === "item.started" && itemType === "command_execution") commands++;
    if (type !== "item.completed" || item === undefined || itemType !== "command_execution") {
      trace.push(traceEntry);
      return;
    }
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    const command = typeof item.command === "string" ? item.command : "";
    const exitCode = number(item.exit_code ?? item.exitCode);
    const readPathSha256s = exitCode === 0 ? explicitFileOperandHashes(command, root) : [];
    for (const hash of readPathSha256s) directReadPathSha256s.add(hash);
    trace.push({
      ...traceEntry,
      commandSha256: sha256(command),
      outputSha256: sha256(output),
      ...(readPathSha256s.length === 0 ? {} : { readPathSha256s }),
    });
    completedCommands.push({ command, output, exitCode });
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
    commands,
    eventStreamSha256: streamHash.digest("hex"),
    usageEventSha256,
    traceRootSha256: sha256(JSON.stringify(trace)),
    trace,
    expectedReadPathSha256s,
    directReadPathSha256s: [...directReadPathSha256s].sort(),
    completedCommands,
  };
}

function score(answer: FinalAnswer, expected: { readonly paths: readonly string[]; readonly facts: Readonly<Record<string, string>> }) {
  const pathCounts = new Map<string, number>();
  for (const path of answer.paths) pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  const paths = new Set(pathCounts.keys());
  const expectedPathSet = new Set(expected.paths);
  const missingPaths = expected.paths.filter((path) => !paths.has(path));
  const extraPathSha256s = [...paths].filter((path) => !expectedPathSet.has(path)).map((path) => sha256(`path:${path}`)).sort();
  const reportedPathSha256s = [...paths].map((path) => sha256(`path:${path}`)).sort();
  const reportedPathOccurrenceSha256s = answer.paths.map((path) => sha256(`path:${path}`)).sort();
  const reportedFacts = answer.facts.map(({ id, value }) => ({
    id: FACT_IDS.includes(id as typeof FACT_IDS[number]) ? id : `other:${sha256(id)}`,
    valueSha256: sha256(value),
  }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.valueSha256.localeCompare(right.valueSha256));
  const factCounts = new Map<string, number>();
  const factValues = new Map<string, string[]>();
  for (const fact of reportedFacts) {
    factCounts.set(fact.id, (factCounts.get(fact.id) ?? 0) + 1);
    factValues.set(fact.id, [...(factValues.get(fact.id) ?? []), fact.valueSha256]);
  }
  const expectedFactIds = Object.keys(expected.facts);
  const missingFactIds = expectedFactIds.filter((id) => !factValues.has(id));
  const mismatchedFactIds = expectedFactIds.filter((id) =>
    factValues.has(id) && !factValues.get(id)!.includes(sha256(expected.facts[id]!)));
  const extraFactIdSha256s = [...factValues.keys()].filter((id) => !(id in expected.facts))
    .map((id) => sha256(`fact-id:${id}`)).sort();
  const reportedFactSha256s = reportedFacts.map(({ id, valueSha256 }) => sha256(`fact:${id}\0${valueSha256}`)).sort();
  const matchedPaths = expected.paths.length - missingPaths.length;
  const matchedFacts = expectedFactIds.length - missingFactIds.length - mismatchedFactIds.length;
  const duplicatePathCount = [...pathCounts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  const duplicateFactIdCount = [...factCounts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  const reportedTask = answer.task === "ownership" || answer.task === "budget" ? answer.task : "other";
  const qualityValid = reportedTask === (expectedFactIds.includes("maxBytes") ? "budget" : "ownership") &&
    missingPaths.length === 0 && missingFactIds.length === 0 && mismatchedFactIds.length === 0 &&
    extraPathSha256s.length === 0 && extraFactIdSha256s.length === 0 && duplicatePathCount === 0 && duplicateFactIdCount === 0;
  return {
    expectedPaths: expected.paths.length,
    matchedPaths,
    expectedFacts: expectedFactIds.length,
    matchedFacts,
    missingPaths,
    missingFactIds,
    mismatchedFactIds,
    extraPathSha256s,
    extraFactIdSha256s,
    reportedPathSha256s,
    reportedPathOccurrenceSha256s,
    reportedFacts,
    reportedFactSha256s,
    duplicatePathCount,
    duplicateFactIdCount,
    limitationsCount: answer.limitations.length,
    reportedTask,
    taskValid: reportedTask === (expectedFactIds.includes("maxBytes") ? "budget" : "ownership"),
    qualityValid,
    pathRecall: matchedPaths / expected.paths.length,
    factRecall: matchedFacts / expectedFactIds.length,
    recall: (matchedPaths + matchedFacts) / (expected.paths.length + expectedFactIds.length),
  };
}

interface SideProviderRecord {
  readonly runToken: string;
  readonly kind: "graph" | "context";
  readonly requestSha256: string;
  readonly resultSha256: string;
  readonly resultBytes: number;
  readonly exitCode: number;
}

interface ProviderHarness {
  readonly root: string;
  readonly graph: string;
  readonly context: string;
  readonly take: (runToken: string) => Promise<readonly SideProviderRecord[]>;
  readonly close: () => Promise<void>;
}

function providerShim(kind: "graph" | "context", target: string, socketPath: string, nonce: string): string {
  return `#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
const kind = ${JSON.stringify(kind)};
const target = ${JSON.stringify(target)};
const socketPath = ${JSON.stringify(socketPath)};
const nonce = ${JSON.stringify(nonce)};
const input = await Bun.stdin.text();
const outcome = Bun.spawnSync([target, ...process.argv.slice(2)], {
  stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe", env: process.env,
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
const record = JSON.stringify({
  nonce, runToken: process.env.PILOT_RUN_TOKEN, kind, requestSha256: digest(input),
  resultSha256: digest(outcome.stdout), resultBytes: outcome.stdout.byteLength, exitCode: outcome.exitCode,
});
await new Promise((resolve) => {
  const socket = createConnection(socketPath);
  socket.once("connect", () => socket.end(record + "\\n"));
  socket.once("close", resolve);
  socket.once("error", resolve);
});
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exit(outcome.exitCode);
`;
}

async function createProviderHarness(): Promise<ProviderHarness> {
  const root = mkdtempSync(join(tmpdir(), "gdm-pilot-channel-"));
  const socketPath = join(root, "r.sock");
  const nonce = randomBytes(32).toString("hex");
  const records: SideProviderRecord[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { buffer += chunk; });
    socket.on("end", () => {
      for (const line of buffer.split("\n").filter(Boolean)) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.nonce !== nonce || typeof value.runToken !== "string" || !/^[0-9a-f]{32}$/u.test(value.runToken) ||
              (value.kind !== "graph" && value.kind !== "context") ||
              typeof value.requestSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.requestSha256) ||
              typeof value.resultSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.resultSha256) ||
              !Number.isInteger(value.resultBytes) || !Number.isInteger(value.exitCode)) continue;
          records.push(value as unknown as SideProviderRecord);
        } catch {}
      }
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socketPath, () => resolvePromise());
  });
  const graph = join(root, "graph-provider");
  const context = join(root, "context-provider");
  writeFileSync(graph, providerShim("graph", GRAPH, socketPath, nonce), { mode: 0o700 });
  writeFileSync(context, providerShim("context", GDM, socketPath, nonce), { mode: 0o700 });
  chmodSync(graph, 0o700);
  chmodSync(context, 0o700);
  return {
    root,
    graph,
    context,
    take: async (runToken) => {
      await Bun.sleep(50);
      const selected = records.filter((record) => record.runToken === runToken);
      for (let index = records.length - 1; index >= 0; index--) if (records[index]!.runToken === runToken) records.splice(index, 1);
      return selected;
    },
    close: async () => await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

function providerProof(markers: readonly ProviderMarker[], arm: Arm) {
  const calls = {
    graph: markers.filter((marker) => marker.kind === "graph").length,
    context: markers.filter((marker) => marker.kind === "context").length,
  };
  const expected = arm === "control" ? { graph: 0, context: 0 }
    : arm === "graph" ? { graph: 1, context: 0 }
    : { graph: 0, context: 1 };
  const selected = arm === "control" ? undefined : markers.find((marker) => marker.kind === arm);
  return {
    calls,
    observations: markers,
    valid: calls.graph === expected.graph && calls.context === expected.context &&
      markers.every((marker) => marker.contractValid && marker.commandObserved && marker.traceBound) &&
      (arm === "control" || selected !== undefined),
    commandSha256: selected?.commandSha256 ?? null,
    requestSha256: selected?.requestSha256 ?? null,
    resultSha256: selected?.resultSha256 ?? null,
    resultBytes: selected?.resultBytes ?? null,
    resultSchema: selected?.resultSchema ?? null,
    resultStatus: selected?.resultStatus ?? null,
    resultFreshness: selected?.resultFreshness ?? null,
  };
}

function fixtureManifest(root: string): { readonly sha256: string; readonly files: number } {
  const entries: { readonly path: string; readonly sha256: string }[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git" || name.startsWith(".pilot-final-")) continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`fixture symlink is forbidden: ${relative(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) entries.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: sha256(readFileSync(path)) });
    }
  };
  walk(root);
  return { sha256: sha256(JSON.stringify(entries)), files: entries.length };
}

async function runOne(
  task: Task,
  arm: Arm,
  trial: 1 | 2 | 3,
  root: string,
  expected: { readonly paths: readonly string[]; readonly facts: Readonly<Record<string, string>> },
  providers: ProviderHarness,
  runId: string,
  baselineFixture: { readonly sha256: string; readonly files: number },
  attemptStartSha256: string,
): Promise<RunResult> {
  const finalPath = join(root, `.pilot-final-${task}-${arm}-t${trial}.json`);
  const runToken = randomBytes(16).toString("hex");
  const env = {
    ...process.env,
    GDM_GRAPH_PROVIDER: providers.graph,
    GDM_CONTEXT_PROVIDER: providers.context,
    GDM_CONTEXT_TRUSTED_ROOT: root,
    PILOT_RUN_TOKEN: runToken,
  } as Record<string, string | undefined>;
  const child = Bun.spawn([
    CODEX,
    "exec",
    "-C", root,
    "-s", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-m", MODEL,
    "-c", 'model_reasoning_effort="xhigh"',
    "--output-schema", SCHEMA,
    "-o", finalPath,
    "--json",
    "-",
  ], {
    stdin: new TextEncoder().encode(armPrompt(task, arm, root)),
    stdout: "pipe",
    stderr: "pipe",
    env,
    detached: true,
  });
  const started = performance.now();
  const eventsPromise = consumeEvents(child.stdout, expected.paths, root);
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    forceTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 5_000);
  }, 900_000);
  const [childExitCode, events, rawStderr] = await Promise.all([child.exited, eventsPromise, stderrPromise]);
  const sideRecords = await providers.take(runToken);
  clearTimeout(timeoutTimer);
  if (forceTimer !== null) clearTimeout(forceTimer);
  const exitCode = timedOut ? 124 : childExitCode;
  const stderr = timedOut ? `${rawStderr}\nprovider run timed out after 900000ms` : rawStderr;
  if (exitCode !== 0) throw new Error(`codex ${task}/${arm} exited ${exitCode}: ${stderr.slice(-2000)}`);
  const answerBytes = readFileSync(finalPath);
  const answer = JSON.parse(new TextDecoder().decode(answerBytes)) as FinalAnswer;
  unlinkSync(finalPath);
  const postFixture = fixtureManifest(root);
  if (JSON.stringify(postFixture) !== JSON.stringify(baselineFixture)) throw new Error(`fixture changed during ${task}/${arm}`);
  const scored = score(answer, expected);
  const providerMarkers = sideRecords.map((side) => {
    const expectedReference = side.kind === "graph" ? "$GDM_GRAPH_PROVIDER" : "$GDM_CONTEXT_PROVIDER";
    const providerPath = side.kind === "graph" ? providers.graph : providers.context;
    const completed = events.completedCommands.find((entry) =>
      sha256(entry.output) === side.resultSha256 &&
      (entry.command.includes(expectedReference) || entry.command.includes(providerPath)));
    return providerObservation(
      side.kind, completed?.command ?? "", completed?.output ?? "", completed?.exitCode ?? -1,
      root, task, side, completed !== undefined,
    );
  });
  const proof = providerProof(providerMarkers, arm);
  const elapsedMs = Math.round(performance.now() - started);
  const contextPackBytes = arm === "context" ? proof.resultBytes : null;
  const observedReadPaths = new Set(events.directReadPathSha256s);
  const directReadsValid = scored.reportedPathSha256s.every((path) => observedReadPaths.has(path));
  const anchorSha256 = sha256(`path:${taskAnchor(task).path}`);
  const anchorIndex = events.trace.findIndex((entry) => entry.readPathSha256s?.includes(anchorSha256) === true);
  const providerIndex = proof.commandSha256 === null ? -1
    : events.trace.findIndex((entry) => entry.commandSha256 === proof.commandSha256);
  const anchorFirstValid = anchorIndex >= 0 && (arm === "control" || (providerIndex >= 0 && anchorIndex < providerIndex));
  const commandPolicyValid = events.commands >= 1 && events.commands <= (arm === "control" ? 4 : 5);
  const receiptPath = `receipts/${task}-${arm}-t${trial}.json`;
  const receiptPayload = {
    schemaVersion: "gdm-context-pack-pilot-receipt/v12",
    runId,
    task,
    arm,
    trial,
    runnerSha256: RUNNER_SHA256,
    verifierSha256: VERIFIER_SHA256,
    assessorSha256: ASSESSOR_SHA256,
    outputSchemaSha256: OUTPUT_SCHEMA_SHA256,
    fixtureSourceSha256: FIXTURE_SOURCE_SHA256,
    runtimeSha256: RUNTIME_SHA256,
    fixtureManifestSha256: baselineFixture.sha256,
    fixtureFileCount: baselineFixture.files,
    staticGateSha256: STATIC_GATE_SHA256,
    attemptStartSha256,
    eventStreamSha256: events.eventStreamSha256,
    usageEventSha256: events.usageEventSha256,
    usageProjectionSha256: sha256(JSON.stringify(events.usage)),
    traceRootSha256: events.traceRootSha256,
    trace: events.trace,
    expectedReadPathSha256s: events.expectedReadPathSha256s,
    directReadPathSha256s: events.directReadPathSha256s,
    directReadsValid,
    anchorFirstValid,
    commandPolicyValid,
    answerSha256: sha256(answerBytes),
    exitCode,
    elapsedMs,
    commands: events.commands,
    usage: events.usage,
    provider: proof,
    contextPackBytes,
    score: scored,
  };
  const receiptBytes = new TextEncoder().encode(`${JSON.stringify(receiptPayload, null, 2)}\n`);
  writeFileSync(join(HERE, "results", receiptPath), receiptBytes, { mode: 0o600 });
  const receipt = { path: receiptPath, sha256: sha256(receiptBytes) };
  return {
    task,
    arm,
    trial,
    exitCode,
    elapsedMs,
    commands: events.commands,
    inputTokens: events.usage.input,
    cachedInputTokens: events.usage.cached,
    freshInputTokens: Math.max(0, events.usage.input - events.usage.cached),
    outputTokens: events.usage.output,
    contextPackBytes,
    providerCalls: proof.calls,
    providerContractValid: proof.valid,
    directReadsValid,
    anchorFirstValid,
    commandPolicyValid,
    receipt,
    ...scored,
  };
}

function cleanup(path: string): void {
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (statSync(child).isDirectory()) cleanup(child);
    else unlinkSync(child);
  }
  rmdirSync(path);
}

if (process.argv.length !== 2) throw new Error("run-pilot.ts does not support resume or tuple replacement");
if (existsSync(ATTEMPTS)) {
  const priorLines = readFileSync(ATTEMPTS, "utf8").trimEnd().split("\n");
  if (priorLines.length < 2 || priorLines.length % 2 !== 0) throw new Error("attempt ledger is incomplete");
  const previous = JSON.parse(priorLines.at(-1)!) as Record<string, unknown>;
  if (previous.event !== "failed" || previous.completedRuns !== 0) {
    throw new Error("only a zero-completed-run preflight failure may start a new protocol revision");
  }
}
const fixture = createPilotFixture();
const providers = await createProviderHarness();
const expectedFingerprint = sha256(JSON.stringify(fixture.expected));
const baselineFixture = fixtureManifest(fixture.root);
const runs: RunResult[] = [];
const runId = randomBytes(16).toString("hex");
const summaryPath = join(HERE, "results", "summary.json");
mkdirSync(join(HERE, "results"), { recursive: true });
if (existsSync(summaryPath)) unlinkSync(summaryPath);
if (existsSync(RECEIPTS)) cleanup(RECEIPTS);
mkdirSync(RECEIPTS, { recursive: true, mode: 0o700 });
const attemptStart = {
  event: "started",
  protocol: "fair-anchor-receipts/v12",
  runId,
  runnerSha256: RUNNER_SHA256,
  runtimeSha256: RUNTIME_SHA256,
  fixtureManifestSha256: baselineFixture.sha256,
  at: new Date().toISOString(),
};
const attemptStartLine = JSON.stringify(attemptStart);
appendFileSync(ATTEMPTS, `${attemptStartLine}\n`, { mode: 0o600 });
const attemptStartSha256 = sha256(attemptStartLine);
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
      process.stderr.write(`pilot t${trial} ${task}/${arm}\n`);
      runs.push(await runOne(
        task, arm, trial, fixture.root, fixture.expected[task]!, providers, runId, baselineFixture, attemptStartSha256,
      ));
    }
  }
} catch (error) {
  appendFileSync(ATTEMPTS, `${JSON.stringify({
    event: "failed",
    runId,
    errorSha256: sha256(error instanceof Error ? error.message : String(error)),
    completedRuns: runs.length,
    at: new Date().toISOString(),
  })}\n`);
  throw error;
} finally {
  cleanup(fixture.root);
  await providers.close();
  cleanup(providers.root);
}

const byArm = Object.fromEntries(ARMS.map((arm) => {
  const selected = runs.filter((run) => run.arm === arm);
  return [arm, {
    meanRecall: selected.reduce((sum, run) => sum + run.recall, 0) / selected.length,
    meanFreshInputTokens: selected.reduce((sum, run) => sum + run.freshInputTokens, 0) / selected.length,
    meanInputTokens: selected.reduce((sum, run) => sum + run.inputTokens, 0) / selected.length,
  }];
}));
const summary = {
  schemaVersion: "gdm-context-pack-pilot/v14",
  protocol: "fair-anchor-receipts/v12",
  runId,
  runnerSha256: RUNNER_SHA256,
  verifierSha256: VERIFIER_SHA256,
  assessorSha256: ASSESSOR_SHA256,
  outputSchemaSha256: OUTPUT_SCHEMA_SHA256,
  fixtureSourceSha256: FIXTURE_SOURCE_SHA256,
  runtimeSha256: RUNTIME_SHA256,
  runtime: RUNTIME,
  fixtureManifestSha256: baselineFixture.sha256,
  fixtureFileCount: baselineFixture.files,
  staticGateSha256: STATIC_GATE_SHA256,
  staticGate: STATIC_GATE,
  attemptStartSha256,
  navigationStartPolicy: "direct-doc-anchor-first",
  followupShellCommandLimit: 3,
  contextTermSource: "common-anchor-heading-only",
  contextSeedCount: 0,
  generatedAt: new Date().toISOString(),
  model: MODEL,
  reasoning: "xhigh",
  trialsPerTaskArm: 3,
  retention: "metrics-hashes-and-structured-score-only",
  attemptPolicy: "append-only-zero-run-preflight-retry-no-tuple-replacement",
  fixtureSha256: expectedFingerprint,
  runs: runs.sort((left, right) => left.trial - right.trial || left.task.localeCompare(right.task) || left.arm.localeCompare(right.arm)),
  byArm,
};
const summaryBytes = `${JSON.stringify(summary, null, 2)}\n`;
writeFileSync(summaryPath, summaryBytes);
appendFileSync(ATTEMPTS, `${JSON.stringify({
  event: "completed",
  runId,
  summarySha256: sha256(summaryBytes),
  completedRuns: runs.length,
  at: new Date().toISOString(),
})}\n`);
console.log(JSON.stringify(summary));
