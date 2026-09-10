import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

test("fresh standalone install completes go and preserves same-provider audit gates without calling Codex or Pi", () => {
  const home = mkdtempSync(join(tmpdir(), "gdm-claude-only-install-"));
  try {
    const bin = join(home, "test-bin");
    const cwd = join(home, "project");
    mkdirSync(bin);
    mkdirSync(cwd);
    symlinkSync(process.execPath, join(bin, "bun"));
    for (const provider of ["codex", "pi", "claude"]) {
      const path = join(bin, provider);
      writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$HOME/unexpected-provider-call"\nexit 97\n');
      chmodSync(path, 0o755);
    }
    // No personal settings, credentials, provider binaries, or inherited provider homes.
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/sh" };
    const run = (argv: string[]) => {
      const result = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
    };
    const install = run(["/bin/bash", join(ROOT, "install/install.sh")]);
    expect(install.code, install.err).toBe(0);
    const gdm = (...args: string[]) => run([join(home, ".local/bin/gdm"), ...args]);
    const skill = readFileSync(join(home, ".claude/skills/gdm-go/SKILL.md"), "utf8");
    expect(skill).toContain("Claude Code coordinator contract");
    expect(skill).toContain("gdm done");
    expect(skill).not.toContain("비실행 stub");
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);

    writeFileSync(join(cwd, "product.txt"), "BAD\n");
    const slug = "claude-only-go";
    expect(gdm("plan", "init", "--slug", slug, "--brief", "synthetic Claude-only workflow", "--require", "correct product", "--forbid", "automatic commit").code).toBe(0);
    expect(gdm("plan", "add", "--slug", slug, "--desc", "product regression", "--cmd", "grep -qx GOOD product.txt", "--expect", "exact GOOD line", "--kind", "regression").code).toBe(0);
    expect(gdm("pass", "c1", "--red", "--slug", slug).code).toBe(0);
    expect(gdm("done", "--slug", slug).code).not.toBe(0);
    writeFileSync(join(cwd, "product.txt"), "GOOD\n");
    expect(gdm("pass", "c1", "--slug", slug).code).toBe(0);
    const done = gdm("done", "--slug", slug);
    expect(done.code, done.err).toBe(0);
    expect(gdm("plan", "contract", "--check-commit", "--slug", slug).code).not.toBe(0);

    const full = "claude-only-full";
    expect(gdm("plan", "init", "--slug", full, "--brief", "synthetic same-provider gate check", "--audit", "--require", "independent model", "--forbid", "automatic commit").code).toBe(0);
    expect(gdm("plan", "add", "--slug", full, "--desc", "product behavior", "--cmd", "grep -qx GOOD product.txt", "--expect", "exact GOOD line").code).toBe(0);
    expect(gdm("pass", "c1", "--slug", full).code).toBe(0);
    expect(gdm("done", "--slug", full).code).not.toBe(0);
    // Fixture identities exercise the CLI gate, not real model execution or attestation.
    const implementation = "claude-implementation-fixture";
    const report = `.gdm/${full}/audit-report.md`;
    const verdict = (audit: string) => {
      writeFileSync(join(cwd, report), `**판정: 통과**\nimplementationModel: ${implementation}\nauditModel: ${audit}\n`);
      return gdm("audit", "verdict", "--pass", "--report", report, "--implementation-model", implementation, "--audit-model", audit, "--slug", full);
    };
    expect(verdict(implementation).code).not.toBe(0);
    const distinct = verdict("claude-review-fixture");
    expect(distinct.code, distinct.err).toBe(0);
    expect(gdm("done", "--slug", full).code).toBe(0);
    expect(gdm("plan", "contract", "--check-commit", "--slug", full).code).not.toBe(0);
    expect(existsSync(join(home, "unexpected-provider-call"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
