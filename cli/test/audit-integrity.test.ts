import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

function run(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

function git(cwd: string, args: readonly string[]) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

function auditedRepo(command = "grep -q GOOD product.txt"): { cwd: string; slug: string; report: string } {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-audit-integrity-"));
  writeFileSync(join(cwd, "product.txt"), "GOOD\n");
  expect(git(cwd, ["init", "-b", "main"]).exitCode).toBe(0);
  expect(git(cwd, ["config", "user.email", "test@example.com"]).exitCode).toBe(0);
  expect(git(cwd, ["config", "user.name", "Test User"]).exitCode).toBe(0);
  expect(git(cwd, ["add", "product.txt"]).exitCode).toBe(0);
  expect(git(cwd, ["commit", "-m", "initial"]).exitCode).toBe(0);
  const slug = "audit-integrity";
  expect(run(cwd, [
    "plan", "init", "--slug", slug, "--brief", "audit integrity", "--audit",
    "--require", "preserve report", "--forbid", "automatic commit",
  ]).exitCode).toBe(0);
  expect(run(cwd, [
    "plan", "add", "--slug", slug, "--desc", "product check", "--cmd", command, "--expect", "exit 0",
  ]).exitCode).toBe(0);
  expect(run(cwd, ["pass", "c1", "--slug", slug]).exitCode).toBe(0);
  const report = join(".gdm", slug, "audit-report.md");
  writeFileSync(join(cwd, report), "# audit\n**판정: 통과**\nimplementationModel: Codex\nauditModel: Claude\n");
  return { cwd, slug, report };
}

function verdict(cwd: string, slug: string, report: string, implementation = "Codex", audit = "Claude") {
  return run(cwd, [
    "audit", "verdict", "--pass", "--report", report,
    "--implementation-model", implementation, "--audit-model", audit, "--slug", slug,
  ]);
}

describe("audit integrity", () => {
  test("outside reports and same-model audits are rejected", () => {
    const { cwd, slug, report } = auditedRepo();
    const outsidePath = join(tmpdir(), `gdm-outside-report-${Date.now()}.md`);
    writeFileSync(outsidePath, "implementationModel: Codex\nauditModel: Claude\n");
    const outside = verdict(cwd, slug, outsidePath);
    expect(outside.exitCode).toBe(5);

    writeFileSync(join(cwd, report), "**판정: 통과**\nimplementationModel: Codex\nauditModel: Codex\n");
    const same = verdict(cwd, slug, report, "Codex", "Codex");
    expect(same.exitCode).not.toBe(0);
    expect(same.stderr).toContain("달라야");
  });

  test("report verdict marker is singular and matches the requested verdict", () => {
    const mismatch = auditedRepo();
    writeFileSync(
      join(mismatch.cwd, mismatch.report),
      "# audit\n**판정: 반려**\nimplementationModel: Codex\nauditModel: Claude\n",
    );
    const forgedPass = verdict(mismatch.cwd, mismatch.slug, mismatch.report);
    expect(forgedPass.exitCode).toBe(3);
    expect(forgedPass.stderr).toContain("오류(audit_verdict_mismatch)");

    const ambiguous = auditedRepo();
    writeFileSync(
      join(ambiguous.cwd, ambiguous.report),
      "**판정: 통과**\n**판정: 반려**\nimplementationModel: Codex\nauditModel: Claude\n",
    );
    const duplicate = verdict(ambiguous.cwd, ambiguous.slug, ambiguous.report);
    expect(duplicate.exitCode).toBe(3);
    expect(duplicate.stderr).toContain("오류(audit_verdict_invalid)");
  });

  test("report or git worktree changes invalidate a passed audit", () => {
    const first = auditedRepo();
    expect(verdict(first.cwd, first.slug, first.report).exitCode).toBe(0);
    writeFileSync(join(first.cwd, first.report), "changed\nimplementationModel: Codex\nauditModel: Claude\n");
    expect(run(first.cwd, ["done", "--slug", first.slug]).exitCode).not.toBe(0);

    const second = auditedRepo();
    expect(verdict(second.cwd, second.slug, second.report).exitCode).toBe(0);
    writeFileSync(join(second.cwd, "product.txt"), "GOOD\nCHANGED\n");
    const changed = run(second.cwd, ["done", "--slug", second.slug]);
    expect(changed.exitCode).not.toBe(0);
    expect(changed.stderr).toContain("워크트리");
  });

  test("an unchanged git-bound audit closes without a duplicate command run", () => {
    const state = auditedRepo("grep -q GOOD product.txt && printf 'run\\n' >> executions.log");
    expect(verdict(state.cwd, state.slug, state.report).exitCode).toBe(0);
    expect(git(state.cwd, ["add", "executions.log"]).exitCode).toBe(0);
    expect(git(state.cwd, ["commit", "-m", "record verified output"]).exitCode).toBe(0);
    expect(run(state.cwd, ["done", "--slug", state.slug]).exitCode).toBe(0);
    expect(readFileSync(join(state.cwd, "executions.log"), "utf8")).toBe("run\n");
  });
});
