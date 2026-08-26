import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationPlanFingerprint } from "../src/state.ts";
import { loadWork } from "../src/store.ts";
import { saveVerificationPlanSourceFingerprint } from "../src/work-source-fingerprint.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();
const OUTCOME = {
  bottleneck: "검증 피드백 지연",
  desiredOutcome: "회귀 검토 시간 단축",
  baseline: "주당 4건",
  target: "주당 1건",
  unit: "회귀 후보 수",
  interveneIf: "주당 3건 초과",
} as const;

function run(cwd: string, args: readonly string[]) {
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

function workFiles(cwd: string, slug: string): { readonly state: string; readonly journal: string } {
  const dir = join(cwd, ".gdm", slug);
  return {
    state: readFileSync(join(dir, "checks.json"), "utf8"),
    journal: readFileSync(join(dir, "journal.jsonl"), "utf8"),
  };
}

function initializedWork(): { readonly cwd: string; readonly slug: string; readonly fingerprint: string } {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-expected-plan-"));
  const slug = "expected-plan";
  expect(run(cwd, [
    "plan", "init", "--slug", slug, "--brief", "approved verification plan",
    "--require", "run approved checks", "--forbid", "stale approval",
  ]).exitCode).toBe(0);
  expect(run(cwd, [
    "plan", "add", "--slug", slug, "--desc", "record execution",
    "--cmd", "printf 'run\\n' >> executions.log", "--expect", "exit 0",
  ]).exitCode).toBe(0);
  return { cwd, slug, fingerprint: verificationPlanFingerprint(loadWork(cwd, slug)) };
}

describe("expected verification plan fingerprint", () => {
  test("a declared outcome invalidates an expected fingerprint captured before that intent", () => {
    const { cwd, slug, fingerprint } = initializedWork();
    const checksPath = join(cwd, ".gdm", slug, "checks.json");
    const raw = JSON.parse(readFileSync(checksPath, "utf8")) as Record<string, any>;
    raw.contract.outcome = OUTCOME;
    writeFileSync(checksPath, `${JSON.stringify(raw, null, 2)}\n`);

    const outcomeFingerprint = verificationPlanFingerprint(loadWork(cwd, slug));
    expect(outcomeFingerprint).not.toBe(fingerprint);
    const before = workFiles(cwd, slug);
    const stale = run(cwd, [
      "pass", "c1", "--slug", slug, "--expected-plan-fingerprint", fingerprint,
    ]);
    expect(stale.exitCode).toBe(4);
    expect(stale.stderr).toContain("plan_fingerprint_mismatch");
    expect(workFiles(cwd, slug)).toEqual(before);
    expect(existsSync(join(cwd, "executions.log"))).toBe(false);

    const current = run(cwd, [
      "pass", "c1", "--slug", slug, "--expected-plan-fingerprint", outcomeFingerprint,
    ]);
    expect(current.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "executions.log"), "utf8")).toBe("run\n");
  });

  test("pass, recheck, and done reject a stale plan before command or state mutation", () => {
    const { cwd, slug, fingerprint } = initializedWork();
    const stale = "f".repeat(64) === fingerprint ? "e".repeat(64) : "f".repeat(64);

    let before = workFiles(cwd, slug);
    const rejectedPass = run(cwd, [
      "pass", "c1", "--slug", slug, "--expected-plan-fingerprint", stale,
    ]);
    expect(rejectedPass.exitCode).toBe(4);
    expect(rejectedPass.stderr).toContain("plan_fingerprint_mismatch");
    expect(workFiles(cwd, slug)).toEqual(before);
    expect(existsSync(join(cwd, "executions.log"))).toBe(false);

    const acceptedPass = run(cwd, [
      "pass", "c1", "--slug", slug, "--expected-plan-fingerprint", fingerprint,
    ]);
    expect(acceptedPass.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "executions.log"), "utf8")).toBe("run\n");
    expect(verificationPlanFingerprint(loadWork(cwd, slug))).toBe(fingerprint);

    before = workFiles(cwd, slug);
    const rejectedRecheck = run(cwd, [
      "recheck", "--slug", slug, "--expected-plan-fingerprint", stale,
    ]);
    expect(rejectedRecheck.exitCode).toBe(4);
    expect(workFiles(cwd, slug)).toEqual(before);
    expect(readFileSync(join(cwd, "executions.log"), "utf8")).toBe("run\n");

    expect(run(cwd, [
      "recheck", "--slug", slug, "--expected-plan-fingerprint", fingerprint,
    ]).exitCode).toBe(0);
    expect(readFileSync(join(cwd, "executions.log"), "utf8")).toBe("run\nrun\n");

    before = workFiles(cwd, slug);
    const rejectedDone = run(cwd, [
      "done", "--slug", slug, "--expected-plan-fingerprint", stale,
    ]);
    expect(rejectedDone.exitCode).toBe(4);
    expect(workFiles(cwd, slug)).toEqual(before);
    expect(readFileSync(join(cwd, "executions.log"), "utf8")).toBe("run\nrun\n");

    expect(run(cwd, [
      "done", "--slug", slug, "--expected-plan-fingerprint", fingerprint,
    ]).exitCode).toBe(0);
    expect(loadWork(cwd, slug).done).toBe(true);
    expect(readFileSync(join(cwd, "executions.log"), "utf8")).toBe("run\nrun\nrun\n");
  });

  test("malformed expected digests fail before mutation and old callers remain compatible", () => {
    const { cwd, slug } = initializedWork();
    const before = workFiles(cwd, slug);

    const malformed = run(cwd, [
      "pass", "c1", "--slug", slug, "--expected-plan-fingerprint", "ABC123",
    ]);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain("소문자 64자리 SHA-256");
    expect(workFiles(cwd, slug)).toEqual(before);
    expect(existsSync(join(cwd, "executions.log"))).toBe(false);

    expect(run(cwd, ["pass", "c1", "--slug", slug]).exitCode).toBe(0);
    expect(run(cwd, ["recheck", "--slug", slug]).exitCode).toBe(0);
    expect(run(cwd, ["done", "--slug", slug]).exitCode).toBe(0);
  });

  test("plan source stores one validated source digest without changing the plan identity", () => {
    const { cwd, slug, fingerprint } = initializedWork();
    const source = "a".repeat(64);
    const checksPath = join(cwd, ".gdm", slug, "checks.json");
    const workMarkdownPath = join(cwd, ".gdm", slug, "work.md");
    const legacy = JSON.parse(readFileSync(checksPath, "utf8")) as Record<string, any>;
    delete legacy.auditRequired;
    for (const field of [
      "assumptions", "uncertainties", "allowedPaths", "forbiddenPaths", "stopConditions",
      "risk", "verification", "simplificationRequired", "scopeAmendments",
    ]) delete legacy.contract[field];
    for (const check of legacy.checks as Record<string, unknown>[]) {
      delete check.kind;
      delete check.expert;
    }
    writeFileSync(checksPath, JSON.stringify(legacy, null, 2) + "\n");
    const before = loadWork(cwd, slug);
    const rawBefore = JSON.parse(readFileSync(checksPath, "utf8")) as Record<string, unknown>;
    const markdownBefore = readFileSync(workMarkdownPath, "utf8");

    const malformed = run(cwd, ["plan", "source", "--slug", slug, "--fingerprint", "not-a-digest"]);
    expect(malformed.exitCode).toBe(2);
    expect(loadWork(cwd, slug)).toEqual(before);

    const stored = run(cwd, ["plan", "source", "--slug", slug, "--fingerprint", source]);
    expect(stored.exitCode).toBe(0);
    const after = loadWork(cwd, slug);
    expect(after).toEqual({ ...before, verificationPlanSourceFingerprint: source });
    expect(JSON.parse(readFileSync(checksPath, "utf8"))).toEqual({
      ...rawBefore,
      verificationPlanSourceFingerprint: source,
    });
    expect(readFileSync(workMarkdownPath, "utf8")).toBe(markdownBefore);
    expect(verificationPlanFingerprint(after)).toBe(fingerprint);
  });

  test("plan source rejects work parent and checks symlinks without touching outside bytes", () => {
    const source = "b".repeat(64);

    const linkedFileCwd = mkdtempSync(join(tmpdir(), "gdm-source-link-file-"));
    const outsideFile = join(mkdtempSync(join(tmpdir(), "gdm-source-outside-")), "checks.json");
    const unchanged = "outside remains unchanged\n";
    writeFileSync(outsideFile, unchanged);
    mkdirSync(join(linkedFileCwd, ".gdm", "linked-file"), { recursive: true });
    symlinkSync(outsideFile, join(linkedFileCwd, ".gdm", "linked-file", "checks.json"));
    const fileResult = run(linkedFileCwd, [
      "plan", "source", "--slug", "linked-file", "--fingerprint", source,
    ]);
    expect(fileResult.exitCode).toBe(2);
    expect(fileResult.stderr).toContain("state_corrupt");
    expect(readFileSync(outsideFile, "utf8")).toBe(unchanged);

    const linkedParentCwd = mkdtempSync(join(tmpdir(), "gdm-source-link-parent-"));
    const outsideDirectory = mkdtempSync(join(tmpdir(), "gdm-source-outside-dir-"));
    writeFileSync(join(outsideDirectory, "checks.json"), unchanged);
    mkdirSync(join(linkedParentCwd, ".gdm"));
    symlinkSync(outsideDirectory, join(linkedParentCwd, ".gdm", "linked-parent"));
    const parentResult = run(linkedParentCwd, [
      "plan", "source", "--slug", "linked-parent", "--fingerprint", source,
    ]);
    expect(parentResult.exitCode).toBe(2);
    expect(parentResult.stderr).toContain("state_corrupt");
    expect(readFileSync(join(outsideDirectory, "checks.json"), "utf8")).toBe(unchanged);
  });

  test("plan source preserves state mode, leaves no temp, and refuses completed Work", () => {
    const { cwd, slug, fingerprint } = initializedWork();
    const checksPath = join(cwd, ".gdm", slug, "checks.json");
    chmodSync(checksPath, 0o640);
    expect(run(cwd, [
      "plan", "source", "--slug", slug, "--fingerprint", "c".repeat(64),
    ]).exitCode).toBe(0);
    expect(lstatSync(checksPath).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(cwd, ".gdm", slug)).some((name) => name.includes(".tmp."))).toBe(false);

    expect(run(cwd, [
      "pass", "c1", "--slug", slug, "--expected-plan-fingerprint", fingerprint,
    ]).exitCode).toBe(0);
    expect(run(cwd, [
      "done", "--slug", slug, "--expected-plan-fingerprint", fingerprint,
    ]).exitCode).toBe(0);
    const before = readFileSync(checksPath);
    const refused = run(cwd, [
      "plan", "source", "--slug", slug, "--fingerprint", "d".repeat(64),
    ]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("work_done");
    expect(readFileSync(checksPath)).toEqual(before);
  });

  test("oversized sparse checks state fails before allocation or replacement", () => {
    const { cwd, slug } = initializedWork();
    const checksPath = join(cwd, ".gdm", slug, "checks.json");
    truncateSync(checksPath, 16 * 1024 * 1024 + 1);
    const before = lstatSync(checksPath);

    const result = run(cwd, [
      "plan", "source", "--slug", slug, "--fingerprint", "e".repeat(64),
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("state_corrupt");
    expect(lstatSync(checksPath).size).toBe(before.size);
    expect(readdirSync(join(cwd, ".gdm", slug)).some((name) => name.includes(".tmp."))).toBe(false);
  });

  test("narrow raw patch preserves legacy omissions and audit checksHash bytes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-source-legacy-audit-"));
    const slug = "legacy-audit-source";
    const directory = join(cwd, ".gdm", slug);
    mkdirSync(directory, { recursive: true });
    const checks = [{
      id: "c1",
      desc: "legacy proof",
      cmd: "true",
      expect: "exit 0",
      manual: false,
      status: "proven",
      evidence: {
        observed: "out.txt",
        sha256: "a".repeat(64),
        manual: false,
        at: "2026-08-12T00:00:00.000Z",
      },
    }];
    const stateHash = createHash("sha256").update(JSON.stringify(checks)).digest("hex");
    const raw = {
      slug,
      brief: "legacy audited work",
      createdAt: "2026-08-12T00:00:00.000Z",
      done: false,
      auditRequired: true,
      audit: {
        result: "pass",
        report: "audit.md",
        stateHash,
        at: "2026-08-12T00:00:00.000Z",
      },
      checks,
      contract: { required: [], forbidden: [], activeHabits: [], commit: "forbidden" },
    };
    const path = join(directory, "checks.json");
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

    saveVerificationPlanSourceFingerprint(cwd, slug, "f".repeat(64));

    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored).toEqual({ ...raw, verificationPlanSourceFingerprint: "f".repeat(64) });
    expect((stored.audit as { stateHash: string }).stateHash).toBe(stateHash);
    expect(Object.keys(stored.contract as object).sort()).toEqual([
      "activeHabits", "commit", "forbidden", "required",
    ]);
    expect(loadWork(cwd, slug).audit?.stateHash).toBe(stateHash);
  });
});
