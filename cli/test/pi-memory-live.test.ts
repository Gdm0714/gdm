import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const RENDERER = join(ROOT, "install", "render-skills.ts");
const LAUNCHER = join(ROOT, "agents", "pi", "gdm-pi");
const roots: string[] = [];
const sessions: string[] = [];
const decoder = new TextDecoder();

function run(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const result = Bun.spawnSync([program, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPiCommand(env: NodeJS.ProcessEnv, command: string): Promise<string> {
  const session = `gdm-memory-live-${process.pid}-${sessions.length}`;
  sessions.push(session);
  const launched = run("tmux", [
    "new-session", "-d", "-x", "110", "-y", "28", "-s", session,
    `env PI_CODING_AGENT_DIR=${env.PI_CODING_AGENT_DIR} GDM_PI_EXECUTABLE=${env.GDM_PI_EXECUTABLE} ${LAUNCHER} --no-session`,
  ], env);
  expect(launched.exitCode, launched.stderr).toBe(0);
  await sleep(2000);
  expect(run("tmux", ["send-keys", "-t", session, "-l", command], env).exitCode).toBe(0);
  expect(run("tmux", ["send-keys", "-t", session, "Enter"], env).exitCode).toBe(0);
  await sleep(1500);
  const captured = run("tmux", ["capture-pane", "-p", "-t", session, "-S", "-28"], env);
  expect(captured.exitCode, captured.stderr).toBe(0);
  return captured.stdout;
}

afterEach(() => {
  for (const session of sessions.splice(0)) run("tmux", ["kill-session", "-t", session]);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gdm-pi memory live session", () => {
  const live = process.env.GDM_MEMORY_LIVE === "1" ? test : test.skip;

  live("recalls a global memory in a fresh real Pi session", async () => {
    const root = mkdtempSync(join(tmpdir(), "gdm-memory-live-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const render = run("bun", [
      RENDERER,
      "--target", "pi",
      "--source-root", join(ROOT, "skills"),
      "--agents-root", join(ROOT, "agents"),
      "--output", join(agentDir, "skills"),
    ]);
    expect(render.exitCode, render.stderr).toBe(0);

    const piExecutable = process.env.GDM_PI_EXECUTABLE || Bun.which("pi") || "";
    expect(piExecutable.startsWith("/")).toBe(true);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      GDM_PI_EXECUTABLE: piExecutable,
    };
    delete env.GDM_PI_PROFILE;
    delete env.GDM_PI_IMPLEMENTATION_MODEL;
    delete env.GDM_PI_AGENT_DIR;

    const marker = `live-memory-${process.pid}`;
    const first = await runPiCommand(env, `/remember --global ${marker}`);
    expect(first).toContain("Remembered mem-");
    const second = await runPiCommand(env, "/memory list --global");
    expect(second).toContain(marker);
  }, 30_000);
});
