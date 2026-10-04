import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceConfig } from "../src/device.ts";
import type { DeviceCommand, DeviceRunner, CommandResult } from "../src/device-cli.ts";
export const config: DeviceConfig = {
  version: 1, device: { id: "11111111-2222-3333-4444-555555555555", udid: "00008140-0012345678900001", name: "Test iPhone" },
  bundleID: "com.example.test", project: "Test.xcodeproj", scheme: "Test App", derivedDataPath: ".build/Device", appPath: ".build/Device/Test.app",
  testTargets: ["Tests/IsolatedTests"], capture: { isolationArgument: "-capture", cases: [{ name: "dark", arguments: ["-theme", "dark"] }] },
};
export const details = () => ({ info: { outcome: "success" }, result: { identifier: config.device.id,
  hardwareProperties: { udid: config.device.udid, platform: "iOS", reality: "physical" },
  deviceProperties: { name: config.device.name, bootState: "booted", developerModeStatus: "enabled", ddiServicesAvailable: true },
  connectionProperties: { pairingState: "paired", tunnelState: "connected" },
} });
export const unlocked = () => ({ info: { outcome: "success" }, result: { deviceIdentifier: config.device.id, passcodeRequired: false, unlockedSinceBoot: true } });
export const summary = () => ({ result: "Passed", totalTestCount: 1, passedTests: 1, failedTests: 0, expectedFailures: 0, testFailures: [], devicesAndConfigurations: [{ device: { deviceId: config.device.udid, deviceName: config.device.name, platform: "iOS" }, failedTests: 0, passedTests: 1, expectedFailures: 0 }] });
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
export function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-device-test-"));
  writeFileSync(join(cwd, ".gdm-device.json"), JSON.stringify(config));
  return { cwd, lockRoot: join(cwd, "locks") };
}
export function fakeRunner(override?: (c: DeviceCommand) => CommandResult | undefined): { calls: DeviceCommand[]; runner: DeviceRunner } {
  const calls: DeviceCommand[] = [];
  return { calls, runner: async c => {
    calls.push(c); writeFileSync(c.stdout, ""); writeFileSync(c.stderr, "");
    const special = override?.(c); if (special) return special;
    const a = c.args, file = a[a.indexOf("--json-output") + 1];
    if (a.includes("--json-output")) {
      const body = a.includes("details") ? details() : a.includes("lockState") ? unlocked() : { info: { outcome: "success" }, result: {} };
      writeFileSync(file!, JSON.stringify(body));
    }
    if (a.includes("copy")) writeFileSync(a[a.indexOf("--destination") + 1]!, png);
    if (a.includes("xcresulttool")) writeFileSync(c.stdout, JSON.stringify(summary()));
    if (c.executable.endsWith("PlistBuddy")) writeFileSync(c.stdout, config.bundleID);
    return { exitCode: 0 };
  } };
}
