import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { encodePng } from "../../agents/pi/gdm-computer-use/png.ts";
import { delay } from "../../agents/pi/gdm-computer-use/rfb.ts";
import { TartVmManager } from "../../agents/pi/gdm-computer-use/vm.ts";
import {
  createRememberEvent,
  renderMemoryBlock,
  selectMemories,
  type MemoryEntry,
  type RememberEvent,
} from "../../agents/pi/gdm-memory/core.ts";
import {
  globalStorePath,
  projectStorePath,
  readMemoryStore,
} from "../../agents/pi/gdm-memory/store.ts";
import {
  CU_LIVE_TRIALS,
  MEMORY_SCENARIOS,
  MEMORY_SELECTION_ITERATIONS,
  MEMORY_STORE_READ_ITERATIONS,
  PROTOCOL,
  REGISTRATION_ARMS,
  REGISTRATION_REPETITIONS,
  RETENTION,
  SOURCE_IDS,
  SUMMARY_SCHEMA,
  acceptChildProbe,
  distribution,
  isRecord,
  scanSensitive,
  sha256,
  type ChildProbe,
  type ComputerUseTrial,
  type MemoryScenarioId,
  type MemoryScenarioSummary,
  type RegistrationArm,
  type RegistrationArmSummary,
  type SourceArtifact,
  type Stage0Summary,
} from "./protocol.ts";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../..");
const STATUS_EXTENSION = join(homedir(), ".pi/agent/extensions/codex-usage-status.ts");
const INSTALLED_LAUNCHER = join(homedir(), ".local/bin/gdm-pi");
const INSTALLED_MEMORY = join(homedir(), ".pi/agent/skills/gdm-agents/pi/gdm-memory/index.ts");
const INSTALLED_COMPUTER_USE = join(homedir(), ".pi/agent/skills/gdm-agents/pi/gdm-computer-use/index.ts");
const CONTEXT_POINTER = join(ROOT, "bench/context-pack-e2e/results/current-v2.json");
const SYNTHETIC_PROJECT = join(tmpdir(), "gdm-feature-value-synthetic-project");

function regularBytes(path: string): Buffer {
  const direct = lstatSync(path);
  if (!direct.isFile() || direct.isSymbolicLink()) throw new Error(`unsafe benchmark input: ${path}`);
  return readFileSync(path);
}

function sourcePaths(): Readonly<Record<typeof SOURCE_IDS[number], string>> {
  const pointer = JSON.parse(regularBytes(CONTEXT_POINTER).toString("utf8")) as unknown;
  if (!isRecord(pointer) || typeof pointer.runId !== "string" || !/^[0-9a-f]{32}$/u.test(pointer.runId) ||
      pointer.runDirectory !== `runs/${pointer.runId}`) throw new Error("invalid Context Pack v2 pointer");
  const summary = join(dirname(CONTEXT_POINTER), pointer.runDirectory, "summary.json");
  return {
    protocol: join(HERE, "protocol.ts"),
    "probe-child": join(HERE, "probe-child.ts"),
    stage0: join(HERE, "stage0.ts"),
    result: join(HERE, "result.ts"),
    publisher: join(HERE, "publish-stage0.ts"),
    verifier: join(HERE, "verify-stage0.ts"),
    "static-check": join(HERE, "static-check.ts"),
    "memory-core": join(ROOT, "agents/pi/gdm-memory/core.ts"),
    "memory-store": join(ROOT, "agents/pi/gdm-memory/store.ts"),
    "memory-extension": join(ROOT, "agents/pi/gdm-memory/index.ts"),
    "computer-use-extension": join(ROOT, "agents/pi/gdm-computer-use/index.ts"),
    "computer-use-vm": join(ROOT, "agents/pi/gdm-computer-use/vm.ts"),
    "source-launcher": join(ROOT, "agents/pi/gdm-pi"),
    "installed-launcher": INSTALLED_LAUNCHER,
    "installed-memory-extension": INSTALLED_MEMORY,
    "installed-computer-use-extension": INSTALLED_COMPUTER_USE,
    "status-extension": STATUS_EXTENSION,
    "context-v2-pointer": CONTEXT_POINTER,
    "context-v2-summary": summary,
    "context-v2-assessor": join(ROOT, "bench/context-pack-e2e/assess-e2e.ts"),
    "context-v2-evaluation": join(ROOT, "bench/context-pack-evaluation-2026-09-03.md"),
  };
}

export function currentSourceCommitment(): { readonly source: readonly SourceArtifact[]; readonly sourceSha256: string } {
  const paths = sourcePaths();
  const source = SOURCE_IDS.map((id) => {
    const bytes = regularBytes(paths[id]);
    return { id, sha256: sha256(bytes), bytes: bytes.byteLength } as const;
  });
  return { source, sourceSha256: sha256(JSON.stringify(source)) };
}

async function spawnProbe(arm: RegistrationArm, agentDir: string): Promise<{ readonly child: ChildProbe; readonly wallMs: number }> {
  const started = performance.now();
  const processHandle = Bun.spawn([process.execPath, join(HERE, "probe-child.ts"), arm], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TZ: "UTC",
      PI_OFFLINE: "1",
      NODE_PATH: join(homedir(), ".pi/agent/npm/node_modules"),
      GDM_BENCH_AGENT_DIR: agentDir,
      GDM_BENCH_STATUS_EXTENSION: STATUS_EXTENSION,
    },
  });
  const timeout = setTimeout(() => processHandle.kill("SIGTERM"), 30_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`feature registration probe failed for ${arm}: ${stderr.trim().slice(0, 1000)}`);
  if (Buffer.byteLength(stdout) > 64 * 1024) throw new Error(`feature registration probe output exceeded limit for ${arm}`);
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error(`feature registration probe returned malformed JSON for ${arm}`); }
  const child = acceptChildProbe(parsed, arm);
  if (child === null) throw new Error(`feature registration probe returned invalid schema for ${arm}`);
  return { child, wallMs: performance.now() - started };
}

function constant<T>(values: readonly T[], label: string): T {
  if (values.length === 0 || values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]))) {
    throw new Error(`registration probe ${label} was not deterministic`);
  }
  return values[0]!;
}

async function measureRegistration(repetitions: number): Promise<readonly RegistrationArmSummary[]> {
  const root = mkdtempSync(join(tmpdir(), "gdm-feature-value-probes-"));
  try {
    const output: RegistrationArmSummary[] = [];
    for (const arm of REGISTRATION_ARMS) {
      const trials: Array<{ readonly child: ChildProbe; readonly wallMs: number }> = [];
      for (let trial = 0; trial < repetitions; trial++) {
        const agentDir = join(root, `${arm}-${trial}`);
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        trials.push(await spawnProbe(arm, agentDir));
      }
      const children = trials.map((trial) => trial.child);
      output.push({
        arm,
        repetitions,
        toolCount: constant(children.map((item) => item.toolCount), `${arm} toolCount`),
        toolSchemaBytes: constant(children.map((item) => item.toolSchemaBytes), `${arm} toolSchemaBytes`),
        promptMetadataBytes: constant(children.map((item) => item.promptMetadataBytes), `${arm} promptMetadataBytes`),
        toolDefinitionBytes: constant(children.map((item) => item.toolDefinitionBytes), `${arm} toolDefinitionBytes`),
        statusIntervalMs: constant(children.map((item) => item.statusIntervalMs), `${arm} statusIntervalMs`),
        statusFetchCalls: constant(children.map((item) => item.statusFetchCalls), `${arm} statusFetchCalls`),
        statusSetCalls: constant(children.map((item) => item.statusSetCalls), `${arm} statusSetCalls`),
        statusFormattingValid: constant(children.map((item) => item.statusFormattingValid), `${arm} statusFormattingValid`),
        statusProviderHideValid: constant(children.map((item) => item.statusProviderHideValid), `${arm} statusProviderHideValid`),
        processWallMs: distribution(trials.map((item) => item.wallMs)),
        loadMs: distribution(children.map((item) => item.loadMs)),
        cpuUserMicros: distribution(children.map((item) => item.cpuUserMicros)),
        cpuSystemMicros: distribution(children.map((item) => item.cpuSystemMicros)),
        rssBytes: distribution(children.map((item) => item.rssBytes)),
        heapUsedBytes: distribution(children.map((item) => item.heapUsedBytes)),
      });
    }
    return output;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function event(scope: "global" | "project", index: number, text: string): RememberEvent {
  return createRememberEvent({
    scope,
    text,
    reason: "synthetic benchmark fixture",
    source: "tool-auto",
    now: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    ...(scope === "project" ? { projectRealpath: SYNTHETIC_PROJECT } : {}),
  });
}

function scenario(id: MemoryScenarioId): {
  readonly prompt: string;
  readonly global: readonly RememberEvent[];
  readonly project: readonly RememberEvent[];
  readonly relevantId: string | null;
} {
  if (id === "empty") return { prompt: "quartz cobalt policy", global: [], project: [], relevantId: null };
  const total = id === "irrelevant-10" ? 10 : 200;
  const global: RememberEvent[] = [];
  const project: RememberEvent[] = [];
  let relevantId: string | null = null;
  for (let index = 0; index < total; index++) {
    const scope = index % 2 === 0 ? "project" : "global";
    const text = id === "relevant-200" && index === 0
      ? "Quartz policy requires cobalt output formatting"
      : `Synthetic durable preference item ${String(index).padStart(3, "0")} uses amber format`;
    const entry = event(scope, index, text);
    if (index === 0 && id === "relevant-200") relevantId = entry.id;
    (scope === "project" ? project : global).push(entry);
  }
  return { prompt: "apply quartz cobalt policy", global, project, relevantId };
}

function writeEvents(path: string, events: readonly RememberEvent[]): number {
  if (events.length === 0) return 0;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(events.map((item) => JSON.stringify(item)).join("\n") + "\n");
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return bytes.byteLength;
}

async function measureMemoryScenario(
  id: MemoryScenarioId,
  selectionIterations: number,
  readIterations: number,
): Promise<{ readonly summary: MemoryScenarioSummary; readonly corpusProjection: unknown }> {
  const fixture = scenario(id);
  const selectionSamples: number[] = [];
  let selected: { readonly project: readonly MemoryEntry[]; readonly global: readonly MemoryEntry[] } = { project: [], global: [] };
  for (let iteration = 0; iteration < selectionIterations; iteration++) {
    const started = performance.now();
    selected = selectMemories({ prompt: fixture.prompt, global: fixture.global, project: fixture.project });
    selectionSamples.push(performance.now() - started);
  }
  const rendered = renderMemoryBlock(selected);
  const root = mkdtempSync(join(tmpdir(), "gdm-feature-value-memory-"));
  let storeBytes = 0;
  const readSamples: number[] = [];
  try {
    const globalPath = globalStorePath(root);
    const projectPath = projectStorePath(root, SYNTHETIC_PROJECT);
    storeBytes += writeEvents(globalPath, fixture.global);
    storeBytes += writeEvents(projectPath, fixture.project);
    for (let iteration = 0; iteration < readIterations; iteration++) {
      const started = performance.now();
      await readMemoryStore({ path: globalPath, scope: "global" });
      await readMemoryStore({ path: projectPath, scope: "project", projectRealpath: SYNTHETIC_PROJECT });
      readSamples.push(performance.now() - started);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const ids = [...selected.project, ...selected.global].map((entry) => entry.id);
  return {
    summary: {
      id,
      totalEntries: fixture.global.length + fixture.project.length,
      selectedProject: selected.project.length,
      selectedGlobal: selected.global.length,
      renderedChars: rendered.length,
      renderedBytes: Buffer.byteLength(rendered),
      selectedSha256: sha256(JSON.stringify(ids)),
      storeBytes,
      relevantEntryFirst: fixture.relevantId === null ? null : selected.project[0]?.id === fixture.relevantId,
      selectionMs: distribution(selectionSamples),
      storeReadMs: distribution(readSamples),
    },
    corpusProjection: {
      id,
      global: fixture.global.map((entry) => ({ id: entry.id, sha256: sha256(entry.text), bytes: Buffer.byteLength(entry.text) })),
      project: fixture.project.map((entry) => ({ id: entry.id, sha256: sha256(entry.text), bytes: Buffer.byteLength(entry.text) })),
    },
  };
}

async function measureMemory(selectionIterations: number, readIterations: number) {
  const measured = [];
  for (const id of MEMORY_SCENARIOS) measured.push(await measureMemoryScenario(id, selectionIterations, readIterations));
  const scenarios = measured.map((item) => item.summary);
  return {
    syntheticOnly: true as const,
    corpusSha256: sha256(JSON.stringify(measured.map((item) => item.corpusProjection))),
    selectionIterations,
    storeReadIterations: readIterations,
    zeroOverlapInjects: (scenarios.find((item) => item.id === "irrelevant-200")?.renderedBytes ?? 0) > 0,
    scenarios,
  };
}

function command(executable: string, args: readonly string[]): string {
  const output = Bun.spawnSync([executable, ...args], { stdout: "pipe", stderr: "pipe" });
  if (output.exitCode !== 0) throw new Error(`${executable} failed`);
  return output.stdout.toString().trim();
}

function frontmost(): string {
  return command("/usr/bin/lsappinfo", ["front"]);
}

async function stableFrontmost(): Promise<string> {
  const deadline = Date.now() + 15_000;
  let candidate = frontmost();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await delay(100);
    const current = frontmost();
    if (current !== candidate) {
      candidate = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 3000) {
      return candidate;
    }
  }
  throw new Error("host focus was not stable before Computer Use measurement");
}

function tartTcpListenerLines(): number {
  const table = command("/bin/ps", ["-axo", "pid=,command="]);
  const pids = table.split(/\r?\n/u).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    return match && match[2]!.includes("tart") && match[2]!.includes("gdm-cu-vm") ? [match[1]!] : [];
  });
  if (pids.length === 0) return 0;
  const result = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN"], {
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error("host TCP listener inspection failed");
  const output = result.stdout.toString().trim();
  return output.length === 0 ? 0 : output.split(/\r?\n/u).length;
}

function vmResources(): { readonly processCount: number; readonly rssBytes: number; readonly cpuPercent: number } {
  const table = command("/bin/ps", ["-axo", "rss=,%cpu=,command="]);
  let processCount = 0;
  let rssBytes = 0;
  let cpuPercent = 0;
  for (const line of table.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+([0-9.]+)\s+(.+)$/u);
    if (!match || !match[3]!.includes("tart") || !match[3]!.includes("gdm-cu-vm")) continue;
    processCount++;
    rssBytes += Number(match[1]) * 1024;
    cpuPercent += Number(match[2]);
  }
  return { processCount, rssBytes, cpuPercent };
}

function vmDiskBytes(): number {
  const path = join(homedir(), ".tart/vms/gdm-cu-vm");
  const output = command("/usr/bin/du", ["-sk", path]);
  const kib = Number(output.split(/\s+/u)[0]);
  if (!Number.isFinite(kib) || kib < 0) throw new Error("invalid VM disk size");
  return kib * 1024;
}

function failureCode(error: unknown): NonNullable<ComputerUseTrial["failureCode"]> {
  const message = (error as Error).message;
  if (message === "host-focus-changed") return "host-focus-changed";
  if (message === "host-tcp-listener") return "host-tcp-listener";
  if (message === "host-sentinel-created") return "host-sentinel-created";
  if (message === "guest-write-failed") return "guest-write-failed";
  if (message === "cleanup-failed") return "cleanup-failed";
  return "runtime-error";
}

async function measureComputerUseTrial(trial: number): Promise<ComputerUseTrial> {
  const manager = new TartVmManager();
  const hostPath = `/tmp/gdm-feature-value-host-sentinel-${randomBytes(16).toString("hex")}.txt`;
  if (existsSync(hostPath)) throw new Error("host sentinel unexpectedly exists");
  const baseline = await stableFrontmost();
  const focusSamples: string[] = [];
  const sampler = setInterval(() => {
    try { focusSamples.push(frontmost()); } catch { focusSamples.push("focus-probe-error"); }
  }, 100);
  let startMs = 0;
  let screenshotMs = 0;
  let guiMutationMs = 0;
  let stopMs = 0;
  let pngBytes = 0;
  let frameWidth = 0;
  let frameHeight = 0;
  let resources = { processCount: 0, rssBytes: 0, cpuPercent: 0 };
  const diskBefore = vmDiskBytes();
  let listenerLines = 0;
  let guestWriteVerified = false;
  let cleanupVerified = false;
  let caught: unknown;
  try {
    let started = performance.now();
    await manager.start();
    startMs = performance.now() - started;
    listenerLines = tartTcpListenerLines();
    resources = vmResources();

    started = performance.now();
    const frame = await manager.screenshot();
    screenshotMs = performance.now() - started;
    const png = encodePng(frame);
    pngBytes = png.byteLength;
    frameWidth = frame.width;
    frameHeight = frame.height;

    started = performance.now();
    const guestPath = hostPath;
    await manager.execGuest(["/usr/bin/killall", "TextEdit"]).catch(() => {});
    await delay(1000);
    await manager.execGuest(["/bin/rm", "-f", guestPath]);
    await manager.execGuest(["/usr/bin/touch", guestPath]);
    await manager.execGuest(["/usr/bin/sudo", "/bin/launchctl", "asuser", "501", "/usr/bin/open", "-a", "TextEdit", guestPath]);
    await delay(3000);
    await manager.click(600, 300);
    await manager.typeText("G");
    await manager.pressKey("s", ["cmd"]);
    await delay(500);
    await manager.pressKey("s", ["cmd"]);
    await delay(2000);
    guestWriteVerified = (await manager.execGuest(["/bin/cat", guestPath])).trim() === "G";
    await manager.execGuest(["/bin/rm", "-f", guestPath]);
    guiMutationMs = performance.now() - started;
    if (!guestWriteVerified) throw new Error("guest-write-failed");
    if (existsSync(hostPath)) throw new Error("host-sentinel-created");
    if (listenerLines !== 0 || tartTcpListenerLines() !== 0) throw new Error("host-tcp-listener");
  } catch (error) {
    caught = error;
  } finally {
    const started = performance.now();
    await manager.stop().catch((error) => { caught ??= error; });
    stopMs = performance.now() - started;
    cleanupVerified = (await manager.status()).state === "stopped";
    clearInterval(sampler);
  }
  const hostFocusChanges = focusSamples.filter((sample) => sample !== baseline).length;
  const hostSentinelCreated = existsSync(hostPath);
  if (hostFocusChanges > 0) caught = new Error("host-focus-changed");
  if (hostSentinelCreated) caught = new Error("host-sentinel-created");
  if (!cleanupVerified) caught ??= new Error("cleanup-failed");
  const diskAfter = vmDiskBytes();
  const code = caught === undefined ? null : failureCode(caught);
  return {
    trial,
    startMs,
    screenshotMs,
    guiMutationMs,
    stopMs,
    pngBytes,
    frameWidth,
    frameHeight,
    vmProcessCount: resources.processCount,
    vmRssBytes: resources.rssBytes,
    vmCpuPercent: resources.cpuPercent,
    vmDiskBytesBefore: diskBefore,
    vmDiskBytesAfter: diskAfter,
    hostFocusChanges,
    hostTcpListenerLines: listenerLines,
    hostSentinelCreated,
    guestWriteVerified,
    cleanupVerified,
    failureCode: code,
    valid: code === null,
  };
}

async function measureComputerUse(trialsPlanned: number) {
  const trials: ComputerUseTrial[] = [];
  for (let trial = 1; trial <= trialsPlanned; trial++) {
    trials.push(await measureComputerUseTrial(trial));
    const latest = trials.at(-1)!;
    if (latest.hostFocusChanges > 0 || latest.hostTcpListenerLines > 0 || latest.hostSentinelCreated) break;
    await delay(1000);
  }
  const safetyViolations = trials.filter((trial) => trial.hostFocusChanges > 0 || trial.hostTcpListenerLines > 0 || trial.hostSentinelCreated).length;
  return {
    trialsPlanned,
    trials,
    safetyViolations,
    liveValid: trials.length === trialsPlanned && trials.every((trial) => trial.valid),
  };
}

function contextCarryForward() {
  const pointerBytes = regularBytes(CONTEXT_POINTER);
  const pointer = JSON.parse(pointerBytes.toString("utf8")) as unknown;
  if (!isRecord(pointer) || typeof pointer.runId !== "string" || !/^[0-9a-f]{32}$/u.test(pointer.runId) ||
      pointer.runDirectory !== `runs/${pointer.runId}` || typeof pointer.summarySha256 !== "string") {
    throw new Error("invalid Context Pack carry-forward pointer");
  }
  const resultsRoot = resolve(dirname(CONTEXT_POINTER));
  const summaryPath = resolve(resultsRoot, pointer.runDirectory, "summary.json");
  if (!summaryPath.startsWith(`${resultsRoot}${sep}`)) throw new Error("Context Pack summary escaped result root");
  const summaryBytes = regularBytes(summaryPath);
  if (sha256(summaryBytes) !== pointer.summarySha256) throw new Error("Context Pack pointer summary hash mismatch");
  const summary = JSON.parse(summaryBytes.toString("utf8")) as unknown;
  if (!isRecord(summary) || summary.runId !== pointer.runId || !Array.isArray(summary.runs) || summary.runs.length !== 18 ||
      summary.promotionEligible !== false || summary.defaultActivation !== "blocked") {
    throw new Error("Context Pack immutable summary contract changed");
  }
  const validRuns = summary.runs.filter((run) => isRecord(run) && run.measurementValid === true).length;
  const evaluation = regularBytes(join(ROOT, "bench/context-pack-evaluation-2026-09-03.md")).toString("utf8");
  if (validRuns !== 13 || !evaluation.includes(`run ID: \`${pointer.runId}\``) || !evaluation.includes("13/18") ||
      !evaluation.includes("`invalid-not-evidence`") || !evaluation.includes("기본 활성화는 계속 차단")) {
    throw new Error("Context Pack documented negative assessment changed");
  }
  return {
    measurementValid: false as const,
    validRuns,
    totalRuns: summary.runs.length,
    tokenConclusion: "invalid-not-evidence" as const,
    promotionEligible: false as const,
    defaultActivation: "blocked" as const,
  };
}

export async function runStage0(input: {
  readonly runId: string;
  readonly registrationRepetitions?: number;
  readonly memorySelectionIterations?: number;
  readonly memoryStoreReadIterations?: number;
  readonly computerUseTrials?: number;
}): Promise<Stage0Summary> {
  if (!/^[0-9a-f]{32}$/u.test(input.runId)) throw new Error("invalid Stage 0 run id");
  const repetitions = input.registrationRepetitions ?? REGISTRATION_REPETITIONS;
  const selectionIterations = input.memorySelectionIterations ?? MEMORY_SELECTION_ITERATIONS;
  const readIterations = input.memoryStoreReadIterations ?? MEMORY_STORE_READ_ITERATIONS;
  const computerUseTrials = input.computerUseTrials ?? CU_LIVE_TRIALS;
  const source = currentSourceCommitment();
  const registrationArms = await measureRegistration(repetitions);
  const memory = await measureMemory(selectionIterations, readIterations);
  const computerUse = await measureComputerUse(computerUseTrials);
  const statusArm = registrationArms.find((arm) => arm.arm === "status");
  const context = contextCarryForward();
  const expectedTools: Readonly<Record<RegistrationArm, number>> = {
    baseline: 0, memory: 1, "computer-use": 1, both: 2, status: 0, all: 2,
  };
  const registrationComplete = registrationArms.length === REGISTRATION_ARMS.length && registrationArms.every((arm) =>
    arm.repetitions === repetitions && arm.toolCount === expectedTools[arm.arm]);
  const memoryComplete = memory.scenarios.length === MEMORY_SCENARIOS.length &&
    memory.scenarios.find((scenario) => scenario.id === "irrelevant-200")?.selectedProject === 6 &&
    memory.scenarios.find((scenario) => scenario.id === "irrelevant-200")?.selectedGlobal === 4 &&
    memory.scenarios.find((scenario) => scenario.id === "relevant-200")?.relevantEntryFirst === true;
  const statusComplete = statusArm !== undefined && statusArm.statusIntervalMs === 1000 && statusArm.statusFetchCalls === 0 &&
    statusArm.statusFormattingValid === true && statusArm.statusProviderHideValid === true;
  const gates = {
    sourceBound: true,
    syntheticOnly: memory.syntheticOnly,
    bodyFree: true,
    registrationComplete,
    memoryComplete,
    statusComplete,
    contextCarryForwardValid: context.measurementValid === false && context.tokenConclusion === "invalid-not-evidence" && context.promotionEligible === false,
    computerUseComplete: computerUse.liveValid,
    computerUseSafety: computerUse.safetyViolations === 0,
  };
  const measurementValid = Object.values(gates).every((gate) => gate === true);
  const summary: Stage0Summary = {
    schemaVersion: SUMMARY_SCHEMA,
    protocol: PROTOCOL,
    scale: "local-stage0",
    runId: input.runId,
    createdAt: new Date().toISOString(),
    retention: RETENTION,
    measurementScope: "cost-and-safety-only",
    utilityConclusion: "not-measured",
    freshInputConclusion: "not-measured",
    promotionEligible: false,
    removalEligible: false,
    defaultActivation: "unchanged",
    ...source,
    registration: { repetitions, arms: registrationArms },
    memory,
    computerUse,
    statusline: {
      measurementScope: "display-extension-only",
      piCodexLimitIncluded: false,
      qualityConclusion: "not-measured",
      available: statusArm !== undefined,
      intervalMs: statusArm?.statusIntervalMs ?? null,
      fetchCalls: statusArm?.statusFetchCalls ?? 0,
      formattingValid: statusArm?.statusFormattingValid === true,
      providerHideValid: statusArm?.statusProviderHideValid === true,
    },
    contextCarryForward: context,
    gates,
    measurementValid,
    stage1Eligible: measurementValid,
  };
  scanSensitive(summary);
  return summary;
}
