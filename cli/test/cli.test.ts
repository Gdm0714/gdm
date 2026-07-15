import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWork } from "../src/state.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(cwd: string, args: readonly string[]): CliResult {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "gdm-cli-test-"));
}

describe("CLI regression", () => {
  test("bare and help show the current usage", () => {
    // Given: an empty temporary repository.
    const cwd = tempRepo();

    // When: the CLI is invoked through both help entry points.
    const bare = runCli(cwd, []);
    const help = runCli(cwd, ["--help"]);

    // Then: both are read-only successful usage responses.
    expect(bare.exitCode).toBe(0);
    expect(help.exitCode).toBe(0);
    expect(bare.stderr).toContain("gdm 0.8.0 — 작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우");
    expect(help.stderr).toBe(bare.stderr);
    expect(existsSync(join(cwd, ".gdm"))).toBe(false);
  });

  test("unknown command exits 2", () => {
    // Given: an empty temporary repository.
    const cwd = tempRepo();

    // When: an unsupported command is invoked.
    const result = runCli(cwd, ["unknown-command"]);

    // Then: usage is printed and no state is created.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("사용법:");
    expect(existsSync(join(cwd, ".gdm"))).toBe(false);
  });

  test("plan pass done", () => {
    // Given: a one-check work created through the real CLI.
    const cwd = tempRepo();
    expect(
      runCli(cwd, [
        "plan",
        "init",
        "--slug",
        "sample",
        "--brief",
        "회귀 테스트",
        "--require",
        "기존 변경 보존",
        "--forbid",
        "자동 커밋",
      ]).exitCode,
    ).toBe(0);
    expect(
      runCli(cwd, [
        "plan",
        "add",
        "--slug",
        "sample",
        "--desc",
        "명령 성공",
        "--cmd",
        "printf ok",
        "--expect",
        "ok 출력",
      ]).exitCode,
    ).toBe(0);

    // When: the check is passed and the work is closed.
    const passed = runCli(cwd, ["pass", "c1", "--slug", "sample"]);
    const done = runCli(cwd, ["done", "--slug", "sample"]);

    // Then: the persisted work is complete with CLI-produced evidence.
    expect(passed.exitCode).toBe(0);
    expect(passed.stdout).toContain("c1 통과 (1/1)");
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("작업 완료: sample (1/1)");
    const work = validateWork(
      JSON.parse(readFileSync(join(cwd, ".gdm", "sample", "checks.json"), "utf8")),
      "checks.json",
    );
    expect(work.done).toBe(true);
    expect(work.checks[0]?.evidence?.exitCode).toBe(0);
  });

  test("manual evidence rejects paths outside the working tree", () => {
    // Given: a work with one manual check and an in-tree evidence file.
    const cwd = tempRepo();
    runCli(cwd, ["plan", "init", "--slug", "shot", "--brief", "수동 증거", "--require", "보존", "--forbid", "자동 커밋"]);
    runCli(cwd, ["plan", "add", "--slug", "shot", "--desc", "화면 확인", "--manual", "--expect", "정상 렌더"]);
    writeFileSync(join(cwd, "evidence.txt"), "rendered\n");

    // When: manual evidence is submitted with an absolute path, a traversal path, and a contained path.
    const absolute = runCli(cwd, ["pass", "c1", "--slug", "shot", "--manual", "--observed", "/etc/hosts"]);
    const traversal = runCli(cwd, ["pass", "c1", "--slug", "shot", "--manual", "--observed", "../../../../etc/hosts"]);
    const contained = runCli(cwd, ["pass", "c1", "--slug", "shot", "--manual", "--observed", "evidence.txt"]);

    // Then: only the in-tree file proves the check; escapes are rejected as path violations.
    expect(absolute.exitCode).toBe(5);
    expect(traversal.exitCode).toBe(5);
    expect(contained.exitCode).toBe(0);
    expect(contained.stdout).toContain("c1 통과");
  });

  test("miss is visible in retro json", () => {
    // Given: an open work with one recorded check.
    const cwd = tempRepo();
    expect(
      runCli(cwd, [
        "plan",
        "init",
        "--slug",
        "sample",
        "--brief",
        "회고 테스트",
        "--require",
        "기존 변경 보존",
        "--forbid",
        "자동 커밋",
      ]).exitCode,
    ).toBe(0);
    expect(
      runCli(cwd, [
        "plan",
        "add",
        "--slug",
        "sample",
        "--desc",
        "기준",
        "--cmd",
        "true",
        "--expect",
        "exit 0",
      ]).exitCode,
    ).toBe(0);

    // When: a gate escape is recorded and the aggregate retro is requested.
    const missed = runCli(cwd, [
      "miss",
      "--slug",
      "sample",
      "--desc",
      "경계 조건 누락",
      "--type",
      "edge",
      "--check",
      "c1",
    ]);
    const retro = runCli(cwd, ["retro", "--all", "--json"]);

    // Then: the structured retro retains the incident and suggestion fields.
    expect(missed.exitCode).toBe(0);
    expect(retro.exitCode).toBe(0);
    const report: unknown = JSON.parse(retro.stdout);
    expect(report).toMatchObject({
      works: 1,
      misses: [{ work: "sample", type: "edge", check: "c1", desc: "경계 조건 누락" }],
      suggestions: [expect.stringContaining("edge")],
    });
  });
});
