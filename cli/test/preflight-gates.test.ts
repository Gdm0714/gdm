import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkKind, checksHash, validateWork } from "../src/state.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gdm-preflight-"));
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
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
}

function committedRepo(): string {
  const cwd = tempDir();
  git(cwd, ["init", "-q"]);
  writeFileSync(join(cwd, "sentinel.txt"), "baseline\n");
  git(cwd, ["add", "sentinel.txt"]);
  git(cwd, ["-c", "user.name=gdm", "-c", "user.email=gdm@example.invalid", "commit", "-qm", "baseline"]);
  return cwd;
}

describe("preflight gates", () => {
  test("legacy work receives safe defaults without changing its done policy", () => {
    const legacy = validateWork(
      {
        slug: "legacy",
        brief: "old state",
        createdAt: "2026-01-01T00:00:00.000Z",
        done: false,
        checks: [
          { id: "c1", desc: "old check", cmd: "true", expect: "ok", manual: false, status: "open" },
        ],
        contract: { required: [], forbidden: [], activeHabits: [], commit: "forbidden" },
      },
      "legacy.json",
    );

    expect(legacy.contract).toMatchObject({
      assumptions: [],
      uncertainties: [],
      allowedPaths: ["."],
      forbiddenPaths: [],
      stopConditions: [],
      risk: "low",
      verification: "deterministic",
      simplificationRequired: false,
    });
    expect(checkKind(legacy.checks[0]!)).toBe("behavior");
    expect(legacy.checks[0]!.kind).toBeUndefined();
    expect(legacy.baseline).toBeUndefined();
  });

  test("legacy audit hashes stay valid when default check classification is inferred", () => {
    const checks = [{
      id: "c1",
      desc: "legacy proof",
      cmd: "true",
      expect: "ok",
      manual: false,
      status: "proven" as const,
      evidence: {
        observed: "out.txt",
        sha256: "a".repeat(64),
        manual: false,
        at: "2026-01-01T00:00:00.000Z",
      },
    }];
    const legacyHash = createHash("sha256").update(JSON.stringify(checks)).digest("hex");
    const work = validateWork({
      slug: "legacy-audit",
      brief: "old audit",
      createdAt: "2026-01-01T00:00:00.000Z",
      done: false,
      auditRequired: true,
      audit: { result: "pass", report: "audit.md", stateHash: legacyHash, at: "2026-01-01T00:00:00.000Z" },
      checks,
      contract: { required: [], forbidden: [], activeHabits: [], commit: "forbidden" },
    }, "legacy-audit.json");

    expect(checksHash(work)).toBe(legacyHash);
    expect(checkKind(work.checks[0]!)).toBe("behavior");
  });

  test("plan init persists the preflight contract and a file-level baseline", () => {
    const cwd = committedRepo();
    const result = run(cwd, [
      "plan", "init", "--slug", "preflight", "--brief", "safe change",
      "--require", "기존 동작 보존", "--forbid", "자동 커밋",
      "--assume", "테스트 환경 사용", "--uncertain", "외부 응답 시간",
      "--allow-path", "cli/src", "--forbid-path", "cli/src/delivery.ts",
      "--stop-if", "스키마 불일치", "--risk", "high", "--verification", "opaque", "--simplify",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("high risk 정책");
    const work = JSON.parse(readFileSync(join(cwd, ".gdm", "preflight", "checks.json"), "utf8"));
    expect(work.auditRequired).toBe(true);
    expect(work.contract).toMatchObject({
      assumptions: ["테스트 환경 사용"],
      uncertainties: ["외부 응답 시간"],
      allowedPaths: ["cli/src"],
      forbiddenPaths: ["cli/src/delivery.ts"],
      stopConditions: ["스키마 불일치"],
      risk: "high",
      verification: "opaque",
      simplificationRequired: true,
    });
    expect(work.baseline.kind).toBe("git");
    expect(work.baseline.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "sentinel.txt" })]));
  });

  test("an unborn Git repository still gets a usable scope baseline", () => {
    const cwd = tempDir();
    git(cwd, ["init", "-q"]);
    writeFileSync(join(cwd, "first.txt"), "untracked\n");
    const result = run(cwd, [
      "plan", "init", "--slug", "unborn-scope", "--brief", "first change",
      "--require", "범위 기록", "--allow-path", "first.txt",
    ]);
    expect(result.exitCode).toBe(0);
    const work = JSON.parse(readFileSync(join(cwd, ".gdm", "unborn-scope", "checks.json"), "utf8"));
    expect(work.baseline.head).toBe("unborn");
    expect(work.baseline.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "first.txt" })]));
  });

  test("unsafe scope paths are rejected atomically with a recovery hint", () => {
    for (const path of ["../outside", "/tmp/outside", ".gdm/checks.json"]) {
      const cwd = committedRepo();
      const result = run(cwd, [
        "plan", "init", "--slug", "bad-path", "--brief", "bad path",
        "--require", "범위 보존", "--allow-path", path,
      ]);
      expect(result.exitCode).toBe(5);
      expect(result.stderr).toMatch(/상대 경로|상위 경로|내부 상태 경로/);
      expect(existsSync(join(cwd, ".gdm", "bad-path"))).toBe(false);
    }
  });
});
