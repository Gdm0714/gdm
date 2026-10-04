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
  MAX_EVENT_STREAM_BYTES,
  MAX_EVENT_LINE_BYTES,
  MAX_TASK_BYTES,
  MAX_TOTAL_CHILDREN,
  buildChildArguments,
  childTimeout,
  resolveChildConfiguration,
  validateDelegationRequest,
} from "../../tests/legacy/pi/delegate-policy.mjs";
import { runBoundedChild } from "../../tests/legacy/pi/delegate-runner.mjs";

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

function fakePi(directory: string): { readonly executable: string; readonly argv: string; readonly profile: string; readonly routing: string } {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "pi");
  const argv = join(directory, "argv.txt");
  const profile = join(directory, "profile.txt");
  const routing = join(directory, "routing.txt");
  writeFileSync(executable, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"$GDM_CAPTURE_ARGV"
printf '%s\\n' "\${GDM_PI_PROFILE:-raw}|\${GDM_PI_IMPLEMENTATION_MODEL:-}|\${GDM_PI_AUDIT_MODEL:-}" >"$GDM_CAPTURE_PROFILE"
printf '%s\\n' "\${GDM_PI_MODEL:-}:\${GDM_PI_THINKING:-}|\${GDM_PI_SCOUT_MODEL:-}:\${GDM_PI_SCOUT_THINKING:-}|\${GDM_PI_DESIGN_MODEL:-}:\${GDM_PI_DESIGN_THINKING:-}|\${GDM_PI_REVIEW_MODEL:-}:\${GDM_PI_REVIEW_THINKING:-}" >"$GDM_CAPTURE_ROUTING"
`);
  chmodSync(executable, 0o755);
  const gdm = join(directory, "gdm");
  writeFileSync(gdm, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(gdm, 0o755);
  return { executable, argv, profile, routing };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi role-routed GDM harness policy", () => {
  test("allows only bounded credential-free read-only child requests", () => {
    const task = {
      role: "scout",
      scope: "agents/pi",
      task: "Inspect the delegation boundary",
      deliverable: "Paths and line-backed findings",
      verify: "Coordinator opens every cited file",
    } as const;
    expect(validateDelegationRequest({ tasks: [task] })).toBeNull();
    expect(validateDelegationRequest({ tasks: [{ ...task, role: "design", thinking: "high" }] })).toBeNull();
    expect(validateDelegationRequest({ tasks: [{ ...task, role: "reviewer", thinking: "medium" }] })).toBeNull();
    expect(validateDelegationRequest({ tasks: [{ ...task, thinking: "medium" }] })).toBeNull();
    expect(validateDelegationRequest({ tasks: [{ ...task, thinking: "high" }] })).toBeNull();
    expect(validateDelegationRequest({ tasks: [{ ...task, role: "design", thinking: "max" }] })).toContain("medium|high");
    expect(validateDelegationRequest({ tasks: [{ ...task, role: "writer" }] })).toContain("unsupported read-only role");
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
      "--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--tools", "read,grep,find,ls", "--system-prompt", "Read-only specialist",
      "--model", "openai-codex/gpt-5.6-sol", "--thinking", "xhigh",
      "Task:\nInspect one bounded scope",
    ]);
    expect(argv.join("\n")).not.toMatch(/(^|,)(bash|edit|write)(,|$)/u);
    expect(childTimeout("999")).toBe(10 * 60 * 1000);
    expect(childTimeout("2500")).toBe(2500);
  });

  test("routes roles independently of the coordinator with bounded task effort and explicit override precedence", () => {
    const mainOnly = { GDM_PI_MODEL: "openai-codex/gpt-6-astra", GDM_PI_THINKING: "low" };
    expect(resolveChildConfiguration("scout", mainOnly)).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "medium" });
    for (const role of ["design", "reviewer"] as const) {
      expect(resolveChildConfiguration(role, mainOnly)).toEqual({ model: "openai-codex/gpt-6-astra", thinking: "medium" });
      expect(resolveChildConfiguration(role, mainOnly, "high").thinking).toBe("high");
    }
    const legacy = { ...mainOnly, GDM_PI_CHILD_MODEL: "openai-codex/gpt-5.6-sol", GDM_PI_CHILD_THINKING: "xhigh" };
    expect(resolveChildConfiguration("scout", legacy)).toEqual({ model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" });
    expect(resolveChildConfiguration("reviewer", { ...legacy, GDM_PI_REVIEW_MODEL: "openai-codex/gpt-5.6-terra", GDM_PI_REVIEW_THINKING: "medium" }))
      .toEqual({ model: "openai-codex/gpt-5.6-terra", thinking: "medium" });
    expect(resolveChildConfiguration("design", legacy, "high").thinking).toBe("high");
    expect(resolveChildConfiguration("scout", {}, "medium")).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "medium" });
    expect(resolveChildConfiguration("scout", {}, "high")).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "high" });
    expect(() => resolveChildConfiguration("design", { GDM_PI_DESIGN_MODEL: "bad model" })).toThrow("invalid design");
    expect(() => resolveChildConfiguration("reviewer", { GDM_PI_REVIEW_THINKING: "" })).toThrow("invalid reviewer");
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
      GDM_CAPTURE_ROUTING: fake.routing,
      PATH: `${join(home, "fake")}:${process.env.PATH ?? ""}`,
    };
    delete env.GDM_PI_PROFILE;
    delete env.GDM_PI_IMPLEMENTATION_MODEL;
    delete env.GDM_PI_AUDIT_MODEL;
    delete env.GDM_PI_AGENT_DIR;
    for (const key of ["MODEL", "THINKING", "CHILD_MODEL", "CHILD_THINKING", "SCOUT_MODEL", "SCOUT_THINKING",
      "DESIGN_MODEL", "DESIGN_THINKING", "REVIEW_MODEL", "REVIEW_THINKING"]) delete env[`GDM_PI_${key}`];

    const launched = run("bash", [LAUNCHER, "--print", "Inspect this repository"], ROOT, env);

    expect(launched).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
    const argv = readFileSync(fake.argv, "utf8").trimEnd().split("\n");
    expect(argv).toContain("openai-codex/gpt-5.6-terra");
    expect(argv).toContain("openai-codex/gpt-5.6-terra:high");
    expect(argv).toContain("high");
    expect(readFileSync(fake.routing, "utf8").trim()).toBe(
      "openai-codex/gpt-5.6-terra:high|openai-codex/gpt-5.6-luna:medium|openai-codex/gpt-6-astra:medium|openai-codex/gpt-6-astra:medium",
    );
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain(join(skills, "gdm-agents", "pi", "gdm-delegate.ts"));
    expect(argv).toContain(join(skills, "gdm-agents", "pi", "gdm-memory", "index.ts"));
    expect(argv).toContain(join(skills, "gdm-agents", "pi", "gdm-computer-use", "index.ts"));
    expect(readFileSync(join(skills, "gdm-agents", "pi", "ax.mjs"), "utf8")).toBe(
      readFileSync(join(ROOT, "agents", "pi", "ax.mjs"), "utf8"),
    );
    expect(argv).toContain("--no-skills");
    const renderedGo = readFileSync(join(skills, "gdm-go", "SKILL.md"), "utf8");
    expect(renderedGo).toContain("`scout|design|reviewer`만 허용");
    expect(renderedGo).not.toContain("`scout|reviewer`만 허용");
    for (const name of [
      "analyze", "db", "design", "document", "email", "full", "go", "plan", "pr",
      "reflect", "research", "review", "ui",
    ]) {
      expect(argv).toContain(join(skills, `gdm-${name}`));
    }
    expect(argv).toContain("read,bash,edit,write,grep,find,ls,gdm_delegate,gdm_memory,gdm_computer_use");
    expect(argv).toContain("Inspect this repository");
    expect(readFileSync(fake.profile, "utf8").trim()).toBe(
      "auto|openai-codex/gpt-5.6-terra:high|openai-codex/gpt-6-astra:medium",
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
      GDM_PI_AUDIT_MODEL: "openai-codex/gpt-5.6-terra:medium",
    });
    expect(sameModelAudit.exitCode).toBe(64);
    expect(sameModelAudit.stderr).toContain("audit model identity must differ");
    expect(existsSync(fake.argv)).toBe(false);

    const full = run("bash", [LAUNCHER, "full", "--print", "Audit this repository"], ROOT, env);
    expect(full.exitCode, full.stderr).toBe(0);
    expect(readFileSync(fake.argv, "utf8")).toContain(join(skills, "gdm-full"));
    expect(readFileSync(fake.profile, "utf8").trim()).toBe(
      "full|openai-codex/gpt-5.6-terra:high|openai-codex/gpt-6-astra:medium",
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
      GDM_PI_MODEL: "openai-codex/gpt-6-astra",
      GDM_PI_THINKING: "low",
      GDM_PI_CHILD_MODEL: "openai-codex/gpt-5.6-sol",
      GDM_PI_CHILD_THINKING: "xhigh",
      GDM_PI_REVIEW_MODEL: "openai-codex/gpt-5.6-terra",
      GDM_PI_REVIEW_THINKING: "high",
    });
    expect(overridden.exitCode, overridden.stderr).toBe(0);
    const overriddenArgv = readFileSync(fake.argv, "utf8");
    expect(overriddenArgv).toContain("openai-codex/gpt-6-astra:low");
    expect(readFileSync(fake.routing, "utf8").trim()).toBe(
      "openai-codex/gpt-6-astra:low|openai-codex/gpt-5.6-sol:xhigh|openai-codex/gpt-5.6-sol:xhigh|openai-codex/gpt-5.6-terra:high",
    );
    expect(run("bash", [LAUNCHER, "full", "Inspect"], ROOT, { ...env, GDM_PI_MODEL: "openai-codex/gpt-6-astra" }).exitCode).toBe(64);
    expect(run("bash", [LAUNCHER, "full", "Inspect"], ROOT, { ...env, GDM_PI_MODEL: "openai-codex/gpt-6-astra", GDM_PI_AUDIT_MODEL: "openai-codex/gpt-5.6-terra:high" }).exitCode).toBe(0);
    for (const [key, value] of [["GDM_PI_SCOUT_MODEL", "bad:model"], ["GDM_PI_DESIGN_THINKING", "unbounded"],
      ["GDM_PI_CHILD_MODEL", ""], ["GDM_PI_REVIEW_THINKING", ""], ["GDM_PI_MODEL", ""]]) {
      rmSync(fake.argv, { force: true });
      const invalid = run("bash", [LAUNCHER, "go", "Inspect"], ROOT, { ...env, [key!]: value });
      expect(invalid.exitCode).toBe(64);
      expect(invalid.stderr).toContain(`invalid ${key}`);
      expect(existsSync(fake.argv)).toBe(false);
    }

    const installedMemory = join(skills, "gdm-agents", "pi", "gdm-memory", "index.ts");
    const memoryBytes = readFileSync(installedMemory);
    rmSync(installedMemory);
    rmSync(fake.argv, { force: true });
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
    // Prebuild JSON bytes in the test process. The child only streams a fixture,
    // so parser checks do not compete with renderer/Bun/Node startup overhead.
    const usage = { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 1, totalTokens: 15,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } };
    const message = (text: string, stopReason = "stop"): Record<string, unknown> => ({
      role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol",
      content: [{ type: "thinking", thinking: "private thinking", thinkingSignature: "private signature" }, { type: "text", text }],
      usage, stopReason,
    });
    const event = (value: unknown) => JSON.stringify(value) + "\n";
    const payloads: Record<string, string> = {
      STREAMSIZE: event({ type: "message_update", delta: "x".repeat(1024) }).repeat(MAX_EVENT_STREAM_BYTES / 1024 + 1),
      LINESIZE: "x".repeat(MAX_EVENT_LINE_BYTES + 1),
      MALFORMED: "not JSON\n",
      OVERSIZE: event({ type: "message_end", message: message("x".repeat(MAX_OUTPUT_BYTES + 1)) }),
      INCOMPLETE: event({ type: "message_end", message: message("partial") }),
    };
    for (const scenario of ["NORMAL", "PROVIDERERROR", "LENGTH", "MISSINGUSAGE", "INVALIDUSAGE"]) {
      const first = message("investigating", "toolUse");
      const final = message("delegated=1\n");
      if (scenario === "PROVIDERERROR") { final.stopReason = "error"; final.errorMessage = "provider rejected request"; }
      if (scenario === "LENGTH") final.stopReason = "length";
      if (scenario === "MISSINGUSAGE") delete final.usage;
      if (scenario === "INVALIDUSAGE") final.usage = { ...usage, input: -1 };
      payloads[scenario] = [
        { type: "message_start", message: first },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ignored" }, message: first },
        { type: "message_end", message: first },
        { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "ignored tool output" }], usage } },
        { type: "turn_end", message: first },
        { type: "message_end", message: final },
        { type: "agent_end", messages: [first, final] },
      ].map((value) => JSON.stringify(value)).join("\n");
    }
    const failedAttempt = { ...message("retryable failure", "error"), errorMessage: "temporary provider error" };
    const retryPrefix = [
      { type: "message_end", message: failedAttempt },
      { type: "turn_end", message: failedAttempt },
      { type: "agent_end", messages: [failedAttempt], willRetry: true },
    ].map(event).join("");
    payloads.RETRYPENDING = retryPrefix;
    for (const scenario of ["RECOVERED", "RETRYEXHAUSTED"]) {
      const final = scenario === "RECOVERED" ? message("recovered final") : failedAttempt;
      payloads[scenario] = retryPrefix + [
        { type: "agent_start" },
        { type: "message_update", message: final },
        { type: "message_end", message: final },
        { type: "turn_end", message: final },
        { type: "agent_end", messages: [failedAttempt, final], willRetry: false },
      ].map(event).join("");
    }
    payloads.AFTERTERMINAL = event({ type: "message_end", message: message("already finished") }) +
      event({ type: "agent_end", willRetry: false }) + event({ type: "agent_end", willRetry: true }) +
      event({ type: "message_end", message: message("unexpected restart") });
    for (const scenario of ["COMPACTTHRESHOLD", "COMPACTOVERFLOW", "COMPACTMISSING"]) {
      const overflow = scenario === "COMPACTOVERFLOW";
      payloads[scenario] = [
        { type: "message_end", message: message("before compaction", overflow ? "length" : "stop") },
        { type: "agent_end", willRetry: false },
        { type: "compaction_start", reason: overflow ? "overflow" : "threshold" },
        { type: "compaction_end", reason: overflow ? "overflow" : "threshold",
          result: scenario === "COMPACTMISSING" ? null : { usage }, willRetry: overflow },
        ...(overflow ? [{ type: "agent_start" },
          { type: "message_end", message: message("after compaction") },
          { type: "agent_end", willRetry: false }] : []),
        { type: "agent_settled" },
      ].map(event).join("");
    }
    for (const [scenario, payload] of Object.entries(payloads)) writeFileSync(join(root, `${scenario}.jsonl`), payload);
    writeFileSync(executable, `#!/bin/sh
set -eu
[ "\${GDM_PI_DELEGATED:-}" = "1" ] || exit 99
for last do :; done
fixture_dir="\${0%/*}"
case "$last" in
  *TIMEOUT*|*ABORT*) trap '' TERM; while :; do sleep 1; done ;;
  *NONZERO*) printf 'upstream unavailable' >&2; exit 7 ;;
${Object.keys(payloads).map((scenario) => `  *${scenario}*) exec /bin/cat "$fixture_dir/${scenario}.jsonl" ;;`).join("\n")}
  *) exit 98 ;;
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
      expect(normal).toMatchObject({ model: common.model, thinking: "xhigh", assistantTurns: 2,
        reportedModels: ["openai-codex/gpt-5.6-sol"], usageComplete: true, stopReason: "stop",
        usage: { input: 20, output: 6, cacheRead: 4, cacheWrite: 0, reasoning: 2, totalTokens: 30,
          cost: { input: 0.02, output: 0.04, cacheRead: 0.002, cacheWrite: 0, total: 0.062 } } });
      expect(normal.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(normal.output).not.toContain("thinking");

      const recovered = await runBoundedChild({ ...common, taskText: "RECOVERED", timeoutMs: 2_000 });
      expect(recovered).toMatchObject({ ok: true, exitCode: 0, error: "", output: "recovered final",
        assistantTurns: 2, usageComplete: true, stopReason: "stop",
        usage: { input: 20, output: 6, cacheRead: 4, cacheWrite: 0, reasoning: 2, totalTokens: 30,
          cost: { input: 0.02, output: 0.04, cacheRead: 0.002, cacheWrite: 0, total: 0.062 } } });

      const oversized = await runBoundedChild({ ...common, taskText: "OVERSIZE", timeoutMs: 2_000 });
      expect(oversized.ok).toBe(false);
      expect(oversized.error).toBe("child output limit exceeded");
      expect(oversized.output).toBe("");
      expect(oversized).toMatchObject({ usageComplete: false, usage,
        reportedModels: ["openai-codex/gpt-5.6-sol"] });

      const compacted = await runBoundedChild({ ...common, taskText: "COMPACTTHRESHOLD", timeoutMs: 2_000 });
      expect(compacted).toMatchObject({ ok: true, usageComplete: true, assistantTurns: 1,
        usage: { input: 20, output: 6, totalTokens: 30, reasoning: 2 } });
      const overflow = await runBoundedChild({ ...common, taskText: "COMPACTOVERFLOW", timeoutMs: 2_000 });
      expect(overflow).toMatchObject({ ok: true, output: "after compaction", assistantTurns: 2,
        usageComplete: true, usage: { input: 30, output: 9, totalTokens: 45, reasoning: 3 } });
      const unknownCompaction = await runBoundedChild({ ...common, taskText: "COMPACTMISSING", timeoutMs: 2_000 });
      expect(unknownCompaction).toMatchObject({ ok: true, usageComplete: false,
        usage: { ...usage, reasoning: null } });

      for (const [taskText, error] of [["STREAMSIZE", "child event stream limit exceeded"],
        ["LINESIZE", "child event line limit exceeded"], ["MALFORMED", "child emitted malformed JSON event"],
        ["INCOMPLETE", "child JSON stream incomplete"], ["NONZERO", "upstream unavailable"],
        ["RETRYPENDING", "child JSON stream incomplete"], ["RETRYEXHAUSTED", "temporary provider error"],
        ["AFTERTERMINAL", "child emitted malformed assistant event"],
        ["PROVIDERERROR", "provider rejected request"], ["LENGTH", "child assistant stopped with length"]]) {
        const result = await runBoundedChild({ ...common, taskText: taskText!, timeoutMs: 2_000 });
        expect(result.ok, taskText).toBe(false);
        expect(result.error, taskText).toBe(error!);
        expect(result.usageComplete, taskText).toBe(false);
      }
      for (const taskText of ["MISSINGUSAGE", "INVALIDUSAGE"]) {
        const result = await runBoundedChild({ ...common, taskText, timeoutMs: 2_000 });
        expect(result.ok).toBe(true);
        expect(result.usageComplete).toBe(false);
        expect(result.usage?.input).toBe(10);
        expect(result.usage?.reasoning).toBeNull();
      }

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
