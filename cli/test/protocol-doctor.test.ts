import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "cli", "src", "cli.ts");
const RENDERER = join(ROOT, "install", "render-skills.ts");
const roots: string[] = [];

function fixture(): { readonly cwd: string; readonly home: string; readonly codexHome: string } {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-protocol-doctor-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "gdm-protocol-doctor-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "gdm-protocol-doctor-codex-"));
  roots.push(cwd, home, codexHome);
  for (const [target, output] of [
    ["codex", join(codexHome, "skills")],
    ["claude", join(home, ".claude", "skills")],
  ] as const) {
    const rendered = Bun.spawnSync([
      "bun", RENDERER, "--target", target, "--source-root", join(ROOT, "skills"),
      "--agents-root", join(ROOT, "agents"), "--output", output,
    ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(rendered.exitCode, rendered.stderr.toString()).toBe(0);
  }
  return { cwd, home, codexHome };
}

function doctor(state: ReturnType<typeof fixture>): string {
  const result = Bun.spawnSync(["bun", CLI, "doctor"], {
    cwd: state.cwd,
    env: { ...process.env, HOME: state.home, CODEX_HOME: state.codexHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("protocol target manifest doctor", () => {
  test("detects runner and provider adapter byte drift while preserving source parity semantics", () => {
    const state = fixture();
    const healthy = doctor(state);
    expect(healthy).toContain("protocol target codex: OK manifest[valid]");
    expect(healthy).toContain("hook[supported] runner[supported]");
    expect(healthy).toContain("protocol target claude: OK manifest[valid]");
    expect(healthy).toContain("hook[not-required] runner[supported]");
    expect(healthy).toContain("protocol target source parity: OK");
    expect(healthy).not.toContain("core parity");

    const runner = join(state.codexHome, "skills", "gdm-agents", "run-role.sh");
    const runnerBytes = readFileSync(runner);
    writeFileSync(runner, Buffer.concat([runnerBytes, Buffer.from("\n# tampered\n")]));
    const runnerDrift = doctor(state);
    expect(runnerDrift).toContain("protocol target codex: ERROR manifest[drift]");
    expect(runnerDrift).toContain("runner[invalid]");
    expect(runnerDrift).toContain("runner or provider adapter contract/hash differs");
    expect(runnerDrift).toContain("protocol target source parity: OK");
    writeFileSync(runner, runnerBytes);

    const adapter = join(state.home, ".claude", "skills", "gdm-agents", "providers", "claude.sh");
    writeFileSync(adapter, Buffer.concat([readFileSync(adapter), Buffer.from("\n# tampered\n")]));
    const adapterDrift = doctor(state);
    expect(adapterDrift).toContain("protocol target claude: ERROR manifest[drift]");
    expect(adapterDrift).toContain("runner[invalid]");
    expect(adapterDrift).toContain("runner or provider adapter contract/hash differs");
  });
});
