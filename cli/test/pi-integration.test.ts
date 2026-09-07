import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DelegateBudget,
  MAX_CONCURRENT_CHILDREN,
  MAX_OUTPUT_BYTES,
  MAX_TASK_BYTES,
  MAX_TOTAL_CHILDREN,
  buildChildArguments,
  childTimeout,
  validateDelegationRequest,
} from "../../agents/pi/delegate-policy.mjs";
import { runBoundedChild } from "../../agents/pi/delegate-runner.mjs";

const ROOT = join(import.meta.dir, "..", "..");
const RENDERER = join(ROOT, "install", "render-skills.ts");
const LAUNCHER = join(ROOT, "agents", "pi", "gdm-pi");
const decoder = new TextDecoder();
const roots: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function run(program: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = Bun.spawnSync([program, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function renderPiSkills(agentDirectory: string): string {
  const skills = join(agentDirectory, "skills");
  const result = run("bun", [
    RENDERER,
    "--target", "pi",
    "--source-root", join(ROOT, "skills"),
    "--agents-root", join(ROOT, "agents"),
    "--output", skills,
  ], ROOT, process.env);
  expect(result.exitCode, result.stderr).toBe(0);
  return skills;
}

function fakePi(directory: string): { readonly executable: string; readonly argv: string; readonly profile: string } {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "pi");
  const argv = join(directory, "argv.txt");
  const profile = join(directory, "profile.txt");
  writeFileSync(executable, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"$GDM_CAPTURE_ARGV"
printf '%s\\n' "\${GDM_PI_PROFILE:-raw}|\${GDM_PI_IMPLEMENTATION_MODEL:-}|\${GDM_PI_AUDIT_MODEL:-}" >"$GDM_CAPTURE_PROFILE"
`);
  chmodSync(executable, 0o755);
  const gdm = join(directory, "gdm");
  writeFileSync(gdm, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(gdm, 0o755);
  return { executable, argv, profile };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi xhigh GDM harness policy", () => {
  test("allows only bounded credential-free read-only child requests", () => {
    const task = {
      role: "scout",
      scope: "agents/pi",
      task: "Inspect the delegation boundary",
      deliverable: "Paths and line-backed findings",
      verify: "Coordinator opens every cited file",
    } as const;
    expect(validateDelegationRequest({ tasks: [task] })).toBeNull();
    expect(validateDelegationRequest({ tasks: Array.from({ length: 4 }, () => task) }))
      .toContain(`${MAX_CONCURRENT_CHILDREN}-child concurrency limit`);
    expect(validateDelegationRequest({ tasks: [{ ...task, extra: "not allowed" }] }))
      .toContain("exactly role, scope, task, deliverable, verify");
    expect(validateDelegationRequest({ tasks: [{ ...task, task: "Use Bearer secret-token-now" }] }))
      .toContain("credential-shaped value");
    expect(validateDelegationRequest({ tasks: [{ ...task, task: "x".repeat(MAX_TASK_BYTES) }] }))
      .toContain(`${MAX_TASK_BYTES}-byte limit`);
    expect(validateDelegationRequest({ tasks: [{ ...task, scope: "  " }] }))
      .toContain("must be nonempty text");

    const budget = new DelegateBudget();
    expect(budget.reserve(3)).toBeNull();
    expect(budget.reserve(1)).toContain("concurrency");
    budget.release(3);
    expect(budget.reserve(3)).toBeNull();
    budget.release(3);
    expect(budget.reserve(3)).toContain(`${MAX_TOTAL_CHILDREN}`);
    expect(budget.reserve(2)).toBeNull();
    expect(budget.snapshot()).toEqual({ active: 2, total: MAX_TOTAL_CHILDREN });
    budget.release(2);

    const argv = buildChildArguments({
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
      systemPrompt: "Read-only specialist",
      task: "Inspect one bounded scope",
    });
    expect(argv).toEqual([
      "--mode", "text", "--print", "--no-session", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--tools", "read,grep,find,ls", "--system-prompt", "Read-only specialist",
      "--model", "openai-codex/gpt-5.6-sol", "--thinking", "xhigh",
      "Task:\nInspect one bounded scope",
    ]);
    expect(argv.join("\n")).not.toMatch(/(^|,)(bash|edit|write)(,|$)/u);
    expect(childTimeout("999")).toBe(10 * 60 * 1000);
    expect(childTimeout("2500")).toBe(2500);
  });

  test("routes all GDM skills by default while preserving explicit profiles and raw Pi", () => {
    const home = temporaryDirectory("gdm-pi-launcher-home-");
    const agentDirectory = join(home, ".pi", "agent");
    const skills = renderPiSkills(agentDirectory);
    const fake = fakePi(join(home, "fake"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDirectory,
      GDM_PI_EXECUTABLE: fake.executable,
      GDM_CAPTURE_ARGV: fake.argv,
      GDM_CAPTURE_PROFILE: fake.profile,
      PATH: `${join(home, "fake")}:${process.env.PATH ?? ""}`,
    };
    delete env.GDM_PI_PROFILE;
    delete env.GDM_PI_IMPLEMENTATION_MODEL;
    delete env.GDM_PI_AUDIT_MODEL;
    delete env.GDM_PI_AGENT_DIR;

    const launched = run("bash", [LAUNCHER, "--print", "Inspect this repository"], ROOT, env);

    expect(launched).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
    const argv = readFileSync(fake.argv, "utf8").trimEnd().split("\n");
    expect(argv).toContain("openai-codex/gpt-5.6-sol");
    expect(argv).toContain("openai-codex/gpt-5.6-sol:xhigh");
    expect(argv).toContain("xhigh");
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain(join(skills, "gdm-agents", "pi", "gdm-delegate.ts"));
    expect(argv).toContain(join(skills, "gdm-agents", "pi", "gdm-memory", "index.ts"));
    expect(argv).toContain(join(skills, "gdm-agents", "pi", "gdm-computer-use", "index.ts"));
    expect(readFileSync(join(skills, "gdm-agents", "pi", "ax.mjs"), "utf8")).toBe(
      readFileSync(join(ROOT, "agents", "pi", "ax.mjs"), "utf8"),
    );
    expect(argv).toContain("--no-skills");
    for (const name of [
      "analyze", "db", "design", "document", "email", "full", "go", "plan", "pr",
      "reflect", "research", "review", "ui",
    ]) {
      expect(argv).toContain(join(skills, `gdm-${name}`));
    }
    expect(argv).toContain("read,bash,edit,write,grep,find,ls,gdm_delegate,gdm_memory,gdm_computer_use");
    expect(argv).toContain("Inspect this repository");
    expect(readFileSync(fake.profile, "utf8").trim()).toBe(
      "auto|openai-codex/gpt-5.6-sol:xhigh|openai-codex/gpt-5.6-terra:xhigh",
    );

    rmSync(fake.argv);
    const rejected = run("bash", [LAUNCHER, "go", "--extension=/tmp/untrusted.ts"], ROOT, env);
    expect(rejected.exitCode).toBe(64);
    expect(rejected.stderr).toContain("reserved Pi option");
    expect(existsSync(fake.argv)).toBe(false);

    const modelScopeRejected = run("bash", [LAUNCHER, "go", "--models=other/*"], ROOT, env);
    expect(modelScopeRejected.exitCode).toBe(64);
    expect(modelScopeRejected.stderr).toContain("reserved Pi option");
    expect(existsSync(fake.argv)).toBe(false);

    const sameModelAudit = run("bash", [LAUNCHER, "auto", "review"], ROOT, {
      ...env,
      GDM_PI_AUDIT_MODEL: "openai-codex/gpt-5.6-sol:high",
    });
    expect(sameModelAudit.exitCode).toBe(64);
    expect(sameModelAudit.stderr).toContain("audit model identity must differ");
    expect(existsSync(fake.argv)).toBe(false);

    const full = run("bash", [LAUNCHER, "full", "--print", "Audit this repository"], ROOT, env);
    expect(full.exitCode, full.stderr).toBe(0);
    expect(readFileSync(fake.argv, "utf8")).toContain(join(skills, "gdm-full"));
    expect(readFileSync(fake.profile, "utf8").trim()).toBe(
      "full|openai-codex/gpt-5.6-sol:xhigh|openai-codex/gpt-5.6-terra:xhigh",
    );

    const go = run("bash", [LAUNCHER, "go", "--print", "Fix this repository"], ROOT, env);
    expect(go.exitCode, go.stderr).toBe(0);
    const goArgv = readFileSync(fake.argv, "utf8").trimEnd().split("\n");
    expect(goArgv).toContain(join(skills, "gdm-go"));
    expect(goArgv).not.toContain(join(skills, "gdm-full"));

    const raw = run("bash", [LAUNCHER, "--raw", "--model", "openai/gpt-4o", "--version"], ROOT, env);
    expect(raw.exitCode, raw.stderr).toBe(0);
    expect(readFileSync(fake.argv, "utf8").trimEnd().split("\n")).toEqual([
      "--model", "openai/gpt-4o", "--version",
    ]);
    expect(readFileSync(fake.profile, "utf8").trim()).toBe("raw||");

    const management = run("bash", [LAUNCHER, "update", "--models"], ROOT, env);
    expect(management.exitCode, management.stderr).toBe(0);
    expect(readFileSync(fake.argv, "utf8").trimEnd().split("\n")).toEqual(["update", "--models"]);

    const overridden = run("bash", [LAUNCHER, "go", "--print", "Use overrides"], ROOT, {
      ...env,
      GDM_PI_MODEL: "openai-codex/gpt-5.6-terra",
      GDM_PI_THINKING: "max",
    });
    expect(overridden.exitCode, overridden.stderr).toBe(0);
    const overriddenArgv = readFileSync(fake.argv, "utf8");
    expect(overriddenArgv).toContain("openai-codex/gpt-5.6-terra");
    expect(overriddenArgv).toContain("max");

    const installedMemory = join(skills, "gdm-agents", "pi", "gdm-memory", "index.ts");
    const memoryBytes = readFileSync(installedMemory);
    rmSync(installedMemory);
    rmSync(fake.argv);
    const missingMemory = run("bash", [LAUNCHER, "--print", "Inspect without memory"], ROOT, env);
    expect(missingMemory.exitCode).toBe(69);
    expect(missingMemory.stderr).toContain("installed harness asset missing or unsafe");
    expect(existsSync(fake.argv)).toBe(false);

    writeFileSync(installedMemory, memoryBytes);
    rmSync(join(skills, "gdm-agents", "pi", "ax.mjs"));
    const missingAx = run("bash", [LAUNCHER, "--print", "Inspect without AX"], ROOT, env);
    expect(missingAx.exitCode).toBe(69);
    expect(missingAx.stderr).toContain("installed harness asset missing or unsafe");
    expect(existsSync(fake.argv)).toBe(false);
  });

  test("bounds child output and terminates only the owned child group on timeout or abort", async () => {
    const root = temporaryDirectory("gdm-pi-child-runner-");
    const executable = join(root, "fake-pi-child");
    writeFileSync(executable, `#!/usr/bin/env bash
set -euo pipefail
last="\${!#}"
case "$last" in
  *OVERSIZE*) yes x | head -c 262144 ;;
  *TIMEOUT*|*ABORT*) trap '' TERM; while :; do sleep 1; done ;;
  *) printf 'delegated=%s\\n' "\${GDM_PI_DELEGATED:-}" ;;
esac
`);
    chmodSync(executable, 0o755);
    const common = {
      executable,
      cwd: root,
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
      systemPrompt: "Read-only specialist",
      metadata: { role: "scout", scope: "agents/pi" },
    } as const;
    const unrelated = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });

    try {
      const normal = await runBoundedChild({ ...common, taskText: "NORMAL", timeoutMs: 2_000 });
      expect(normal).toMatchObject({ ok: true, exitCode: 0, output: "delegated=1\n", error: "" });

      const oversized = await runBoundedChild({ ...common, taskText: "OVERSIZE", timeoutMs: 2_000 });
      expect(oversized.ok).toBe(false);
      expect(oversized.error).toBe("child output limit exceeded");
      expect(Buffer.byteLength(oversized.output)).toBe(MAX_OUTPUT_BYTES);

      const timeoutStart = performance.now();
      const timedOut = await runBoundedChild({ ...common, taskText: "TIMEOUT", timeoutMs: 100 });
      expect(timedOut.ok).toBe(false);
      expect(timedOut.error).toBe("child timeout");
      expect(performance.now() - timeoutStart).toBeLessThan(2_500);

      const controller = new AbortController();
      const abortedPromise = runBoundedChild({
        ...common,
        taskText: "ABORT",
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      const aborted = await abortedPromise;
      expect(aborted.ok).toBe(false);
      expect(aborted.error).toBe("child aborted");
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      unrelated.kill("SIGKILL");
      await unrelated.exited;
    }
  });
});
