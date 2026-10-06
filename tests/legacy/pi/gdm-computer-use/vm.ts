import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import { encodeAppleVncPassword } from "./auth.ts";
import { RfbClient, delay, type RgbaFrame } from "./rfb.ts";

export const VM_NAME = "gdm-cu-vm";
const DEFAULT_TART_PATH = "/opt/homebrew/bin/tart";
const DEFAULT_SOFTNET_PATH = "/opt/homebrew/bin/softnet";
const PINNED_TART_LAUNCHER_SHA256 = "4247b559b8d3f216127bf864f00397880a79c1e16dcccfcadeec708d0f39b950";
const PINNED_TART_BINARY_SHA256 = "e0d71385a2974229c3e97f71862020cce4911c16c3a2fb74ab5e6f540a62131e";
const PINNED_SOFTNET_SHA256 = "5982c8cde55cd039d4aa71add54356224b8b8a040df1a8786f16327b421f701d";
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const TART_COMMAND_SANDBOX = "(version 1) (allow default) (deny process-fork)";
const LSOF_PATH = "/usr/sbin/lsof";
const MAX_COMMAND_OUTPUT = 64 * 1024;
const START_TIMEOUT_MS = 120_000;
const GUEST_MARKER_PATH = "/var/db/gdm-computer-use-vsock";
const GUEST_MARKER_VALUE = "gdm-computer-use-vsock-v1";
const VNC_SETTINGS_PATH = "/Library/Preferences/com.apple.VNCSettings.txt";

type VmRecord = {
  readonly Name: string;
  readonly Running: boolean;
  readonly State: string;
};

type CommandResult = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
};

type CommandOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly detached?: boolean;
  readonly onSpawn?: (child: ChildProcess) => void;
};

export type ComputerUseState = "not-installed" | "no-vm" | "stopped" | "starting" | "ready" | "busy" | "stopping" | "failed";

export type ComputerUseStatus = {
  readonly state: ComputerUseState;
  readonly vmName: string;
  readonly owned: boolean;
  readonly lastError?: string;
};

export interface ComputerUseBackend {
  status(): Promise<ComputerUseStatus>;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  screenshot(signal?: AbortSignal): Promise<RgbaFrame>;
  click(x: number, y: number, button?: "left" | "right" | "middle", clickCount?: 1 | 2, signal?: AbortSignal): Promise<void>;
  typeText(text: string, signal?: AbortSignal): Promise<void>;
  pressKey(key: string, modifiers: readonly string[] | undefined, signal?: AbortSignal): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number, signal?: AbortSignal): Promise<void>;
  drag(x: number, y: number, toX: number, toY: number, button?: "left" | "right" | "middle", signal?: AbortSignal): Promise<void>;
  openApp(app: string, signal?: AbortSignal): Promise<void>;
  execGuest(args: readonly string[], signal?: AbortSignal): Promise<string>;
}

export function parseVmList(output: string): readonly VmRecord[] {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Tart VM list is not an array");
  return parsed.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Tart VM list contains an invalid record");
    const record = value as Record<string, unknown>;
    if (typeof record.Name !== "string" || typeof record.Running !== "boolean" || typeof record.State !== "string") {
      throw new Error("Tart VM list record has an invalid shape");
    }
    return { Name: record.Name, Running: record.Running, State: record.State };
  });
}

export function validateAppName(app: string): string {
  if (!/^[A-Za-z0-9 ._-]{1,64}$/u.test(app)) throw new Error("Guest app name contains unsupported characters");
  return app;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function canonicalExecutable(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error("GDM_TART_PATH must be absolute");
  let canonical: string;
  try {
    canonical = await realpath(input);
    const info = await lstat(canonical);
    if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error("not an executable regular file");
  } catch (error) {
    throw new Error(`Tart is unavailable at ${input}: ${(error as Error).message}`);
  }
  if (process.env.GDM_TART_PATH === undefined) {
    const softnet = await realpath(DEFAULT_SOFTNET_PATH);
    const tartBinary = resolve(dirname(canonical), "..", "libexec", "tart.app", "Contents", "MacOS", "tart");
    const [launcherHash, tartBinaryHash, softnetHash] = await Promise.all([
      sha256File(canonical), sha256File(tartBinary), sha256File(softnet),
    ]);
    if (launcherHash !== PINNED_TART_LAUNCHER_SHA256 || tartBinaryHash !== PINNED_TART_BINARY_SHA256 || softnetHash !== PINNED_SOFTNET_SHA256) {
      throw new Error("Pinned Tart or Softnet runtime hash does not match the audited build");
    }
  }
  return canonical;
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
  };
}

async function runCommandResult(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted) throw new Error("Tart operation cancelled");
  const child = spawn(executable, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: runtimeEnvironment(),
    detached: options.detached ?? false,
  });
  options.onSpawn?.(child);
  child.stdin.end();
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let overflow = false;
  const append = (current: Buffer, chunk: Buffer): Buffer => {
    if (current.length + chunk.length > MAX_COMMAND_OUTPUT) {
      overflow = true;
      child.kill("SIGTERM");
      return current;
    }
    return Buffer.concat([current, chunk]);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

  return await new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Tart command timed out"));
    }, options.timeoutMs ?? 30_000);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("Tart operation cancelled"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => finish(error));
    child.once("close", (exitCode) => {
      if (overflow) finish(new Error("Tart command output exceeded 64 KiB"));
      else finish(undefined, { stdout, stderr, exitCode });
    });
  });
}

async function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  const result = await runCommandResult(executable, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`Tart command failed (${result.exitCode ?? "signal"}): ${result.stderr.toString("utf8").trim().slice(0, 1000)}`);
  }
  return result.stdout.toString("utf8");
}

async function runCommandInput(
  executable: string,
  args: readonly string[],
  input: Buffer,
  options: CommandOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw new Error("Tart operation cancelled");
  const child = spawn(executable, [...args], {
    stdio: ["pipe", "ignore", "pipe"],
    env: runtimeEnvironment(),
    detached: options.detached ?? false,
  });
  options.onSpawn?.(child);
  let stderr: Buffer = Buffer.alloc(0);
  let overflow = false;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length + chunk.length > MAX_COMMAND_OUTPUT) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    stderr = Buffer.concat([stderr, chunk]);
  });
  child.stdin.end(input);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Tart input command timed out"));
    }, options.timeoutMs ?? 30_000);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("Tart operation cancelled"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (overflow) finish(new Error("Tart input command output exceeded 64 KiB"));
      else if (code !== 0) finish(new Error(`Tart input command failed (${code ?? "signal"}): ${stderr.toString("utf8").trim().slice(0, 1000)}`));
      else finish();
    });
  });
}

class ChildStdioDuplex extends Duplex {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.on("end", () => this.push(null));
    child.stdout.on("error", (error) => this.destroy(error));
    child.stdin.on("error", (error) => this.destroy(error));
    child.once("error", (error) => this.destroy(error));
    child.once("exit", (code, signal) => {
      if (code !== 0 && !this.destroyed) this.destroy(new Error(`Guest RFB tunnel exited (${code ?? signal ?? "signal"})`));
      else this.push(null);
    });
  }

  override _read(): void {
    this.child.stdout.resume();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.child.stdin.write(chunk, encoding)) callback();
    else this.child.stdin.once("drain", callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
    callback(error);
  }
}

export function createSessionPassword(random: (bytes: number) => Buffer = randomBytes): Buffer {
  const password = random(8);
  if (password.length !== 8) throw new Error("Session password source must return exactly 8 bytes");
  return Buffer.from(password);
}

type ProcessRecord = { readonly pid: number; readonly parentPid: number; readonly groupId: number; readonly started: string };

function parseProcessTable(table: string): readonly ProcessRecord[] {
  return table.split(/\r?\n/u).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), groupId: Number(match[3]), started: match[4]! }] : [];
  });
}

function ownedProcessPids(records: readonly ProcessRecord[], roots: readonly number[]): readonly number[] {
  const groups = new Set(roots);
  const byParent = new Map<number, number[]>();
  for (const record of records) {
    const children = byParent.get(record.parentPid) ?? [];
    children.push(record.pid);
    byParent.set(record.parentPid, children);
  }
  const seen = new Set(records.filter((record) => groups.has(record.groupId)).map((record) => record.pid));
  const pending = [...seen];
  while (pending.length > 0) {
    for (const child of byParent.get(pending.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      pending.push(child);
    }
  }
  return [...seen];
}

export class TartVmManager implements ComputerUseBackend {
  private state: ComputerUseState = "stopped";
  private tartPath: string | undefined;
  private runProcess: ChildProcessWithoutNullStreams | undefined;
  private tunnelProcess: ChildProcessWithoutNullStreams | undefined;
  private rfb: RfbClient | undefined;
  private runStderr = "";
  private lastError: string | undefined;
  private listenerFailure: Error | undefined;
  private listenerMonitorAbort: AbortController | undefined;
  private listenerMonitor: Promise<void> | undefined;
  private readonly ownedGroupIds = new Set<number>();
  private readonly knownOwnedProcesses = new Map<number, string>();

  async status(): Promise<ComputerUseStatus> {
    try {
      const tart = await this.getTartPath();
      const record = await this.vmRecord(tart);
      if (!record) this.state = "no-vm";
      else if (record.Running && !this.runProcess) this.state = "failed";
      else if (!record.Running && this.state !== "starting" && this.state !== "stopping") this.state = "stopped";
    } catch (error) {
      this.state = "not-installed";
      this.lastError = (error as Error).message;
    }
    return {
      state: this.state,
      vmName: VM_NAME,
      owned: this.runProcess !== undefined,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.runProcess) {
      if (this.state === "ready" || this.state === "busy") return;
      throw new Error(`Computer Use VM is ${this.state}`);
    }
    const tart = await this.getTartPath();
    const record = await this.vmRecord(tart);
    if (!record) throw new Error("Computer Use VM is not set up. Run agents/pi/gdm-computer-use/setup.sh once.");
    if (record.Running) throw new Error("Computer Use VM is already running under another process; refusing to attach or stop it");

    this.state = "starting";
    this.lastError = undefined;
    this.listenerFailure = undefined;
    let password: Buffer | undefined;
    try {
      this.runProcess = await this.spawnVm(tart, signal);
      this.startListenerMonitor();
      await this.waitForGuest(tart, signal);
      await this.assertNoHostTcpListeners();
      await this.verifyGuestMarker(tart, signal);
      password = await this.rotateGuestPassword(tart, signal);
      this.rfb = await this.connectGuestRfb(tart, password, signal);
      password.fill(0);
      password = undefined;
      await this.assertNoHostTcpListeners();
      this.state = "ready";
    } catch (error) {
      password?.fill(0);
      this.lastError = (error as Error).message;
      await this.stop().catch(() => {});
      this.state = "failed";
      throw error;
    }
  }

  async stop(): Promise<void> {
    const owned = this.runProcess;
    this.state = "stopping";
    await this.stopListenerMonitor();
    await this.closeRfb();
    if (owned) {
      await terminateProcessGroup(owned);
      if (owned.pid !== undefined) this.ownedGroupIds.delete(owned.pid);
    }
    for (const groupId of [...this.ownedGroupIds]) await terminateProcessGroupId(groupId);
    await this.terminateEscapedOwnedProcesses();
    this.ownedGroupIds.clear();
    this.knownOwnedProcesses.clear();
    this.runProcess = undefined;
    this.runStderr = "";
    this.state = "stopped";
  }

  async screenshot(signal?: AbortSignal): Promise<RgbaFrame> {
    return await this.withRfb(async (rfb) => await rfb.screenshot(signal));
  }

  async click(x: number, y: number, button?: "left" | "right" | "middle", clickCount?: 1 | 2, signal?: AbortSignal): Promise<void> {
    await this.withRfb(async (rfb) => await rfb.click(x, y, button, clickCount, signal));
  }

  async typeText(text: string, signal?: AbortSignal): Promise<void> {
    await this.withRfb(async (rfb) => await rfb.typeText(text, signal));
  }

  async pressKey(key: string, modifiers: readonly string[] | undefined, signal?: AbortSignal): Promise<void> {
    await this.withRfb(async (rfb) => await rfb.pressKey(key, modifiers, signal));
  }

  async scroll(x: number, y: number, dx: number, dy: number, signal?: AbortSignal): Promise<void> {
    await this.withRfb(async (rfb) => await rfb.scroll(x, y, dx, dy, signal));
  }

  async drag(x: number, y: number, toX: number, toY: number, button?: "left" | "right" | "middle", signal?: AbortSignal): Promise<void> {
    await this.withRfb(async (rfb) => await rfb.drag(x, y, toX, toY, button, signal));
  }

  async openApp(app: string, signal?: AbortSignal): Promise<void> {
    const name = validateAppName(app);
    await this.withRfb(async (rfb) => {
      await rfb.pressKey("escape", undefined, signal);
      await this.execGuest([
        "/usr/bin/sudo", "/bin/launchctl", "asuser", "501",
        "/usr/bin/open", "-a", name,
      ], signal);
      await delay(1500, signal);
    });
  }

  async execGuest(args: readonly string[], signal?: AbortSignal): Promise<string> {
    if (!this.runProcess || (this.state !== "ready" && this.state !== "busy")) throw new Error("Computer Use VM is not ready");
    if (args.length === 0 || args.some((arg) => arg.length === 0 || arg.length > 4096 || arg.includes("\0"))) {
      throw new Error("Guest command arguments are invalid");
    }
    await this.enforceListenerBoundary();
    return await this.runTart(await this.getTartPath(), ["exec", VM_NAME, ...args], { timeoutMs: 30_000, ...(signal ? { signal } : {}) });
  }

  setBusy(busy: boolean): void {
    if (busy && this.state === "ready") this.state = "busy";
    else if (!busy && this.state === "busy") this.state = "ready";
  }

  private async getTartPath(): Promise<string> {
    this.tartPath ??= await canonicalExecutable(process.env.GDM_TART_PATH ?? DEFAULT_TART_PATH);
    return this.tartPath;
  }

  private registerOwnedChild(child: ChildProcess): void {
    if (child.pid === undefined) throw new Error("Owned Tart child has no process ID");
    this.ownedGroupIds.add(child.pid);
  }

  private async readProcessRecords(): Promise<readonly ProcessRecord[]> {
    const table = await runCommand("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { timeoutMs: 5000 });
    return parseProcessTable(table);
  }

  private async refreshOwnedProcesses(rejectEscaped = true): Promise<{
    readonly records: readonly ProcessRecord[];
    readonly reachable: ReadonlySet<number>;
    readonly knownAlive: readonly ProcessRecord[];
  }> {
    const records = await this.readProcessRecords();
    const reachable = new Set(ownedProcessPids(records, [...this.ownedGroupIds]));
    for (const record of records) {
      if (reachable.has(record.pid)) this.knownOwnedProcesses.set(record.pid, record.started);
    }
    const byPid = new Map(records.map((record) => [record.pid, record]));
    const knownAlive: ProcessRecord[] = [];
    for (const [pid, started] of [...this.knownOwnedProcesses]) {
      const record = byPid.get(pid);
      if (!record || record.started !== started) this.knownOwnedProcesses.delete(pid);
      else knownAlive.push(record);
    }
    const escaped = knownAlive.filter((record) => !reachable.has(record.pid));
    if (rejectEscaped && escaped.length > 0) {
      throw new Error(`Owned Tart descendant escaped process containment: ${escaped[0]!.pid}`);
    }
    return { records, reachable, knownAlive };
  }

  private startProcessTracker(child: ChildProcess): () => Promise<void> {
    const controller = new AbortController();
    let failure: Error | undefined;
    const tracker = (async () => {
      while (!controller.signal.aborted && child.exitCode === null) {
        try {
          await this.refreshOwnedProcesses();
        } catch (error) {
          failure = error as Error;
          return;
        }
        await delay(25, controller.signal).catch(() => {});
      }
      try {
        await this.refreshOwnedProcesses();
      } catch (error) {
        failure = error as Error;
      }
    })();
    return async () => {
      controller.abort();
      await tracker;
      if (failure) throw failure;
    };
  }

  private async terminateEscapedOwnedProcesses(): Promise<void> {
    const snapshot = await this.refreshOwnedProcesses(false);
    const escaped = snapshot.knownAlive.filter((record) => !snapshot.reachable.has(record.pid));
    for (const record of escaped) {
      try { process.kill(record.pid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const alive = (await this.refreshOwnedProcesses(false)).knownAlive.filter((record) => escaped.some((candidate) => candidate.pid === record.pid && candidate.started === record.started));
      if (alive.length === 0) return;
      await delay(100);
    }
    for (const record of escaped) {
      try { process.kill(record.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await delay(100);
    const remaining = (await this.refreshOwnedProcesses(false)).knownAlive.filter((record) => escaped.some((candidate) => candidate.pid === record.pid && candidate.started === record.started));
    if (remaining.length > 0) throw new Error(`Escaped owned process did not terminate: ${remaining[0]!.pid}`);
  }

  private async finishTartCommand(child: ChildProcess | undefined, commandFailed: boolean): Promise<void> {
    if (child?.pid === undefined) return;
    const groupId = child.pid;
    try {
      if (await waitForProcessGroupsGone([groupId], 500)) return;
      await terminateProcessGroup(child);
      if (!commandFailed) throw new Error(`Tart command left descendant processes in owned group ${groupId}`);
    } finally {
      this.ownedGroupIds.delete(groupId);
    }
  }

  private async runTart(
    tart: string,
    args: readonly string[],
    options: Pick<CommandOptions, "timeoutMs" | "signal"> = {},
  ): Promise<string> {
    let child: ChildProcess | undefined;
    let stopTracker: (() => Promise<void>) | undefined;
    try {
      const output = await runCommand(SANDBOX_EXEC_PATH, ["-p", TART_COMMAND_SANDBOX, tart, ...args], {
        ...options,
        detached: true,
        onSpawn: (spawned) => {
          child = spawned;
          this.registerOwnedChild(spawned);
          stopTracker = this.startProcessTracker(spawned);
        },
      });
      await stopTracker?.();
      await this.finishTartCommand(child, false);
      return output;
    } catch (error) {
      let trackerError: Error | undefined;
      try { await stopTracker?.(); } catch (failure) { trackerError = failure as Error; }
      await this.terminateEscapedOwnedProcesses();
      await this.finishTartCommand(child, true);
      throw trackerError ?? error;
    }
  }

  private async runTartInput(
    tart: string,
    args: readonly string[],
    input: Buffer,
    options: Pick<CommandOptions, "timeoutMs" | "signal"> = {},
  ): Promise<void> {
    let child: ChildProcess | undefined;
    let stopTracker: (() => Promise<void>) | undefined;
    try {
      await runCommandInput(SANDBOX_EXEC_PATH, ["-p", TART_COMMAND_SANDBOX, tart, ...args], input, {
        ...options,
        detached: true,
        onSpawn: (spawned) => {
          child = spawned;
          this.registerOwnedChild(spawned);
          stopTracker = this.startProcessTracker(spawned);
        },
      });
      await stopTracker?.();
      await this.finishTartCommand(child, false);
    } catch (error) {
      let trackerError: Error | undefined;
      try { await stopTracker?.(); } catch (failure) { trackerError = failure as Error; }
      await this.terminateEscapedOwnedProcesses();
      await this.finishTartCommand(child, true);
      throw trackerError ?? error;
    }
  }

  private async vmRecord(tart: string): Promise<VmRecord | undefined> {
    const records = parseVmList(await this.runTart(tart, ["list", "--source", "local", "--format", "json"]));
    return records.find((record) => record.Name === VM_NAME);
  }

  private async spawnVm(tart: string, signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
    if (signal?.aborted) throw new Error("Tart operation cancelled");
    const child = spawn(tart, [
      "run", VM_NAME,
      "--no-graphics",
      "--no-clipboard",
      "--net-softnet",
      "--net-softnet-block=0.0.0.0/0",
    ], { stdio: ["pipe", "pipe", "pipe"], env: runtimeEnvironment(), detached: true });
    this.registerOwnedChild(child);
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.length > MAX_COMMAND_OUTPUT) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.runStderr += chunk.toString("utf8");
      if (this.runStderr.length > MAX_COMMAND_OUTPUT) child.kill("SIGTERM");
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        child.kill("SIGTERM");
        reject(new Error("Tart process did not spawn within 5 seconds"));
      }, 5000);
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onAbort = () => { cleanup(); child.kill("SIGTERM"); reject(new Error("Tart operation cancelled")); };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("spawn", onSpawn);
        child.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return child;
  }

  private async waitForGuest(tart: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await this.runTart(tart, ["exec", VM_NAME, "/usr/bin/true"], { timeoutMs: 5000, ...(signal ? { signal } : {}) });
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (this.listenerFailure) throw this.listenerFailure;
        if (!this.runProcess || this.runProcess.exitCode !== null) {
          const detail = this.runStderr.trim().slice(-1000);
          throw new Error(`Tart VM exited before the guest agent was ready${detail ? `: ${detail}` : ""}`);
        }
        await delay(2000, signal);
      }
    }
    throw new Error("Tart guest agent did not become ready within 120 seconds");
  }

  private async verifyGuestMarker(tart: string, signal?: AbortSignal): Promise<void> {
    const marker = await this.runTart(tart, ["exec", VM_NAME, "/bin/cat", GUEST_MARKER_PATH], {
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    });
    if (marker.trim() !== GUEST_MARKER_VALUE) throw new Error("Computer Use guest identity marker is missing or invalid");
  }

  private async rotateGuestPassword(tart: string, signal?: AbortSignal): Promise<Buffer> {
    const password = createSessionPassword();
    const encoded = encodeAppleVncPassword(password);
    try {
      await this.runTartInput(tart, ["exec", "-i", VM_NAME, "/usr/bin/sudo", "/usr/bin/tee", VNC_SETTINGS_PATH], encoded, {
        timeoutMs: 10_000,
        ...(signal ? { signal } : {}),
      });
      await this.runTart(tart, ["exec", VM_NAME, "/usr/bin/sudo", "/bin/chmod", "600", VNC_SETTINGS_PATH], {
        timeoutMs: 10_000,
        ...(signal ? { signal } : {}),
      });
      await this.runTart(tart, ["exec", VM_NAME, "/usr/bin/sudo", "/bin/launchctl", "kickstart", "-k", "system/com.apple.screensharing"], {
        timeoutMs: 15_000,
        ...(signal ? { signal } : {}),
      });
      return password;
    } catch (error) {
      password.fill(0);
      throw error;
    } finally {
      encoded.fill(0);
    }
  }

  private async connectGuestRfb(tart: string, password: Buffer, signal?: AbortSignal): Promise<RfbClient> {
    const deadline = Date.now() + 20_000;
    let lastError: Error | undefined;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Tart operation cancelled");
      const tunnel = spawn(SANDBOX_EXEC_PATH, [
        "-p", TART_COMMAND_SANDBOX,
        tart, "exec", "-i", VM_NAME, "/usr/bin/nc", "127.0.0.1", "5900",
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: runtimeEnvironment(),
        detached: true,
      });
      this.registerOwnedChild(tunnel);
      let stderrBytes = 0;
      tunnel.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_COMMAND_OUTPUT) tunnel.kill("SIGTERM");
      });
      this.tunnelProcess = tunnel;
      try {
        const client = await RfbClient.connectStream(new ChildStdioDuplex(tunnel), password, signal);
        return client;
      } catch (error) {
        lastError = error as Error;
        await terminateProcessGroup(tunnel);
        if (tunnel.pid !== undefined) this.ownedGroupIds.delete(tunnel.pid);
        if (this.tunnelProcess === tunnel) this.tunnelProcess = undefined;
        await delay(500, signal);
      }
    }
    throw new Error(`Guest loopback RFB tunnel did not become ready: ${lastError?.message ?? "timeout"}`);
  }

  private async assertNoHostTcpListeners(): Promise<void> {
    if (this.listenerFailure) throw this.listenerFailure;
    const roots = [...this.ownedGroupIds];
    if (roots.length === 0) throw new Error("Owned Tart processes are unavailable for listener inspection");
    const snapshot = await this.refreshOwnedProcesses();
    const pids = [...new Set([...snapshot.reachable, ...snapshot.knownAlive.map((record) => record.pid)])];
    if (pids.length === 0) throw new Error("Owned Tart process groups disappeared unexpectedly");
    const result = await runCommandResult(LSOF_PATH, ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN"], { timeoutMs: 5000 });
    const output = result.stdout.toString("utf8").trim();
    if (result.exitCode === 1 && output === "") return;
    if (result.exitCode !== 0) throw new Error(`Host TCP listener inspection failed (${result.exitCode ?? "signal"})`);
    if (output !== "") throw new Error(`Owned Tart process exposed a host TCP listener: ${output.split(/\r?\n/u)[0]}`);
  }

  private startListenerMonitor(): void {
    const controller = new AbortController();
    this.listenerMonitorAbort = controller;
    this.listenerMonitor = (async () => {
      while (!controller.signal.aborted) {
        try {
          await this.assertNoHostTcpListeners();
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure = error as Error;
          this.listenerFailure = failure;
          this.lastError = failure.message;
          await this.closeRfb().catch(() => {});
          const run = this.runProcess;
          if (run) {
            await terminateProcessGroup(run).catch(() => {});
            if (run.pid !== undefined) this.ownedGroupIds.delete(run.pid);
          }
          for (const groupId of [...this.ownedGroupIds]) await terminateProcessGroupId(groupId).catch(() => {});
          await this.terminateEscapedOwnedProcesses().catch(() => {});
          this.ownedGroupIds.clear();
          this.knownOwnedProcesses.clear();
          this.runProcess = undefined;
          this.state = "failed";
          return;
        }
        await delay(250, controller.signal).catch(() => {});
      }
    })();
  }

  private async stopListenerMonitor(): Promise<void> {
    const controller = this.listenerMonitorAbort;
    const monitor = this.listenerMonitor;
    this.listenerMonitorAbort = undefined;
    this.listenerMonitor = undefined;
    controller?.abort();
    if (monitor) await monitor;
  }

  private async enforceListenerBoundary(): Promise<void> {
    if (this.listenerFailure) throw this.listenerFailure;
    try {
      await this.assertNoHostTcpListeners();
    } catch (error) {
      this.lastError = (error as Error).message;
      await this.stop().catch(() => {});
      this.state = "failed";
      throw error;
    }
  }

  private async withRfb<T>(operation: (rfb: RfbClient) => Promise<T>): Promise<T> {
    try {
      return await operation(await this.client());
    } catch (error) {
      this.lastError = (error as Error).message;
      await this.stop().catch(() => {});
      this.state = "failed";
      throw error;
    }
  }

  private async client(signal?: AbortSignal): Promise<RfbClient> {
    if (this.listenerFailure) throw this.listenerFailure;
    if (!this.runProcess || !this.tunnelProcess || !this.rfb || (this.state !== "ready" && this.state !== "busy")) {
      throw new Error("Computer Use VM is not ready");
    }
    await this.enforceListenerBoundary();
    if (signal?.aborted) throw new Error("Tart operation cancelled");
    return this.rfb;
  }

  private async closeRfb(): Promise<void> {
    const current = this.rfb;
    this.rfb = undefined;
    const tunnel = this.tunnelProcess;
    this.tunnelProcess = undefined;
    if (current) await current.close();
    if (tunnel) {
      await terminateProcessGroup(tunnel);
      if (tunnel.pid !== undefined) this.ownedGroupIds.delete(tunnel.pid);
    }
  }
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}

async function processGroupsRemain(groupIds: readonly number[]): Promise<boolean> {
  const table = await runCommand("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { timeoutMs: 5000 });
  const groups = new Set(groupIds);
  return parseProcessTable(table).some((record) => groups.has(record.groupId));
}

async function waitForProcessGroupsGone(groupIds: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processGroupsRemain(groupIds))) return true;
    await delay(100);
  }
  return !(await processGroupsRemain(groupIds));
}

async function terminateProcessGroupId(groupId: number, child?: ChildProcess): Promise<void> {
  if (!(await processGroupsRemain([groupId]))) return;
  if (!signalProcessGroup(groupId, "SIGTERM") && child?.exitCode === null) child.kill("SIGTERM");
  if (child) await waitForExit(child, 5000);
  if (await waitForProcessGroupsGone([groupId], 2000)) return;
  if (!signalProcessGroup(groupId, "SIGKILL") && child?.exitCode === null) child.kill("SIGKILL");
  if (child) await waitForExit(child, 2000);
  if (!(await waitForProcessGroupsGone([groupId], 2000))) {
    throw new Error(`Owned process group ${groupId} did not terminate`);
  }
}

async function terminateProcessGroup(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) await terminateProcessGroupId(child.pid, child);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}
