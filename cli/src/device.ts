import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute, resolve, relative, sep } from "node:path";
import { GdmError } from "./state.ts";

export interface DeviceConfig {
  version: 1;
  device: { id: string; udid: string; name: string };
  bundleID: string;
  project: string;
  scheme: string;
  derivedDataPath: string;
  appPath: string;
  testTargets: string[];
  capture?: { isolationArgument: string; cases: { name: string; arguments: string[] }[] };
}
export function deviceError(message: string, code = "device_invalid"): never { throw new GdmError(message, code); }
function object(value: unknown, allowed: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) deviceError("실기기 설정 필드를 확인해 주세요");
  return value as Record<string, any>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/u.test(value)) deviceError("빈 값·제어 문자는 실기기 설정에 사용할 수 없습니다");
  return value;
}
export function localDevicePath(cwd: string, value: unknown): string {
  const part = text(value, 1024);
  if (isAbsolute(part)) deviceError("프로젝트 경로는 작업 폴더 기준 상대 경로여야 합니다");
  const path = resolve(cwd, part), rel = relative(cwd, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) deviceError("실기기 경로가 작업 폴더를 벗어났습니다");
  return path;
}
export function parseDeviceConfig(value: unknown, cwd: string): DeviceConfig {
  const v = object(value, ["version", "device", "bundleID", "project", "scheme", "derivedDataPath", "appPath", "testTargets", "capture"]);
  if (v.version !== 1) deviceError("지원하는 실기기 설정 version은 1입니다");
  const d = object(v.device, ["id", "udid", "name"]);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(text(d.id)) || !/^[a-z0-9-]{8,80}$/iu.test(text(d.udid))) deviceError("CoreDevice ID와 Xcode UDID가 필요합니다");
  text(d.name);
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu.test(text(v.bundleID))) deviceError("bundleID를 확인해 주세요");
  text(v.scheme);
  for (const field of ["project", "derivedDataPath", "appPath"]) localDevicePath(cwd, v[field]);
  if (!v.project.endsWith(".xcodeproj") || !v.appPath.endsWith(".app")) deviceError("project는 .xcodeproj, appPath는 .app 경로여야 합니다");
  if (!Array.isArray(v.testTargets) || v.testTargets.length > 32 || v.testTargets.some((x: unknown) => !/^[A-Za-z0-9_./]+$/u.test(text(x)))) deviceError("testTargets를 확인해 주세요");
  if (v.capture !== undefined) {
    const c = object(v.capture, ["isolationArgument", "cases"]);
    if (!/^-[a-z][a-z0-9-]*$/iu.test(text(c.isolationArgument))) deviceError("앱의 격리 캡처 인자가 필요합니다");
    if (!Array.isArray(c.cases) || c.cases.length < 1 || c.cases.length > 20) deviceError("캡처 장면은 1~20개여야 합니다");
    const names = new Set<string>();
    for (const entry of c.cases) {
      const row = object(entry, ["name", "arguments"]);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(text(row.name)) || names.has(row.name)) deviceError("장면 이름은 고유한 영문 소문자·숫자·하이픈이어야 합니다");
      names.add(row.name);
      if (!Array.isArray(row.arguments) || row.arguments.length > 32) deviceError("장면 arguments를 확인해 주세요");
      for (const arg of row.arguments) {
        text(arg, 1024);
        if (arg === c.isolationArgument) deviceError("캡처 파일 인자는 gdm이 추가합니다. 장면에 중복하지 마세요");
      }
    }
  }
  return v as DeviceConfig;
}
export function readDeviceConfig(cwd: string, path: string): DeviceConfig {
  const file = resolve(cwd, path), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) deviceError("실기기 설정은 128KiB 이하의 일반 JSON 파일이어야 합니다");
  try { return parseDeviceConfig(JSON.parse(readFileSync(file, "utf8")), cwd); }
  catch (error) { if (error instanceof GdmError) throw error; return deviceError("실기기 설정 JSON을 읽지 못했습니다"); }
}
export function inspectPhysicalDevice(result: any, config: DeviceConfig): void {
  const r = result?.result;
  if (r?.identifier?.toLowerCase() !== config.device.id.toLowerCase() || r?.hardwareProperties?.udid !== config.device.udid || r?.deviceProperties?.name !== config.device.name) deviceError("설정한 기기의 이름·CoreDevice ID·UDID가 일치하지 않습니다", "device_mismatch");
  if (r.hardwareProperties.reality !== "physical" || r.hardwareProperties.platform !== "iOS") deviceError("iOS 실기기만 사용할 수 있습니다", "device_not_physical");
  const p = r.deviceProperties, c = r.connectionProperties;
  if (c?.pairingState !== "paired" || c?.tunnelState !== "connected" || p.bootState !== "booted" || p.developerModeStatus !== "enabled" || p.ddiServicesAvailable !== true) deviceError("기기를 연결하고 잠금을 푼 뒤 개발자 모드를 확인해 주세요", "device_not_ready");
}
export function inspectUnlocked(result: any, config: DeviceConfig): void {
  // Apple's versioned devicectl JSON, not its human-readable stdout.
  if (result?.result?.deviceIdentifier?.toLowerCase() !== config.device.id.toLowerCase()) deviceError("잠금 검사 대상 기기가 일치하지 않습니다", "device_mismatch");
  if (result?.result?.unlockedSinceBoot !== true || result?.result?.passcodeRequired !== false) deviceError("iPhone 잠금을 풀고 다시 실행해 주세요", "device_locked");
}
export function inspectTestSummary(s: any, config: DeviceConfig): void {
  if (s?.result !== "Passed" || !(s.totalTestCount > 0) || !(s.passedTests > 0) || s.failedTests !== 0 || s.expectedFailures !== 0 || !Array.isArray(s.testFailures) || s.testFailures.length !== 0) deviceError("0개 테스트 또는 실패한 XCTest 결과는 통과할 수 없습니다", "device_test_failed");
  const devices = s.devicesAndConfigurations;
  if (!Array.isArray(devices) || !devices.length || !devices.every((row: any) => row.device?.deviceId === config.device.udid && row.device?.deviceName === config.device.name && row.device?.platform === "iOS" && row.failedTests === 0 && row.expectedFailures === 0 && row.passedTests > 0)) deviceError("XCTest 결과의 실기기 식별 또는 성공 개수를 확인하지 못했습니다", "device_test_mismatch");
}
export function inspectPNG(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 45 || bytes.length > 30 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") deviceError("유효한 새 PNG 캡처가 없습니다", "device_capture_invalid");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16384 || height > 16384) deviceError("캡처 이미지 크기가 올바르지 않습니다", "device_capture_invalid");
  let offset = 8, hasPixels = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) deviceError("PNG 청크가 잘렸습니다", "device_capture_invalid");
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if ((offset === 8 && (kind !== "IHDR" || length !== 13)) || (offset !== 8 && kind === "IHDR")) deviceError("PNG 헤더가 올바르지 않습니다", "device_capture_invalid");
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++) crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) deviceError("PNG 파일이 손상되었습니다", "device_capture_invalid");
    if (kind === "IDAT" && length > 0) hasPixels = true;
    if (kind === "IEND") { ended = length === 0 && end === bytes.length; break; }
    offset = end;
  }
  if (!hasPixels || !ended) deviceError("PNG 이미지 데이터가 완성되지 않았습니다", "device_capture_invalid");
  return { width, height };
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  return crc >>> 0;
});
