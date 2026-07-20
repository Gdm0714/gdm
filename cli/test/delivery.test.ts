import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

function run(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

function git(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout).trim() };
}

function completedRepo(): { cwd: string; slug: string; head: string } {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-delivery-"));
  writeFileSync(join(cwd, "product.txt"), "ready\n");
  expect(git(cwd, ["init", "-b", "main"]).exitCode).toBe(0);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  git(cwd, ["add", "product.txt"]);
  expect(git(cwd, ["commit", "-m", "initial"]).exitCode).toBe(0);
  const slug = "delivery-gate";
  expect(run(cwd, [
    "plan", "init", "--slug", slug, "--brief", "delivery gate",
    "--require", "passing CI", "--forbid", "unapproved merge",
  ]).exitCode).toBe(0);
  expect(run(cwd, [
    "plan", "add", "--slug", slug, "--desc", "ready", "--cmd", "true", "--expect", "exit 0",
  ]).exitCode).toBe(0);
  expect(run(cwd, ["pass", "c1", "--slug", slug]).exitCode).toBe(0);
  expect(run(cwd, ["done", "--slug", slug]).exitCode).toBe(0);
  expect(run(cwd, [
    "plan", "contract", "--slug", slug, "--commit", "explicitly-approved", "--reason", "publish request",
  ]).exitCode).toBe(0);
  return { cwd, slug, head: git(cwd, ["rev-parse", "HEAD"]).stdout };
}

describe("delivery state machine", () => {
  test("merge requires PR, passed CI, matching HEAD, and explicit approval", () => {
    const { cwd, slug, head } = completedRepo();
    expect(run(cwd, [
      "delivery", "prepare", "--slug", slug, "--issue", "#12", "--branch", "main", "--head", head,
    ]).exitCode).toBe(0);
    expect(run(cwd, ["delivery", "check-merge", "--slug", slug, "--head", head]).exitCode).toBe(4);

    expect(run(cwd, ["delivery", "pr", "--slug", slug, "--number", "#13", "--head", head]).exitCode).toBe(0);
    expect(run(cwd, [
      "delivery", "ci", "--slug", slug, "--status", "failed", "--head", head, "--run", "run-1",
    ]).exitCode).toBe(0);
    expect(run(cwd, ["delivery", "check-merge", "--slug", slug, "--head", head]).exitCode).toBe(4);

    expect(run(cwd, [
      "delivery", "ci", "--slug", slug, "--status", "passed", "--head", head, "--run", "run-2",
    ]).exitCode).toBe(0);
    expect(run(cwd, ["delivery", "check-merge", "--slug", slug, "--head", head]).exitCode).toBe(4);
    expect(run(cwd, [
      "delivery", "approve-merge", "--slug", slug, "--head", head, "--reason", "user requested merge",
    ]).exitCode).toBe(0);
    const allowed = run(cwd, ["delivery", "check-merge", "--slug", slug, "--head", head]);
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toContain("머지 가능");
    const status = run(cwd, ["status", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)[0].delivery.ci.status).toBe("passed");
    expect(run(cwd, ["resume", "--slug", slug]).stdout).toContain("전달:");
  });

  test("a new Git HEAD invalidates the prepared delivery chain", () => {
    const { cwd, slug, head } = completedRepo();
    expect(run(cwd, [
      "delivery", "prepare", "--slug", slug, "--issue", "#20", "--branch", "main", "--head", head,
    ]).exitCode).toBe(0);
    expect(run(cwd, ["delivery", "pr", "--slug", slug, "--number", "#21", "--head", head]).exitCode).toBe(0);
    expect(run(cwd, [
      "delivery", "ci", "--slug", slug, "--status", "passed", "--head", head, "--run", "run-3",
    ]).exitCode).toBe(0);
    expect(run(cwd, [
      "delivery", "approve-merge", "--slug", slug, "--head", head, "--reason", "user requested merge",
    ]).exitCode).toBe(0);

    writeFileSync(join(cwd, "product.txt"), "new head\n");
    git(cwd, ["add", "product.txt"]);
    expect(git(cwd, ["commit", "-m", "new head"]).exitCode).toBe(0);
    const rejected = run(cwd, ["delivery", "check-merge", "--slug", slug, "--head", head]);
    expect(rejected.exitCode).toBe(4);
    expect(rejected.stderr).toContain("Git HEAD");
  });
});
