import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentHookEnvironment } from "./codex-agent-hooks-config.ts";

export const AGENT_ENVELOPE_PREFIX = "GDM_AGENT_ENVELOPE_V1=";
export const AGENT_LEDGER_SCHEMA_VERSION = 1;
export const AGENT_SESSION_INITIAL_ATTEMPT_LIMIT = 16;
export const AGENT_SESSION_ATTEMPT_EXTENSION_SIZE = 4;
export const AGENT_SESSION_HARD_ATTEMPT_LIMIT = 32;
export const AGENT_PRE_ACK_TTL_MS = 60_000;
export const AGENT_RESERVATION_TTL_MS = 30 * 60 * 1_000;

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const EXACT_SPAWN_TOOLS = new Set([
  "Agent",
  "spawn_agent",
  "collaborationspawn_agent",
  "collaboration.spawn_agent",
]);
const SPAWN_AGENT_TOOL_SUFFIX = "spawn_agent";
const FLAT_NAMESPACE_SPAWN_TOOL =
  /^[A-Za-z0-9_-]{1,64}spawn_agent$/u;
const RESERVED_RESPONSES_TOOL_NAMESPACES = new Set([
  "api_tool",
  "browser",
  "computer",
  "container",
  "file_search",
  "functions",
  "image_gen",
  "multi_tool_use",
  "python",
  "python_user_visible",
  "submodel_delegator",
  "terminal",
  "tool_search",
  "web",
]);
const ACTIVE_RESERVATION_STATES = new Set<ReservationState>(["pending", "running"]);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

type JsonObject = { [key: string]: unknown };
type ReservationState = "pending" | "running" | "failed" | "stopped" | "expired";
type ReservationContractMode = "structured" | "unstructured";
type SpawnProtocol = "v1" | "v2";
type AgentState = "pending" | "running" | "stopped";
type PostOutcome = "succeeded" | "failed";
type AgentLinkAuthority = "provisional" | "post" | "caller" | "serialized-v2";

export type AgentEnvelope = {
  readonly taskId: string;
  readonly parentId: string;
  readonly role: string;
  readonly scope: string;
  readonly ownership: {
    readonly mode: "read" | "write";
    readonly resources: readonly string[];
  };
  readonly deliverable: string;
  readonly verify: string;
  readonly stopWhen: string;
  readonly canDelegate: boolean;
  readonly childQuota: number;
  readonly depth: number;
  readonly blockedBy: readonly string[];
};

type Reservation = {
  toolUseId: string;
  toolInputDigest: string;
  contractMode: ReservationContractMode;
  spawnProtocol?: SpawnProtocol;
  taskName?: string;
  envelope: AgentEnvelope;
  state: ReservationState;
  reservedAt: string;
  expiresAt: string;
  postOutcome?: PostOutcome;
  postObservedAt?: string;
  postResponseDigest?: string;
  callerAgentId?: string;
  agentId?: string;
  agentLinkAuthority?: AgentLinkAuthority;
  stoppedAt?: string;
  failureReason?: string;
};

type AgentObservation = {
  agentId: string;
  agentType: string;
  state: AgentState;
  firstObservedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  reservationToolUseId?: string;
};

type OrphanPost = {
  toolUseId: string;
  toolInputDigest?: string;
  responseDigest?: string;
  spawnProtocol?: SpawnProtocol;
  taskName?: string;
  outcome: PostOutcome;
  observedAt: string;
  callerAgentId?: string;
  agentId?: string;
};

export type AgentLedgerV1 = {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  totalAcceptedAttempts: number;
  reservations: Record<string, Reservation>;
  agents: Record<string, AgentObservation>;
  orphanPosts: Record<string, OrphanPost>;
};

export type AgentHookLedgerSummary = {
  readonly schemaVersion: 1;
  readonly directory: string;
  readonly sessions: number;
  readonly corruptLedgers: number;
  readonly totalAcceptedAttempts: number;
  readonly structuredAttempts: number;
  readonly unstructuredAttempts: number;
  readonly pending: number;
  readonly running: number;
  readonly stopped: number;
  readonly failed: number;
  readonly expired: number;
  readonly initialSessionAttemptLimit: number;
  readonly attemptExtensionSize: number;
  readonly hardSessionAttemptLimit: number;
  readonly preAcknowledgementTtlMs: number;
  readonly lifecycleLeaseMs: number;
  readonly parentDelegationEnforcement:
    "caller-bound when agent_id is present; declaration-based compatibility fallback otherwise";
  readonly subagentStopSemantics:
    "turn-stop sequencing hint only; it is not thread termination or verified completion";
  readonly lifecycleAssociation:
    "V1 lifecycle-only association is provisional; V2 serialized handshakes associate turns; reuse and interrupt remain cooperative";
};

export class AgentHookStateError extends Error {
  readonly code:
    | "agent_hook_input_invalid"
    | "agent_envelope_invalid"
    | "agent_state_home_missing"
    | "agent_state_path_invalid"
    | "agent_state_corrupt"
    | "agent_state_lock_timeout";

  constructor(message: string, code: AgentHookStateError["code"]) {
    super(message);
    this.name = "AgentHookStateError";
    this.code = code;
  }
}

export type AgentHookOutput = JsonObject;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function pathEntryExists(path: string): boolean {
  return lstatIfExists(path) !== undefined;
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function recordGet<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function recordSet<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function sleep(milliseconds: number): void {
  Atomics.wait(sleepCell, 0, 0, milliseconds);
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exactKeys(object: JsonObject, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(object).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !hasOwn(object, key));
  if (unknown.length > 0 || missing.length > 0) {
    const details = [
      unknown.length > 0 ? `unknown=${unknown.join(",")}` : "",
      missing.length > 0 ? `missing=${missing.join(",")}` : "",
    ].filter((part) => part.length > 0);
    throw new AgentHookStateError(
      `${label} fields are invalid (${details.join("; ")})`,
      "agent_envelope_invalid",
    );
  }
}

function requiredString(
  object: JsonObject,
  key: string,
  exact = false,
): string {
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    (exact && value !== value.trim())
  ) {
    throw new AgentHookStateError(
      `${key} must be a non-empty string${exact ? " without surrounding whitespace" : ""}`,
      "agent_envelope_invalid",
    );
  }
  return value;
}

function stringArray(
  object: JsonObject,
  key: string,
  requireItem = false,
  exact = false,
): string[] {
  const value = object[key];
  if (
    !Array.isArray(value) ||
    (requireItem && value.length === 0) ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0 ||
        (exact && item !== item.trim()),
    )
  ) {
    throw new AgentHookStateError(
      `${key} must be ${requireItem ? "a non-empty " : "an "}array of non-empty strings` +
        `${exact ? " without surrounding whitespace" : ""}`,
      "agent_envelope_invalid",
    );
  }
  return [...value] as string[];
}

export function parseAgentEnvelope(message: string): AgentEnvelope {
  const lines = message.split(/\r?\n/u);
  const line = lines[0] ?? "";
  if (!line.startsWith(AGENT_ENVELOPE_PREFIX)) {
    throw new AgentHookStateError(
      `${AGENT_ENVELOPE_PREFIX} must begin the first message line`,
      "agent_envelope_invalid",
    );
  }
  if (lines.slice(1).some((candidate) => candidate.startsWith(AGENT_ENVELOPE_PREFIX))) {
    throw new AgentHookStateError(
      `message must not contain an additional ${AGENT_ENVELOPE_PREFIX} line`,
      "agent_envelope_invalid",
    );
  }
  const jsonText = line.slice(AGENT_ENVELOPE_PREFIX.length);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    throw new AgentHookStateError(
      `agent envelope must be single-line JSON: ${errorMessage(error)}`,
      "agent_envelope_invalid",
    );
  }
  if (!isObject(raw)) {
    throw new AgentHookStateError(
      "agent envelope must be a JSON object",
      "agent_envelope_invalid",
    );
  }
  exactKeys(
    raw,
    [
      "taskId",
      "parentId",
      "role",
      "scope",
      "ownership",
      "deliverable",
      "verify",
      "stopWhen",
      "canDelegate",
      "childQuota",
      "depth",
      "blockedBy",
    ],
    "agent envelope",
  );
  const ownership = raw.ownership;
  if (!isObject(ownership)) {
    throw new AgentHookStateError(
      "ownership must be an object",
      "agent_envelope_invalid",
    );
  }
  exactKeys(ownership, ["mode", "resources"], "ownership");
  if (ownership.mode !== "read" && ownership.mode !== "write") {
    throw new AgentHookStateError(
      "ownership.mode must be read or write",
      "agent_envelope_invalid",
    );
  }
  if (typeof raw.canDelegate !== "boolean") {
    throw new AgentHookStateError(
      "canDelegate must be a boolean",
      "agent_envelope_invalid",
    );
  }
  if (
    !Number.isInteger(raw.childQuota) ||
    typeof raw.childQuota !== "number" ||
    raw.childQuota < 0 ||
    raw.childQuota > 2
  ) {
    throw new AgentHookStateError(
      "childQuota must be an integer from 0 through 2",
      "agent_envelope_invalid",
    );
  }
  if (
    !Number.isInteger(raw.depth) ||
    typeof raw.depth !== "number" ||
    raw.depth < 1 ||
    raw.depth > 3
  ) {
    throw new AgentHookStateError(
      "depth must be an integer from 1 through 3",
      "agent_envelope_invalid",
    );
  }
  return {
    taskId: requiredString(raw, "taskId", true),
    parentId: requiredString(raw, "parentId", true),
    role: requiredString(raw, "role"),
    scope: requiredString(raw, "scope", true),
    ownership: {
      mode: ownership.mode,
      resources: stringArray(ownership, "resources", true, true),
    },
    deliverable: requiredString(raw, "deliverable"),
    verify: requiredString(raw, "verify"),
    stopWhen: requiredString(raw, "stopWhen"),
    canDelegate: raw.canDelegate,
    childQuota: raw.childQuota,
    depth: raw.depth,
    blockedBy: stringArray(raw, "blockedBy", false, true),
  };
}

function codexHome(cwd: string, env: AgentHookEnvironment): string {
  if (env.CODEX_HOME !== undefined && env.CODEX_HOME.length > 0) {
    return isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : resolve(cwd, env.CODEX_HOME);
  }
  if (env.HOME === undefined || env.HOME.length === 0) {
    throw new AgentHookStateError(
      "CODEX_HOME or HOME is required",
      "agent_state_home_missing",
    );
  }
  return join(env.HOME, ".codex");
}

export function agentLedgerDirectory(
  cwd: string,
  env: AgentHookEnvironment,
): string {
  return join(codexHome(cwd, env), "gdm", "agent-ledgers");
}

export function agentLedgerPath(
  cwd: string,
  env: AgentHookEnvironment,
  sessionId: string,
): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(agentLedgerDirectory(cwd, env), `${digest}.json`);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentHookStateError(
      `agent state path is not a regular directory: ${path}`,
      "agent_state_path_invalid",
    );
  }
  chmodSync(path, 0o700);
}

function ensureLedgerDirectories(cwd: string, env: AgentHookEnvironment): string {
  const root = join(codexHome(cwd, env), "gdm");
  ensurePrivateDirectory(root);
  const ledgers = join(root, "agent-ledgers");
  ensurePrivateDirectory(ledgers);
  return ledgers;
}

function assertRegularStateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AgentHookStateError(
      `agent state path is not a regular file: ${path}`,
      "agent_state_path_invalid",
    );
  }
}

function defaultLedger(timestamp: number): AgentLedgerV1 {
  const time = iso(timestamp);
  return {
    schemaVersion: 1,
    createdAt: time,
    updatedAt: time,
    totalAcceptedAttempts: 0,
    reservations: Object.create(null) as Record<string, Reservation>,
    agents: Object.create(null) as Record<string, AgentObservation>,
    orphanPosts: Object.create(null) as Record<string, OrphanPost>,
  };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validExactId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validReservation(value: unknown, key: string): value is Reservation {
  if (!isObject(value)) return false;
  if (
    value.toolUseId !== key ||
    !validExactId(value.toolUseId) ||
    !validDigest(value.toolInputDigest) ||
    (value.contractMode !== "structured" && value.contractMode !== "unstructured") ||
    (value.spawnProtocol !== undefined &&
      value.spawnProtocol !== "v1" &&
      value.spawnProtocol !== "v2") ||
    (value.spawnProtocol === "v2"
      ? !validExactId(value.taskName)
      : value.taskName !== undefined) ||
    typeof value.state !== "string" ||
    !["pending", "running", "failed", "stopped", "expired"].includes(value.state) ||
    !validTimestamp(value.reservedAt) ||
    !validTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) < Date.parse(value.reservedAt) ||
    (value.postOutcome !== undefined &&
      value.postOutcome !== "succeeded" &&
      value.postOutcome !== "failed") ||
    (value.postObservedAt !== undefined && !validTimestamp(value.postObservedAt)) ||
    (value.postResponseDigest !== undefined && !validDigest(value.postResponseDigest)) ||
    (value.callerAgentId !== undefined && !validExactId(value.callerAgentId)) ||
    (value.agentId !== undefined && !validExactId(value.agentId)) ||
    (value.agentLinkAuthority !== undefined &&
      value.agentLinkAuthority !== "provisional" &&
      value.agentLinkAuthority !== "post" &&
      value.agentLinkAuthority !== "caller" &&
      value.agentLinkAuthority !== "serialized-v2") ||
    (value.stoppedAt !== undefined && !validTimestamp(value.stoppedAt)) ||
    (value.failureReason !== undefined && typeof value.failureReason !== "string") ||
    ((value.postOutcome === undefined) !== (value.postObservedAt === undefined)) ||
    (value.postResponseDigest !== undefined && value.postOutcome === undefined) ||
    (value.agentLinkAuthority !== undefined && value.agentId === undefined) ||
    (value.state === "stopped" && value.stoppedAt === undefined) ||
    (value.state !== "stopped" && value.stoppedAt !== undefined) ||
    (value.postResponseDigest !== undefined &&
      value.postOutcome === "succeeded" &&
      value.state !== "running" &&
      value.state !== "stopped" &&
      value.state !== "expired") ||
    (value.postResponseDigest !== undefined &&
      value.postOutcome === "failed" &&
      value.state !== "failed" &&
      value.state !== "running" &&
      value.state !== "expired")
  ) {
    return false;
  }
  try {
    validateStoredEnvelope(value.envelope);
  } catch {
    return false;
  }
  return true;
}

function validateStoredEnvelope(value: unknown): AgentEnvelope {
  if (!isObject(value)) {
    throw new AgentHookStateError("stored envelope is invalid", "agent_state_corrupt");
  }
  const encoded = `${AGENT_ENVELOPE_PREFIX}${JSON.stringify(value)}`;
  try {
    return parseAgentEnvelope(encoded);
  } catch (error) {
    throw new AgentHookStateError(
      `stored envelope is invalid: ${errorMessage(error)}`,
      "agent_state_corrupt",
    );
  }
}

function validAgent(value: unknown, key: string): value is AgentObservation {
  return (
    isObject(value) &&
    value.agentId === key &&
    validExactId(value.agentId) &&
    typeof value.agentType === "string" &&
    (value.state === "pending" || value.state === "running" || value.state === "stopped") &&
    validTimestamp(value.firstObservedAt) &&
    (value.startedAt === undefined ||
      validTimestamp(value.startedAt)) &&
    (value.stoppedAt === undefined ||
      validTimestamp(value.stoppedAt)) &&
    (value.startedAt === undefined ||
      Date.parse(value.startedAt) >= Date.parse(value.firstObservedAt)) &&
    (value.stoppedAt === undefined ||
      Date.parse(value.stoppedAt) >= Date.parse(value.firstObservedAt)) &&
    (value.startedAt === undefined ||
      value.stoppedAt === undefined ||
      Date.parse(value.stoppedAt) >= Date.parse(value.startedAt)) &&
    (value.reservationToolUseId === undefined ||
      validExactId(value.reservationToolUseId)) &&
    (value.state === "stopped" ? value.stoppedAt !== undefined : value.stoppedAt === undefined)
  );
}

function validOrphanPost(value: unknown, key: string): value is OrphanPost {
  return (
    isObject(value) &&
    value.toolUseId === key &&
    validExactId(value.toolUseId) &&
    (value.toolInputDigest === undefined || validDigest(value.toolInputDigest)) &&
    (value.responseDigest === undefined || validDigest(value.responseDigest)) &&
    ((value.toolInputDigest === undefined) ===
      (value.responseDigest === undefined)) &&
    (value.spawnProtocol === undefined ||
      value.spawnProtocol === "v1" ||
      value.spawnProtocol === "v2") &&
    (value.spawnProtocol === "v2"
      ? validExactId(value.taskName)
      : value.taskName === undefined) &&
    (value.outcome === "succeeded" || value.outcome === "failed") &&
    validTimestamp(value.observedAt) &&
    (value.callerAgentId === undefined || validExactId(value.callerAgentId)) &&
    (value.agentId === undefined || validExactId(value.agentId))
  );
}

function recordValuesAre<T>(
  value: unknown,
  validator: (entry: unknown, key: string) => entry is T,
): value is Record<string, T> {
  return (
    isObject(value) &&
    Object.entries(value).every(([key, entry]) => validator(entry, key))
  );
}

function validateLedger(value: unknown, path: string): AgentLedgerV1 {
  if (
    !isObject(value) ||
    value.schemaVersion !== AGENT_LEDGER_SCHEMA_VERSION ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    typeof value.totalAcceptedAttempts !== "number" ||
    !Number.isSafeInteger(value.totalAcceptedAttempts) ||
    value.totalAcceptedAttempts < 0 ||
    !recordValuesAre(value.reservations, validReservation) ||
    !recordValuesAre(value.agents, validAgent) ||
    !recordValuesAre(value.orphanPosts, validOrphanPost)
  ) {
    throw new AgentHookStateError(
      `agent ledger is corrupt: ${path}`,
      "agent_state_corrupt",
    );
  }
  const ledger = value as AgentLedgerV1;
  const reservations = Object.values(ledger.reservations);
  if (ledger.totalAcceptedAttempts !== reservations.length) {
    throw new AgentHookStateError(
      `agent ledger attempt count is inconsistent: ${path}`,
      "agent_state_corrupt",
    );
  }
  const taskIds = new Set<string>();
  for (const reservation of reservations) {
    if (taskIds.has(reservation.envelope.taskId)) {
      throw new AgentHookStateError(
        `agent ledger contains duplicate task ids: ${path}`,
        "agent_state_corrupt",
      );
    }
    taskIds.add(reservation.envelope.taskId);
    if (reservation.agentId === undefined) continue;
    const agent = recordGet(ledger.agents, reservation.agentId);
    if (agent?.reservationToolUseId !== reservation.toolUseId) {
      throw new AgentHookStateError(
        `agent ledger reservation link is inconsistent: ${path}`,
        "agent_state_corrupt",
      );
    }
    if (
      reservation.state === "stopped" &&
      (reservation.agentLinkAuthority === "provisional" ||
        agent.state !== "stopped")
    ) {
      throw new AgentHookStateError(
        `agent ledger stopped state is inconsistent: ${path}`,
        "agent_state_corrupt",
      );
    }
  }
  for (const agent of Object.values(ledger.agents)) {
    if (agent.reservationToolUseId === undefined) continue;
    const reservation = recordGet(ledger.reservations, agent.reservationToolUseId);
    if (reservation?.agentId !== agent.agentId) {
      throw new AgentHookStateError(
        `agent ledger agent link is inconsistent: ${path}`,
        "agent_state_corrupt",
      );
    }
  }
  return ledger;
}

function validateLedgerBounds(ledger: AgentLedgerV1, path: string): void {
  if (
    Object.keys(ledger.orphanPosts).length > AGENT_SESSION_HARD_ATTEMPT_LIMIT ||
    Object.values(ledger.agents).filter(
      (agent) => agent.reservationToolUseId === undefined,
    ).length > AGENT_SESSION_HARD_ATTEMPT_LIMIT
  ) {
    throw new AgentHookStateError(
      `agent ledger exceeds bounded auxiliary records: ${path}`,
      "agent_state_corrupt",
    );
  }
}

function migrateLedgerV1(ledger: AgentLedgerV1): boolean {
  let changed = false;
  for (const reservation of Object.values(ledger.reservations)) {
    if (reservation.agentId !== undefined && reservation.agentLinkAuthority === undefined) {
      reservation.agentLinkAuthority = "provisional";
      changed = true;
    }
    if (
      reservation.state === "stopped" &&
      reservation.agentLinkAuthority !== "post" &&
      reservation.agentLinkAuthority !== "caller" &&
      reservation.agentLinkAuthority !== "serialized-v2"
    ) {
      reservation.state =
        reservation.postOutcome === "failed" ? "failed" : "running";
      delete reservation.stoppedAt;
      changed = true;
    }
  }
  const orphanPosts = Object.values(ledger.orphanPosts).sort(
    (left, right) =>
      Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
      left.toolUseId.localeCompare(right.toolUseId),
  );
  for (const orphan of orphanPosts.slice(AGENT_SESSION_HARD_ATTEMPT_LIMIT)) {
    delete ledger.orphanPosts[orphan.toolUseId];
    changed = true;
  }
  const unlinkedAgents = Object.values(ledger.agents)
    .filter((agent) => agent.reservationToolUseId === undefined)
    .sort((left, right) => {
      const statePriority =
        Number(left.state !== "stopped") - Number(right.state !== "stopped");
      if (statePriority !== 0) return -statePriority;
      const leftTime = Date.parse(
        left.stoppedAt ?? left.startedAt ?? left.firstObservedAt,
      );
      const rightTime = Date.parse(
        right.stoppedAt ?? right.startedAt ?? right.firstObservedAt,
      );
      return rightTime - leftTime || left.agentId.localeCompare(right.agentId);
    });
  for (const agent of unlinkedAgents.slice(AGENT_SESSION_HARD_ATTEMPT_LIMIT)) {
    delete ledger.agents[agent.agentId];
    changed = true;
  }
  return changed;
}

function readLedger(path: string, timestamp: number): {
  readonly existed: boolean;
  readonly ledger: AgentLedgerV1;
  readonly migrated: boolean;
} {
  if (!pathEntryExists(path)) {
    return { existed: false, ledger: defaultLedger(timestamp), migrated: false };
  }
  assertRegularStateFile(path);
  chmodSync(path, 0o600);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new AgentHookStateError(
      `agent ledger JSON is corrupt: ${path}: ${errorMessage(error)}`,
      "agent_state_corrupt",
    );
  }
  const ledger = validateLedger(value, path);
  const migrated = migrateLedgerV1(ledger);
  if (migrated) validateLedger(ledger, path);
  validateLedgerBounds(ledger, path);
  return { existed: true, ledger, migrated };
}

function openExclusive(path: string): number {
  return openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function processStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closingParenthesis = stat.lastIndexOf(")");
      if (closingParenthesis < 0) return undefined;
      const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
      const startTicks = fields[19];
      if (startTicks === undefined || !/^[0-9]+$/u.test(startTicks)) {
        return undefined;
      }
      let bootId = "unknown-boot";
      try {
        const candidate = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        if (candidate.length > 0) bootId = candidate;
      } catch {
        // The process start tick still distinguishes PID reuse within this boot.
      }
      return `linux:${bootId}:${startTicks}`;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const started = execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(pid)],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 250,
        },
      ).trim();
      return started.length === 0 ? undefined : `darwin:${started}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function processStartDigest(pid: number): string | undefined {
  const identity = processStartIdentity(pid);
  return identity === undefined
    ? undefined
    : createHash("sha256").update(identity).digest("hex");
}

function lockOwnerIsLive(path: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8").trim();
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") return false;
    throw error;
  }
  const current = /^v2:([1-9][0-9]*):([a-f0-9]{64}|unknown):([a-f0-9]+)$/u.exec(
    contents,
  );
  if (current !== null) {
    const pid = Number(current[1]);
    if (!Number.isSafeInteger(pid) || !processIsLive(pid)) return false;
    const publishedStart = current[2];
    if (publishedStart === "unknown") return false;
    const observedStart = processStartDigest(pid);
    // This is called only after the 30-second stale threshold. Normal hook
    // critical sections are bounded below that threshold; once stale, only an
    // exact process-incarnation match may continue to own the lock.
    return observedStart !== undefined && observedStart === publishedStart;
  }
  const legacy = /^([1-9][0-9]*)-[a-f0-9]+$/u.exec(contents);
  if (legacy === null) return false;
  // Legacy PID-only publications cannot distinguish PID reuse. They receive
  // the same bounded stale recovery as an unavailable start identity.
  return false;
}

function acquireLedgerLock(path: string): () => void {
  const token =
    `v2:${process.pid}:${processStartDigest(process.pid) ?? "unknown"}:` +
    randomBytes(12).toString("hex");
  const started = Date.now();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openExclusive(path);
      writeFileSync(fd, `${token}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      return () => {
        const stat = lstatIfExists(path);
        if (stat === undefined) return;
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new AgentHookStateError(
            `agent state path is not a regular file: ${path}`,
            "agent_state_path_invalid",
          );
        }
        try {
          if (readFileSync(path, "utf8").trim() === token) unlinkSync(path);
        } catch (error) {
          const code = isObject(error) && typeof error.code === "string" ? error.code : "";
          if (code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      const code = isObject(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "EEXIST") throw error;
      const stat = lstatIfExists(path);
      if (stat === undefined) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new AgentHookStateError(
          `agent state path is not a regular file: ${path}`,
          "agent_state_path_invalid",
        );
      }
      if (
        Date.now() - Number(stat.mtimeMs) > LOCK_STALE_MS &&
        !lockOwnerIsLive(path)
      ) {
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          const unlinkCode =
            isObject(unlinkError) && typeof unlinkError.code === "string"
              ? unlinkError.code
              : "";
          if (unlinkCode !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new AgentHookStateError(
          `agent ledger lock timed out: ${path}`,
          "agent_state_lock_timeout",
        );
      }
      sleep(10);
    }
  }
}

function writeLedgerAtomic(path: string, ledger: AgentLedgerV1): void {
  const temporary = join(
    agentDirectoryOf(path),
    `.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openExclusive(temporary);
    chmodSync(temporary, 0o600);
    writeFileSync(fd, `${JSON.stringify(ledger, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    fsyncDirectoryBestEffort(agentDirectoryOf(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // rename already committed the new name. Some filesystems reject directory
    // fsync, so durability strengthening must never turn a committed write into
    // a reported failure that a caller might retry.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The post-commit best-effort path is deliberately non-fallible.
      }
    }
  }
}

function agentDirectoryOf(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSlash < 0 ? "." : path.slice(0, lastSlash);
}

function pruneExpiredReservations(ledger: AgentLedgerV1, timestamp: number): boolean {
  let changed = false;
  for (const reservation of Object.values(ledger.reservations)) {
    if (
      (reservation.state === "pending" || reservation.state === "running") &&
      Date.parse(reservation.expiresAt) <= timestamp
    ) {
      const previousState = reservation.state;
      reservation.state = "expired";
      if (previousState === "pending") {
        reservation.failureReason = "pre_acknowledgement_expired";
      } else if (reservation.postOutcome === "failed") {
        reservation.failureReason ??= "spawn tool reported failure";
      } else {
        reservation.failureReason = "lifecycle_lease_expired";
      }
      changed = true;
    }
  }
  return changed;
}

function pruneUnlinkedAgentObservations(
  ledger: AgentLedgerV1,
  timestamp: number,
): boolean {
  let changed = false;
  for (const [agentId, agent] of Object.entries(ledger.agents)) {
    if (agent.reservationToolUseId !== undefined) continue;
    const lastObservation =
      agent.stoppedAt ?? agent.startedAt ?? agent.firstObservedAt;
    if (Date.parse(lastObservation) + AGENT_RESERVATION_TTL_MS > timestamp) {
      continue;
    }
    delete ledger.agents[agentId];
    changed = true;
  }
  return changed;
}

type LedgerMutation<T> = {
  readonly result: T;
  readonly changed: boolean;
};

function withLedger<T>(
  cwd: string,
  env: AgentHookEnvironment,
  sessionId: string,
  timestamp: number,
  mutate: (
    ledger: AgentLedgerV1,
    effectiveTimestamp: number,
  ) => LedgerMutation<T>,
): T {
  ensureLedgerDirectories(cwd, env);
  const path = agentLedgerPath(cwd, env, sessionId);
  const release = acquireLedgerLock(`${path}.lock`);
  try {
    const { ledger, migrated } = readLedger(path, timestamp);
    const effectiveTimestamp = Math.max(
      timestamp,
      Date.parse(ledger.updatedAt),
    );
    const reservationsExpired = pruneExpiredReservations(
      ledger,
      effectiveTimestamp,
    );
    const observationsExpired = pruneUnlinkedAgentObservations(
      ledger,
      effectiveTimestamp,
    );
    const expired = reservationsExpired || observationsExpired;
    const mutation = mutate(ledger, effectiveTimestamp);
    if (migrated || expired || mutation.changed) {
      ledger.updatedAt = iso(effectiveTimestamp);
      validateLedger(ledger, path);
      validateLedgerBounds(ledger, path);
      writeLedgerAtomic(path, ledger);
    }
    return mutation.result;
  } finally {
    release();
  }
}

function parseHookInput(stdinText: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(stdinText);
  } catch (error) {
    throw new AgentHookStateError(
      `hook stdin must be JSON: ${errorMessage(error)}`,
      "agent_hook_input_invalid",
    );
  }
  if (!isObject(value)) {
    throw new AgentHookStateError(
      "hook stdin must be a JSON object",
      "agent_hook_input_invalid",
    );
  }
  return value;
}

function inputString(input: JsonObject, key: string, exact = false): string {
  const value = input[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (exact && value !== value.trim())
  ) {
    throw new AgentHookStateError(
      `${key} must be a non-empty string${exact ? " without surrounding whitespace" : ""}`,
      "agent_hook_input_invalid",
    );
  }
  return value;
}

function optionalExactInputString(
  input: JsonObject,
  key: string,
): string | undefined {
  if (!hasOwn(input, key)) return undefined;
  return inputString(input, key, true);
}

function hasCustomV2SpawnShape(toolName: string, toolInput: JsonObject): boolean {
  const namespace = toolName.slice(0, -SPAWN_AGENT_TOOL_SUFFIX.length);
  return (
    !EXACT_SPAWN_TOOLS.has(toolName) &&
    FLAT_NAMESPACE_SPAWN_TOOL.test(toolName) &&
    namespace !== "mcp" &&
    !namespace.startsWith("mcp__") &&
    !RESERVED_RESPONSES_TOOL_NAMESPACES.has(namespace) &&
    validExactId(toolInput.task_name) &&
    typeof toolInput.message === "string" &&
    toolInput.message.length > 0
  );
}

function spawnInput(input: JsonObject): {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: JsonObject;
  readonly isSpawnTool: boolean;
  readonly spawnProtocol: SpawnProtocol;
  readonly taskName?: string;
  readonly callerAgentId?: string;
} {
  const sessionId = inputString(input, "session_id", true);
  const toolName = inputString(input, "tool_name");
  const toolUseId = inputString(input, "tool_use_id", true);
  const callerAgentId = optionalExactInputString(input, "agent_id");
  if (!isObject(input.tool_input)) {
    throw new AgentHookStateError(
      "tool_input must be an object",
      "agent_hook_input_invalid",
    );
  }
  const toolInput = input.tool_input;
  const isSpawnTool =
    EXACT_SPAWN_TOOLS.has(toolName) ||
    hasCustomV2SpawnShape(toolName, toolInput);
  const taskName = isSpawnTool && hasOwn(toolInput, "task_name")
    ? inputString(toolInput, "task_name", true)
    : undefined;
  return {
    sessionId,
    toolName,
    toolUseId,
    toolInput,
    isSpawnTool,
    spawnProtocol: taskName === undefined ? "v1" : "v2",
    ...(taskName === undefined ? {} : { taskName }),
    ...(callerAgentId === undefined ? {} : { callerAgentId }),
  };
}

function allowPreToolUse(): AgentHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

function denyPreToolUse(reason: string): AgentHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function policyDenial(code: string, detail: string): AgentHookOutput {
  return denyPreToolUse(`gdm agent gate denied (${code}): ${detail}`);
}

function envelopeKey(envelope: AgentEnvelope): string {
  return JSON.stringify(envelope);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toolInputDigest(toolInput: JsonObject): string {
  return createHash("sha256").update(canonicalJson(toolInput)).digest("hex");
}

function unstructuredEnvelope(
  toolUseId: string,
  inputDigest: string,
): AgentEnvelope {
  const id = createHash("sha256").update(toolUseId).digest("hex").slice(0, 20);
  const syntheticScope = `unstructured/${id}/${inputDigest.slice(0, 20)}`;
  return {
    taskId: `unstructured-${id}`,
    parentId: "unstructured-root",
    role: "unstructured",
    scope: syntheticScope,
    ownership: { mode: "read", resources: [syntheticScope] },
    deliverable: "delegated task result",
    verify: "parent verifies the returned result",
    stopWhen: "SubagentStop is observed",
    canDelegate: true,
    childQuota: 2,
    depth: 1,
    blockedBy: [],
  };
}

function startsWithEnvelopeLine(message: string): boolean {
  const firstLine = message.split(/\r?\n/u, 1)[0] ?? "";
  return firstLine.startsWith(AGENT_ENVELOPE_PREFIX) ||
    firstLine.trimStart().startsWith(AGENT_ENVELOPE_PREFIX);
}

function reservationByTaskId(
  ledger: AgentLedgerV1,
  taskId: string,
): Reservation | undefined {
  return Object.values(ledger.reservations).find(
    (reservation) => reservation.envelope.taskId === taskId,
  );
}

function canonicalPathLike(cwd: string, value: string): string {
  if (value === "*") return value;
  return resolve(cwd, value.replaceAll("\\", "/")).replaceAll("\\", "/");
}

function canonicalizeEnvelope(cwd: string, envelope: AgentEnvelope): AgentEnvelope {
  return {
    ...envelope,
    scope: canonicalPathLike(cwd, envelope.scope),
    ownership: {
      ...envelope.ownership,
      resources: envelope.ownership.resources.map((resource) =>
        canonicalPathLike(cwd, resource)
      ),
    },
  };
}

function resourcesOverlap(cwd: string, left: string, right: string): boolean {
  const a = canonicalPathLike(cwd, left);
  const b = canonicalPathLike(cwd, right);
  if (a === "*" || b === "*" || a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function writeOwnershipOverlaps(
  cwd: string,
  left: AgentEnvelope,
  right: AgentEnvelope,
): boolean {
  if (left.ownership.mode !== "write" || right.ownership.mode !== "write") {
    return false;
  }
  return left.ownership.resources.some((a) =>
    right.ownership.resources.some((b) => resourcesOverlap(cwd, a, b)),
  );
}

function postOutcome(response: unknown): {
  readonly outcome: PostOutcome;
  readonly reason?: string;
} {
  if (!isObject(response)) return { outcome: "succeeded" };
  const status = typeof response.status === "string" ? response.status.toLowerCase() : "";
  const failed =
    response.success === false ||
    response.ok === false ||
    response.isError === true ||
    response.is_error === true ||
    (typeof response.exitCode === "number" && response.exitCode !== 0) ||
    (typeof response.exit_code === "number" && response.exit_code !== 0) ||
    status === "failed" ||
    status === "failure" ||
    status === "error" ||
    (hasOwn(response, "error") && response.error !== null && response.error !== false);
  return {
    outcome: failed ? "failed" : "succeeded",
    reason: failed ? "spawn tool reported failure" : undefined,
  };
}

function containsNestedAgentId(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsNestedAgentId(item, depth + 1));
  }
  if (!isObject(value)) return false;
  if (depth > 0 && (hasOwn(value, "agent_id") || hasOwn(value, "agentId"))) {
    return true;
  }
  return Object.entries(value).some(([key, nested]) =>
    (depth === 0 && (key === "agent_id" || key === "agentId"))
      ? false
      : containsNestedAgentId(nested, depth + 1)
  );
}

function parsePostResponse(response: unknown): {
  readonly responseDigest: string;
  readonly outcome: PostOutcome;
  readonly reason?: string;
  readonly agentId?: string;
} {
  let decoded = response;
  if (typeof response === "string") {
    try {
      decoded = JSON.parse(response);
    } catch {
      decoded = response;
    }
  }
  const outcome = postOutcome(decoded);
  if (!isObject(decoded) || containsNestedAgentId(decoded)) {
    return {
      responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
      ...outcome,
    };
  }
  const candidateIds: string[] = [];
  let invalidTopLevelId = false;
  for (const key of ["agent_id", "agentId"]) {
    if (!hasOwn(decoded, key)) continue;
    const candidate = decoded[key];
    if (!validExactId(candidate)) {
      invalidTopLevelId = true;
      continue;
    }
    candidateIds.push(candidate);
  }
  const distinctIds = [...new Set(candidateIds)];
  return {
    responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
    ...outcome,
    ...(invalidTopLevelId || distinctIds.length !== 1
      ? {}
      : { agentId: distinctIds[0] }),
  };
}

function linkReservationToAgent(
  ledger: AgentLedgerV1,
  reservation: Reservation,
  agent: AgentObservation,
  authority: AgentLinkAuthority,
): boolean {
  const authoritative = authority !== "provisional";
  const reservationAgentConflict =
    reservation.agentId !== undefined && reservation.agentId !== agent.agentId;
  const linkedReservation =
    agent.reservationToolUseId === undefined
      ? undefined
      : recordGet(ledger.reservations, agent.reservationToolUseId);
  const agentReservationConflict =
    agent.reservationToolUseId !== undefined &&
    agent.reservationToolUseId !== reservation.toolUseId;
  if (
    (reservationAgentConflict &&
      (!authoritative || reservation.agentLinkAuthority !== "provisional")) ||
    (agentReservationConflict &&
      (!authoritative || linkedReservation?.agentLinkAuthority !== "provisional"))
  ) {
    return false;
  }
  if (reservation.agentId !== undefined && reservation.agentId !== agent.agentId) {
    const previousAgent = recordGet(ledger.agents, reservation.agentId);
    if (previousAgent?.reservationToolUseId === reservation.toolUseId) {
      delete previousAgent.reservationToolUseId;
    }
    delete reservation.agentId;
    delete reservation.agentLinkAuthority;
    delete reservation.stoppedAt;
    reservation.state =
      reservation.postOutcome === "failed"
        ? "failed"
        : reservation.postOutcome === "succeeded"
          ? "running"
          : "pending";
  }
  if (
    agent.reservationToolUseId !== undefined &&
    agent.reservationToolUseId !== reservation.toolUseId
  ) {
    const previousReservation = linkedReservation;
    if (previousReservation?.agentId === agent.agentId) {
      delete previousReservation.agentId;
      delete previousReservation.agentLinkAuthority;
      delete previousReservation.stoppedAt;
      if (previousReservation.state !== "expired") {
        previousReservation.state =
          previousReservation.postOutcome === "failed"
            ? "failed"
            : previousReservation.postOutcome === "succeeded"
              ? "running"
              : "pending";
      }
    }
    delete agent.reservationToolUseId;
  }
  reservation.agentId = agent.agentId;
  if (
    reservation.agentLinkAuthority === undefined ||
    reservation.agentLinkAuthority === "provisional" ||
    authority !== "provisional"
  ) {
    reservation.agentLinkAuthority = authority;
  }
  agent.reservationToolUseId = reservation.toolUseId;
  if (
    reservation.postOutcome !== "failed" &&
    agent.state === "stopped" &&
    reservation.agentLinkAuthority !== "provisional"
  ) {
    reservation.state = "stopped";
    reservation.stoppedAt = agent.stoppedAt ?? agent.firstObservedAt;
  } else if (
    reservation.postOutcome !== "failed" &&
    agent.state === "running"
  ) {
    reservation.state = "running";
  }
  return true;
}

function uniqueFreshUnlinkedReservation(
  ledger: AgentLedgerV1,
  timestamp: number,
): Reservation | undefined {
  const candidates = Object.values(ledger.reservations).filter(
    (reservation) =>
      reservationProtocol(reservation) === "v1" &&
      reservation.state === "pending" &&
      reservation.agentId === undefined &&
      Date.parse(reservation.reservedAt) <= timestamp &&
      Date.parse(reservation.expiresAt) > timestamp,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function reservationProtocol(reservation: Reservation): SpawnProtocol {
  // Protocol metadata was added without changing the on-disk schema version.
  // Existing ledgers came from the V1 tool shape and therefore remain V1.
  return reservation.spawnProtocol ?? "v1";
}

function unresolvedV2Reservations(ledger: AgentLedgerV1): Reservation[] {
  return unresolvedIdentityReservations(ledger).filter(
    (reservation) =>
      reservationProtocol(reservation) === "v2",
  );
}

function unresolvedIdentityReservations(ledger: AgentLedgerV1): Reservation[] {
  return Object.values(ledger.reservations).filter(
    (reservation) =>
      ACTIVE_RESERVATION_STATES.has(reservation.state) &&
      reservation.agentId === undefined,
  );
}

function uniqueV2LifecycleCandidate(
  ledger: AgentLedgerV1,
): Reservation | undefined {
  const unresolvedIdentity = unresolvedIdentityReservations(ledger);
  return unresolvedIdentity.length === 1 &&
      reservationProtocol(unresolvedIdentity[0]!) === "v2"
    ? unresolvedIdentity[0]
    : undefined;
}

function uniqueStartLifecycleCandidate(
  ledger: AgentLedgerV1,
  timestamp: number,
): Reservation | undefined {
  const v2 = uniqueV2LifecycleCandidate(ledger);
  if (v2 !== undefined) return v2;
  return unresolvedV2Reservations(ledger).length === 0
    ? uniqueFreshUnlinkedReservation(ledger, timestamp)
    : undefined;
}

function makeRoomForUnlinkedAgentObservation(ledger: AgentLedgerV1): boolean {
  const unlinked = Object.values(ledger.agents).filter(
    (agent) => agent.reservationToolUseId === undefined,
  );
  if (unlinked.length < AGENT_SESSION_HARD_ATTEMPT_LIMIT) return true;
  const stopped = unlinked
    .filter((agent) => agent.state === "stopped")
    .sort((left, right) =>
      Date.parse(left.stoppedAt ?? left.firstObservedAt) -
      Date.parse(right.stoppedAt ?? right.firstObservedAt)
    );
  const evicted = stopped[0];
  if (evicted === undefined) return false;
  delete ledger.agents[evicted.agentId];
  return true;
}

function callerCanResolveReservation(
  ledger: AgentLedgerV1,
  reservation: Reservation,
  callerAgentId: string | undefined,
): boolean {
  if (
    callerAgentId === undefined ||
    reservation.agentId !== undefined ||
    !ACTIVE_RESERVATION_STATES.has(reservation.state)
  ) {
    return false;
  }
  const caller = recordGet(ledger.agents, callerAgentId);
  if (caller?.state === "stopped") return false;
  if (
    caller?.reservationToolUseId !== undefined &&
    caller.reservationToolUseId !== reservation.toolUseId
  ) {
    const linked = recordGet(ledger.reservations, caller.reservationToolUseId);
    return linked?.agentLinkAuthority === "provisional";
  }
  return true;
}

function callerResolutionCandidate(
  ledger: AgentLedgerV1,
  contractMode: ReservationContractMode,
  envelope: AgentEnvelope,
  callerAgentId: string | undefined,
): Reservation | undefined {
  if (callerAgentId === undefined) return undefined;
  if (contractMode === "structured") {
    const declaredParent = reservationByTaskId(ledger, envelope.parentId);
    return declaredParent !== undefined &&
        callerCanResolveReservation(ledger, declaredParent, callerAgentId)
      ? declaredParent
      : undefined;
  }
  const unresolved = unresolvedV2Reservations(ledger);
  return unresolved.length === 1 &&
      callerCanResolveReservation(ledger, unresolved[0]!, callerAgentId)
    ? unresolved[0]
    : undefined;
}

function validateIdentitySerialization(
  ledger: AgentLedgerV1,
  spawnProtocol: SpawnProtocol,
  callerResolution: Reservation | undefined,
): PolicyDenial | undefined {
  const unresolved = unresolvedIdentityReservations(ledger).filter(
    (reservation) => reservation !== callerResolution,
  );
  const conflicting =
    spawnProtocol === "v2"
      ? unresolved
      : unresolved.filter((reservation) => reservationProtocol(reservation) === "v2");
  return conflicting.length === 0
    ? undefined
    : {
        code: "v2_identity_handshake_pending",
        detail:
          `task ${conflicting[0]!.taskName ?? conflicting[0]!.toolUseId} ` +
          "is still in an identity-ambiguous window involving V2 lifecycle correlation",
      };
}

function commitUnstructuredCallerResolution(
  ledger: AgentLedgerV1,
  reservation: Reservation | undefined,
  callerAgentId: string | undefined,
  timestamp: number,
): void {
  if (reservation === undefined || callerAgentId === undefined) return;
  let caller = recordGet(ledger.agents, callerAgentId);
  if (caller === undefined) {
    caller = {
      agentId: callerAgentId,
      agentType: "unknown",
      state: "pending",
      firstObservedAt: iso(timestamp),
    };
    recordSet(ledger.agents, callerAgentId, caller);
  }
  if (
    caller.state === "stopped" ||
    !linkReservationToAgent(ledger, reservation, caller, "caller")
  ) {
    throw new AgentHookStateError(
      `caller ${callerAgentId} could not resolve V2 reservation ${reservation.toolUseId}`,
      "agent_state_corrupt",
    );
  }
  caller.state = "running";
  caller.startedAt ??= iso(timestamp);
  reservation.state = "running";
  reservation.expiresAt = iso(timestamp + AGENT_RESERVATION_TTL_MS);
}

function applyPostToReservation(
  ledger: AgentLedgerV1,
  reservation: Reservation,
  post: OrphanPost,
  timestamp: number,
): void {
  if (reservation.state === "expired") return;
  if (
    post.toolInputDigest !== undefined &&
    post.toolInputDigest !== reservation.toolInputDigest
  ) {
    throw new AgentHookStateError(
      `PostToolUse tool_input does not match reservation ${reservation.toolUseId}`,
      "agent_hook_input_invalid",
    );
  }
  if (
    post.spawnProtocol !== undefined &&
    post.spawnProtocol !== reservationProtocol(reservation)
  ) {
    throw new AgentHookStateError(
      `PostToolUse protocol does not match reservation ${reservation.toolUseId}`,
      "agent_hook_input_invalid",
    );
  }
  if (
    reservationProtocol(reservation) === "v2" &&
    post.taskName !== reservation.taskName
  ) {
    throw new AgentHookStateError(
      `PostToolUse task_name does not match reservation ${reservation.toolUseId}`,
      "agent_hook_input_invalid",
    );
  }
  if (
    reservation.callerAgentId !== post.callerAgentId
  ) {
    throw new AgentHookStateError(
      `PostToolUse caller does not match reservation ${reservation.toolUseId}`,
      "agent_hook_input_invalid",
    );
  }
  if (reservation.postOutcome !== undefined) return;
  reservation.postOutcome = post.outcome;
  reservation.postObservedAt = post.observedAt;
  if (post.responseDigest !== undefined) {
    reservation.postResponseDigest = post.responseDigest;
  }
  reservation.expiresAt = iso(timestamp + AGENT_RESERVATION_TTL_MS);
  let agent: AgentObservation | undefined;
  if (post.agentId !== undefined) {
    agent = recordGet(ledger.agents, post.agentId);
    if (agent === undefined) {
      agent = {
        agentId: post.agentId,
        agentType: "unknown",
        state: "pending",
        firstObservedAt: post.observedAt,
      };
      recordSet(ledger.agents, post.agentId, agent);
    }
  } else if (reservation.agentId !== undefined) {
    agent = recordGet(ledger.agents, reservation.agentId);
  }
  if (post.agentId !== undefined && agent !== undefined) {
    if (!linkReservationToAgent(ledger, reservation, agent, "post")) {
      throw new AgentHookStateError(
        `PostToolUse agent_id conflicts with reservation ${reservation.toolUseId}`,
        "agent_hook_input_invalid",
      );
    }
  }
  if (reservation.postOutcome === "failed") {
    reservation.failureReason = "spawn tool reported failure";
    delete reservation.stoppedAt;
    reservation.state = agent?.state === "running" ? "running" : "failed";
    return;
  }
  if (
    agent?.state === "stopped" &&
    reservation.agentLinkAuthority !== "provisional"
  ) {
    reservation.state = "stopped";
    reservation.stoppedAt = agent.stoppedAt ?? agent.firstObservedAt;
  } else {
    reservation.state = "running";
  }
}

function checkpointLegacyPost(
  ledger: AgentLedgerV1,
  reservation: Reservation,
  post: OrphanPost,
  timestamp: number,
): void {
  if (
    reservation.postOutcome !== post.outcome ||
    post.responseDigest === undefined
  ) {
    throw new AgentHookStateError(
      `conflicting PostToolUse was observed for ${reservation.toolUseId}`,
      "agent_hook_input_invalid",
    );
  }
  let agent: AgentObservation | undefined;
  if (post.agentId !== undefined) {
    agent = recordGet(ledger.agents, post.agentId);
    if (agent === undefined) {
      agent = {
        agentId: post.agentId,
        agentType: "unknown",
        state: "pending",
        firstObservedAt: post.observedAt,
      };
      recordSet(ledger.agents, post.agentId, agent);
    }
    if (!linkReservationToAgent(ledger, reservation, agent, "post")) {
      throw new AgentHookStateError(
        `PostToolUse agent_id conflicts with reservation ${reservation.toolUseId}`,
        "agent_hook_input_invalid",
      );
    }
  } else if (reservation.agentId !== undefined) {
    agent = recordGet(ledger.agents, reservation.agentId);
  }
  reservation.postResponseDigest = post.responseDigest;
  reservation.expiresAt = iso(timestamp + AGENT_RESERVATION_TTL_MS);
  if (reservation.postOutcome === "failed") {
    delete reservation.stoppedAt;
    reservation.failureReason ??= "spawn tool reported failure";
    reservation.state = agent?.state === "running" ? "running" : "failed";
  } else if (agent?.state === "stopped") {
    reservation.state = "stopped";
    reservation.stoppedAt = agent.stoppedAt ?? agent.firstObservedAt;
  } else {
    reservation.state = "running";
    delete reservation.stoppedAt;
  }
}

type PolicyDenial = {
  readonly code: string;
  readonly detail: string;
};

function validateStructuredCaller(
  ledger: AgentLedgerV1,
  envelope: AgentEnvelope,
  callerAgentId: string | undefined,
): PolicyDenial | undefined {
  if (callerAgentId === undefined) {
    // Some hook runtimes omit caller identity. Keep structured recursion
    // available there, but only through the declared parent's existing budget.
    if (envelope.parentId === "root") {
      if (envelope.depth === 1) return undefined;
      return {
        code: "root_parent_guardrail",
        detail: "a root spawn must declare depth=1",
      };
    }
    const declaredParent = reservationByTaskId(ledger, envelope.parentId);
    if (
      declaredParent === undefined ||
      !ACTIVE_RESERVATION_STATES.has(declaredParent.state)
    ) {
      return {
        code: "declared_parent_guardrail",
        detail:
          `caller identity is unavailable and declared parent ${envelope.parentId} ` +
          "is missing or no longer active",
      };
    }
    return undefined;
  }
  if (envelope.parentId === "root") {
    return {
      code: "caller_parent_guardrail",
      detail: `caller ${callerAgentId} must declare its linked parent task`,
    };
  }
  const parent = reservationByTaskId(ledger, envelope.parentId);
  if (parent === undefined || !ACTIVE_RESERVATION_STATES.has(parent.state)) {
    return {
      code: "caller_parent_guardrail",
      detail: `declared parent ${envelope.parentId} is missing or no longer active`,
    };
  }
  const caller = recordGet(ledger.agents, callerAgentId);
  if (caller?.state === "stopped") {
    return {
      code: "caller_parent_conflict",
      detail: `caller ${callerAgentId} was already observed stopped`,
    };
  }
  if (
    parent.agentId !== undefined &&
    parent.agentId !== callerAgentId &&
    parent.agentLinkAuthority !== "provisional"
  ) {
    return {
      code: "caller_parent_conflict",
      detail:
        `caller ${callerAgentId} is not one-to-one linked to declared parent ` +
        envelope.parentId,
    };
  }
  if (
    caller?.reservationToolUseId !== undefined &&
    caller.reservationToolUseId !== parent.toolUseId
  ) {
    const linkedReservation = recordGet(
      ledger.reservations,
      caller.reservationToolUseId,
    );
    if (linkedReservation?.agentLinkAuthority !== "provisional") {
      return {
        code: "caller_parent_conflict",
        detail:
          `caller ${callerAgentId} is not one-to-one linked to declared parent ` +
          envelope.parentId,
      };
    }
  }
  return undefined;
}

function commitStructuredCaller(
  ledger: AgentLedgerV1,
  envelope: AgentEnvelope,
  callerAgentId: string | undefined,
  timestamp: number,
): void {
  if (callerAgentId === undefined) return;
  const parent = reservationByTaskId(ledger, envelope.parentId);
  if (parent === undefined) {
    throw new AgentHookStateError(
      `validated parent ${envelope.parentId} disappeared before commit`,
      "agent_state_corrupt",
    );
  }
  let caller = recordGet(ledger.agents, callerAgentId);
  if (caller === undefined) {
    caller = {
      agentId: callerAgentId,
      agentType: "unknown",
      state: "pending",
      firstObservedAt: iso(timestamp),
    };
    recordSet(ledger.agents, callerAgentId, caller);
  }
  if (!linkReservationToAgent(ledger, parent, caller, "caller")) {
    throw new AgentHookStateError(
      `validated caller ${callerAgentId} could not be linked to ${envelope.parentId}`,
      "agent_state_corrupt",
    );
  }
  caller.state = "running";
  caller.startedAt ??= iso(timestamp);
  parent.state = "running";
  delete parent.stoppedAt;
  parent.expiresAt = iso(timestamp + AGENT_RESERVATION_TTL_MS);
}

function validatePrePolicy(
  cwd: string,
  ledger: AgentLedgerV1,
  envelope: AgentEnvelope,
  callerAgentId: string | undefined,
): PolicyDenial | undefined {
  if (reservationByTaskId(ledger, envelope.taskId) !== undefined) {
    return {
      code: "duplicate_task_id",
      detail: `taskId ${envelope.taskId} was already accepted`,
    };
  }
  if (envelope.taskId === envelope.parentId) {
    return {
      code: "self_replication",
      detail: "taskId and parentId must differ",
    };
  }
  const callerDenial = validateStructuredCaller(
    ledger,
    envelope,
    callerAgentId,
  );
  if (callerDenial !== undefined) return callerDenial;
  const parent = reservationByTaskId(ledger, envelope.parentId);
  if (parent !== undefined) {
    if (
      canonicalPathLike(cwd, parent.envelope.scope) ===
      canonicalPathLike(cwd, envelope.scope)
    ) {
      return {
        code: "same_scope_self_replication",
        detail: `child scope duplicates parent scope ${envelope.scope}`,
      };
    }
    if (!parent.envelope.canDelegate) {
      return {
        code: "parent_delegation_guardrail",
        detail: `declared parent ${envelope.parentId} cannot delegate`,
      };
    }
    const childCount = Object.values(ledger.reservations).filter(
      (reservation) => reservation.envelope.parentId === envelope.parentId,
    ).length;
    if (childCount >= parent.envelope.childQuota) {
      return {
        code: "parent_child_quota_guardrail",
        detail: `declared parent ${envelope.parentId} child quota is exhausted`,
      };
    }
    if (envelope.depth !== parent.envelope.depth + 1) {
      return {
        code: "parent_depth_guardrail",
        detail: `child depth must be ${parent.envelope.depth + 1}`,
      };
    }
  }
  for (const dependency of envelope.blockedBy) {
    const reservation = reservationByTaskId(ledger, dependency);
    if (reservation?.state !== "stopped") {
      return {
        code: "unmet_blocked_by",
        detail:
          `dependency ${dependency} has no associated SubagentStop turn signal; ` +
          "that signal is only a sequencing hint, not permanent thread termination or proof of success",
      };
    }
  }
  for (const active of Object.values(ledger.reservations)) {
    if (
      ACTIVE_RESERVATION_STATES.has(active.state) &&
      active.contractMode === "structured" &&
      canonicalPathLike(cwd, active.envelope.scope) ===
        canonicalPathLike(cwd, envelope.scope)
    ) {
      return {
        code: "duplicate_active_scope",
        detail: `scope duplicates active task ${active.envelope.taskId}`,
      };
    }
    if (
      ACTIVE_RESERVATION_STATES.has(active.state) &&
      writeOwnershipOverlaps(cwd, active.envelope, envelope)
    ) {
      return {
        code: "write_ownership_overlap",
        detail: `write ownership overlaps active task ${active.envelope.taskId}`,
      };
    }
  }
  return validateSessionAttemptLimit(ledger);
}

function validateSessionAttemptLimit(
  ledger: AgentLedgerV1,
): { readonly code: string; readonly detail: string } | undefined {
  if (ledger.totalAcceptedAttempts >= AGENT_SESSION_HARD_ATTEMPT_LIMIT) {
    return {
      code: "session_attempt_hard_limit",
      detail:
        `session accepted-attempt hard limit is ` +
        `${AGENT_SESSION_HARD_ATTEMPT_LIMIT}`,
    };
  }
  const extensionCount = Math.ceil(
    Math.max(
      0,
      ledger.totalAcceptedAttempts - AGENT_SESSION_INITIAL_ATTEMPT_LIMIT,
    ) / AGENT_SESSION_ATTEMPT_EXTENSION_SIZE,
  );
  const currentLimit = Math.min(
    AGENT_SESSION_HARD_ATTEMPT_LIMIT,
    AGENT_SESSION_INITIAL_ATTEMPT_LIMIT +
      extensionCount * AGENT_SESSION_ATTEMPT_EXTENSION_SIZE,
  );
  if (ledger.totalAcceptedAttempts < currentLimit) return undefined;
  const active = Object.values(ledger.reservations).filter((reservation) =>
    ACTIVE_RESERVATION_STATES.has(reservation.state)
  ).length;
  return active > 0
    ? {
        code: "session_attempt_wave_pending",
        detail:
          `automatic attempt wave ${currentLimit} is exhausted while ` +
          `${active} delegated task(s) remain pending or running; ` +
          "the next wave opens only after all active delegated work settles",
      }
    : undefined;
}

function validateUnstructuredCaller(
  ledger: AgentLedgerV1,
  callerAgentId: string | undefined,
): PolicyDenial | undefined {
  return callerAgentId !== undefined &&
      recordGet(ledger.agents, callerAgentId)?.state === "stopped"
    ? {
        code: "caller_parent_conflict",
        detail:
          `caller ${callerAgentId} was already observed stopped; ` +
          "agent reuse or follow-up cannot be verified by this hook",
      }
    : undefined;
}

function onPreToolUse(
  cwd: string,
  env: AgentHookEnvironment,
  input: JsonObject,
  timestamp: number,
): AgentHookOutput {
  const parsed = spawnInput(input);
  if (!parsed.isSpawnTool) return allowPreToolUse();
  const message =
    typeof parsed.toolInput.message === "string" ? parsed.toolInput.message : "";
  const contractMode: ReservationContractMode =
    startsWithEnvelopeLine(message) ? "structured" : "unstructured";
  const inputDigest = toolInputDigest(parsed.toolInput);
  // A present marker opts into the full delegation contract. Ordinary Codex
  // spawns stay usable globally and consume only the hard session budget.
  // Invalid marked envelopes deny before any state directory or lock is created.
  const parsedEnvelope =
    contractMode === "structured"
      ? parseAgentEnvelope(message)
      : unstructuredEnvelope(parsed.toolUseId, inputDigest);
  const envelope =
    contractMode === "structured"
      ? canonicalizeEnvelope(cwd, parsedEnvelope)
      : parsedEnvelope;
  return withLedger(
    cwd,
    env,
    parsed.sessionId,
    timestamp,
    (ledger, effectiveTimestamp): LedgerMutation<AgentHookOutput> => {
      const existing = recordGet(ledger.reservations, parsed.toolUseId);
      if (existing !== undefined) {
        const exactReplay =
          existing.contractMode === contractMode &&
          reservationProtocol(existing) === parsed.spawnProtocol &&
          existing.taskName === parsed.taskName &&
          existing.toolInputDigest === inputDigest &&
          envelopeKey(
            contractMode === "structured"
              ? canonicalizeEnvelope(cwd, existing.envelope)
              : existing.envelope,
          ) === envelopeKey(envelope) &&
          existing.callerAgentId === parsed.callerAgentId;
        if (exactReplay) {
          return {
            result: policyDenial(
              "tool_use_id_already_reserved",
              `tool_use_id ${parsed.toolUseId} was already accepted; ` +
                "a repeated PreToolUse cannot prove that the tool did not execute",
            ),
            changed: false,
          };
        }
        return {
          result: policyDenial(
            "tool_use_id_conflict",
            `tool_use_id ${parsed.toolUseId} was reused with different input`,
          ),
          changed: false,
        };
      }
      const callerResolution = callerResolutionCandidate(
        ledger,
        contractMode,
        envelope,
        parsed.callerAgentId,
      );
      const policy =
        contractMode === "structured"
          ? validatePrePolicy(
              cwd,
              ledger,
              envelope,
              parsed.callerAgentId,
            )
          : validateUnstructuredCaller(ledger, parsed.callerAgentId) ??
            validateSessionAttemptLimit(ledger);
      const denial =
        policy ??
        validateIdentitySerialization(
          ledger,
          parsed.spawnProtocol,
          callerResolution,
        );
      if (denial !== undefined) {
        return {
          result: policyDenial(denial.code, denial.detail),
          changed: false,
        };
      }
      if (contractMode === "structured") {
        commitStructuredCaller(
          ledger,
          envelope,
          parsed.callerAgentId,
          effectiveTimestamp,
        );
      } else {
        commitUnstructuredCallerResolution(
          ledger,
          callerResolution,
          parsed.callerAgentId,
          effectiveTimestamp,
        );
      }
      const reservation: Reservation = {
        toolUseId: parsed.toolUseId,
        toolInputDigest: inputDigest,
        contractMode,
        spawnProtocol: parsed.spawnProtocol,
        ...(parsed.taskName === undefined ? {} : { taskName: parsed.taskName }),
        envelope,
        state: "pending",
        reservedAt: iso(effectiveTimestamp),
        expiresAt: iso(effectiveTimestamp + AGENT_PRE_ACK_TTL_MS),
        ...(parsed.callerAgentId !== undefined
          ? { callerAgentId: parsed.callerAgentId }
          : {}),
      };
      recordSet(ledger.reservations, parsed.toolUseId, reservation);
      ledger.totalAcceptedAttempts += 1;
      const reorderedPost = recordGet(ledger.orphanPosts, parsed.toolUseId);
      if (reorderedPost !== undefined) {
        applyPostToReservation(
          ledger,
          reservation,
          reorderedPost,
          effectiveTimestamp,
        );
        delete ledger.orphanPosts[parsed.toolUseId];
      }
      return { result: allowPreToolUse(), changed: true };
    },
  );
}

function onPostToolUse(
  cwd: string,
  env: AgentHookEnvironment,
  input: JsonObject,
  timestamp: number,
): AgentHookOutput {
  const parsed = spawnInput(input);
  if (!parsed.isSpawnTool) return {};
  if (!hasOwn(input, "tool_response")) {
    throw new AgentHookStateError(
      "PostToolUse tool_response is required",
      "agent_hook_input_invalid",
    );
  }
  const response = parsePostResponse(input.tool_response);
  return withLedger(
    cwd,
    env,
    parsed.sessionId,
    timestamp,
    (ledger, effectiveTimestamp): LedgerMutation<AgentHookOutput> => {
      const post: OrphanPost = {
        toolUseId: parsed.toolUseId,
        toolInputDigest: toolInputDigest(parsed.toolInput),
        responseDigest: response.responseDigest,
        spawnProtocol: parsed.spawnProtocol,
        ...(parsed.taskName === undefined ? {} : { taskName: parsed.taskName }),
        outcome: response.outcome,
        observedAt: iso(effectiveTimestamp),
        ...(parsed.callerAgentId === undefined
          ? {}
          : { callerAgentId: parsed.callerAgentId }),
        ...(response.agentId === undefined
          ? {}
          : { agentId: response.agentId }),
      };
      const reservation = recordGet(ledger.reservations, parsed.toolUseId);
      if (reservation === undefined) {
        const existing = recordGet(ledger.orphanPosts, parsed.toolUseId);
        if (existing !== undefined) {
          if (
            existing.toolInputDigest === post.toolInputDigest &&
            existing.responseDigest === post.responseDigest &&
            existing.outcome === post.outcome &&
            existing.spawnProtocol === post.spawnProtocol &&
            existing.taskName === post.taskName &&
            existing.callerAgentId === post.callerAgentId &&
            existing.agentId === post.agentId
          ) {
            return { result: {}, changed: false };
          }
          throw new AgentHookStateError(
            `conflicting PostToolUse was observed for ${parsed.toolUseId}`,
            "agent_hook_input_invalid",
          );
        }
        if (
          Object.keys(ledger.orphanPosts).length >=
            AGENT_SESSION_HARD_ATTEMPT_LIMIT
        ) {
          return {
            result: {
              decision: "block",
              reason:
                "gdm agent gate: unmatched PostToolUse record limit is " +
                AGENT_SESSION_HARD_ATTEMPT_LIMIT,
            },
            changed: false,
          };
        }
        recordSet(ledger.orphanPosts, parsed.toolUseId, post);
        return { result: {}, changed: true };
      }
      if (reservation.toolInputDigest !== post.toolInputDigest) {
        throw new AgentHookStateError(
          `PostToolUse tool_input does not match reservation ${parsed.toolUseId}`,
          "agent_hook_input_invalid",
        );
      }
      if (
        reservationProtocol(reservation) !== post.spawnProtocol ||
        reservation.taskName !== post.taskName
      ) {
        throw new AgentHookStateError(
          `PostToolUse protocol identity does not match reservation ${parsed.toolUseId}`,
          "agent_hook_input_invalid",
        );
      }
      if (
        reservation.callerAgentId !== post.callerAgentId
      ) {
        throw new AgentHookStateError(
          `PostToolUse caller does not match reservation ${parsed.toolUseId}`,
          "agent_hook_input_invalid",
        );
      }
      if (reservation.state === "expired") {
        return {
          result: {
            decision: "block",
            reason:
              `gdm agent gate: PostToolUse for ${parsed.toolUseId} arrived after ` +
              (reservation.failureReason === "lifecycle_lease_expired"
                ? "the running lifecycle lease expired"
                : "the PreToolUse acknowledgement window expired"),
          },
          changed: false,
        };
      }
      if (reservation.postOutcome !== undefined) {
        if (reservation.postResponseDigest === undefined) {
          const before = JSON.stringify(reservation);
          checkpointLegacyPost(
            ledger,
            reservation,
            post,
            effectiveTimestamp,
          );
          return { result: {}, changed: before !== JSON.stringify(reservation) };
        }
        if (
          reservation.postResponseDigest === post.responseDigest &&
          reservation.postOutcome === post.outcome &&
          (reservation.postOutcome === "failed" ||
            post.agentId === undefined ||
            reservation.agentId === post.agentId)
        ) {
          return { result: {}, changed: false };
        }
        throw new AgentHookStateError(
          `conflicting PostToolUse was observed for ${parsed.toolUseId}`,
          "agent_hook_input_invalid",
        );
      }
      const before = JSON.stringify(reservation);
      applyPostToReservation(
        ledger,
        reservation,
        post,
        effectiveTimestamp,
      );
      return { result: {}, changed: before !== JSON.stringify(reservation) };
    },
  );
}

function lifecycleInput(input: JsonObject): {
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentType: string;
} {
  return {
    sessionId: inputString(input, "session_id", true),
    agentId: inputString(input, "agent_id", true),
    agentType: inputString(input, "agent_type"),
  };
}

function reservationLinkedToAgent(
  ledger: AgentLedgerV1,
  agent: AgentObservation,
): Reservation | undefined {
  if (agent.reservationToolUseId !== undefined) {
    return recordGet(ledger.reservations, agent.reservationToolUseId);
  }
  return Object.values(ledger.reservations).find(
    (reservation) => reservation.agentId === agent.agentId,
  );
}

function onSubagentStart(
  cwd: string,
  env: AgentHookEnvironment,
  input: JsonObject,
  timestamp: number,
): AgentHookOutput {
  const parsed = lifecycleInput(input);
  return withLedger(
    cwd,
    env,
    parsed.sessionId,
    timestamp,
    (ledger, effectiveTimestamp): LedgerMutation<AgentHookOutput> => {
      const existing = recordGet(ledger.agents, parsed.agentId);
      const linkedReservation =
        existing === undefined
          ? undefined
          : reservationLinkedToAgent(ledger, existing);
      if (
        existing?.state === "running" &&
        (linkedReservation === undefined ||
          ACTIVE_RESERVATION_STATES.has(linkedReservation.state))
      ) {
        return { result: {}, changed: false };
      }
      if (
        existing?.state === "stopped" ||
        linkedReservation?.state === "stopped"
      ) {
        return { result: {}, changed: false };
      }
      const isNewAgent = existing === undefined;
      const newReservation =
        isNewAgent
          ? uniqueStartLifecycleCandidate(ledger, effectiveTimestamp)
          : undefined;
      if (
        isNewAgent &&
        newReservation === undefined &&
        !makeRoomForUnlinkedAgentObservation(ledger)
      ) {
        return {
          result: {
            systemMessage:
              "gdm agent gate: unlinked lifecycle observation limit reached; " +
              "the new Start could not be correlated safely",
          },
          changed: false,
        };
      }
      const agent: AgentObservation =
        existing ??
        {
          agentId: parsed.agentId,
          agentType: parsed.agentType,
          state: "pending",
          firstObservedAt: iso(effectiveTimestamp),
        };
      agent.agentType = parsed.agentType;
      agent.state = "running";
      agent.startedAt = iso(effectiveTimestamp);
      delete agent.stoppedAt;
      recordSet(ledger.agents, parsed.agentId, agent);
      const reservation = linkedReservation ?? newReservation;
      if (reservation !== undefined && linkedReservation !== undefined) {
        reservation.state = "running";
        delete reservation.stoppedAt;
        if (
          reservation.postOutcome !== "failed" &&
          (reservation.failureReason === "pre_acknowledgement_expired" ||
            reservation.failureReason === "lifecycle_lease_expired")
        ) {
          delete reservation.failureReason;
        }
        reservation.expiresAt = iso(
          effectiveTimestamp + AGENT_RESERVATION_TTL_MS,
        );
      } else if (
        reservation !== undefined &&
        ACTIVE_RESERVATION_STATES.has(reservation.state)
      ) {
        const authority: AgentLinkAuthority =
          reservationProtocol(reservation) === "v2"
            ? "serialized-v2"
            : "provisional";
        if (linkReservationToAgent(ledger, reservation, agent, authority)) {
          reservation.state = "running";
          reservation.expiresAt = iso(
            effectiveTimestamp + AGENT_RESERVATION_TTL_MS,
          );
        }
      }
      return { result: {}, changed: true };
    },
  );
}

function onSubagentStop(
  cwd: string,
  env: AgentHookEnvironment,
  input: JsonObject,
  timestamp: number,
): AgentHookOutput {
  const parsed = lifecycleInput(input);
  return withLedger(
    cwd,
    env,
    parsed.sessionId,
    timestamp,
    (ledger, effectiveTimestamp): LedgerMutation<AgentHookOutput> => {
      const existing = recordGet(ledger.agents, parsed.agentId);
      if (existing?.state === "stopped") return { result: {}, changed: false };
      const isNewAgent = existing === undefined;
      const newReservation =
        isNewAgent ? uniqueV2LifecycleCandidate(ledger) : undefined;
      if (
        isNewAgent &&
        newReservation === undefined &&
        !makeRoomForUnlinkedAgentObservation(ledger)
      ) {
        return {
          result: {
            systemMessage:
              "gdm agent gate: unlinked lifecycle observation limit reached; " +
              "the new Stop could not be correlated safely",
          },
          changed: false,
        };
      }
      const agent: AgentObservation =
        existing ??
        {
          agentId: parsed.agentId,
          agentType: parsed.agentType,
          state: "pending",
          firstObservedAt: iso(effectiveTimestamp),
        };
      agent.agentType = parsed.agentType;
      agent.state = "stopped";
      agent.stoppedAt = iso(effectiveTimestamp);
      recordSet(ledger.agents, parsed.agentId, agent);
      let reservation =
        agent.reservationToolUseId === undefined
          ? undefined
          : recordGet(ledger.reservations, agent.reservationToolUseId);
      reservation ??= Object.values(ledger.reservations).find(
        (candidate) => candidate.agentId === parsed.agentId,
      );
      reservation ??= newReservation;
      if (newReservation !== undefined && reservation === newReservation) {
        if (
          !linkReservationToAgent(
            ledger,
            newReservation,
            agent,
            "serialized-v2",
          )
        ) {
          throw new AgentHookStateError(
            `SubagentStop could not resolve V2 reservation ${newReservation.toolUseId}`,
            "agent_state_corrupt",
          );
        }
      }
      if (
        reservation !== undefined &&
        ACTIVE_RESERVATION_STATES.has(reservation.state) &&
        (reservation.agentLinkAuthority === "post" ||
          reservation.agentLinkAuthority === "caller" ||
          reservation.agentLinkAuthority === "serialized-v2") &&
        linkReservationToAgent(
          ledger,
          reservation,
          agent,
          reservation.agentLinkAuthority,
        )
      ) {
        if (reservation.postOutcome === "failed") {
          reservation.state = "failed";
          delete reservation.stoppedAt;
        } else {
          reservation.state = "stopped";
          reservation.stoppedAt = iso(effectiveTimestamp);
        }
      }
      return { result: {}, changed: true };
    },
  );
}

function onStop(
  cwd: string,
  env: AgentHookEnvironment,
  input: JsonObject,
  timestamp: number,
): AgentHookOutput {
  const sessionId = inputString(input, "session_id", true);
  const stopHookActive = input.stop_hook_active;
  if (stopHookActive !== undefined && typeof stopHookActive !== "boolean") {
    throw new AgentHookStateError(
      "stop_hook_active must be a boolean when present",
      "agent_hook_input_invalid",
    );
  }
  return withLedger(
    cwd,
    env,
    sessionId,
    timestamp,
    (ledger): LedgerMutation<AgentHookOutput> => {
      const active = Object.values(ledger.reservations).filter((reservation) =>
        ACTIVE_RESERVATION_STATES.has(reservation.state),
      );
      const unlinkedActiveAgents = Object.values(ledger.agents).filter(
        (agent) =>
          (agent.state === "pending" || agent.state === "running") &&
          (agent.reservationToolUseId === undefined ||
            recordGet(ledger.reservations, agent.reservationToolUseId) === undefined),
      );
      if (active.length === 0 && unlinkedActiveAgents.length === 0) {
        return { result: {}, changed: false };
      }
      const pending =
        active.filter((reservation) => reservation.state === "pending").length +
        unlinkedActiveAgents.filter((agent) => agent.state === "pending").length;
      const running =
        active.filter((reservation) => reservation.state === "running").length +
        unlinkedActiveAgents.filter((agent) => agent.state === "running").length;
      const ids = [
        ...active.map((reservation) => reservation.envelope.taskId),
        ...unlinkedActiveAgents.map((agent) => `agent:${agent.agentId}`),
      ].slice(0, AGENT_SESSION_HARD_ATTEMPT_LIMIT);
      const reason =
        `gdm agent gate: delegated work remains pending (${pending}) or running (${running})` +
        `${ids.length > 0 ? ` [${ids.join(", ")}]` : ""}. ` +
        "Reconcile or stop those agents before ending the turn.";
      if (stopHookActive === true) {
        return {
          result: {
            systemMessage:
              `${reason} The Stop guardrail already continued once, so it will not ` +
              "create an infinite continuation loop.",
          },
          changed: false,
        };
      }
      return {
        result: {
          decision: "block",
          reason,
        },
        changed: false,
      };
    },
  );
}

function hookFailureOutput(
  event: unknown,
  error: unknown,
  stopHookActive: boolean,
): AgentHookOutput {
  const reason = `gdm agent gate failed closed: ${errorMessage(error)}`;
  if (event === "PostToolUse" || event === "SubagentStop" || event === "Stop") {
    if (
      stopHookActive &&
      (event === "SubagentStop" || event === "Stop")
    ) {
      return {
        systemMessage:
          `${reason}. The hook already requested one continuation and will not loop again.`,
      };
    }
    return { decision: "block", reason };
  }
  if (event === "SubagentStart") return { systemMessage: reason };
  return denyPreToolUse(reason);
}

export function runCodexAgentHook(
  cwd: string,
  stdinText: string,
  env: AgentHookEnvironment,
  timestamp = Date.now(),
): AgentHookOutput {
  let input: JsonObject | undefined;
  let event: unknown;
  try {
    input = parseHookInput(stdinText);
    event = input.hook_event_name;
    if (typeof event !== "string") {
      throw new AgentHookStateError(
        "hook_event_name must be a string",
        "agent_hook_input_invalid",
      );
    }
    if (event === "PreToolUse") return onPreToolUse(cwd, env, input, timestamp);
    if (event === "PostToolUse") return onPostToolUse(cwd, env, input, timestamp);
    if (event === "SubagentStart") return onSubagentStart(cwd, env, input, timestamp);
    if (event === "SubagentStop") return onSubagentStop(cwd, env, input, timestamp);
    if (event === "Stop") return onStop(cwd, env, input, timestamp);
    throw new AgentHookStateError(
      `unsupported hook event: ${event}`,
      "agent_hook_input_invalid",
    );
  } catch (error) {
    return hookFailureOutput(event, error, input?.stop_hook_active === true);
  }
}

function emptySummary(directory: string): AgentHookLedgerSummary {
  return {
    schemaVersion: 1,
    directory,
    sessions: 0,
    corruptLedgers: 0,
    totalAcceptedAttempts: 0,
    structuredAttempts: 0,
    unstructuredAttempts: 0,
    pending: 0,
    running: 0,
    stopped: 0,
    failed: 0,
    expired: 0,
    initialSessionAttemptLimit: AGENT_SESSION_INITIAL_ATTEMPT_LIMIT,
    attemptExtensionSize: AGENT_SESSION_ATTEMPT_EXTENSION_SIZE,
    hardSessionAttemptLimit: AGENT_SESSION_HARD_ATTEMPT_LIMIT,
    preAcknowledgementTtlMs: AGENT_PRE_ACK_TTL_MS,
    lifecycleLeaseMs: AGENT_RESERVATION_TTL_MS,
    parentDelegationEnforcement:
      "caller-bound when agent_id is present; declaration-based compatibility fallback otherwise",
    subagentStopSemantics:
      "turn-stop sequencing hint only; it is not thread termination or verified completion",
    lifecycleAssociation:
      "V1 lifecycle-only association is provisional; V2 serialized handshakes associate turns; reuse and interrupt remain cooperative",
  };
}

export function readAgentHookLedgerSummary(
  cwd: string,
  env: AgentHookEnvironment,
  timestamp = Date.now(),
): AgentHookLedgerSummary {
  const directory = agentLedgerDirectory(cwd, env);
  const summary = emptySummary(directory);
  if (!pathEntryExists(directory)) return summary;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentHookStateError(
      `agent ledger directory is invalid: ${directory}`,
      "agent_state_path_invalid",
    );
  }
  const counts = {
    sessions: 0,
    corruptLedgers: 0,
    totalAcceptedAttempts: 0,
    structuredAttempts: 0,
    unstructuredAttempts: 0,
    pending: 0,
    running: 0,
    stopped: 0,
    failed: 0,
    expired: 0,
  };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      assertRegularStateFile(path);
      const ledger = validateLedger(JSON.parse(readFileSync(path, "utf8")), path);
      migrateLedgerV1(ledger);
      validateLedger(ledger, path);
      validateLedgerBounds(ledger, path);
      counts.sessions += 1;
      counts.totalAcceptedAttempts += ledger.totalAcceptedAttempts;
      for (const reservation of Object.values(ledger.reservations)) {
        if (reservation.contractMode === "structured") counts.structuredAttempts += 1;
        else counts.unstructuredAttempts += 1;
        const effectiveState =
          ACTIVE_RESERVATION_STATES.has(reservation.state) &&
            Date.parse(reservation.expiresAt) <= timestamp
            ? "expired"
            : reservation.state;
        counts[effectiveState] += 1;
      }
    } catch {
      counts.corruptLedgers += 1;
    }
  }
  return { ...summary, ...counts };
}
