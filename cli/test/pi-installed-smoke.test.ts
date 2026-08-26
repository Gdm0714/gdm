import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const INSTALL = join(ROOT, "install", "install.sh");
const decoder = new TextDecoder();

function sourceSnapshot(): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (root: string, directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      expect(stat.isSymbolicLink(), path).toBe(false);
      if (stat.isDirectory()) visit(root, path);
      else if (stat.isFile()) {
        result[relative(ROOT, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  for (const name of ["agents", "install", "skills"]) visit(join(ROOT, name), join(ROOT, name));
  return result;
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

test("temp-HOME install launches a pinned coordinator and an installed read-only child policy without source writes", () => {
  const before = sourceSnapshot();
  const home = mkdtempSync(join(tmpdir(), "gdm-pi-installed-smoke-"));
  try {
    const userSkill = join(home, ".pi", "agent", "skills", "user-owned", "SKILL.md");
    const userSettings = join(home, ".pi", "agent", "settings.json");
    mkdirSync(join(userSkill, ".."), { recursive: true });
    writeFileSync(userSkill, "user-owned Pi skill\n");
    writeFileSync(userSettings, "{\"theme\":\"user-owned\"}\n");

    const installed = run("bash", [INSTALL], ROOT, { ...process.env, HOME: home });
    expect(installed.exitCode, `${installed.stdout}\n${installed.stderr}`).toBe(0);

    const launcher = join(home, ".local", "bin", "gdm-pi");
    const rootArgv = join(home, "root-argv.json");
    const childArgv = join(home, "child-argv.json");
    const fakePi = join(home, "fake-pi.ts");
    writeFileSync(fakePi, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const argv = Bun.argv.slice(2);
if (process.env.GDM_PI_DELEGATED === "1") {
  writeFileSync(process.env.GDM_CHILD_ARGV!, JSON.stringify(argv));
  process.exit(0);
}
writeFileSync(process.env.GDM_ROOT_ARGV!, JSON.stringify(argv));
if (process.env.GDM_EXPECT_RAW === "1") process.exit(0);
const extensionIndex = argv.indexOf("--extension");
if (extensionIndex < 0 || argv[extensionIndex + 1] === undefined) process.exit(91);
const policyPath = join(dirname(argv[extensionIndex + 1]!), "delegate-policy.mjs");
const policy = await import(pathToFileURL(policyPath).href);
const child = policy.buildChildArguments({
  model: process.env.GDM_PI_CHILD_MODEL,
  thinking: process.env.GDM_PI_CHILD_THINKING,
  systemPrompt: "Installed smoke read-only child",
  task: "Inspect installed harness boundaries",
});
const result = Bun.spawnSync([Bun.argv[0]!, Bun.argv[1]!, ...child], {
  env: { ...process.env, GDM_PI_DELEGATED: "1" },
  stdout: "pipe",
  stderr: "pipe",
});
process.exit(result.exitCode);
`);
    chmodSync(fakePi, 0o755);

    const launched = run(launcher, ["--print", "Inspect the installed harness"], ROOT, {
      ...process.env,
      HOME: home,
      GDM_PI_EXECUTABLE: fakePi,
      GDM_ROOT_ARGV: rootArgv,
      GDM_CHILD_ARGV: childArgv,
    });
    expect(launched.exitCode, `${launched.stdout}\n${launched.stderr}`).toBe(0);

    const root = JSON.parse(readFileSync(rootArgv, "utf8")) as string[];
    const child = JSON.parse(readFileSync(childArgv, "utf8")) as string[];
    expect(root).toContain("openai-codex/gpt-5.6-sol");
    expect(root).toContain("xhigh");
    const installedPiAssets = join(home, ".pi", "agent", "skills", "gdm-agents", "pi");
    expect(root).toContain(join(installedPiAssets, "gdm-delegate.ts"));
    expect(readFileSync(join(installedPiAssets, "presentation.mjs"), "utf8")).toBe(
      readFileSync(join(ROOT, "agents", "pi", "presentation.mjs"), "utf8"),
    );
    expect(readFileSync(join(installedPiAssets, "ax.mjs"), "utf8")).toBe(
      readFileSync(join(ROOT, "agents", "pi", "ax.mjs"), "utf8"),
    );
    for (const name of [
      "analyze", "db", "design", "document", "email", "full", "go", "plan", "pr",
      "reflect", "research", "review", "ui",
    ]) {
      expect(root).toContain(join(home, ".pi", "agent", "skills", `gdm-${name}`));
    }
    expect(root).toContain("read,bash,edit,write,grep,find,ls,gdm_delegate");
    expect(child).toEqual([
      "--mode", "text", "--print", "--no-session", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--tools", "read,grep,find,ls", "--system-prompt", "Installed smoke read-only child",
      "--model", "openai-codex/gpt-5.6-sol", "--thinking", "xhigh",
      "Task:\nInspect installed harness boundaries",
    ]);

    expect(readFileSync(userSkill, "utf8")).toBe("user-owned Pi skill\n");
    expect(readFileSync(userSettings, "utf8")).toBe("{\"theme\":\"user-owned\"}\n");

    const raw = run(launcher, ["--raw", "--version"], ROOT, {
      ...process.env,
      HOME: home,
      GDM_PI_EXECUTABLE: fakePi,
      GDM_ROOT_ARGV: rootArgv,
      GDM_CHILD_ARGV: childArgv,
      GDM_EXPECT_RAW: "1",
    });
    expect(raw.exitCode, `${raw.stdout}\n${raw.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(rootArgv, "utf8"))).toEqual(["--version"]);
    expect(sourceSnapshot()).toEqual(before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
