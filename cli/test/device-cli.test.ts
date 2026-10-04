import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeviceArgs, runDevice, runDeviceProcess } from "../src/device-cli.ts";
import { config, fakeRunner, fixture, png, summary, unlocked } from "./device-fixtures.ts";
const roots: string[] = [];
function context() { const f = fixture(); roots.push(f.cwd); return f; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const opts = (action: string) => parseDeviceArgs([action, "--json"]);

test("capture uses unique remote/local evidence, retries copy only, restores without arguments", async () => {
  const f = context(); let copied = false;
  const r = fakeRunner(c => { if (c.args.includes("copy") && !copied) { copied = true; return { exitCode: 1 }; } });
  const first = await runDevice(f.cwd, opts("capture"), { ...f, ...r, sleep: async () => {} });
  const second = await runDevice(f.cwd, opts("capture"), { ...f, ...r, sleep: async () => {} });
  expect(first.success).toBe(true); expect(first.restore?.success).toBe(true);
  expect(first.capture?.path).not.toBe(second.capture?.path);
  expect(first.capture?.sha256).toHaveLength(64);
  expect(r.calls.filter(c => c.args.includes("-capture"))).toHaveLength(2);
  const launch = r.calls.find(c => c.args.includes("-capture"))!;
  expect(launch.args[launch.args.indexOf("-capture") + 1]).toBe(`gdm-${first.runID}.png`);
  const last = r.calls.at(-1)!.args;
  expect(last.at(-1)).toBe(config.bundleID); expect(last).not.toContain("-capture");
  expect(JSON.parse(readFileSync(first.receiptPath, "utf8")).success).toBe(true);
});
test("old PNG cannot make a failed copy succeed; restores after failure", async () => {
  const f = context(); writeFileSync(join(f.cwd, "old.png"), png);
  const r = fakeRunner(c => c.args.includes("copy") ? { exitCode: 1 } : undefined);
  const result = await runDevice(f.cwd, opts("capture"), { ...f, ...r, sleep: async () => {} });
  expect(result.success).toBe(false); expect(result.capture).toBeUndefined(); expect(result.restore?.success).toBe(true);
  expect(r.calls.filter(c => c.args.includes("-capture"))).toHaveLength(1);
  expect(r.calls.filter(c => c.args.includes("copy"))).toHaveLength(8);
});
test("successful copy without file and invalid PNG do not pass", async () => {
  for (const content of [undefined, Buffer.from("invalid")]) {
    const f = context();
    const r = fakeRunner(c => {
      if (!c.args.includes("copy")) return;
      writeFileSync(c.args[c.args.indexOf("--json-output") + 1]!, JSON.stringify({ info: { outcome: "success" } }));
      if (content) writeFileSync(c.args[c.args.indexOf("--destination") + 1]!, content);
      return { exitCode: 0 };
    });
    const result = await runDevice(f.cwd, opts("capture"), { ...f, ...r, sleep: async () => {} });
    expect(result.success).toBe(false); expect(result.restore?.success).toBe(true);
  }
});
test("locked or mismatched device never launches or installs", async () => {
  const f = context();
  const r = fakeRunner(c => {
    if (!c.args.includes("lockState")) return;
    const value = unlocked(); value.result.passcodeRequired = true;
    writeFileSync(c.args[c.args.indexOf("--json-output") + 1]!, JSON.stringify(value)); return { exitCode: 0 };
  });
  const result = await runDevice(f.cwd, opts("capture"), { ...f, ...r });
  expect(result.error?.code).toBe("device_locked"); expect(r.calls).toHaveLength(2); expect(result.restore).toBeUndefined();
});
test("cleanup failure fails otherwise successful capture", async () => {
  const f = context();
  const r = fakeRunner(c => c.args.includes("launch") && !c.args.includes("-capture") ? { exitCode: 1 } : undefined);
  const result = await runDevice(f.cwd, opts("capture"), { ...f, ...r, sleep: async () => {} });
  expect(result.success).toBe(false); expect(result.restore?.success).toBe(false); expect(result.error?.code).toBe("device_restore_failed");
});
test("cancellation still restores, and cleanup gets its own uncancelled signal", async () => {
  const f = context(), controller = new AbortController();
  const r = fakeRunner(c => { if (c.args.includes("copy")) { controller.abort(); return { exitCode: 130 }; } });
  const result = await runDevice(f.cwd, opts("capture"), { ...f, ...r, signal: controller.signal, sleep: async () => {} });
  expect(result.success).toBe(false); expect(result.restore?.success).toBe(true); expect(r.calls.at(-1)!.signal).toBeUndefined();
});
test("XCTest uses physical UDID, bounded jobs, selected targets; zero tests rejected", async () => {
  const f = context();
  const r = fakeRunner(c => {
    if (!c.args.includes("xcresulttool")) return;
    const s = summary(); s.totalTestCount = 0; writeFileSync(c.stdout, JSON.stringify(s)); return { exitCode: 0 };
  });
  const result = await runDevice(f.cwd, opts("test"), { ...f, ...r });
  expect(result.success).toBe(false); expect(result.error?.code).toBe("device_test_failed"); expect(result.restore?.success).toBe(true);
  const args = r.calls.find(c => c.executable === "nice")!.args;
  expect(args).toContain(`platform=iOS,id=${config.device.udid}`); expect(args).toContain("-only-testing:Tests/IsolatedTests");
  expect(args[args.indexOf("-jobs") + 1]).toBe("2"); expect(args).not.toContain("iOS Simulator");
});
test("empty test allowlist and unknown case fail before touching device", async () => {
  const f = context(), r = fakeRunner();
  writeFileSync(join(f.cwd, ".gdm-device.json"), JSON.stringify({ ...config, testTargets: [] }));
  await expect(runDevice(f.cwd, opts("test"), { ...f, ...r })).rejects.toThrow();
  await expect(runDevice(f.cwd, { ...opts("capture"), caseName: "missing" }, { ...f, ...r })).rejects.toThrow();
  expect(r.calls).toHaveLength(0);
});
test("symlink output root is refused; device lock excludes concurrent commands", async () => {
  const f = context(), r = fakeRunner();
  mkdirSync(join(f.cwd, "outside")); symlinkSync(join(f.cwd, "outside"), join(f.cwd, ".gdm-artifacts"));
  await expect(runDevice(f.cwd, opts("doctor"), { ...f, ...r })).rejects.toThrow();
  expect(r.calls).toHaveLength(0);
  rmSync(join(f.cwd, ".gdm-artifacts"));
  mkdirSync(join(f.lockRoot, config.device.id), { recursive: true });
  const result = await runDevice(f.cwd, opts("doctor"), { ...f, ...r });
  expect(result.error?.code).toBe("device_busy"); expect(r.calls).toHaveLength(0);
  expect(existsSync(join(f.lockRoot, config.device.id))).toBe(true);
});
test("argv stays literal and hung child is bounded", async () => {
  const f = context(), literal = "$(touch forbidden) `touch forbidden` ; test";
  const result = await runDeviceProcess({ executable: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", literal], cwd: f.cwd, stdout: join(f.cwd, "out"), stderr: join(f.cwd, "err"), timeoutMs: 5000 });
  expect(result.exitCode).toBe(0); expect(readFileSync(join(f.cwd, "out"), "utf8")).toBe(literal); expect(existsSync(join(f.cwd, "forbidden"))).toBe(false);
  const timed = await runDeviceProcess({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: f.cwd, stdout: join(f.cwd, "timed-out"), stderr: join(f.cwd, "timed-err"), timeoutMs: 50 });
  expect(timed.timedOut).toBe(true); expect(timed.exitCode).not.toBe(0);
});
test("install rejects bundle mismatch before codesign or device installation", async () => {
  const f = context(); mkdirSync(join(f.cwd, config.appPath), { recursive: true });
  const r = fakeRunner(c => { if (c.executable.endsWith("PlistBuddy")) { writeFileSync(c.stdout, "com.other.app"); return { exitCode: 0 }; } });
  const result = await runDevice(f.cwd, opts("install"), { ...f, ...r });
  expect(result.success).toBe(false); expect(result.error?.code).toBe("device_mismatch");
  expect(r.calls.some(c => c.args.includes("install"))).toBe(false);
});
test("build, install and nonzero XCTest success return their actual outcome", async () => {
  for (const action of ["build", "install", "test"]) {
    const f = context(); mkdirSync(join(f.cwd, config.appPath), { recursive: true });
    const r = fakeRunner();
    const result = await runDevice(f.cwd, opts(action), { ...f, ...r });
    expect(result.success).toBe(true);
    if (action === "install") expect(r.calls.map(c => c.executable)).toContain("codesign");
    if (action === "test") { expect(result.testSummary?.passed).toBe(1); expect(result.restore?.success).toBe(true); }
  }
});
