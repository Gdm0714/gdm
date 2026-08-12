import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";

const ROOT = join(import.meta.dir, "..", "..");
const INSTALL = join(ROOT, "install", "install.sh");
const REMOTE_INSTALL = join(ROOT, "install.sh");
const decoder = new TextDecoder();
const PATTERN = "learning.minimal-rule-after-recurrence";

// These integration tests compile binaries, archive skills, and install into
// isolated homes. The default 5-second unit-test budget flakes under host load.
setDefaultTimeout(30_000);

type ProcessResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
type InstalledGdm = { readonly binary: string; readonly home: string; readonly output: string };
type JsonObject = { readonly [key: string]: unknown };

function run(program: string, cwd: string, args: readonly string[], home?: string): ProcessResult {
  const result = Bun.spawnSync([program, ...args], {
    cwd,
    env: home === undefined ? process.env : { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function runEnv(program: string, cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): ProcessResult {
  const result = Bun.spawnSync([program, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function testGdmLauncher(home: string): string {
  const launcher = join(home, "gdm-test-launcher");
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(ROOT, "cli", "src", "cli.ts"))} "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

function runHookInstall(home: string, codexHome?: string): ProcessResult {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (codexHome === undefined) {
    delete env.CODEX_HOME;
  } else {
    env.CODEX_HOME = codexHome;
  }
  return runEnv(
    "bun",
    join(ROOT, "cli"),
    [
      "src/cli.ts",
      "agent",
      "hook-install",
      "--binary",
      testGdmLauncher(home),
    ],
    env,
  );
}

function expectOneGdmHandlerPerLifecycle(hooksPath: string): void {
  const config = object(JSON.parse(readFileSync(hooksPath, "utf8")));
  const hooks = object(config.hooks);
  for (const event of ["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"]) {
    const groups = hooks[event];
    expect(Array.isArray(groups)).toBe(true);
    const handlers = (groups as readonly unknown[]).flatMap((group) => {
      const value = object(group);
      expect(Array.isArray(value.hooks)).toBe(true);
      return value.hooks as readonly unknown[];
    });
    const gdmHandlers = handlers.filter((handler) => {
      const value = object(handler);
      return (
        typeof value.command === "string" &&
        value.command.includes("--handler-id gdm-agent-gate-v1")
      );
    });
    expect(gdmHandlers).toHaveLength(1);
  }
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function remoteAssets(withChecksums: boolean): { directory: string; asset: string } {
  const directory = tempDirectory("gdm-remote-assets-");
  const generated = tempDirectory("gdm-remote-targets-");
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const asset = `gdm-${os}-${arch}`;
  expect(run("bun", ROOT, ["build", "cli/src/cli.ts", "--compile", "--outfile", join(directory, asset)]).exitCode).toBe(0);
  for (const target of ["codex", "claude"] as const) {
    expect(run("bun", ROOT, [
      "install/render-skills.ts",
      "--target", target,
      "--source-root", join(ROOT, "skills"),
      "--agents-root", join(ROOT, "agents"),
      "--output", join(generated, "targets", target),
    ]).exitCode).toBe(0);
  }
  expect(run("tar", generated, ["-czf", join(directory, "gdm-skills.tar.gz"), "targets"]).exitCode).toBe(0);
  if (withChecksums) {
    writeFileSync(
      join(directory, "SHASUMS256.txt"),
      `${fileHash(join(directory, asset))}  ${asset}\n${fileHash(join(directory, "gdm-skills.tar.gz"))}  gdm-skills.tar.gz\n`,
    );
  }
  return { directory, asset };
}

let verifiedRemoteAssets:
  | { readonly directory: string; readonly asset: string }
  | undefined;

function sharedVerifiedRemoteAssets(): {
  readonly directory: string;
  readonly asset: string;
} {
  verifiedRemoteAssets ??= remoteAssets(true);
  return verifiedRemoteAssets;
}

function mutatedRemoteAssets(
  mutate: (targetRoot: string) => void,
): { readonly directory: string; readonly asset: string } {
  const source = sharedVerifiedRemoteAssets();
  const directory = tempDirectory("gdm-remote-mutated-assets-");
  const extracted = tempDirectory("gdm-remote-mutated-targets-");
  writeFileSync(join(directory, source.asset), readFileSync(join(source.directory, source.asset)));
  chmodSync(join(directory, source.asset), 0o755);
  expect(run("tar", extracted, ["-xzf", join(source.directory, "gdm-skills.tar.gz")]).exitCode).toBe(0);
  mutate(join(extracted, "targets"));
  expect(run("tar", extracted, ["-czf", join(directory, "gdm-skills.tar.gz"), "targets"]).exitCode).toBe(0);
  writeFileSync(
    join(directory, "SHASUMS256.txt"),
    `${fileHash(join(directory, source.asset))}  ${source.asset}\n${fileHash(join(directory, "gdm-skills.tar.gz"))}  gdm-skills.tar.gz\n`,
  );
  return { directory, asset: source.asset };
}

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function installGdm(): InstalledGdm {
  const home = tempDirectory("gdm-install-home-");
  const result = run("bash", ROOT, [INSTALL], home);
  expect(result.exitCode).toBe(0);
  return {
    binary: join(home, ".local", "bin", "gdm"),
    home,
    output: `${result.stdout}${result.stderr}`,
  };
}

function seedExistingInstall(home: string): {
  readonly binary: string;
  readonly binaryBytes: Buffer;
  readonly skillPaths: readonly string[];
  readonly skillBytes: Buffer;
} {
  const binary = join(home, ".local", "bin", "gdm");
  const binaryBytes = Buffer.from("#!/bin/sh\nprintf old-gdm\n", "utf8");
  const skillBytes = Buffer.from("old skill\n", "utf8");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(binary, binaryBytes);
  chmodSync(binary, 0o755);
  const skillPaths = [
    join(home, ".claude", "skills", "gdm-go", "SKILL.md"),
    join(home, ".codex", "skills", "gdm-go", "SKILL.md"),
  ];
  for (const path of skillPaths) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, skillBytes);
  }
  return { binary, binaryBytes, skillPaths, skillBytes };
}

function expectExistingInstallUnchanged(
  seeded: ReturnType<typeof seedExistingInstall>,
): void {
  expect(readFileSync(seeded.binary, "utf8")).toBe(
    seeded.binaryBytes.toString("utf8"),
  );
  for (const path of seeded.skillPaths) {
    expect(readFileSync(path, "utf8")).toBe(seeded.skillBytes.toString("utf8"));
  }
}

function seedLiveHookLock(home: string): string {
  const lock = join(home, ".codex", "hooks.json.gdm-lock");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(lock, `${process.pid}-${"a".repeat(24)}\n`);
  return lock;
}

function expectNoInstallerTransactionArtifacts(home: string): void {
  for (const directory of [
    join(home, ".local", "bin"),
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
  ]) {
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) continue;
    expect(
      readdirSync(directory).filter((name) =>
        name.startsWith(".gdm-stage.") ||
        name.startsWith(".gdm-rollback.") ||
        name.startsWith(".gdm.tmp.")
      ),
    ).toEqual([]);
  }
}

function skill(name: string): string {
  return readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8");
}

function frontmatter(contents: string): string {
  if (!contents.startsWith("---\n")) throw new Error("skill frontmatter must start on byte zero");
  const end = contents.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("skill frontmatter must have a closing delimiter");
  return contents.slice(4, end);
}

function hasDescription(metadata: string): boolean {
  const lines = metadata.split("\n");
  const index = lines.findIndex((line) => line.startsWith("description:"));
  const declaration = index < 0 ? undefined : lines[index];
  if (declaration === undefined) return false;
  const value = declaration.slice("description:".length).trim();
  if (value.length > 0 && value !== "|" && value !== ">") return true;
  return lines.slice(index + 1).some((line) => /^\s+\S/u.test(line));
}

function metadataKeys(metadata: string): readonly string[] {
  return metadata.split("\n").flatMap((line) => {
    const match = /^([a-z][a-z-]*):/u.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("expected object");
  return value;
}

function ledgerEvents(cwd: string): readonly JsonObject[] {
  const bytes = readFileSync(join(cwd, ".gdm", "habits", "ledger.jsonl"), "utf8");
  return bytes.trim().split("\n").map((line) => object(JSON.parse(line)));
}

function observationFixture(): readonly JsonObject[] {
  return [
    {
      schemaVersion: 1,
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-a1",
      sourceGroup: "grp-a1",
      sourceKind: "incident",
    },
    {
      schemaVersion: 1,
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-b1",
      sourceGroup: "grp-b1",
      sourceKind: "principle",
    },
  ];
}

function importFixture(binary: string, home: string, cwd: string): readonly string[] {
  const observations = observationFixture();
  const input = observations.map((value) => JSON.stringify(value)).join("\n");
  writeFileSync(join(cwd, "observations.jsonl"), `${input}\n`);
  expect(run(binary, cwd, ["habit", "import", "--file", "observations.jsonl"], home).exitCode).toBe(0);
  return ledgerEvents(cwd).flatMap((event) =>
    typeof event.eventId === "string" ? [event.eventId] : [],
  );
}

describe("gdm installation and workflow skills", () => {
  test("remote installer verifies complete artifacts before changing the target", () => {
    const assets = sharedVerifiedRemoteAssets();
    const home = tempDirectory("gdm-remote-home-");
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const installed = runEnv("bash", ROOT, [REMOTE_INSTALL], {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      GDM_BASE_URL: `file://${assets.directory}`,
      GDM_BIN_DIR: bin,
    });
    expect(installed.exitCode).toBe(0);
    expect(run(join(bin, "gdm"), ROOT, ["--version"]).stdout.trim()).toBe(packageJson.version);
    const hookStatus = run(join(bin, "gdm"), ROOT, ["agent", "hook-status", "--json"], home);
    expect(hookStatus.exitCode).toBe(0);
    expect(JSON.parse(hookStatus.stdout)).toMatchObject({ installed: true });
    const installedHooks = readFileSync(join(home, ".codex", "hooks.json"), "utf8");
    expect(installedHooks.match(/gdm-agent-gate-v1/g)?.length).toBe(5);
    expect(installedHooks).toContain(join(bin, "gdm"));
    expect(existsSync(join(home, ".claude", "skills", "gdm-go", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills", "gdm-pr", "SKILL.md"))).toBe(true);
    const installedGo = readFileSync(join(home, ".codex", "skills", "gdm-go", "SKILL.md"), "utf8");
    const installedFull = readFileSync(join(home, ".codex", "skills", "gdm-full", "SKILL.md"), "utf8");
    const installedResearch = readFileSync(join(home, ".codex", "skills", "gdm-research", "SKILL.md"), "utf8");
    const installedAuditor = readFileSync(join(home, ".claude", "skills", "gdm-agents", "auditor.md"), "utf8");
    const installedCompatibilityRunner = readFileSync(join(home, ".codex", "skills", "gdm-agents", "run-auditor.sh"), "utf8");
    const installedRunner = readFileSync(join(home, ".codex", "skills", "gdm-agents", "run-role.sh"), "utf8");
    const installedCodexAdapter = readFileSync(join(home, ".codex", "skills", "gdm-agents", "providers", "codex.sh"), "utf8");
    const installedClaudeAdapter = readFileSync(join(home, ".codex", "skills", "gdm-agents", "providers", "claude.sh"), "utf8");
    expect(installedGo).toContain("Codex native delegation contract");
    expect(installedGo).toContain("일반 역할은 leaf가 아니다");
    expect(installedFull).toContain("같은 구현 모델의 에이전트는 여러 명이어도 된다");
    expect(installedFull).toContain("Codex native delegation contract");
    expect(installedResearch).toContain("모든 세대의 활성 spawned agent");
    expect(installedResearch).toContain("`MAX_ACTIVE_SUBAGENTS: 4`");
    expect(installedResearch).toContain("하위 역할을 만들 수 있다");
    expect(installedResearch).toContain("자기복제형 재위임");
    expect(installedResearch.replace(/\s+/gu, " ")).toContain("끝이 정해지지 않은 팬아웃");
    expect(installedGo).toContain("`GDM_AGENT_ENVELOPE_V1=`");
    expect(installedFull).toContain("`INITIAL_SPAWN_ATTEMPT_BUDGET: 16`");
    expect(installedFull).toContain("`SPAWN_ATTEMPT_EXTENSION: 4`");
    expect(installedFull).toContain("`MAX_TOTAL_SPAWNS_PER_ROOT: 32`");
    expect(installedResearch).toContain("`DEFAULT_CHILD_QUOTA: 1`");
    expect(installedResearch.replace(/\s+/gu, " ")).toContain(
      "실패·취소된 spawn도 예산을 돌려주지 않는다",
    );
    expect(installedResearch).not.toContain("에이전트 팬아웃을 사용하지 않는다");
    expect(installedAuditor).toContain("MAX_AGENT_DEPTH: 0");
    expect(installedAuditor).toContain("MAX_CHILD_AGENTS: 0");
    expect(installedAuditor).toContain("NEVER: 서브에이전트 생성");
    expect(installedAuditor).toContain("AUDITOR_RESOURCE_LIMIT");
    expect(installedCompatibilityRunner).toContain('"$runner"');
    expect(installedCodexAdapter).toContain("--disable multi_agent");
    expect(installedCodexAdapter).toContain("--disable multi_agent_v2");
    expect(installedCodexAdapter).not.toContain("--enable enable_fanout");
    expect(installedCodexAdapter).not.toContain("--disable enable_fanout");
    expect(installedCodexAdapter).toContain("--disable shell_tool");
    expect(installedCodexAdapter).toContain("--disable unified_exec");
    expect(installedCodexAdapter).toContain("--disable browser_use");
    expect(installedCodexAdapter).toContain("--ignore-rules");
    expect(installedCodexAdapter).toContain("--skip-git-repo-check");
    expect(installedClaudeAdapter).toContain('--tools ""');
    expect(installedClaudeAdapter).toContain("--no-chrome");
    expect(installedClaudeAdapter).toContain("--disable-slash-commands");
    expect(installedRunner).toContain('CAPABILITY_PROFILE="gdm-read-only-specialist/v1"');
    expect(installedRunner).toContain("max_processes");
    expect(installedRunner).toContain("stop_owned_tree");
    expect(installedRunner).not.toContain("pkill");
  });

  test("source installer preserves user hooks and config while updating only its handlers", () => {
    const home = tempDirectory("gdm-hook-preserve-home-");
    const codex = join(home, ".codex");
    mkdirSync(codex, { recursive: true });
    const originalHooks = `${JSON.stringify({
      description: "user-owned hooks",
      hooks: {
        Stop: [{
          hooks: [{
            type: "command",
            command: "/opt/user/stop-hook",
            timeout: 7,
            statusMessage: "user stop",
          }],
        }],
      },
    }, null, 2)}\n`;
    const originalConfig = "[agents]\nmax_concurrent_threads_per_session = 4\n\n[features]\nhooks = true\n";
    writeFileSync(join(codex, "hooks.json"), originalHooks);
    writeFileSync(join(codex, "config.toml"), originalConfig);

    const first = run("bash", ROOT, [INSTALL], home);
    expect(first.exitCode).toBe(0);
    expect(readFileSync(join(codex, "hooks.json.gdm-backup"), "utf8")).toBe(originalHooks);
    expect(readFileSync(join(codex, "config.toml"), "utf8")).toBe(originalConfig);
    const afterFirst = readFileSync(join(codex, "hooks.json"), "utf8");
    expect(afterFirst).toContain("/opt/user/stop-hook");
    expect(afterFirst.match(/gdm-agent-gate-v1/g)?.length).toBe(5);

    const second = run("bash", ROOT, [INSTALL], home);
    expect(second.exitCode).toBe(0);
    const afterSecond = readFileSync(join(codex, "hooks.json"), "utf8");
    expect(afterSecond).toContain("/opt/user/stop-hook");
    expect(afterSecond.match(/gdm-agent-gate-v1/g)?.length).toBe(5);
    expect(readFileSync(join(codex, "hooks.json.gdm-backup"), "utf8")).toBe(originalHooks);
    expect(readFileSync(join(codex, "config.toml"), "utf8")).toBe(originalConfig);
  });

  test("source installer preflight preserves old binary and skills for malformed hooks, hostile backup, and malformed TOML", () => {
    const scenarios = ["malformed-hooks", "backup-symlink", "malformed-toml"] as const;
    for (const scenario of scenarios) {
      const home = tempDirectory(`gdm-source-preflight-${scenario}-`);
      const seeded = seedExistingInstall(home);
      const codex = join(home, ".codex");
      const hooksPath = join(codex, "hooks.json");
      mkdirSync(codex, { recursive: true });
      if (scenario === "malformed-hooks") {
        writeFileSync(hooksPath, '{"hooks":[\n');
      } else if (scenario === "backup-symlink") {
        writeFileSync(hooksPath, '{"description":"user"}\n');
        const target = join(home, "user-backup.json");
        writeFileSync(target, "owned backup target\n");
        symlinkSync(target, `${hooksPath}.gdm-backup`);
      } else {
        writeFileSync(hooksPath, '{"description":"user"}\n');
        writeFileSync(join(codex, "config.toml"), "[features\nhooks = true\n");
      }

      const rejected = run("bash", ROOT, [INSTALL], home);

      expect(rejected.exitCode).not.toBe(0);
      expectExistingInstallUnchanged(seeded);
    }
  });

  test("source installer rolls binary and both skill roots back when the real hook commit fails", () => {
    const home = tempDirectory("gdm-source-hook-rollback-");
    const seeded = seedExistingInstall(home);
    const lock = seedLiveHookLock(home);

    const rejected = run("bash", ROOT, [INSTALL], home);

    expect(rejected.exitCode).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain(
      "잠금을 기다리다 시간 초과",
    );
    expectExistingInstallUnchanged(seeded);
    expect(existsSync(lock)).toBe(true);
    expectNoInstallerTransactionArtifacts(home);
  });

  test("source installer preflights a regular-file skill root before changing binary or hooks", () => {
    const home = tempDirectory("gdm-source-skill-root-file-");
    const binary = join(home, ".local", "bin", "gdm");
    const claudeSkillRoot = join(home, ".claude", "skills");
    const codexSkill = join(home, ".codex", "skills", "gdm-go", "SKILL.md");
    const oldBinary = "#!/bin/sh\nprintf old-gdm\n";
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, oldBinary);
    chmodSync(binary, 0o755);
    mkdirSync(join(claudeSkillRoot, ".."), { recursive: true });
    writeFileSync(claudeSkillRoot, "user-owned skill root\n");
    mkdirSync(join(codexSkill, ".."), { recursive: true });
    writeFileSync(codexSkill, "old codex skill\n");

    const rejected = run("bash", ROOT, [INSTALL], home);

    expect(rejected.exitCode).not.toBe(0);
    expect(readFileSync(binary, "utf8")).toBe(oldBinary);
    expect(readFileSync(claudeSkillRoot, "utf8")).toBe(
      "user-owned skill root\n",
    );
    expect(readFileSync(codexSkill, "utf8")).toBe("old codex skill\n");
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
    expectNoInstallerTransactionArtifacts(home);
  });

  test("source installer replaces legacy skill directories with generated targets and preserves unrelated skills", () => {
    const home = tempDirectory("gdm-source-skill-migration-");
    for (const host of [".claude", ".codex"]) {
      const root = join(home, host, "skills");
      mkdirSync(join(root, "gdm-go"), { recursive: true });
      writeFileSync(join(root, "gdm-go", "stale.txt"), "stale\n");
      mkdirSync(join(root, "user-owned"), { recursive: true });
      writeFileSync(join(root, "user-owned", "SKILL.md"), "keep me\n");
    }

    const installed = run("bash", ROOT, [INSTALL], home);

    expect(installed.exitCode).toBe(0);
    for (const host of [".claude", ".codex"]) {
      const root = join(home, host, "skills");
      const migrated = join(root, "gdm-go");
      expect(lstatSync(migrated).isDirectory()).toBe(true);
      expect(lstatSync(join(migrated, "SKILL.md")).isFile()).toBe(true);
      expect(existsSync(join(migrated, "stale.txt"))).toBe(false);
      expect(readFileSync(join(root, "user-owned", "SKILL.md"), "utf8")).toBe(
        "keep me\n",
      );
    }
  });

  test("source and remote installers never delete a non-regular existing binary target", () => {
    const assets = sharedVerifiedRemoteAssets();
    for (const variant of ["source", "remote"] as const) {
      const home = tempDirectory(`gdm-${variant}-binary-directory-`);
      const binary = join(home, ".local", "bin", "gdm");
      const sentinel = join(binary, "user-owned.txt");
      mkdirSync(binary, { recursive: true });
      writeFileSync(sentinel, "keep me\n");

      const rejected =
        variant === "source"
          ? run("bash", ROOT, [INSTALL], home)
          : runEnv("bash", ROOT, [REMOTE_INSTALL], {
              ...process.env,
              HOME: home,
              SHELL: "/bin/zsh",
              GDM_BASE_URL: `file://${assets.directory}`,
              GDM_BIN_DIR: join(home, ".local", "bin"),
            });

      expect(rejected.exitCode).not.toBe(0);
      expect(`${rejected.stdout}${rejected.stderr}`).toContain(
        "기존 바이너리 경로가 일반 파일이 아닙니다",
      );
      expect(lstatSync(binary).isDirectory()).toBe(true);
      expect(readFileSync(sentinel, "utf8")).toBe("keep me\n");
      expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
      expectNoInstallerTransactionArtifacts(home);
    }
  });

  test("hook installer rejects malformed config without changing bytes or creating a backup", () => {
    const home = tempDirectory("gdm-hook-malformed-home-");
    const codex = join(home, ".codex");
    const hooksPath = join(codex, "hooks.json");
    const backupPath = `${hooksPath}.gdm-backup`;
    const malformed = Buffer.from('{"hooks": [\n', "utf8");
    mkdirSync(codex, { recursive: true });
    writeFileSync(hooksPath, malformed);

    const rejected = runHookInstall(home);

    expect(rejected.exitCode).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain("JSON이 손상");
    expect(readFileSync(hooksPath)).toEqual(malformed);
    expect(existsSync(backupPath)).toBe(false);
  });

  test("hook installer rejects a symlink without changing the link or its target", () => {
    const home = tempDirectory("gdm-hook-symlink-home-");
    const codex = join(home, ".codex");
    const hooksPath = join(codex, "hooks.json");
    const targetPath = join(home, "user-hooks.json");
    const targetBytes = Buffer.from('{"description":"user-owned"}\n', "utf8");
    mkdirSync(codex, { recursive: true });
    writeFileSync(targetPath, targetBytes);
    symlinkSync(targetPath, hooksPath);
    const linkTarget = readlinkSync(hooksPath);

    const rejected = runHookInstall(home);

    expect(rejected.exitCode).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain("일반 파일이 아닙니다");
    expect(lstatSync(hooksPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(hooksPath)).toBe(linkTarget);
    expect(readFileSync(targetPath)).toEqual(targetBytes);
    expect(existsSync(`${hooksPath}.gdm-backup`)).toBe(false);
  });

  test("hook installer rejects a non-regular config path without mutation", () => {
    const home = tempDirectory("gdm-hook-nonregular-home-");
    const codex = join(home, ".codex");
    const hooksPath = join(codex, "hooks.json");
    const sentinelPath = join(hooksPath, "sentinel");
    const sentinelBytes = Buffer.from("user-owned\n", "utf8");
    mkdirSync(hooksPath, { recursive: true });
    writeFileSync(sentinelPath, sentinelBytes);

    const rejected = runHookInstall(home);

    expect(rejected.exitCode).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain("일반 파일이 아닙니다");
    expect(lstatSync(hooksPath).isDirectory()).toBe(true);
    expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);
    expect(existsSync(`${hooksPath}.gdm-backup`)).toBe(false);
  });

  test("hook installer is idempotent in an empty home", () => {
    const home = tempDirectory("gdm-hook-idempotent-home-");
    const hooksPath = join(home, ".codex", "hooks.json");

    const first = runHookInstall(home);
    expect(first.exitCode).toBe(0);
    const afterFirst = readFileSync(hooksPath);

    const second = runHookInstall(home);

    expect(second.exitCode).toBe(0);
    expect(readFileSync(hooksPath)).toEqual(afterFirst);
    expect(readFileSync(hooksPath, "utf8").match(/gdm-agent-gate-v1/g)?.length).toBe(5);
    expectOneGdmHandlerPerLifecycle(hooksPath);
    expect(existsSync(`${hooksPath}.gdm-backup`)).toBe(false);
  });

  test("hook installer prefers CODEX_HOME over HOME", () => {
    const home = tempDirectory("gdm-hook-home-priority-");
    const codexHome = join(home, "custom-codex-home");
    const hooksPath = join(codexHome, "hooks.json");

    const installed = runHookInstall(home, codexHome);

    expect(installed.exitCode).toBe(0);
    expect(existsSync(hooksPath)).toBe(true);
    expectOneGdmHandlerPerLifecycle(hooksPath);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  });

  test("remote installer fails closed when checksums are unavailable", () => {
    const assets = remoteAssets(false);
    const home = tempDirectory("gdm-remote-no-checksum-");
    const bin = join(home, "bin");
    const rejected = runEnv("bash", ROOT, [REMOTE_INSTALL], {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      GDM_BASE_URL: `file://${assets.directory}`,
      GDM_BIN_DIR: bin,
    });
    expect(rejected.exitCode).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain("SHASUMS256.txt");
    expect(existsSync(join(bin, "gdm"))).toBe(false);
  });

  test("remote installer preflight preserves old binary and skills for malformed, symlink, hostile backup, and malformed TOML state", () => {
    const assets = sharedVerifiedRemoteAssets();
    const scenarios = [
      "malformed",
      "config-symlink",
      "backup-symlink",
      "malformed-toml",
    ] as const;
    for (const scenario of scenarios) {
      const home = tempDirectory(`gdm-remote-preflight-${scenario}-`);
      const seeded = seedExistingInstall(home);
      const codex = join(home, ".codex");
      const hooksPath = join(codex, "hooks.json");
      mkdirSync(codex, { recursive: true });
      if (scenario === "malformed") {
        writeFileSync(hooksPath, '{"hooks":[\n');
      } else if (scenario === "config-symlink") {
        const target = join(home, "user-hooks.json");
        writeFileSync(target, '{"description":"user"}\n');
        symlinkSync(target, hooksPath);
      } else if (scenario === "backup-symlink") {
        writeFileSync(hooksPath, '{"description":"user"}\n');
        const target = join(home, "user-backup.json");
        writeFileSync(target, "owned backup target\n");
        symlinkSync(target, `${hooksPath}.gdm-backup`);
      } else {
        writeFileSync(hooksPath, '{"description":"user"}\n');
        writeFileSync(join(codex, "config.toml"), "[features\nhooks = true\n");
      }

      const rejected = runEnv("bash", ROOT, [REMOTE_INSTALL], {
        ...process.env,
        HOME: home,
        SHELL: "/bin/zsh",
        GDM_BASE_URL: `file://${assets.directory}`,
        GDM_BIN_DIR: join(home, ".local", "bin"),
      });

      expect(rejected.exitCode).not.toBe(0);
      expectExistingInstallUnchanged(seeded);
    }
  });

  test("remote installer rolls binary and both skill roots back when the real hook commit fails", () => {
    const assets = sharedVerifiedRemoteAssets();
    const home = tempDirectory("gdm-remote-hook-rollback-");
    const seeded = seedExistingInstall(home);
    const lock = seedLiveHookLock(home);

    const rejected = runEnv("bash", ROOT, [REMOTE_INSTALL], {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      GDM_BASE_URL: `file://${assets.directory}`,
      GDM_BIN_DIR: join(home, ".local", "bin"),
    });

    expect(rejected.exitCode).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain(
      "잠금을 기다리다 시간 초과",
    );
    expectExistingInstallUnchanged(seeded);
    expect(existsSync(lock)).toBe(true);
    expectNoInstallerTransactionArtifacts(home);
  });

  test("remote installer rejects signed but inconsistent target identity and adapter bytes before swap", () => {
    const scenarios = [
      { expected: "target manifest identity가 올바르지 않습니다", assets: mutatedRemoteAssets((targets) => {
        const path = join(targets, "claude", "gdm-target-manifest.json");
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        manifest.target = "codex";
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      }) },
      { expected: "provider adapter bytes 또는 mode가 manifest와 다릅니다", assets: mutatedRemoteAssets((targets) => {
        const path = join(targets, "claude", "gdm-agents", "providers", "claude.sh");
        writeFileSync(path, `${readFileSync(path, "utf8")}\n# corrupt signed adapter fixture\n`);
      }) },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const home = tempDirectory(`gdm-remote-target-drift-${index}-`);
      const seeded = seedExistingInstall(home);
      const rejected = runEnv("bash", ROOT, [REMOTE_INSTALL], {
        ...process.env,
        HOME: home,
        SHELL: "/bin/zsh",
        GDM_BASE_URL: `file://${scenario.assets.directory}`,
        GDM_BIN_DIR: join(home, ".local", "bin"),
      });

      expect(rejected.exitCode).not.toBe(0);
      expect(`${rejected.stdout}${rejected.stderr}`).toContain(scenario.expected);
      expectExistingInstallUnchanged(seeded);
      expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
      expectNoInstallerTransactionArtifacts(home);
    }
  });

  test("remote installer preflights a regular-file skill root before changing binary or hooks", () => {
    const assets = sharedVerifiedRemoteAssets();
    const home = tempDirectory("gdm-remote-skill-root-file-");
    const binary = join(home, ".local", "bin", "gdm");
    const claudeSkillRoot = join(home, ".claude", "skills");
    const codexSkill = join(home, ".codex", "skills", "gdm-go", "SKILL.md");
    const oldBinary = "#!/bin/sh\nprintf old-gdm\n";
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, oldBinary);
    chmodSync(binary, 0o755);
    mkdirSync(join(claudeSkillRoot, ".."), { recursive: true });
    writeFileSync(claudeSkillRoot, "user-owned skill root\n");
    mkdirSync(join(codexSkill, ".."), { recursive: true });
    writeFileSync(codexSkill, "old codex skill\n");

    const rejected = runEnv("bash", ROOT, [REMOTE_INSTALL], {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      GDM_BASE_URL: `file://${assets.directory}`,
      GDM_BIN_DIR: join(home, ".local", "bin"),
    });

    expect(rejected.exitCode).not.toBe(0);
    expect(readFileSync(binary, "utf8")).toBe(oldBinary);
    expect(readFileSync(claudeSkillRoot, "utf8")).toBe(
      "user-owned skill root\n",
    );
    expect(readFileSync(codexSkill, "utf8")).toBe("old codex skill\n");
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
    expectNoInstallerTransactionArtifacts(home);
  });

  test("remote installer resolves relative GDM_BIN_DIR from its starting cwd", () => {
    const assets = sharedVerifiedRemoteAssets();
    const home = tempDirectory("gdm-remote-relative-bin-home-");
    const start = tempDirectory("gdm-remote-relative-bin-cwd-");

    const installed = runEnv("bash", start, [REMOTE_INSTALL], {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      GDM_BASE_URL: `file://${assets.directory}`,
      GDM_BIN_DIR: "relative-bin",
    });

    expect(installed.exitCode).toBe(0);
    expect(existsSync(join(start, "relative-bin", "gdm"))).toBe(true);
  });

  test("remote installer reports PATH rc failures as post-commit warnings", () => {
    const assets = sharedVerifiedRemoteAssets();
    const home = tempDirectory("gdm-remote-path-warning-home-");
    const bin = join(home, "bin");
    mkdirSync(join(home, ".zshrc"));

    const installed = runEnv("bash", ROOT, [REMOTE_INSTALL], {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      GDM_BASE_URL: `file://${assets.directory}`,
      GDM_BIN_DIR: bin,
    });

    expect(installed.exitCode).toBe(0);
    expect(installed.stderr).toContain("PATH를 추가하지 못했습니다");
    expect(existsSync(join(bin, "gdm"))).toBe(true);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills", "gdm-go"))).toBe(true);
  });

  test("every skill has discoverable metadata and reflect installs for both hosts", () => {
    // Given: an isolated HOME and every repository skill.
    const installed = installGdm();

    // When: skill metadata and the installed host links are inspected.
    for (const name of readdirSync(join(ROOT, "skills"))) {
      const path = join(ROOT, "skills", name, "SKILL.md");
      if (!existsSync(path)) continue;
      const metadata = frontmatter(readFileSync(path, "utf8"));
      expect(metadataKeys(metadata)).toEqual(["name", "description"]);
      expect(metadata.split("\n")).toContain(`name: gdm-${name}`);
      expect(hasDescription(metadata)).toBe(true);
    }

    // Then: reflect and a target manifest are visible to both hosts.
    for (const host of [".claude", ".codex"]) {
      const root = join(installed.home, host, "skills");
      expect(lstatSync(join(root, "gdm-reflect")).isDirectory()).toBe(true);
      expect(lstatSync(join(root, "gdm-reflect", "SKILL.md")).isFile()).toBe(true);
      expect(lstatSync(join(root, "gdm-target-manifest.json")).isFile()).toBe(true);
    }
    expect(installed.output).toContain("gdm-reflect: claude[OK] codex[OK]");
    rmSync(join(installed.home, ".codex", "skills", "gdm-reflect"), { recursive: true });
    const doctor = run(installed.binary, ROOT, ["doctor"], installed.home);
    expect(doctor.stdout).toContain("gdm-reflect: claude[OK] codex[없음]");
    expect(doctor.stdout).toContain("누락 스킬은 재설치로 채웁니다");
  });

  test("installed gdm skills close a proposed but unadopted reflection loop", () => {
    // Given: the temp-HOME compiled binary and normalized incident/principle observations.
    const installed = installGdm();
    const cwd = tempDirectory("gdm-reflect-loop-");
    const sourceIds = importFixture(installed.binary, installed.home, cwd);

    // When: the installed binary creates the smallest evidence-backed proposal.
    const proposed = run(installed.binary, cwd, [
      "habit", "propose", "--pattern", PATTERN,
      "--statement", "같은 실패가 반복되면 재시도 규칙 하나만 추가한다",
      ...sourceIds.flatMap((eventId) => ["--source-event", eventId]),
    ], installed.home);

    // Then: the candidate exists, adoption does not, and the skill stops at the owner gate.
    expect(proposed.exitCode).toBe(0);
    const events = ledgerEvents(cwd);
    expect(events.some((event) => event.kind === "proposal")).toBe(true);
    expect(events.some((event) => event.kind === "adoption")).toBe(false);
    const reflect = readFileSync(join(installed.home, ".codex", "skills", "gdm-reflect", "SKILL.md"), "utf8");
    expect(reflect).toContain("ADOPTION_REQUIRED");
    expect(reflect).toContain("이 스킬은 `habit adopt`를 실행하지 않는다");
    expect(reflect).toContain("정규화된 여섯 필드 observation");
  });

  test("forbidden delivery and raw source input stop without mutation", () => {
    // Given: a proposed ledger, a temp git repository, and a default-forbidden work contract.
    const installed = installGdm();
    const cwd = tempDirectory("gdm-reflect-denial-");
    expect(run("git", cwd, ["init", "-b", "main"]).exitCode).toBe(0);
    const sourceIds = importFixture(installed.binary, installed.home, cwd);
    expect(run(installed.binary, cwd, [
      "habit", "propose", "--pattern", PATTERN,
      "--statement", "같은 실패가 반복되면 재시도 규칙 하나만 추가한다",
      ...sourceIds.flatMap((eventId) => ["--source-event", eventId]),
    ], installed.home).exitCode).toBe(0);
    const ledgerPath = join(cwd, ".gdm", "habits", "ledger.jsonl");
    const ledgerBefore = readFileSync(ledgerPath, "utf8");
    const headBefore = run("git", cwd, ["symbolic-ref", "HEAD"]);
    const indexBefore = run("git", cwd, ["write-tree"]);
    expect(headBefore.exitCode).toBe(0);
    expect(indexBefore.exitCode).toBe(0);
    expect(run(installed.binary, cwd, [
      "plan", "init", "--slug", "delivery-check", "--brief", "전달 경계",
      "--require", "사용자 소유 변경 보존", "--forbid", "자동 커밋",
    ], installed.home).exitCode).toBe(0);
    const rawPath = "/private/source/transcript.md";
    writeFileSync(join(cwd, "raw.jsonl"), `${JSON.stringify({ ...observationFixture()[0], summary: rawPath })}\n`);

    // When: a raw-path import and the machine-readable delivery gate are attempted.
    const raw = run(installed.binary, cwd, ["habit", "import", "--file", "raw.jsonl"], installed.home);
    const delivery = run(installed.binary, cwd, [
      "plan", "contract", "--slug", "delivery-check", "--check-commit",
    ], installed.home);

    // Then: both stop safely without changing habit, HEAD, or index state.
    expect(raw.exitCode).toBe(5);
    expect(`${raw.stdout}${raw.stderr}`).not.toContain(rawPath);
    expect(delivery.exitCode).toBe(4);
    expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
    expect(run("git", cwd, ["symbolic-ref", "HEAD"]).stdout).toBe(headBefore.stdout);
    expect(run("git", cwd, ["write-tree"]).stdout).toBe(indexBefore.stdout);
  });

  test("workflow skills preserve contract retry review and delivery gates", () => {
    // Given: the installed workflow skill sources.
    const plan = skill("plan");
    const go = skill("go");
    const full = skill("full");
    const review = skill("review");
    const pr = skill("pr");
    const routing = readFileSync(join(ROOT, "skills", "_shared", "routing.md"), "utf8");

    // When: their explicit boundaries are inspected.
    // Then: each stage owns one observable gate in gdm's evidence loop.
    expect(plan).toContain("--require");
    expect(plan).toContain("--forbid");
    expect(go).toContain("gdm attempt fail");
    expect(go).toContain("gdm attempt retry");
    expect(go).toContain("--changed <종류> --evidence <파일>");
    expect(go).toContain("gdm habit harvest");
    expect(go).toMatch(/NEVER:[\s\S]*stage, commit, push, PR/u);
    expect(full).toMatch(/NEVER:[\s\S]*stage,\s+commit, push, PR/u);
    expect(full).toContain("실제 구현 모델과 다른 모델");
    expect(full).toContain("--audit --require <보존> --forbid <금지>");
    expect(full).toContain("INDEPENDENCE_BLOCKED");
    expect(review).toContain("confirmed");
    expect(review).toContain("duplicate");
    expect(review).toContain("rejected");
    expect(review).toContain("새 confirmed 유형이 나오지 않으면 탐색을 끝낸다");
    expect(pr).toContain("gdm plan contract --check-commit");
    expect(pr).toContain("Co-Authored-By");
    expect(pr).toContain("읽기 전용");
    expect(skill("reflect")).toContain("cleanup trap");
    expect(routing).toContain("여러 구현 워커는 겹치지 않는 파일·모듈을 소유");
    expect(routing).toContain("실제 diff를 만든 구현 모델과 달라야 한다");
  });
});
