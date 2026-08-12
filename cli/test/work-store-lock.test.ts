import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

function run(cwd: string, args: readonly string[]) {
  return Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

describe("work repository lock", () => {
  test("parallel plan updates preserve state and journal entries", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-work-lock-"));
    expect(run(cwd, [
      "plan", "init", "--slug", "parallel-work", "--brief", "parallel state",
      "--require", "preserve updates", "--forbid", "automatic commit",
    ]).exitCode).toBe(0);

    const count = 24;
    const children = Array.from({ length: count }, (_, index) => Bun.spawn([
      "bun", CLI, "plan", "add", "--slug", "parallel-work",
      "--desc", `check ${index + 1}`, "--cmd", "true", "--expect", "exit 0",
    ], { cwd, stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (child) => ({
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })));
    expect(results, results.filter((result) => result.exitCode !== 0).map((result) => result.stderr).join("\n"))
      .toEqual(Array.from({ length: count }, () => ({ exitCode: 0, stderr: "" })));

    const root = join(cwd, ".gdm", "parallel-work");
    const state = JSON.parse(readFileSync(join(root, "checks.json"), "utf8")) as { checks: unknown[] };
    const events = readFileSync(join(root, "journal.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { event: string });
    expect(state.checks).toHaveLength(count);
    expect(events.filter((event) => event.event === "plan.add")).toHaveLength(count);
  });

  test("dead owner lock is reclaimed but a symlink is rejected", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-work-lock-dead-"));
    expect(run(cwd, [
      "plan", "init", "--slug", "recovery-work", "--brief", "lock recovery",
      "--require", "preserve state", "--forbid", "automatic commit",
    ]).exitCode).toBe(0);
    const lock = join(cwd, ".gdm.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999 }) + "\n");
    expect(run(cwd, [
      "plan", "add", "--slug", "recovery-work", "--desc", "after crash",
      "--cmd", "true", "--expect", "exit 0",
    ]).exitCode).toBe(0);

    appendFileSync(join(cwd, "target"), "x");
    Bun.spawnSync(["ln", "-s", join(cwd, "target"), lock]);
    const rejected = run(cwd, [
      "plan", "add", "--slug", "recovery-work", "--desc", "unsafe lock",
      "--cmd", "true", "--expect", "exit 0",
    ]);
    expect(rejected.exitCode).not.toBe(0);
    expect(decoder.decode(rejected.stderr)).toContain("잠금");
  });
});
