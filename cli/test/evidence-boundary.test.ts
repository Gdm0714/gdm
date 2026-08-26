import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(cwd: string, args: readonly string[]): CliResult {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
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

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function initializeWork(cwd: string, slug: string): void {
  expect(runCli(cwd, [
    "plan",
    "init",
    "--slug",
    slug,
    "--brief",
    "증거 파일 경계 검증",
    "--require",
    "저장소 밖 파일 보존",
    "--forbid",
    "심볼릭 링크 추적",
  ]).exitCode).toBe(0);
}

function addAutoCheck(cwd: string, slug: string): void {
  expect(runCli(cwd, [
    "plan",
    "add",
    "--slug",
    slug,
    "--desc",
    "자동 검증 성공",
    "--cmd",
    "printf verified",
    "--expect",
    "verified 출력",
  ]).exitCode).toBe(0);
}

function addManualCheck(cwd: string, slug: string): void {
  expect(runCli(cwd, [
    "plan",
    "add",
    "--slug",
    slug,
    "--desc",
    "수동 증거 확인",
    "--manual",
    "--expect",
    "증거 파일 확인",
  ]).exitCode).toBe(0);
}

function persistedWork(cwd: string, slug: string): Record<string, any> {
  return JSON.parse(readFileSync(join(cwd, ".gdm", slug, "checks.json"), "utf8")) as Record<string, any>;
}

describe("evidence filesystem boundary", () => {
  test("pass rejects a symlinked evidence output parent without changing outside bytes", () => {
    const cwd = tempDirectory("gdm-evidence-parent-");
    const slug = "linked-parent";
    initializeWork(cwd, slug);
    addAutoCheck(cwd, slug);

    const outside = tempDirectory("gdm-evidence-parent-outside-");
    const outsideEvidence = join(outside, "c1.txt");
    const original = "outside parent target remains unchanged\n";
    writeFileSync(outsideEvidence, original);
    const outPath = join(cwd, ".gdm", slug, "out");
    rmdirSync(outPath);
    symlinkSync(outside, outPath);

    const passed = runCli(cwd, ["pass", "c1", "--slug", slug]);

    expect(readFileSync(outsideEvidence, "utf8")).toBe(original);
    expect(lstatSync(outPath).isSymbolicLink()).toBe(true);
    expect(passed.exitCode).toBe(5);
    expect(passed.stderr).toContain("path_rejected");
    expect(persistedWork(cwd, slug).checks[0].status).toBe("open");
  });

  test("pass rejects a symlinked final evidence file without changing outside bytes", () => {
    const cwd = tempDirectory("gdm-evidence-final-");
    const slug = "linked-final";
    initializeWork(cwd, slug);
    addAutoCheck(cwd, slug);

    const outPath = join(cwd, ".gdm", slug, "out");
    const outside = join(tempDirectory("gdm-evidence-final-outside-"), "outside.txt");
    const original = "outside final target remains unchanged\n";
    writeFileSync(outside, original);
    const evidencePath = join(outPath, "c1.txt");
    symlinkSync(outside, evidencePath);

    const passed = runCli(cwd, ["pass", "c1", "--slug", slug]);

    expect(readFileSync(outside, "utf8")).toBe(original);
    expect(lstatSync(evidencePath).isSymbolicLink()).toBe(true);
    expect(passed.exitCode).toBe(5);
    expect(passed.stderr).toContain("path_rejected");
    expect(persistedWork(cwd, slug).checks[0].status).toBe("open");
  });

  test("done rejects manual evidence replaced by a symlink after pass", () => {
    const cwd = tempDirectory("gdm-evidence-done-");
    const slug = "manual-link";
    initializeWork(cwd, slug);
    addManualCheck(cwd, slug);

    const evidencePath = join(cwd, "manual-evidence.txt");
    const evidenceBody = "visually verified\n";
    writeFileSync(evidencePath, evidenceBody);
    expect(runCli(cwd, [
      "pass",
      "c1",
      "--slug",
      slug,
      "--manual",
      "--observed",
      "manual-evidence.txt",
    ]).exitCode).toBe(0);

    const outsideEvidence = join(tempDirectory("gdm-evidence-done-outside-"), "same-bytes.txt");
    writeFileSync(outsideEvidence, evidenceBody);
    unlinkSync(evidencePath);
    symlinkSync(outsideEvidence, evidencePath);

    const done = runCli(cwd, ["done", "--slug", slug]);

    expect(done.exitCode).not.toBe(0);
    expect(done.stderr).toMatch(/path_rejected|evidence_stale/u);
    expect(done.stdout).not.toContain(`작업 완료: ${slug}`);
    expect(lstatSync(evidencePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(outsideEvidence, "utf8")).toBe(evidenceBody);
    expect(persistedWork(cwd, slug).done).toBe(false);
  });

  test("normal automatic and manual evidence files remain accepted", () => {
    const cwd = tempDirectory("gdm-evidence-normal-");
    const slug = "normal-flow";
    initializeWork(cwd, slug);
    addAutoCheck(cwd, slug);
    addManualCheck(cwd, slug);
    writeFileSync(join(cwd, "manual-evidence.txt"), "visually verified\n");

    const automatic = runCli(cwd, ["pass", "c1", "--slug", slug]);
    const manual = runCli(cwd, [
      "pass",
      "c2",
      "--slug",
      slug,
      "--manual",
      "--observed",
      "manual-evidence.txt",
    ]);
    const done = runCli(cwd, ["done", "--slug", slug]);

    expect(automatic.exitCode).toBe(0);
    expect(manual.exitCode).toBe(0);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain(`작업 완료: ${slug} (2/2)`);
    expect(existsSync(join(cwd, ".gdm", slug, "out", "c1.txt"))).toBe(true);
    expect(lstatSync(join(cwd, ".gdm", slug, "out", "c1.txt")).isFile()).toBe(true);
    expect(persistedWork(cwd, slug).done).toBe(true);
  });
});
