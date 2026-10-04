import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeviceArgs } from "../src/device-cli.ts";
import { parseDeviceConfig } from "../src/device.ts";
const root = join(import.meta.dir, "../.."), cli = join(root, "cli/src/cli.ts"), source = join(root, "integrations/device");
const temps: string[] = [];
function temp() { const p = mkdtempSync(join(tmpdir(), "gdm-device-install-test-")); temps.push(p); return p; }
function run(args: string[], cwd: string) { const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; }
afterEach(() => { for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true }); });

test("CLI exposes device help and refuses ambiguous or unsupported flags", () => {
  const cwd = temp(), help = run(["bun", cli, "device", "--help"], cwd);
  expect(help.code).toBe(0); expect(help.stdout).toContain("capture");
  for (const a of [["doctor", "--case", "dark"], ["list", "--config", "a"], ["capture", "--case"], ["test", "--simulator"], ["doctor", "--json", "--json"], ["doctor", "extra"]]) {
    expect(() => parseDeviceArgs(a)).toThrow();
    expect(run(["bun", cli, "device", ...a], cwd).code).toBe(2);
  }
  expect(existsSync(join(cwd, ".gdm"))).toBe(false); expect(existsSync(join(cwd, ".gdm-artifacts"))).toBe(false);
});
test("skill installer dry-run, exact payload, idempotence and existing content backup", () => {
  const cwd = temp(), dest = join(cwd, "gdm-device"), command = ["python3", join(source, "install-gid-skill.py"), "--destination", dest];
  expect(run([...command, "--dry-run"], cwd).code).toBe(0); expect(existsSync(dest)).toBe(false);
  expect(run(command, cwd).code).toBe(0);
  for (const f of ["SKILL.md", "README.md", "example.json"]) expect(readFileSync(join(dest, f))).toEqual(readFileSync(join(source, f)));
  expect(run(command, cwd).stdout).toContain("Already current");
  writeFileSync(join(dest, "personal.txt"), "keep user edits");
  expect(run(command, cwd).code).toBe(0);
  const backups = readdirSync(cwd).filter(p => p.startsWith("gdm-device.backup-"));
  expect(backups).toHaveLength(1); expect(readFileSync(join(cwd, backups[0]!, "personal.txt"), "utf8")).toBe("keep user edits");
  const c = parseDeviceConfig(JSON.parse(readFileSync(join(dest, "example.json"), "utf8")), cwd);
  expect(c.capture?.cases.length).toBeGreaterThan(0);
});
test("failed configuration does not start physical tools or mutate gdm work state", () => {
  const cwd = temp(); writeFileSync(join(cwd, ".gdm-device.json"), "{}");
  const result = run(["bun", cli, "device", "doctor", "--json"], cwd);
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("version");
  expect(existsSync(join(cwd, ".gdm-artifacts"))).toBe(false); expect(existsSync(join(cwd, ".gdm"))).toBe(false);
});
test("backup stays outside recursively discovered skills", () => {
  const cwd = temp(), dest = join(cwd, "skills/gdm-device");
  const command = ["python3", join(source, "install-gid-skill.py"), "--destination", dest];
  expect(run(command, cwd).code).toBe(0);
  writeFileSync(join(dest, "note.txt"), "preserve");
  expect(run(command, cwd).code).toBe(0);
  expect(readdirSync(join(cwd, "skills"))).toEqual(["gdm-device"]);
  const backups = readdirSync(join(cwd, "skill-backups"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(cwd, "skill-backups", backups[0]!, "note.txt"), "utf8")).toBe("preserve");
});
