import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import { checksHash, validateWork } from "../src/state.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): CliResult {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: env === undefined ? undefined : { ...process.env, ...env },
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

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    expect(bare.stderr).toContain(`gdm ${packageJson.version} — 작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우`);
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

  test("done re-runs auto checks and blocks on code regression", () => {
    // Given: an auto check proven against a source file.
    const cwd = tempRepo();
    writeFileSync(join(cwd, "src.txt"), "GOOD\n");
    runCli(cwd, ["plan", "init", "--slug", "reg", "--brief", "회귀", "--require", "보존", "--forbid", "자동 커밋"]);
    runCli(cwd, ["plan", "add", "--slug", "reg", "--desc", "내용 검증", "--cmd", "grep -q GOOD src.txt", "--expect", "exit 0"]);
    expect(runCli(cwd, ["pass", "c1", "--slug", "reg"]).exitCode).toBe(0);

    // When: the source regresses after pass, then done is attempted.
    writeFileSync(join(cwd, "src.txt"), "BROKEN\n");
    const regressed = runCli(cwd, ["done", "--slug", "reg"]);

    // Then: done re-runs the cmd, catches the regression, reverts the check, and refuses to complete.
    expect(regressed.exitCode).not.toBe(0);
    const work = validateWork(
      JSON.parse(readFileSync(join(cwd, ".gdm", "reg", "checks.json"), "utf8")),
      "checks.json",
    );
    expect(work.done).toBe(false);
    expect(work.checks[0]?.status).toBe("open");

    // And: fixing the source lets pass + done succeed.
    writeFileSync(join(cwd, "src.txt"), "GOOD\n");
    expect(runCli(cwd, ["pass", "c1", "--slug", "reg"]).exitCode).toBe(0);
    expect(runCli(cwd, ["done", "--slug", "reg"]).exitCode).toBe(0);
  });

  test("verification commands use an opt-in bounded timeout", () => {
    // Given: a real check that needs longer than a deliberately tiny timeout.
    const cwd = tempRepo();
    runCli(cwd, [
      "plan",
      "init",
      "--slug",
      "timeout",
      "--brief",
      "장시간 검증",
      "--require",
      "정상 검증 완료",
      "--forbid",
      "무제한 실행",
    ]);
    runCli(cwd, [
      "plan",
      "add",
      "--slug",
      "timeout",
      "--desc",
      "느린 검증",
      "--cmd",
      "sleep 0.25; printf ok",
      "--expect",
      "ok 출력",
    ]);

    // When: invalid and too-short timeout values are used before the default execution path.
    const invalid = runCli(cwd, ["pass", "c1", "--slug", "timeout"], {
      GDM_COMMAND_TIMEOUT_MS: "unbounded",
    });
    const outOfRange = runCli(cwd, ["pass", "c1", "--slug", "timeout"], {
      GDM_COMMAND_TIMEOUT_MS: "3600001",
    });
    const timedOut = runCli(cwd, ["pass", "c1", "--slug", "timeout"], {
      GDM_COMMAND_TIMEOUT_MS: "100",
    });
    const passed = runCli(cwd, ["pass", "c1", "--slug", "timeout"]);

    // Then: malformed input is rejected, an explicit timeout fails closed, and no implicit wall-clock
    // cutoff mistakes laptop suspension or a long local build for a product failure.
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("GDM_COMMAND_TIMEOUT_MS는 밀리초 단위 정수여야 합니다");
    expect(outOfRange.exitCode).toBe(2);
    expect(outOfRange.stderr).toContain("GDM_COMMAND_TIMEOUT_MS는 100~3600000 범위여야 합니다");
    expect(timedOut.exitCode).toBe(1);
    expect(timedOut.stderr).toContain("ETIMEDOUT");
    expect(passed.exitCode).toBe(0);
    expect(passed.stdout).toContain("c1 통과");
  });

  test("audit pass survives done validation without changing audit-bound evidence", () => {
    // Given: an audited automatic check whose command records each execution outside its evidence file.
    const cwd = tempRepo();
    const slug = "audited";
    expect(
      runCli(cwd, [
        "plan",
        "init",
        "--slug",
        slug,
        "--brief",
        "검수 완료 무결성",
        "--audit",
        "--require",
        "증거 보존",
        "--forbid",
        "자동 커밋",
      ]).exitCode,
    ).toBe(0);
    expect(
      runCli(cwd, [
        "plan",
        "add",
        "--slug",
        slug,
        "--desc",
        "재실행 확인",
        "--cmd",
        "printf 'run\\n' >> executions.log",
        "--expect",
        "exit 0",
      ]).exitCode,
    ).toBe(0);
    expect(runCli(cwd, ["pass", "c1", "--slug", slug]).exitCode).toBe(0);
    const reportRelative = join(".gdm", slug, "audit-report.md");
    const report = join(cwd, reportRelative);
    writeFileSync(report, "**판정: 통과**\nimplementationModel: Codex\nauditModel: Claude\n");
    expect(runCli(cwd, [
      "audit", "verdict", "--pass", "--report", reportRelative,
      "--implementation-model", "Codex", "--audit-model", "Claude", "--slug", slug,
    ]).exitCode).toBe(0);

    const statePath = join(cwd, ".gdm", slug, "checks.json");
    const evidencePath = join(cwd, ".gdm", slug, "out", "c1.txt");
    const before = validateWork(JSON.parse(readFileSync(statePath, "utf8")), statePath);
    const auditBoundBefore = {
      checks: checksHash(before),
      evidence: JSON.stringify(before.checks[0]?.evidence),
      evidenceFile: fileHash(evidencePath),
      report: fileHash(report),
    };

    // When: done performs its mandatory automatic validation.
    const done = runCli(cwd, ["done", "--slug", slug]);

    // Then: the command ran twice, done succeeds, and every audit-bound byte/hash remains stable.
    expect(done.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "executions.log"), "utf8")).toBe("run\nrun\n");
    const after = validateWork(JSON.parse(readFileSync(statePath, "utf8")), statePath);
    expect(after.done).toBe(true);
    expect(after.audit?.stateHash).toBe(checksHash(after));
    expect({
      checks: checksHash(after),
      evidence: JSON.stringify(after.checks[0]?.evidence),
      evidenceFile: fileHash(evidencePath),
      report: fileHash(report),
    }).toEqual(auditBoundBefore);
    const status = JSON.parse(runCli(cwd, ["status", "--json"]).stdout) as Array<{ slug: string; audit: string }>;
    expect(status.find((item) => item.slug === slug)?.audit).toBe("검수: 통과");
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

  test("feedback records one safe event and exposes aggregate eval candidates", () => {
    // Given: a work that can own explicit user feedback.
    const cwd = tempRepo();
    expect(
      runCli(cwd, [
        "plan",
        "init",
        "--slug",
        "sample",
        "--brief",
        "피드백 테스트",
        "--require",
        "기존 변경 보존",
        "--forbid",
        "자동 커밋",
      ]).exitCode,
    ).toBe(0);

    // When: one positive and one reasoned negative rating are recorded, followed by rejected input.
    const good = runCli(cwd, ["feedback", "--value", "good", "--slug", "sample", "--json"]);
    const bad = runCli(cwd, [
      "feedback",
      "--value",
      "bad",
      "--reason",
      "  다음 행동이 모호함  ",
      "--source",
      "pi",
      "--slug",
      "sample",
      "--json",
    ]);
    const reasonlessBad = runCli(cwd, [
      "feedback", "--value", "bad", "--source", "pi", "--slug", "sample", "--json",
    ]);
    const unsafeReason = runCli(cwd, [
      "feedback", "--value", "bad", "--reason", "줄바꿈\n거부", "--slug", "sample",
    ]);
    const unsafeSource = runCli(cwd, [
      "feedback", "--value", "bad", "--source", "pi/session", "--slug", "sample",
    ]);
    const retro = runCli(cwd, ["retro", "--all", "--json"]);

    // Then: only the two valid commands append feedback, and only reasoned bad feedback is an eval candidate.
    expect(good.exitCode).toBe(0);
    expect(JSON.parse(good.stdout)).toEqual({ slug: "sample", value: "good", source: "manual" });
    expect(bad.exitCode).toBe(0);
    expect(JSON.parse(bad.stdout)).toEqual({
      slug: "sample",
      value: "bad",
      reason: "다음 행동이 모호함",
      source: "pi",
    });
    expect(reasonlessBad.exitCode).toBe(2);
    expect(reasonlessBad.stdout).toBe("");
    expect(reasonlessBad.stderr).toContain("--reason");
    expect(unsafeReason.exitCode).toBe(5);
    expect(unsafeReason.stderr).toContain("field=reason");
    expect(unsafeSource.exitCode).toBe(2);
    expect(unsafeSource.stderr).toContain("field=source opaque identifier");

    const events = readFileSync(join(cwd, ".gdm", "sample", "journal.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.event === "feedback")).toEqual([
      expect.objectContaining({ event: "feedback", value: "good", source: "manual" }),
      expect.objectContaining({
        event: "feedback",
        value: "bad",
        reason: "다음 행동이 모호함",
        source: "pi",
      }),
    ]);
    expect(JSON.parse(retro.stdout)).toMatchObject({
      misses: [],
      feedback: { good: 1, bad: 1, total: 2 },
      evalCandidates: [{ work: "sample", reason: "다음 행동이 모호함", source: "pi" }],
    });
  });

  test("feedback without a slug selects the most recently active work", () => {
    // Given: two active works created by separate CLI processes in activity order.
    const cwd = tempRepo();
    for (const slug of ["older", "newer"]) {
      expect(runCli(cwd, [
        "plan", "init", "--slug", slug, "--brief", `${slug} feedback target`,
        "--require", "기존 변경 보존", "--forbid", "자동 커밋",
      ]).exitCode).toBe(0);
    }

    // When: feedback is recorded without an explicit slug.
    const feedback = runCli(cwd, ["feedback", "--value", "good", "--json"]);

    // Then: the newest active work receives the single event.
    expect(feedback.exitCode).toBe(0);
    expect(JSON.parse(feedback.stdout)).toEqual({ slug: "newer", value: "good", source: "manual" });
    const olderJournal = readFileSync(join(cwd, ".gdm", "older", "journal.jsonl"), "utf8");
    const newerJournal = readFileSync(join(cwd, ".gdm", "newer", "journal.jsonl"), "utf8");
    expect(olderJournal).not.toContain('"event":"feedback"');
    expect(newerJournal.match(/"event":"feedback"/gu)).toHaveLength(1);
  });
});
