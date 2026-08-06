import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amendScope, defaultContract, normalizeRepositoryPath } from "../src/contract.ts";
import { addCheck, closeWork, initWork, passCheck, recordAudit } from "../src/state.ts";
import type { WorkspaceFingerprint } from "../src/types.ts";
import { changedWorkspacePaths, workspaceScopeProblems } from "../src/workflow-gates.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();
const NOW = "2026-08-04T00:00:00.000Z";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gdm-scope-"));
}

function run(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function git(cwd: string, args: readonly string[]): void {
  expect(Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
}

function fingerprint(files: Record<string, string>): WorkspaceFingerprint {
  return {
    kind: "git",
    head: "a".repeat(40),
    sha256: JSON.stringify(files),
    files: Object.entries(files).map(([path, sha256]) => ({ path, sha256 })),
  };
}

describe("scope and simplification gates", () => {
  test("scope delta ignores unchanged dirty files and gives forbidden paths priority", () => {
    const before = fingerprint({ "src/a.ts": "1", "delivery/local.ts": "dirty", "docs/readme.md": "1" });
    const after = fingerprint({ "src/a.ts": "2", "delivery/local.ts": "dirty", "docs/readme.md": "2" });
    expect(changedWorkspacePaths(before, after)).toEqual(["docs/readme.md", "src/a.ts"]);
    const work = initWork(
      "scoped-work",
      "scope",
      NOW,
      false,
      { ...defaultContract(), allowedPaths: ["src", "docs"], forbiddenPaths: ["docs"] },
      before,
    );
    expect(workspaceScopeProblems(work, after)).toEqual([
      { path: "docs/readme.md", reason: "forbidden" },
    ]);
  });

  test("repository paths reject traversal, absolute paths, and gdm state", () => {
    expect(normalizeRepositoryPath("./cli/src/")).toBe("cli/src");
    for (const path of ["../secret", "/tmp/secret", "C:/secret", ".gdm/out.txt"]) {
      expect(() => normalizeRepositoryPath(path)).toThrow();
    }
  });

  test("scope amendments require a reason and lock after audit", () => {
    let work = initWork("scope-amend", "scope", NOW);
    expect(() => amendScope(work, { addAllowed: ["docs"] }, "", NOW)).toThrow(/reason|값이 비어/);
    work = amendScope(work, { removeAllowed: ["."], addAllowed: ["src"] }, "작업 범위 축소", NOW).work;
    expect(work.contract.allowedPaths).toEqual(["src"]);
    ({ work } = addCheck(work, { desc: "ok", cmd: "true", expect: "ok" }));
    work = passCheck(work, "c1", { observed: "out.txt", sha256: "green", manual: false }, NOW);
    work = recordAudit(work, "pass", "audit.md", "a".repeat(64), "Codex", "Claude", null, NOW);
    expect(() => amendScope(work, { addAllowed: ["docs"] }, "late expansion", NOW)).toThrow(/검수 뒤/);
  });

  test("simplification contract requires a proven static check", () => {
    const contract = { ...defaultContract(), simplificationRequired: true };
    let work = initWork("simplify-work", "simplify", NOW, false, contract);
    ({ work } = addCheck(work, { desc: "behavior", cmd: "true", expect: "ok" }));
    work = passCheck(work, "c1", { observed: "behavior.txt", sha256: "b", manual: false }, NOW);
    expect(() => closeWork(work, NOW)).toThrow(/간소화 확인/);
    ({ work } = addCheck(work, { desc: "minimal diff", cmd: "true", expect: "minimal", kind: "static" }));
    work = passCheck(work, "c2", { observed: "static.txt", sha256: "s", manual: false }, NOW);
    expect(closeWork(work, NOW).done).toBe(true);
  });

  test("done blocks an out-of-scope change until a reasoned expansion", () => {
    const cwd = tempDir();
    git(cwd, ["init", "-q"]);
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(cwd, "docs", "readme.md"), "baseline\n");
    git(cwd, ["add", "."]);
    git(cwd, ["-c", "user.name=gdm", "-c", "user.email=gdm@example.invalid", "commit", "-qm", "baseline"]);

    expect(run(cwd, [
      "plan", "init", "--slug", "scope-cli", "--brief", "scoped", "--require", "범위 준수",
      "--allow-path", "src",
    ]).exitCode).toBe(0);
    expect(run(cwd, [
      "plan", "add", "--slug", "scope-cli", "--desc", "tests", "--cmd", "true", "--expect", "ok",
    ]).exitCode).toBe(0);
    expect(run(cwd, ["pass", "c1", "--slug", "scope-cli"]).exitCode).toBe(0);
    writeFileSync(join(cwd, "docs", "readme.md"), "changed\n");

    const blocked = run(cwd, ["done", "--slug", "scope-cli"]);
    expect(blocked.exitCode).toBe(4);
    expect(blocked.stderr).toContain("--allow-path");
    expect(run(cwd, [
      "plan", "contract", "--slug", "scope-cli", "--allow-path", "docs", "--reason", "문서 동기화",
    ]).exitCode).toBe(0);
    expect(run(cwd, ["done", "--slug", "scope-cli"]).exitCode).toBe(0);
  });

  test("done checks scope again after automatic verification commands run", () => {
    const cwd = tempDir();
    git(cwd, ["init", "-q"]);
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(cwd, "docs", "readme.md"), "baseline\n");
    git(cwd, ["add", "."]);
    git(cwd, ["-c", "user.name=gdm", "-c", "user.email=gdm@example.invalid", "commit", "-qm", "baseline"]);
    expect(run(cwd, [
      "plan", "init", "--slug", "scope-recheck", "--brief", "scoped recheck",
      "--require", "범위 준수", "--allow-path", "src",
    ]).exitCode).toBe(0);
    const command = "if test -f src/ran; then printf bad > docs/readme.md; else touch src/ran; fi";
    expect(run(cwd, [
      "plan", "add", "--slug", "scope-recheck", "--desc", "mutating verifier",
      "--cmd", command, "--expect", "exit 0",
    ]).exitCode).toBe(0);
    expect(run(cwd, ["pass", "c1", "--slug", "scope-recheck"]).exitCode).toBe(0);

    const done = run(cwd, ["done", "--slug", "scope-recheck"]);
    expect(done.exitCode).toBe(4);
    expect(done.stderr).toContain("docs/readme.md(outside-allowed)");
  });
});
