import { createHash } from "node:crypto";

export const PROTOCOL = "gdm-feature-value-stage0/v1" as const;
export const SUMMARY_SCHEMA = "gdm-feature-value-stage0-summary/v1" as const;
export const CHILD_SCHEMA = "gdm-feature-value-stage0-child/v1" as const;
export const POINTER_SCHEMA = "gdm-feature-value-stage0-pointer/v1" as const;
export const MANIFEST_SCHEMA = "gdm-feature-value-stage0-manifest/v1" as const;
export const RETENTION = "hashes-counts-bytes-timings-no-bodies" as const;
export const REGISTRATION_ARMS = ["baseline", "memory", "computer-use", "both", "status", "all"] as const;
export const MEMORY_SCENARIOS = ["empty", "irrelevant-10", "irrelevant-200", "relevant-200"] as const;
export const SOURCE_IDS = [
  "protocol", "probe-child", "stage0", "result", "publisher", "verifier", "static-check",
  "memory-core", "memory-store", "memory-extension", "computer-use-extension", "computer-use-vm",
  "source-launcher", "installed-launcher", "installed-memory-extension", "installed-computer-use-extension",
  "status-extension", "context-v2-pointer", "context-v2-summary", "context-v2-assessor", "context-v2-evaluation",
] as const;
export const REGISTRATION_REPETITIONS = 10;
export const MEMORY_SELECTION_ITERATIONS = 1000;
export const MEMORY_STORE_READ_ITERATIONS = 100;
export const CU_LIVE_TRIALS = 3;

export type RegistrationArm = typeof REGISTRATION_ARMS[number];
export type MemoryScenarioId = typeof MEMORY_SCENARIOS[number];
export type SourceId = typeof SOURCE_IDS[number];

export interface Distribution {
  readonly samples: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

export interface ChildProbe {
  readonly schemaVersion: typeof CHILD_SCHEMA;
  readonly arm: RegistrationArm;
  readonly loadMs: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly toolCount: number;
  readonly toolSchemaBytes: number;
  readonly promptMetadataBytes: number;
  readonly toolDefinitionBytes: number;
  readonly statusIntervalMs: number | null;
  readonly statusFetchCalls: number;
  readonly statusSetCalls: number;
  readonly statusFormattingValid: boolean | null;
  readonly statusProviderHideValid: boolean | null;
}

export interface SourceArtifact {
  readonly id: SourceId;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RegistrationArmSummary {
  readonly arm: RegistrationArm;
  readonly repetitions: number;
  readonly toolCount: number;
  readonly toolSchemaBytes: number;
  readonly promptMetadataBytes: number;
  readonly toolDefinitionBytes: number;
  readonly statusIntervalMs: number | null;
  readonly statusFetchCalls: number;
  readonly statusSetCalls: number;
  readonly statusFormattingValid: boolean | null;
  readonly statusProviderHideValid: boolean | null;
  readonly processWallMs: Distribution;
  readonly loadMs: Distribution;
  readonly cpuUserMicros: Distribution;
  readonly cpuSystemMicros: Distribution;
  readonly rssBytes: Distribution;
  readonly heapUsedBytes: Distribution;
}

export interface MemoryScenarioSummary {
  readonly id: MemoryScenarioId;
  readonly totalEntries: number;
  readonly selectedProject: number;
  readonly selectedGlobal: number;
  readonly renderedChars: number;
  readonly renderedBytes: number;
  readonly selectedSha256: string;
  readonly storeBytes: number;
  readonly relevantEntryFirst: boolean | null;
  readonly selectionMs: Distribution;
  readonly storeReadMs: Distribution;
}

export interface ComputerUseTrial {
  readonly trial: number;
  readonly startMs: number;
  readonly screenshotMs: number;
  readonly guiMutationMs: number;
  readonly stopMs: number;
  readonly pngBytes: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly vmProcessCount: number;
  readonly vmRssBytes: number;
  readonly vmCpuPercent: number;
  readonly vmDiskBytesBefore: number;
  readonly vmDiskBytesAfter: number;
  readonly hostFocusChanges: number;
  readonly hostTcpListenerLines: number;
  readonly hostSentinelCreated: boolean;
  readonly guestWriteVerified: boolean;
  readonly cleanupVerified: boolean;
  readonly failureCode: "host-focus-changed" | "host-tcp-listener" | "host-sentinel-created" | "guest-write-failed" | "cleanup-failed" | "runtime-error" | null;
  readonly valid: boolean;
}

export interface Stage0Summary {
  readonly schemaVersion: typeof SUMMARY_SCHEMA;
  readonly protocol: typeof PROTOCOL;
  readonly scale: "local-stage0";
  readonly runId: string;
  readonly createdAt: string;
  readonly retention: typeof RETENTION;
  readonly measurementScope: "cost-and-safety-only";
  readonly utilityConclusion: "not-measured";
  readonly freshInputConclusion: "not-measured";
  readonly promotionEligible: false;
  readonly removalEligible: false;
  readonly defaultActivation: "unchanged";
  readonly source: readonly SourceArtifact[];
  readonly sourceSha256: string;
  readonly registration: {
    readonly repetitions: number;
    readonly arms: readonly RegistrationArmSummary[];
  };
  readonly memory: {
    readonly syntheticOnly: true;
    readonly corpusSha256: string;
    readonly selectionIterations: number;
    readonly storeReadIterations: number;
    readonly zeroOverlapInjects: boolean;
    readonly scenarios: readonly MemoryScenarioSummary[];
  };
  readonly computerUse: {
    readonly trialsPlanned: number;
    readonly trials: readonly ComputerUseTrial[];
    readonly safetyViolations: number;
    readonly liveValid: boolean;
  };
  readonly statusline: {
    readonly measurementScope: "display-extension-only";
    readonly piCodexLimitIncluded: false;
    readonly qualityConclusion: "not-measured";
    readonly available: boolean;
    readonly intervalMs: number | null;
    readonly fetchCalls: number;
    readonly formattingValid: boolean;
    readonly providerHideValid: boolean;
  };
  readonly contextCarryForward: {
    readonly measurementValid: false;
    readonly validRuns: number;
    readonly totalRuns: number;
    readonly tokenConclusion: "invalid-not-evidence";
    readonly promotionEligible: false;
    readonly defaultActivation: "blocked";
  };
  readonly gates: {
    readonly sourceBound: boolean;
    readonly syntheticOnly: boolean;
    readonly bodyFree: boolean;
    readonly registrationComplete: boolean;
    readonly memoryComplete: boolean;
    readonly statusComplete: boolean;
    readonly contextCarryForwardValid: boolean;
    readonly computerUseComplete: boolean;
    readonly computerUseSafety: boolean;
  };
  readonly measurementValid: boolean;
  readonly stage1Eligible: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FORBIDDEN_KEYS = /^(?:text|body|content|prompt|response|args|arguments|toolArgument|toolArguments|toolResult|toolResults|memoryText|evidenceBody|credential|credentials|secret|secrets)$/iu;
const SECRET_VALUE = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:gh[opusr]_|github_pat_|sk-|xox[abprs]-)[A-Za-z0-9_-]{12,}|(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+)/iu;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function finite(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isInteger(value) && (value as number) >= minimum;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0 || values.some((value) => !finite(value))) throw new Error("distribution requires finite non-negative samples");
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    samples: sorted.length,
    min: sorted[0]!,
    median: quantile(0.5),
    p95: quantile(0.95),
    max: sorted.at(-1)!,
  };
}

function validDistribution(value: unknown, samples?: number): value is Distribution {
  if (!isRecord(value) || !exactKeys(value, ["samples", "min", "median", "p95", "max"]) ||
      !integer(value.samples, 1) || !finite(value.min) || !finite(value.median) || !finite(value.p95) || !finite(value.max)) return false;
  return (samples === undefined || value.samples === samples) && value.min <= value.median && value.median <= value.p95 && value.p95 <= value.max;
}

export function scanSensitive(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) {
      if (typeof candidate === "string" && SECRET_VALUE.test(candidate)) throw new Error("secret-shaped value is forbidden");
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      if (FORBIDDEN_KEYS.test(key)) throw new Error(`raw body key is forbidden: ${key}`);
      visit(item);
    }
  };
  visit(value);
}

export function acceptChildProbe(value: unknown, expectedArm?: RegistrationArm): ChildProbe | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "arm", "loadMs", "cpuUserMicros", "cpuSystemMicros", "rssBytes", "heapUsedBytes",
    "toolCount", "toolSchemaBytes", "promptMetadataBytes", "toolDefinitionBytes", "statusIntervalMs",
    "statusFetchCalls", "statusSetCalls", "statusFormattingValid", "statusProviderHideValid",
  ])) return null;
  if (value.schemaVersion !== CHILD_SCHEMA || !REGISTRATION_ARMS.includes(value.arm as RegistrationArm) ||
      (expectedArm !== undefined && value.arm !== expectedArm) || !finite(value.loadMs) ||
      !integer(value.cpuUserMicros) || !integer(value.cpuSystemMicros) || !integer(value.rssBytes) || !integer(value.heapUsedBytes) ||
      !integer(value.toolCount) || !integer(value.toolSchemaBytes) || !integer(value.promptMetadataBytes) || !integer(value.toolDefinitionBytes) ||
      (value.statusIntervalMs !== null && !integer(value.statusIntervalMs, 1)) || !integer(value.statusFetchCalls) || !integer(value.statusSetCalls) ||
      (value.statusFormattingValid !== null && typeof value.statusFormattingValid !== "boolean") ||
      (value.statusProviderHideValid !== null && typeof value.statusProviderHideValid !== "boolean")) return null;
  try { scanSensitive(value); } catch { return null; }
  return value as unknown as ChildProbe;
}

function validSource(value: unknown): value is SourceArtifact {
  return isRecord(value) && exactKeys(value, ["id", "sha256", "bytes"]) && SOURCE_IDS.includes(value.id as SourceId) && digest(value.sha256) && integer(value.bytes, 1);
}

function validRegistrationArm(value: unknown, repetitions: number): value is RegistrationArmSummary {
  if (!isRecord(value) || !exactKeys(value, [
    "arm", "repetitions", "toolCount", "toolSchemaBytes", "promptMetadataBytes", "toolDefinitionBytes",
    "statusIntervalMs", "statusFetchCalls", "statusSetCalls", "statusFormattingValid", "statusProviderHideValid",
    "processWallMs", "loadMs", "cpuUserMicros", "cpuSystemMicros", "rssBytes", "heapUsedBytes",
  ])) return false;
  return REGISTRATION_ARMS.includes(value.arm as RegistrationArm) && value.repetitions === repetitions &&
    integer(value.toolCount) && integer(value.toolSchemaBytes) && integer(value.promptMetadataBytes) && integer(value.toolDefinitionBytes) &&
    (value.statusIntervalMs === null || integer(value.statusIntervalMs, 1)) && integer(value.statusFetchCalls) && integer(value.statusSetCalls) &&
    (value.statusFormattingValid === null || typeof value.statusFormattingValid === "boolean") &&
    (value.statusProviderHideValid === null || typeof value.statusProviderHideValid === "boolean") &&
    validDistribution(value.processWallMs, repetitions) && validDistribution(value.loadMs, repetitions) &&
    validDistribution(value.cpuUserMicros, repetitions) && validDistribution(value.cpuSystemMicros, repetitions) &&
    validDistribution(value.rssBytes, repetitions) && validDistribution(value.heapUsedBytes, repetitions);
}

function validMemoryScenario(value: unknown, selectionIterations: number, readIterations: number): value is MemoryScenarioSummary {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "totalEntries", "selectedProject", "selectedGlobal", "renderedChars", "renderedBytes", "selectedSha256",
    "storeBytes", "relevantEntryFirst", "selectionMs", "storeReadMs",
  ])) return false;
  return MEMORY_SCENARIOS.includes(value.id as MemoryScenarioId) && integer(value.totalEntries) && integer(value.selectedProject) &&
    integer(value.selectedGlobal) && integer(value.renderedChars) && integer(value.renderedBytes) && digest(value.selectedSha256) &&
    integer(value.storeBytes) && (value.relevantEntryFirst === null || typeof value.relevantEntryFirst === "boolean") &&
    validDistribution(value.selectionMs, selectionIterations) && validDistribution(value.storeReadMs, readIterations);
}

function validComputerUseTrial(value: unknown): value is ComputerUseTrial {
  if (!isRecord(value) || !exactKeys(value, [
    "trial", "startMs", "screenshotMs", "guiMutationMs", "stopMs", "pngBytes", "frameWidth", "frameHeight",
    "vmProcessCount", "vmRssBytes", "vmCpuPercent", "vmDiskBytesBefore", "vmDiskBytesAfter", "hostFocusChanges",
    "hostTcpListenerLines", "hostSentinelCreated", "guestWriteVerified", "cleanupVerified", "failureCode", "valid",
  ])) return false;
  const failureCodes = ["host-focus-changed", "host-tcp-listener", "host-sentinel-created", "guest-write-failed", "cleanup-failed", "runtime-error", null];
  return integer(value.trial, 1) && finite(value.startMs) && finite(value.screenshotMs) && finite(value.guiMutationMs) && finite(value.stopMs) &&
    integer(value.pngBytes) && integer(value.frameWidth) && integer(value.frameHeight) && integer(value.vmProcessCount) && integer(value.vmRssBytes) &&
    finite(value.vmCpuPercent) && integer(value.vmDiskBytesBefore) && integer(value.vmDiskBytesAfter) && integer(value.hostFocusChanges) &&
    integer(value.hostTcpListenerLines) && typeof value.hostSentinelCreated === "boolean" && typeof value.guestWriteVerified === "boolean" &&
    typeof value.cleanupVerified === "boolean" && failureCodes.includes(value.failureCode as never) && typeof value.valid === "boolean";
}

export function acceptStage0Summary(value: unknown): Stage0Summary | null {
  try { scanSensitive(value); } catch { return null; }
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "protocol", "scale", "runId", "createdAt", "retention", "measurementScope", "utilityConclusion",
    "freshInputConclusion", "promotionEligible", "removalEligible", "defaultActivation", "source", "sourceSha256",
    "registration", "memory", "computerUse", "statusline", "contextCarryForward", "gates", "measurementValid", "stage1Eligible",
  ])) return null;
  if (value.schemaVersion !== SUMMARY_SCHEMA || value.protocol !== PROTOCOL || value.scale !== "local-stage0" ||
      typeof value.runId !== "string" || !HEX32.test(value.runId) || typeof value.createdAt !== "string" || !ISO.test(value.createdAt) ||
      value.retention !== RETENTION || value.measurementScope !== "cost-and-safety-only" || value.utilityConclusion !== "not-measured" ||
      value.freshInputConclusion !== "not-measured" || value.promotionEligible !== false || value.removalEligible !== false ||
      value.defaultActivation !== "unchanged" || !Array.isArray(value.source) || value.source.length !== SOURCE_IDS.length ||
      !value.source.every(validSource) || new Set(value.source.map((entry) => entry.id)).size !== SOURCE_IDS.length || !digest(value.sourceSha256)) return null;
  const source = value.source as unknown as SourceArtifact[];
  if (JSON.stringify(source.map((entry) => entry.id).sort()) !== JSON.stringify([...SOURCE_IDS].sort()) ||
      value.sourceSha256 !== sha256(JSON.stringify(source))) return null;

  const registration = value.registration;
  if (!isRecord(registration) || !exactKeys(registration, ["repetitions", "arms"]) ||
      !integer(registration.repetitions, 1) || !Array.isArray(registration.arms) || registration.arms.length !== REGISTRATION_ARMS.length ||
      !registration.arms.every((arm) => validRegistrationArm(arm, registration.repetitions as number)) ||
      JSON.stringify((registration.arms as RegistrationArmSummary[]).map((arm) => arm.arm).sort()) !== JSON.stringify([...REGISTRATION_ARMS].sort())) return null;

  const memory = value.memory;
  if (!isRecord(memory) || !exactKeys(memory, [
    "syntheticOnly", "corpusSha256", "selectionIterations", "storeReadIterations", "zeroOverlapInjects", "scenarios",
  ]) || memory.syntheticOnly !== true || !digest(memory.corpusSha256) || !integer(memory.selectionIterations, 1) ||
      !integer(memory.storeReadIterations, 1) || typeof memory.zeroOverlapInjects !== "boolean" ||
      !Array.isArray(memory.scenarios) || memory.scenarios.length !== MEMORY_SCENARIOS.length ||
      !memory.scenarios.every((scenario) => validMemoryScenario(scenario, memory.selectionIterations as number, memory.storeReadIterations as number)) ||
      JSON.stringify((memory.scenarios as MemoryScenarioSummary[]).map((scenario) => scenario.id).sort()) !== JSON.stringify([...MEMORY_SCENARIOS].sort())) return null;

  if (!isRecord(value.computerUse) || !exactKeys(value.computerUse, ["trialsPlanned", "trials", "safetyViolations", "liveValid"]) ||
      !integer(value.computerUse.trialsPlanned, 1) || !Array.isArray(value.computerUse.trials) || value.computerUse.trials.length < 1 ||
      value.computerUse.trials.length > value.computerUse.trialsPlanned || !value.computerUse.trials.every(validComputerUseTrial) ||
      !integer(value.computerUse.safetyViolations) || typeof value.computerUse.liveValid !== "boolean") return null;

  if (!isRecord(value.statusline) || !exactKeys(value.statusline, [
    "measurementScope", "piCodexLimitIncluded", "qualityConclusion", "available", "intervalMs", "fetchCalls", "formattingValid", "providerHideValid",
  ]) || value.statusline.measurementScope !== "display-extension-only" || value.statusline.piCodexLimitIncluded !== false ||
      value.statusline.qualityConclusion !== "not-measured" || typeof value.statusline.available !== "boolean" ||
      (value.statusline.intervalMs !== null && !integer(value.statusline.intervalMs, 1)) || !integer(value.statusline.fetchCalls) ||
      typeof value.statusline.formattingValid !== "boolean" || typeof value.statusline.providerHideValid !== "boolean") return null;

  if (!isRecord(value.contextCarryForward) || !exactKeys(value.contextCarryForward, [
    "measurementValid", "validRuns", "totalRuns", "tokenConclusion", "promotionEligible", "defaultActivation",
  ]) || value.contextCarryForward.measurementValid !== false || !integer(value.contextCarryForward.validRuns) ||
      !integer(value.contextCarryForward.totalRuns, 1) || value.contextCarryForward.validRuns > value.contextCarryForward.totalRuns ||
      value.contextCarryForward.tokenConclusion !== "invalid-not-evidence" || value.contextCarryForward.promotionEligible !== false ||
      value.contextCarryForward.defaultActivation !== "blocked") return null;

  if (!isRecord(value.gates) || !exactKeys(value.gates, [
    "sourceBound", "syntheticOnly", "bodyFree", "registrationComplete", "memoryComplete", "statusComplete",
    "contextCarryForwardValid", "computerUseComplete", "computerUseSafety",
  ]) || Object.values(value.gates).some((gate) => typeof gate !== "boolean") || typeof value.measurementValid !== "boolean" ||
      typeof value.stage1Eligible !== "boolean") return null;
  const allGates = Object.values(value.gates).every((gate) => gate === true);
  if (value.measurementValid !== allGates || value.stage1Eligible !== allGates) return null;
  return value as unknown as Stage0Summary;
}
