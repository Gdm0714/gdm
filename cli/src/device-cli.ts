import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DeviceConfig, deviceError, inspectPhysicalDevice, inspectPNG, inspectTestSummary, inspectUnlocked, localDevicePath, readDeviceConfig } from "./device.ts";
import { GdmError } from "./state.ts";

export const DEVICE_USAGE = `gdm device list [--json]
gdm device <doctor|build|install|test> [--config .gdm-device.json] [--json]
gdm device capture [--config .gdm-device.json] [--case NAME] [--json]
iOS 실기기 전용 · 캡처는 앱에 구현된 격리 훅이 필요합니다.`;
type Action = "list" | "doctor" | "build" | "install" | "test" | "capture";
export interface DeviceOptions { action: Action; config: string; caseName?: string; json: boolean }
export function parseDeviceArgs(args: string[]): DeviceOptions {
  const [action, ...rest] = args;
  if (!["list", "doctor", "build", "install", "test", "capture"].includes(action ?? "")) deviceError(DEVICE_USAGE, "usage");
  const options: DeviceOptions = { action: action as Action, config: ".gdm-device.json", json: false };
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (seen.has(flag)) deviceError(`중복 인자: ${flag}`, "usage");
    seen.add(flag);
    if (flag === "--json") options.json = true;
    else if ((flag === "--config" && action !== "list") || (flag === "--case" && action === "capture")) {
      const value = rest[++i];
      if (!value || value.startsWith("-")) deviceError(`${flag} 값이 필요합니다`, "usage");
      if (flag === "--config") options.config = value; else options.caseName = value;
    } else deviceError(`지원하지 않는 인자: ${flag}\n${DEVICE_USAGE}`, "usage");
  }
  return options;
}
export interface DeviceCommand {
  executable: string; args: string[]; cwd: string; stdout: string; stderr: string;
  timeoutMs: number; signal?: AbortSignal;
}
export interface CommandResult { exitCode: number; timedOut?: boolean }
export type DeviceRunner = (command: DeviceCommand) => Promise<CommandResult>;
export const runDeviceProcess: DeviceRunner = async command => {
  if (command.signal?.aborted) return { exitCode: 130 };
  const out = openSync(command.stdout, "wx", 0o600), err = openSync(command.stderr, "wx", 0o600);
  try {
    return await new Promise<CommandResult>((accept, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd, shell: false, detached: true, stdio: ["ignore", out, err],
      });
      let timedOut = false, killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
        killTimer ??= setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 2000);
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, command.timeoutMs);
      command.signal?.addEventListener("abort", stop, { once: true });
      const clean = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); command.signal?.removeEventListener("abort", stop); };
      child.on("error", error => { clean(); reject(error); });
      child.on("close", code => { clean(); accept({ exitCode: code ?? 130, timedOut }); });
      if (command.signal?.aborted) stop();
    });
  } finally { closeSync(out); closeSync(err); }
};

function containedPath(cwd: string, part: string): string {
  const path = localDevicePath(cwd, part);
  let current = cwd;
  for (const segment of relative(cwd, path).split(sep)) {
    current = join(current, segment);
    if (existsSync(current) || (() => { try { lstatSync(current); return true; } catch { return false; } })()) {
      if (lstatSync(current).isSymbolicLink()) deviceError(`실기기 경로에 심볼릭 링크를 사용할 수 없습니다: ${part}`);
    }
  }
  return path;
}
function readSmall(path: string, max = 4 * 1024 * 1024): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) deviceError("증거 파일의 종류 또는 크기를 확인해 주세요");
  return readFileSync(path);
}
function readJSON(path: string): any { return JSON.parse(readSmall(path).toString("utf8")); }
function errorInfo(error: unknown) {
  return { code: error instanceof GdmError ? error.code : "device_command_failed", message: error instanceof Error ? error.message : String(error) };
}
interface DeviceStep { name: string; executable: string; args: string[]; exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }
export interface DeviceReceipt {
  schemaVersion: "gdm-device-receipt/v1"; action: Action; runID: string;
  startedAt: string; finishedAt?: string; success: boolean; device?: DeviceConfig["device"];
  bundleID?: string; configSHA256?: string; receiptPath: string; steps: DeviceStep[];
  error?: { code: string; message: string }; restore?: { success: boolean; error?: string };
  capture?: { path: string; sha256: string; width: number; height: number; case: string };
  testSummary?: { path: string; total: number; passed: number };
  devices?: { id: string; udid: string; name: string; platform: string; reality: string; connection: string }[];
}
interface Dependencies { runner?: DeviceRunner; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal; lockRoot?: string }
export async function runDevice(cwdInput: string, options: DeviceOptions, dependencies: Dependencies = {}): Promise<DeviceReceipt> {
  const cwd = realpathSync(cwdInput);
  const config = options.action === "list" ? undefined : readDeviceConfig(cwd, options.config);
  const captures = config?.capture?.cases;
  const captureCase = captures?.find(c => c.name === (options.caseName ?? captures[0]?.name));
  if (options.action === "capture" && !captureCase) deviceError("설정에 등록된 격리 캡처 장면을 선택해 주세요");
  if (options.action === "test" && !config?.testTargets.length) deviceError("개인 데이터에 접근하지 않는 testTargets를 명시해 주세요");
  const outputRoot = containedPath(cwd, ".gdm-artifacts/device");
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const runID = randomUUID(), dir = join(outputRoot, runID);
  mkdirSync(dir, { mode: 0o700 });
  const receipt: DeviceReceipt = {
    schemaVersion: "gdm-device-receipt/v1", action: options.action, runID,
    startedAt: new Date().toISOString(), success: false, device: config?.device, bundleID: config?.bundleID,
    configSHA256: config ? createHash("sha256").update(JSON.stringify(config)).digest("hex") : undefined,
    receiptPath: join(dir, "receipt.json"), steps: [],
  };
  const runner = dependencies.runner ?? runDeviceProcess;
  const step = async (name: string, executable: string, args: string[], timeoutMs = 30000, cleanup = false) => {
    if (!cleanup && dependencies.signal?.aborted) deviceError("실기기 작업을 중단했습니다", "device_cancelled");
    const prefix = join(dir, `${String(receipt.steps.length + 1).padStart(2, "0")}-${name}`);
    const record: DeviceStep = { name, executable, args, exitCode: null, stdout: `${prefix}.stdout`, stderr: `${prefix}.stderr` };
    receipt.steps.push(record);
    const result = await runner({ executable, args, cwd, stdout: record.stdout, stderr: record.stderr, timeoutMs, signal: cleanup ? undefined : dependencies.signal });
    record.exitCode = result.exitCode; record.timedOut = result.timedOut;
    if (result.exitCode !== 0 || result.timedOut) deviceError(`${name} 실패. 로그: ${record.stderr}`, result.timedOut ? "device_timeout" : "device_command_failed");
    return record;
  };
  const devicectl = async (name: string, args: string[], cleanup = false) => {
    const json = join(dir, `${receipt.steps.length + 1}-${name}.json`);
    await step(name, "xcrun", ["devicectl", "--timeout", "20", "--json-output", json, "--quiet", ...args], 25000, cleanup);
    const result = readJSON(json);
    if (result?.info?.outcome !== "success") deviceError(`${name}: devicectl이 성공 결과를 반환하지 않았습니다`);
    return result;
  };
  let lock: string | undefined, restore = false;
  try {
    if (config) {
      // Cross-project serialization. A stale lock is reported, never guessed away.
      const root = dependencies.lockRoot ?? join(tmpdir(), `gdm-device-${process.getuid?.() ?? "user"}`);
      if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.getuid && rootStat.uid !== process.getuid())) deviceError("실기기 잠금 폴더 소유자를 확인해 주세요");
      const candidate = join(root, config.device.id.toLowerCase());
      try { mkdirSync(candidate, { mode: 0o700 }); }
      catch { deviceError(`같은 기기의 gdm 작업이 실행 중이거나 이전 잠금이 남아 있습니다: ${candidate}`, "device_busy"); }
      lock = candidate;
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, cwd, runID, receiptPath: receipt.receiptPath }), { mode: 0o600 });
      inspectPhysicalDevice(await devicectl("details", ["device", "info", "details", "--device", config.device.id]), config);
      inspectUnlocked(await devicectl("lock-state", ["device", "info", "lockState", "--device", config.device.id]), config);
    }
    if (options.action === "list") {
      const result = await devicectl("list", ["list", "devices"]);
      if (!Array.isArray(result?.result?.devices)) deviceError("기기 목록 JSON이 올바르지 않습니다");
      receipt.devices = result.result.devices.map((d: any) => ({ id: d.identifier, udid: d.hardwareProperties?.udid, name: d.deviceProperties?.name, platform: d.hardwareProperties?.platform, reality: d.hardwareProperties?.reality, connection: d.connectionProperties?.tunnelState }));
    } else if (options.action === "build" || options.action === "test") {
      const c = config!;
      const project = containedPath(cwd, c.project), derived = containedPath(cwd, c.derivedDataPath);
      const args = ["-n", "10", "xcodebuild", options.action, "-project", project, "-scheme", c.scheme, "-configuration", "Debug", "-destination", `platform=iOS,id=${c.device.udid}`, "-derivedDataPath", derived, "-jobs", "2", "-allowProvisioningUpdates"];
      if (options.action === "test") {
        restore = true;
        const resultBundle = join(dir, "Tests.xcresult");
        args.push("-parallel-testing-enabled", "NO", "-resultBundlePath", resultBundle, ...c.testTargets.map(t => `-only-testing:${t}`));
        await step("xctest", "nice", args, 20 * 60 * 1000);
        const summary = await step("test-summary", "xcrun", ["xcresulttool", "get", "test-results", "summary", "--path", resultBundle, "--compact"]);
        const value = readJSON(summary.stdout);
        inspectTestSummary(value, c);
        receipt.testSummary = { path: summary.stdout, total: value.totalTestCount, passed: value.passedTests };
      } else await step("build", "nice", args, 20 * 60 * 1000);
    } else if (options.action === "install") {
      const c = config!, app = containedPath(cwd, c.appPath);
      const appStat = lstatSync(app);
      if (!appStat.isDirectory()) deviceError("설치할 .app 폴더가 없습니다");
      const plist = await step("bundle-id", "/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(app, "Info.plist")]);
      if (readSmall(plist.stdout).toString("utf8").trim() !== c.bundleID) deviceError("설치 앱의 bundleID가 설정과 다릅니다", "device_mismatch");
      await step("codesign", "codesign", ["--verify", "--deep", "--strict", app]);
      await devicectl("install", ["device", "install", "app", "--device", c.device.id, app]);
    } else if (options.action === "capture") {
      const c = config!, filename = `gdm-${runID}.png`;
      restore = true; // Even an uncertain launch must be followed by a normal launch.
      await devicectl("capture-launch", ["device", "process", "launch", "--device", c.device.id, "--terminate-existing", c.bundleID, "--", c.capture!.isolationArgument, filename, ...captureCase!.arguments]);
      let path: string | undefined;
      for (let attempt = 1; attempt <= 8; attempt++) {
        if (dependencies.signal?.aborted) deviceError("실기기 작업을 중단했습니다", "device_cancelled");
        await (dependencies.sleep ?? delay)(1000);
        const candidate = join(dir, `capture-${attempt}.png`);
        try {
          await devicectl(`capture-copy-${attempt}`, ["device", "copy", "from", "--device", c.device.id, "--domain-type", "appDataContainer", "--domain-identifier", c.bundleID, "--source", `Documents/${filename}`, "--destination", candidate]);
          path = candidate; break;
        } catch (error) {
          if (attempt === 8 || dependencies.signal?.aborted) throw error;
        }
      }
      if (!path) deviceError("새 화면 캡처를 받지 못했습니다", "device_capture_invalid");
      const bytes = readSmall(path, 30 * 1024 * 1024);
      const size = inspectPNG(bytes);
      receipt.capture = { path, sha256: createHash("sha256").update(bytes).digest("hex"), ...size, case: captureCase!.name };
    }
    if (dependencies.signal?.aborted) deviceError("실기기 작업을 중단했습니다", "device_cancelled");
    receipt.success = true;
  } catch (error) { receipt.error = errorInfo(error); }
  finally {
    if (restore && config) {
      try {
        await devicectl("restore-app", ["device", "process", "launch", "--device", config.device.id, "--terminate-existing", config.bundleID], true);
        receipt.restore = { success: true };
      } catch (error) {
        receipt.restore = { success: false, error: errorInfo(error).message };
        receipt.success = false;
        receipt.error ??= { code: "device_restore_failed", message: "앱 정상 실행 복원에 실패했습니다. 기기 연결과 잠금을 확인해 주세요" };
      }
    }
    receipt.finishedAt = new Date().toISOString();
    try { writeFileSync(receipt.receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    finally { if (lock) rmSync(lock, { recursive: true }); }
  }
  return receipt;
}
export async function cmdDevice(cwd: string, args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) { console.log(DEVICE_USAGE); return; }
  const options = parseDeviceArgs(args), controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    const result = await runDevice(cwd, options, { signal: controller.signal });
    if (options.json) console.log(JSON.stringify(result));
    else {
      console.log(`${result.success ? "통과" : "실패"}: ${result.action}${result.device ? ` · ${result.device.name}` : ""}\n기록: ${result.receiptPath}`);
      if (result.devices) for (const d of result.devices) console.log(`${d.name} · ${d.connection} · ${d.id} · ${d.udid}`);
      if (result.capture) console.log(`화면: ${result.capture.path} (${result.capture.width}×${result.capture.height})\n이미지를 직접 열어 UI를 검수해 주세요.`);
    }
    if (!result.success) deviceError(result.error?.message ?? "실기기 작업 실패", result.error?.code);
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
