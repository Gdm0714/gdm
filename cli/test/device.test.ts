import { describe, expect, test } from "bun:test";
import { inspectPhysicalDevice, inspectPNG, inspectTestSummary, inspectUnlocked, parseDeviceConfig } from "../src/device.ts";
import { config, details, png, summary, unlocked } from "./device-fixtures.ts";

describe("physical device identity and result boundaries", () => {
  test("known physical device passes; name/ID/UDID or simulator never falls back", () => {
    expect(() => inspectPhysicalDevice(details(), config)).not.toThrow();
    for (const change of [
      (d: any) => d.result.identifier = "different", (d: any) => d.result.hardwareProperties.udid = "wrong",
      (d: any) => d.result.deviceProperties.name = "different", (d: any) => d.result.hardwareProperties.reality = "simulated",
      (d: any) => d.result.connectionProperties.tunnelState = "unavailable", (d: any) => d.result.deviceProperties.developerModeStatus = "disabled",
    ]) { const d = details(); change(d); expect(() => inspectPhysicalDevice(d, config)).toThrow(); }
  });
  test("unlocked checks exact device and explicit false passcodeRequired", () => {
    expect(() => inspectUnlocked(unlocked(), config)).not.toThrow();
    for (const change of [
      (d: any) => d.result.passcodeRequired = true, (d: any) => delete d.result.passcodeRequired,
      (d: any) => d.result.unlockedSinceBoot = false, (d: any) => d.result.deviceIdentifier = "other",
    ]) { const d = unlocked(); change(d); expect(() => inspectUnlocked(d, config)).toThrow(); }
  });
  test("zero/failed tests and wrong result device are rejected", () => {
    expect(() => inspectTestSummary(summary(), config)).not.toThrow();
    for (const change of [
      (s: any) => s.totalTestCount = 0, (s: any) => s.passedTests = 0, (s: any) => s.failedTests = 1,
      (s: any) => s.expectedFailures = 1, (s: any) => s.devicesAndConfigurations[0].device.platform = "iOS Simulator",
      (s: any) => s.devicesAndConfigurations[0].device.deviceId = "other", (s: any) => s.testFailures.push({}),
    ]) { const s = summary(); change(s); expect(() => inspectTestSummary(s, config)).toThrow(); }
  });
  test("invalid config, traversal, duplicate captures and isolation override fail", () => {
    expect(parseDeviceConfig(config, "/tmp/example").device.name).toBe(config.device.name);
    for (const change of [
      (c: any) => c.derivedDataPath = "../escape", (c: any) => c.appPath = "/tmp/Escape.app",
      (c: any) => c.version = 2, (c: any) => c.capture.cases.push(c.capture.cases[0]),
      (c: any) => c.capture.cases[0].arguments.push("-capture"), (c: any) => c.scheme = "test\ncommand",
      (c: any) => c.unknown = true,
    ]) { const c = structuredClone(config); change(c); expect(() => parseDeviceConfig(c, "/tmp/example")).toThrow(); }
  });
  test("PNG requires signature, dimensions and completed file", () => {
    expect(inspectPNG(png)).toEqual({ width: 1, height: 1 });
    expect(() => inspectPNG(Buffer.from("not an image"))).toThrow();
    expect(() => inspectPNG(png.subarray(0, png.length - 12))).toThrow();
    const corrupted = Buffer.from(png); corrupted[45] = (corrupted[45] ?? 0) ^ 1;
    expect(() => inspectPNG(corrupted)).toThrow();
    const invalid = Buffer.from(png); invalid.writeUInt32BE(0, 16);
    expect(() => inspectPNG(invalid)).toThrow();
  });
});
