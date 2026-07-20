import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";

const decoder = new TextDecoder();
const enabled = process.env.GDM_INSTALLED_CAPABILITY === "1";
const installedTest = enabled ? test : test.skip;

type ProcessResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

function run(binary: string, cwd: string, args: readonly string[]): ProcessResult {
  const result = Bun.spawnSync([binary, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("installed audit-done capability", () => {
  installedTest("installed binary preserves audit-bound hashes across done", () => {
    const binary = join(process.env.HOME ?? "", ".local", "bin", "gdm");
    const cwd = mkdtempSync(join(tmpdir(), "gdm-installed-audit-done-"));
    const slug = "capability-probe";

    expect(run(binary, cwd, ["--version"]).stdout.trim()).toBe(packageJson.version);
    expect(
      run(binary, cwd, [
        "plan",
        "init",
        "--slug",
        slug,
        "--brief",
        "설치본 capability",
        "--audit",
        "--require",
        "증거 보존",
        "--forbid",
        "자동 커밋",
      ]).exitCode,
    ).toBe(0);
    expect(
      run(binary, cwd, [
        "plan",
        "add",
        "--slug",
        slug,
        "--desc",
        "자동 명령",
        "--cmd",
        "printf 'run\\n' >> executions.log",
        "--expect",
        "exit 0",
      ]).exitCode,
    ).toBe(0);
    expect(run(binary, cwd, ["pass", "c1", "--slug", slug]).exitCode).toBe(0);

    const root = join(cwd, ".gdm", slug);
    const statePath = join(root, "checks.json");
    const evidencePath = join(root, "out", "c1.txt");
    const reportRelative = join(".gdm", slug, "audit-report.md");
    const reportPath = join(cwd, reportRelative);
    writeFileSync(reportPath, "[APPROVE]\nimplementationModel: Codex\nauditModel: Claude\n");
    expect(run(binary, cwd, [
      "audit", "verdict", "--pass", "--report", reportRelative,
      "--implementation-model", "Codex", "--audit-model", "Claude", "--slug", slug,
    ]).exitCode).toBe(0);

    const stateBefore = JSON.parse(readFileSync(statePath, "utf8")) as {
      checks: unknown;
      audit: { stateHash: string };
    };
    const before = {
      checks: JSON.stringify(stateBefore.checks),
      audit: stateBefore.audit.stateHash,
      evidence: hash(evidencePath),
      report: hash(reportPath),
    };

    const done = run(binary, cwd, ["done", "--slug", slug]);
    expect(done.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "executions.log"), "utf8")).toBe("run\nrun\n");

    const stateAfter = JSON.parse(readFileSync(statePath, "utf8")) as {
      done: boolean;
      checks: unknown;
      audit: { stateHash: string };
    };
    expect(stateAfter.done).toBe(true);
    expect({
      checks: JSON.stringify(stateAfter.checks),
      audit: stateAfter.audit.stateHash,
      evidence: hash(evidencePath),
      report: hash(reportPath),
    }).toEqual(before);
    const status = JSON.parse(run(binary, cwd, ["status", "--json"]).stdout) as Array<{
      slug: string;
      done: boolean;
      audit: string;
    }>;
    expect(status).toContainEqual(expect.objectContaining({ slug, done: true, audit: "검수: 통과" }));
  });
});
