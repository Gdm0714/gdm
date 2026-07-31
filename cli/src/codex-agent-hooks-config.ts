import {
  closeSync,
  constants,
  accessSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  objectValue,
  readCodexConfig,
} from "./codex-config.ts";

export const AGENT_HOOK_HANDLER_ID = "gdm-agent-gate-v1";
export const AGENT_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export type AgentHookEvent = (typeof AGENT_HOOK_EVENTS)[number];
export type AgentHookEnvironment = Readonly<Record<string, string | undefined>>;

type JsonObject = { [key: string]: unknown };

export type CodexHooksFeatureState =
  | "enabled"
  | "disabled"
  | "default-enabled"
  | "invalid";

export type CodexHooksFeatureInspection = {
  readonly state: CodexHooksFeatureState;
  readonly configPath: string;
  readonly invalidKind?: "path" | "read" | "parse" | "shape" | "conflict";
  readonly invalidMessage?: string;
  readonly inlineHooksConfigured: boolean;
};

export type AgentHooksStatus = {
  readonly schemaVersion: 1;
  readonly configPath: string;
  readonly backupPath: string;
  readonly handlerId: string;
  readonly configExists: boolean;
  readonly configured: boolean;
  readonly executable: boolean;
  readonly executablePath: string | null;
  readonly executableError: string | null;
  readonly currentExecutablePath: string | null;
  readonly matchesCurrentExecutable: boolean | null;
  readonly inlineHooksConfigured: boolean;
  readonly multipleSources: boolean;
  readonly installed: boolean;
  readonly installedEvents: readonly AgentHookEvent[];
  readonly missingEvents: readonly AgentHookEvent[];
  readonly duplicateEvents: readonly AgentHookEvent[];
  readonly invalidEvents: readonly AgentHookEvent[];
  readonly commandsConsistent: boolean;
  readonly command: string | null;
};

export type AgentHooksInstallResult = AgentHooksStatus & {
  readonly changed: boolean;
  readonly backupCreated: boolean;
  readonly dryRun: boolean;
};

export class AgentHooksConfigError extends Error {
  readonly code:
    | "agent_hooks_home_missing"
    | "agent_hooks_path_invalid"
    | "agent_hooks_binary_invalid"
    | "agent_hooks_config_invalid"
    | "agent_hooks_backup_invalid"
    | "agent_hooks_config_drift"
    | "agent_hooks_lock_timeout";

  constructor(message: string, code: AgentHooksConfigError["code"]) {
    super(message);
    this.name = "AgentHooksConfigError";
    this.code = code;
  }
}

export const AGENT_HOOK_SPAWN_MATCHER =
  "^(Agent|spawn_agent|collaborationspawn_agent|collaboration\\.spawn_agent|[A-Za-z0-9_-]{1,64}spawn_agent)$";
const AGENT_HOOK_TIMEOUT_SECONDS = 10;
const CONFIG_LOCK_WAIT_MS = 5_000;
const CONFIG_LOCK_STALE_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

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

function sleep(milliseconds: number): void {
  Atomics.wait(sleepCell, 0, 0, milliseconds);
}

function processIsAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

type LockOwnerState = "alive" | "dead" | "malformed" | "unreadable";

function lockOwnerState(path: string): LockOwnerState {
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    return "unreadable";
  }
  const match = /^([1-9]\d*)-[0-9a-f]{24}$/u.exec(token);
  if (match === null) return "malformed";
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) return "malformed";
  const alive = processIsAlive(pid);
  if (alive === true) return "alive";
  if (alive === false) return "dead";
  return "unreadable";
}

function reclaimStaleLock(
  path: string,
  observed: NonNullable<ReturnType<typeof lstatSync>>,
): boolean {
  const initialState = lockOwnerState(path);
  if (initialState !== "dead" && initialState !== "malformed") return false;
  const current = lstatIfExists(path);
  if (current === undefined) return true;
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== observed.dev ||
    current.ino !== observed.ino ||
    current.mtimeMs !== observed.mtimeMs ||
    Date.now() - Number(current.mtimeMs) <= CONFIG_LOCK_STALE_MS
  ) {
    return false;
  }
  const confirmedState = lockOwnerState(path);
  if (confirmedState !== "dead" && confirmedState !== "malformed") return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") return true;
    throw error;
  }
}

export function resolveCodexHome(
  cwd: string,
  env: AgentHookEnvironment,
): string {
  const configured = env.CODEX_HOME;
  if (configured !== undefined && configured.length > 0) {
    return isAbsolute(configured) ? configured : resolve(cwd, configured);
  }
  const home = env.HOME;
  if (home === undefined || home.length === 0) {
    throw new AgentHooksConfigError(
      "CODEX_HOME 또는 HOME이 필요합니다",
      "agent_hooks_home_missing",
    );
  }
  return join(home, ".codex");
}

export function agentHooksConfigPath(cwd: string, env: AgentHookEnvironment): string {
  return join(resolveCodexHome(cwd, env), "hooks.json");
}

export function agentHooksBackupPath(cwd: string, env: AgentHookEnvironment): string {
  return `${agentHooksConfigPath(cwd, env)}.gdm-backup`;
}

function ensureConfigDirectory(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentHooksConfigError(
      `Codex 설정 디렉터리가 일반 디렉터리가 아닙니다: ${directory}`,
      "agent_hooks_path_invalid",
    );
  }
}

function assertExistingConfigDirectory(path: string): void {
  const directory = dirname(path);
  const stat = lstatIfExists(directory);
  if (stat === undefined) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentHooksConfigError(
      `Codex 설정 디렉터리가 일반 디렉터리가 아닙니다: ${directory}`,
      "agent_hooks_path_invalid",
    );
  }
}

function assertRegularFile(path: string, kind: "config" | "backup" | "lock"): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const code =
      kind === "backup" ? "agent_hooks_backup_invalid" : "agent_hooks_path_invalid";
    throw new AgentHooksConfigError(
      `${kind} 경로가 일반 파일이 아닙니다: ${path}`,
      code,
    );
  }
}

function parseConfig(bytes: Buffer, path: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new AgentHooksConfigError(
      `Codex hooks 설정 JSON이 손상되었습니다: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "agent_hooks_config_invalid",
    );
  }
  if (!isObject(value)) {
    throw new AgentHooksConfigError(
      `Codex hooks 설정 최상위 값은 객체여야 합니다: ${path}`,
      "agent_hooks_config_invalid",
    );
  }
  if (value.hooks !== undefined && !isObject(value.hooks)) {
    throw new AgentHooksConfigError(
      `Codex hooks 설정의 hooks 값은 객체여야 합니다: ${path}`,
      "agent_hooks_config_invalid",
    );
  }
  return value;
}

function readConfig(path: string): { readonly existed: boolean; readonly bytes: Buffer; readonly value: JsonObject } {
  if (!pathEntryExists(path)) {
    return { existed: false, bytes: Buffer.alloc(0), value: {} };
  }
  assertRegularFile(path, "config");
  const bytes = readFileSync(path);
  return { existed: true, bytes, value: parseConfig(bytes, path) };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function assertRegularExecutable(executable: string): void {
  if (!isAbsolute(executable)) {
    throw new AgentHooksConfigError(
      `hook 실행 파일은 절대 경로여야 합니다: ${executable}`,
      "agent_hooks_binary_invalid",
    );
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(executable);
  } catch (error) {
    throw new AgentHooksConfigError(
      `hook 실행 파일을 확인할 수 없습니다: ${executable}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "agent_hooks_binary_invalid",
    );
  }
  if (!stat.isFile()) {
    throw new AgentHooksConfigError(
      `hook 실행 파일이 일반 파일이 아닙니다: ${executable}`,
      "agent_hooks_binary_invalid",
    );
  }
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    throw new AgentHooksConfigError(
      `hook 실행 파일에 실행 권한이 없습니다: ${executable}`,
      "agent_hooks_binary_invalid",
    );
  }
}

function isExactProbeResponse(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return false;
  }
  if (!isObject(parsed) || Object.keys(parsed).length !== 1) return false;
  const output = parsed.hookSpecificOutput;
  return (
    isObject(output) &&
    Object.keys(output).length === 2 &&
    output.hookEventName === "PreToolUse" &&
    output.permissionDecision === "allow"
  );
}

export function assertAgentHookExecutable(executable: string): void {
  assertRegularExecutable(executable);
  const probeInput = JSON.stringify({
    session_id: "gdm-hook-install-probe",
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_use_id: "gdm-hook-install-probe",
    tool_input: {},
  });
  const result = spawnSync(
    executable,
    ["agent", "hook", "--handler-id", AGENT_HOOK_HANDLER_ID],
    {
      input: probeInput,
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    !isExactProbeResponse(result.stdout)
  ) {
    throw new AgentHooksConfigError(
      `hook 실행 파일이 gdm agent hook 프로토콜 검증에 실패했습니다: ${executable}`,
      "agent_hooks_binary_invalid",
    );
  }
}

function pathsReferToSameExecutable(
  configured: string,
  current: string,
): boolean {
  if (resolve(configured) === resolve(current)) return true;
  try {
    return realpathSync(configured) === realpathSync(current);
  } catch {
    return false;
  }
}

export function agentHookCommand(executable: string): string {
  if (executable.length === 0 || executable.includes("\n") || executable.includes("\r")) {
    throw new AgentHooksConfigError(
      "hook 실행 파일 경로가 올바르지 않습니다",
      "agent_hooks_path_invalid",
    );
  }
  return `${shellQuote(executable)} agent hook --handler-id ${AGENT_HOOK_HANDLER_ID}`;
}

function executableFromExactCommand(command: string): string | undefined {
  const suffix = ` agent hook --handler-id ${AGENT_HOOK_HANDLER_ID}`;
  if (!command.endsWith(suffix)) return undefined;
  const quoted = command.slice(0, -suffix.length);
  if (quoted.length < 2 || quoted[0] !== "'" || quoted.at(-1) !== "'") {
    return undefined;
  }
  const body = quoted.slice(1, -1);
  const encodedQuote = "'\"'\"'";
  let decoded = "";
  for (let index = 0; index < body.length;) {
    if (body.startsWith(encodedQuote, index)) {
      decoded += "'";
      index += encodedQuote.length;
      continue;
    }
    if (body[index] === "'" || body[index] === "\n" || body[index] === "\r") {
      return undefined;
    }
    decoded += body[index]!;
    index += 1;
  }
  if (!isAbsolute(decoded) || agentHookCommand(decoded) !== command) return undefined;
  return decoded;
}

function executableState(path: string | null): {
  readonly executable: boolean;
  readonly error: string | null;
} {
  if (path === null) {
    return { executable: false, error: "handler command에서 실행 파일을 확인할 수 없습니다" };
  }
  try {
    assertRegularExecutable(path);
    return { executable: true, error: null };
  } catch (error) {
    return {
      executable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function handlerFor(event: AgentHookEvent, executable: string): JsonObject {
  const status: Record<AgentHookEvent, string> = {
    PreToolUse: "Checking delegated agent envelope",
    PostToolUse: "Reconciling delegated agent spawn",
    SubagentStart: "Recording delegated agent start",
    SubagentStop: "Recording delegated agent stop",
    Stop: "Checking delegated agent completion",
  };
  return {
    type: "command",
    command: agentHookCommand(executable),
    timeout: AGENT_HOOK_TIMEOUT_SECONDS,
    statusMessage: status[event],
  };
}

function desiredGroup(event: AgentHookEvent, executable: string): JsonObject {
  const group: JsonObject = { hooks: [handlerFor(event, executable)] };
  if (event === "PreToolUse" || event === "PostToolUse") {
    group.matcher = AGENT_HOOK_SPAWN_MATCHER;
  }
  return group;
}

function isGdmHandler(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.command === "string" &&
    new RegExp(
      `(?:^|\\s)--handler-id(?:=|\\s+)(?:['"])?${AGENT_HOOK_HANDLER_ID}(?:['"])?(?=\\s|$)`,
      "u",
    ).test(value.command)
  );
}

function eventGroups(hooks: JsonObject, event: AgentHookEvent, path: string): unknown[] {
  const value = hooks[event];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AgentHooksConfigError(
      `Codex hooks 설정의 ${event} 값은 배열이어야 합니다: ${path}`,
      "agent_hooks_config_invalid",
    );
  }
  return value;
}

function withoutGdmHandlers(
  groups: readonly unknown[],
  event: AgentHookEvent,
  path: string,
): unknown[] {
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      throw new AgentHooksConfigError(
        `Codex hooks 설정의 ${event} matcher group이 올바르지 않습니다: ${path}`,
        "agent_hooks_config_invalid",
      );
    }
    const handlers = group.hooks.filter((handler) => !isGdmHandler(handler));
    if (handlers.length === 0) continue;
    kept.push({ ...group, hooks: handlers });
  }
  return kept;
}

function mergedConfig(config: JsonObject, path: string, executable: string): JsonObject {
  const existingHooks = config.hooks;
  const hooks: JsonObject = isObject(existingHooks) ? { ...existingHooks } : {};
  for (const event of AGENT_HOOK_EVENTS) {
    const groups = eventGroups(hooks, event, path);
    hooks[event] = [
      ...withoutGdmHandlers(groups, event, path),
      desiredGroup(event, executable),
    ];
  }
  return { ...config, hooks };
}

function serializedConfig(config: JsonObject): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function openExclusive(path: string, mode: number): number {
  return openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
}

function writeExclusive(path: string, bytes: Buffer, mode: number): void {
  let fd: number | undefined;
  try {
    fd = openExclusive(path, mode);
    writeFileSync(fd, bytes);
    // Apply the final mode to the still-private inode before publishing it.
    // That leaves rename as the only operation that can expose the new bytes,
    // with no fallible chmod after the atomic replacement.
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function unlinkBestEffort(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Private temporary files use unpredictable names and restrictive modes.
    // Cleanup failure must not mask the original error or a completed publish.
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems. The
    // atomic rename/link remains correct even when this durability hint fails.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // This is a durability hint only.
      }
    }
  }
}

function publishBackupExclusive(
  path: string,
  bytes: Buffer,
  mode: number,
  beforePublish?: () => void,
): boolean {
  const temporary = join(
    dirname(path),
    `.${AGENT_HOOK_HANDLER_ID}.backup.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let published = false;
  try {
    // A private, fully synced inode is linked into the final name only after
    // the complete backup exists. link(2) also preserves no-overwrite
    // semantics if another writer publishes the first backup concurrently.
    writeExclusive(temporary, bytes, mode);
    beforePublish?.();
    try {
      linkSync(temporary, path);
      published = true;
    } catch (error) {
      const code = isObject(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "EEXIST") throw error;
      assertRegularFile(path, "backup");
    }
  } finally {
    unlinkBestEffort(temporary);
  }
  if (published) syncDirectoryBestEffort(dirname(path));
  return published;
}

function writeAtomic(
  path: string,
  bytes: Buffer,
  mode: number,
  beforeRename: () => void,
): void {
  const temporary = join(
    dirname(path),
    `.${AGENT_HOOK_HANDLER_ID}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeExclusive(temporary, bytes, mode);
    beforeRename();
    renameSync(temporary, path);
    syncDirectoryBestEffort(dirname(path));
  } finally {
    unlinkBestEffort(temporary);
  }
}

function acquireConfigLock(path: string): () => void {
  const token = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const started = Date.now();
  for (;;) {
    let fd: number | undefined;
    let createdStat: ReturnType<typeof fstatSync> | undefined;
    try {
      fd = openExclusive(path, 0o600);
      createdStat = fstatSync(fd);
      writeFileSync(fd, `${token}\n`);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      return () => {
        try {
          const stat = lstatIfExists(path);
          if (
            stat === undefined ||
            !stat.isFile() ||
            stat.isSymbolicLink()
          ) {
            return;
          }
          if (readFileSync(path, "utf8").trim() === token) unlinkSync(path);
        } catch {
          // Releasing a lock must never turn an already-published config into
          // an apparent install failure. A replaced/foreign lock is left alone.
        }
      };
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the original publication error.
        }
      }
      if (createdStat !== undefined) {
        const current = lstatIfExists(path);
        if (
          current !== undefined &&
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === createdStat.dev &&
          current.ino === createdStat.ino
        ) {
          try {
            unlinkSync(path);
          } catch {
            // Preserve the original publication error.
          }
        }
        throw error;
      }
      const code = isObject(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "EEXIST") throw error;
      const stat = lstatIfExists(path);
      if (stat === undefined) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new AgentHooksConfigError(
          `lock 경로가 일반 파일이 아닙니다: ${path}`,
          "agent_hooks_path_invalid",
        );
      }
      const age = Date.now() - Number(stat.mtimeMs);
      if (age > CONFIG_LOCK_STALE_MS && reclaimStaleLock(path, stat)) {
        continue;
      }
      if (Date.now() - started >= CONFIG_LOCK_WAIT_MS) {
        throw new AgentHooksConfigError(
          `Codex hooks 설정 잠금을 기다리다 시간 초과했습니다: ${path}`,
          "agent_hooks_lock_timeout",
        );
      }
      sleep(10);
    }
  }
}

type AgentHookCandidate = {
  readonly group: JsonObject;
  readonly handler: JsonObject;
};

function handlersForEvent(
  config: JsonObject,
  event: AgentHookEvent,
  path: string,
): AgentHookCandidate[] {
  const hooks = config.hooks;
  if (!isObject(hooks)) return [];
  const handlers: AgentHookCandidate[] = [];
  for (const group of eventGroups(hooks, event, path)) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      throw new AgentHooksConfigError(
        `Codex hooks 설정의 ${event} matcher group이 올바르지 않습니다: ${path}`,
        "agent_hooks_config_invalid",
      );
    }
    for (const handler of group.hooks) {
      if (isGdmHandler(handler) && isObject(handler)) {
        handlers.push({ group, handler });
      }
    }
  }
  return handlers;
}

function hasValidMatcher(event: AgentHookEvent, group: JsonObject): boolean {
  if (event === "PreToolUse" || event === "PostToolUse") {
    return group.matcher === AGENT_HOOK_SPAWN_MATCHER;
  }
  return !Object.prototype.hasOwnProperty.call(group, "matcher");
}

function statusFromConfig(
  cwd: string,
  env: AgentHookEnvironment,
  config: JsonObject,
  configExists: boolean,
  currentExecutable?: string,
): AgentHooksStatus {
  const path = agentHooksConfigPath(cwd, env);
  const installedEvents: AgentHookEvent[] = [];
  const missingEvents: AgentHookEvent[] = [];
  const duplicateEvents: AgentHookEvent[] = [];
  const invalidEvents: AgentHookEvent[] = [];
  const commands: string[] = [];
  const executablePaths: string[] = [];
  let command: string | null = null;
  for (const event of AGENT_HOOK_EVENTS) {
    const candidates = handlersForEvent(config, event, path);
    if (candidates.length === 0) {
      missingEvents.push(event);
      continue;
    }
    if (candidates.length > 1) {
      duplicateEvents.push(event);
      continue;
    }
    const candidate = candidates[0]!;
    const current = candidate.handler.command;
    if (typeof current === "string") {
      command ??= current;
      commands.push(current);
    }
    const executablePath =
      typeof current === "string" ? executableFromExactCommand(current) : undefined;
    if (executablePath !== undefined) executablePaths.push(executablePath);
    if (
      candidate.handler.type === "command" &&
      typeof current === "string" &&
      executablePath !== undefined &&
      candidate.handler.timeout === AGENT_HOOK_TIMEOUT_SECONDS &&
      hasValidMatcher(event, candidate.group)
    ) {
      installedEvents.push(event);
    } else {
      invalidEvents.push(event);
    }
  }
  const commandsConsistent =
    commands.length === AGENT_HOOK_EVENTS.length &&
    new Set(commands).size === 1;
  const configured =
    installedEvents.length === AGENT_HOOK_EVENTS.length &&
    missingEvents.length === 0 &&
    duplicateEvents.length === 0 &&
    invalidEvents.length === 0 &&
    commandsConsistent;
  const executablePath =
    configured &&
    executablePaths.length === AGENT_HOOK_EVENTS.length &&
    new Set(executablePaths).size === 1
      ? executablePaths[0]!
      : null;
  const executable = executableState(executablePath);
  const matchesCurrentExecutable =
    currentExecutable === undefined || executablePath === null
      ? currentExecutable === undefined
        ? null
        : false
      : pathsReferToSameExecutable(executablePath, currentExecutable);
  const feature = inspectCodexHooksFeature(resolveCodexHome(cwd, env));
  const multipleSources = configExists && feature.inlineHooksConfigured;
  return {
    schemaVersion: 1,
    configPath: path,
    backupPath: agentHooksBackupPath(cwd, env),
    handlerId: AGENT_HOOK_HANDLER_ID,
    configExists,
    configured,
    executable: configured && executable.executable,
    executablePath,
    executableError: configured ? executable.error : null,
    currentExecutablePath: currentExecutable ?? null,
    matchesCurrentExecutable,
    inlineHooksConfigured: feature.inlineHooksConfigured,
    multipleSources,
    installed:
      configured &&
      executable.executable &&
      matchesCurrentExecutable !== false,
    installedEvents,
    missingEvents,
    duplicateEvents,
    invalidEvents,
    commandsConsistent,
    command,
  };
}

export function readAgentHooksStatus(
  cwd: string,
  env: AgentHookEnvironment,
  currentExecutable?: string,
): AgentHooksStatus {
  const path = agentHooksConfigPath(cwd, env);
  if (!pathEntryExists(path)) {
    return statusFromConfig(cwd, env, {}, false, currentExecutable);
  }
  return statusFromConfig(
    cwd,
    env,
    readConfig(path).value,
    true,
    currentExecutable,
  );
}

export type AgentHooksInstallOptions = {
  readonly dryRun?: boolean;
  readonly beforeWrite?: () => void;
  readonly beforeBackupPublish?: () => void;
  readonly beforeRename?: () => void;
};

function assertBackupSafe(path: string): void {
  if (pathEntryExists(path)) assertRegularFile(path, "backup");
}

function assertConfigUnchanged(
  path: string,
  original: {
    readonly existed: boolean;
    readonly bytes: Buffer;
  },
): void {
  let current: ReturnType<typeof readConfig>;
  try {
    current = readConfig(path);
  } catch (error) {
    throw new AgentHooksConfigError(
      `Codex hooks 설정이 설치 도중 외부에서 변경되었습니다: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "agent_hooks_config_drift",
    );
  }
  if (current.existed !== original.existed || !current.bytes.equals(original.bytes)) {
    throw new AgentHooksConfigError(
      `Codex hooks 설정이 설치 도중 외부에서 변경되었습니다: ${path}`,
      "agent_hooks_config_drift",
    );
  }
}

function assertCodexHooksFeatureConfigValid(
  cwd: string,
  env: AgentHookEnvironment,
): void {
  const feature = inspectCodexHooksFeature(resolveCodexHome(cwd, env));
  if (feature.state !== "invalid") return;
  throw new AgentHooksConfigError(
    `Codex config.toml의 hooks 설정이 올바르지 않습니다: ${
      feature.invalidMessage ?? feature.configPath
    }`,
    "agent_hooks_config_invalid",
  );
}

export function installAgentHooks(
  cwd: string,
  env: AgentHookEnvironment,
  executable: string,
  options: AgentHooksInstallOptions = {},
): AgentHooksInstallResult {
  const path = agentHooksConfigPath(cwd, env);
  assertCodexHooksFeatureConfigValid(cwd, env);
  if (options.dryRun === true) {
    assertExistingConfigDirectory(path);
    const current = readConfig(path);
    const backup = agentHooksBackupPath(cwd, env);
    assertBackupSafe(backup);
    const next = serializedConfig(mergedConfig(current.value, path, executable));
    const changed = !current.bytes.equals(next);
    return {
      ...statusFromConfig(
        cwd,
        env,
        changed ? parseConfig(next, path) : current.value,
        true,
        executable,
      ),
      changed,
      backupCreated: false,
      dryRun: true,
    };
  }

  ensureConfigDirectory(path);
  const release = acquireConfigLock(`${path}.gdm-lock`);
  let backupCreated = false;
  try {
    const current = readConfig(path);
    const backup = agentHooksBackupPath(cwd, env);
    assertBackupSafe(backup);
    const next = serializedConfig(mergedConfig(current.value, path, executable));
    const changed = !current.bytes.equals(next);
    options.beforeWrite?.();
    assertConfigUnchanged(path, current);
    if (changed && current.existed) {
      if (pathEntryExists(backup)) {
        assertRegularFile(backup, "backup");
      } else {
        backupCreated = publishBackupExclusive(
          backup,
          current.bytes,
          0o600,
          options.beforeBackupPublish,
        );
      }
    }
    if (changed) {
      assertConfigUnchanged(path, current);
      const mode = current.existed ? lstatSync(path).mode & 0o777 : 0o600;
      writeAtomic(path, next, mode, () => {
        options.beforeRename?.();
        assertConfigUnchanged(path, current);
      });
    }
    return {
      ...statusFromConfig(
        cwd,
        env,
        changed ? parseConfig(next, path) : current.value,
        current.existed || changed,
        executable,
      ),
      changed,
      backupCreated,
      dryRun: false,
    };
  } finally {
    release();
  }
}

export function inspectCodexHooksFeature(
  codexHomePath: string,
): CodexHooksFeatureInspection {
  const config = readCodexConfig(codexHomePath);
  if (config.state === "missing") {
    return {
      state: "default-enabled",
      configPath: config.path,
      inlineHooksConfigured: false,
    };
  }
  if (config.state === "invalid") {
    return {
      state: "invalid",
      configPath: config.path,
      invalidKind: config.kind,
      invalidMessage: config.message,
      inlineHooksConfigured: false,
    };
  }

  const inlineHooksRaw = config.value.hooks;
  const inlineHooksConfigured = inlineHooksRaw !== undefined;
  const featuresRaw = config.value.features;
  const features = objectValue(featuresRaw);
  if (
    (inlineHooksRaw !== undefined && objectValue(inlineHooksRaw) === undefined) ||
    (featuresRaw !== undefined && features === undefined)
  ) {
    return {
      state: "invalid",
      configPath: config.path,
      invalidKind: "shape",
      invalidMessage: "config.toml의 hooks 또는 features 값은 TOML 테이블이어야 합니다",
      inlineHooksConfigured,
    };
  }
  if (features === undefined) {
    return {
      state: "default-enabled",
      configPath: config.path,
      inlineHooksConfigured,
    };
  }

  const hasHooks = Object.prototype.hasOwnProperty.call(features, "hooks");
  const hasAlias = Object.prototype.hasOwnProperty.call(features, "codex_hooks");
  if (hasHooks && hasAlias) {
    return {
      state: "invalid",
      configPath: config.path,
      invalidKind: "conflict",
      invalidMessage:
        "[features] hooks와 deprecated codex_hooks를 함께 설정할 수 없습니다",
      inlineHooksConfigured,
    };
  }
  const value = hasHooks
    ? features.hooks
    : hasAlias
      ? features.codex_hooks
      : undefined;
  if (value === undefined) {
    return {
      state: "default-enabled",
      configPath: config.path,
      inlineHooksConfigured,
    };
  }
  if (typeof value !== "boolean") {
    return {
      state: "invalid",
      configPath: config.path,
      invalidKind: "shape",
      invalidMessage:
        "[features] hooks 값은 true 또는 false여야 합니다",
      inlineHooksConfigured,
    };
  }
  return {
    state: value ? "enabled" : "disabled",
    configPath: config.path,
    inlineHooksConfigured,
  };
}

export function readCodexHooksFeatureState(codexHomePath: string): CodexHooksFeatureState {
  return inspectCodexHooksFeature(codexHomePath).state;
}

export function codexAgentHookDoctorLines(
  cwd: string,
  env: AgentHookEnvironment = { HOME: cwd },
  currentExecutable?: string,
): readonly string[] {
  let codexHomePath: string;
  let status: AgentHooksStatus;
  try {
    codexHomePath = resolveCodexHome(cwd, env);
    status = readAgentHooksStatus(cwd, env, currentExecutable);
  } catch (error) {
    return [
      "  Codex 에이전트 게이트: 설정 오류",
      `  → ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const feature = inspectCodexHooksFeature(codexHomePath);
  const lines: string[] = [];
  const multipleSourceWarning = status.multipleSources
    ? [
        "  → 경고: 같은 Codex 설정 계층에 hooks.json과 inline [hooks]가 함께 있어 둘 다 로드됩니다",
      ]
    : [];
  if (!status.configured) {
    return [
      "  Codex 에이전트 게이트: 미설치 또는 설정 불완전",
      "  → gdm agent hook-install --binary <gdm 절대경로>",
      ...multipleSourceWarning,
    ];
  }
  if (!status.executable) {
    return [
      "  Codex 에이전트 게이트: 설정됨, 실행 파일 사용 불가",
      `  → ${status.executableError ?? status.executablePath ?? "handler command를 확인하세요"}`,
      ...multipleSourceWarning,
    ];
  }
  if (status.matchesCurrentExecutable === false) {
    return [
      "  Codex 에이전트 게이트: 실행 파일 드리프트",
      `  → handler: ${status.executablePath ?? "알 수 없음"}`,
      `  → 현재 gdm: ${status.currentExecutablePath ?? "알 수 없음"}`,
      "  → 현재 gdm으로 hook-install을 다시 실행하세요",
      ...multipleSourceWarning,
    ];
  }
  if (feature.state === "disabled") {
    lines.push(
      "  Codex 에이전트 게이트: 비활성화",
      `  → ${feature.configPath}에 [features] hooks = true를 설정하세요`,
    );
  } else if (feature.state === "invalid") {
    lines.push(
      "  Codex 에이전트 게이트: hooks 기능 설정 오류",
      `  → ${feature.invalidMessage ?? `${feature.configPath}를 확인하세요`}`,
    );
  } else {
    const featureDescription =
      feature.state === "enabled"
        ? "사용자 설정 활성"
        : "명시 설정 없음 · 기본값 활성";
    lines.push(
      `  Codex 에이전트 게이트: 설치됨 (설정 완료 · 실행 가능 · ${featureDescription}, 현재 세션 유효값 미확인)`,
      "  → profile·project·CLI·requirements override가 가능하므로 /debug-config에서 유효 features.hooks를 확인하세요",
      "  → Codex /hooks에서 현재 handler를 검토하고 신뢰해야 실제로 실행됩니다",
    );
  }
  lines.push(...multipleSourceWarning);
  return lines;
}
