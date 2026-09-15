import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attemptFingerprint,
  parseChangeCategory,
  prepareFailure,
  prepareRetry,
  recordFailure,
  recordRetry,
} from "../src/attempt.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();
const FINGERPRINT = "fp-d91af59cecfc2b74";

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type JsonObject = { readonly [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runCli(cwd: string, args: readonly string[]): CliResult {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "gdm-attempt-test-"));
}

function initWork(cwd: string): void {
  const result = runCli(cwd, [
    "plan",
    "init",
    "--slug",
    "sample",
    "--brief",
    "재시도 테스트",
    "--require",
    "실패 원인 기록",
    "--forbid",
    "변화 없는 반복",
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

function failArgs(attemptId: string, hypothesis = "호스트 파일 확인"): readonly string[] {
  return [
    "attempt",
    "fail",
    "--slug",
    "sample",
    "--attempt-id",
    attemptId,
    "--command",
    "build.test",
    "--target",
    "cli",
    "--error-code",
    "ENOENT",
    "--hypothesis",
    hypothesis,
  ];
}

function retryArgs(attemptId: string): readonly string[] {
  return [
    "attempt",
    "retry",
    "--slug",
    "sample",
    "--attempt-id",
    attemptId,
    "--fingerprint",
    FINGERPRINT,
  ];
}

function journalPath(cwd: string): string {
  return join(cwd, ".gdm", "sample", "journal.jsonl");
}

function journalBytes(cwd: string): string {
  return readFileSync(journalPath(cwd), "utf8");
}

function attemptEvents(cwd: string): readonly JsonObject[] {
  return journalBytes(cwd)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((value): value is JsonObject => isJsonObject(value) && value.event === "attempt");
}

function evidence(cwd: string, name: string, content: string): string {
  const relative = join("evidence", name);
  mkdirSync(join(cwd, "evidence"), { recursive: true });
  writeFileSync(join(cwd, relative), content);
  return relative;
}

function lockFingerprint(cwd: string, prefix = "a"): void {
  expect(runCli(cwd, failArgs(`${prefix}1`)).exitCode).toBe(0);
  expect(runCli(cwd, retryArgs(`${prefix}2`)).exitCode).toBe(0);
  expect(runCli(cwd, failArgs(`${prefix}3`, "확인 뒤 같은 실패")).exitCode).toBe(0);
}

describe("attempt gate", () => {
  test("fingerprint uses the canonical normalized tuple", () => {
    // Given: a command, target, and exact error identifier.
    const input = { sourceId: "  build.test  ", target: " cli ", errorCode: "ENOENT" };

    // When: the stable attempt fingerprint is derived.
    const fingerprint = attemptFingerprint(input);

    // Then: trimming is deterministic and the fixed SHA-256 vector is preserved.
    expect(fingerprint).toBe(FINGERPRINT);
  });

  test("domain transitions require confirmation and changed evidence", () => {
    const cwd = tempRepo();
    const at = "2026-07-20T00:00:00.000Z";
    const firstInput = prepareFailure({
      attemptId: "direct1",
      sourceKind: "command",
      sourceId: "build.test",
      target: "cli",
      errorCode: "ENOENT",
      hypothesis: "host file missing",
    });
    const first = recordFailure([], firstInput, at);
    expect(first.event.decision).toBe("awaiting-confirmation");
    expect(recordFailure([first.event], firstInput, at).changed).toBe(false);

    const confirmationInput = prepareRetry({ attemptId: "direct2", fingerprint: firstInput.fingerprint });
    const confirmation = recordRetry(cwd, [first.event], confirmationInput, at);
    expect(confirmation.event.decision).toBe("confirmation-permitted");

    const secondInput = prepareFailure({ ...firstInput, attemptId: "direct3" });
    const second = recordFailure([first.event, confirmation.event], secondInput, at);
    expect(second.event.decision).toBe("locked");
    expect(() => recordRetry(cwd, [first.event, confirmation.event, second.event], prepareRetry({
      attemptId: "direct4",
      fingerprint: firstInput.fingerprint,
    }), at)).toThrow("unchanged_retry");

    const path = evidence(cwd, "direct-change.txt", "changed input\n");
    const changedInput = prepareRetry({
      attemptId: "direct5",
      fingerprint: firstInput.fingerprint,
      changed: "input",
      evidence: path,
    });
    const changed = recordRetry(cwd, [first.event, confirmation.event, second.event], changedInput, at);
    expect(changed.event.decision).toBe("changed-permitted");
    expect(changed.event.epoch).toBe(1);
    expect(changed.event.evidenceSha256).toHaveLength(64);
  });

  test("changed evidence opens a new retry epoch", () => {
    // Given: a constrained work and the first unique failure.
    const cwd = tempRepo();
    initWork(cwd);
    const first = runCli(cwd, failArgs("a1"));
    const afterFirst = journalBytes(cwd);
    const exactReplay = runCli(cwd, failArgs("a1"));
    const afterReplay = journalBytes(cwd);
    const conflict = runCli(cwd, failArgs("a1", "다른 가설"));
    const unpermitted = runCli(cwd, failArgs("a-unpermitted"));

    // When: one confirmation fails, then two distinct evidence hashes open later epochs.
    const confirmation = runCli(cwd, retryArgs("a2"));
    const locked = runCli(cwd, failArgs("a3", "확인 뒤 같은 실패"));
    const firstEvidence = evidence(cwd, "change-one.txt", "changed dependency\n");
    const epochOne = runCli(cwd, [
      ...retryArgs("a4"),
      "--changed",
      "dependency",
      "--evidence",
      firstEvidence,
    ]);
    const epochOneFail = runCli(cwd, failArgs("a5", "새 전제 뒤 실패"));
    const epochOneConfirmation = runCli(cwd, retryArgs("a6"));
    const epochOneLocked = runCli(cwd, failArgs("a7", "새 전제 확인 뒤 실패"));
    const secondEvidence = evidence(cwd, "change-two.txt", "changed environment\n");
    const epochTwo = runCli(cwd, [
      ...retryArgs("a8"),
      "--changed",
      "environment",
      "--evidence",
      secondEvidence,
    ]);
    const resumed = runCli(cwd, ["resume", "--slug", "sample"]);

    // Then: replay is idempotent, collisions fail, and the journal shows ordered epochs 0→2.
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(FINGERPRINT);
    expect(exactReplay.exitCode).toBe(0);
    expect(afterReplay).toBe(afterFirst);
    expect(conflict.exitCode).toBe(3);
    expect(unpermitted.exitCode).toBe(3);
    expect(confirmation.exitCode).toBe(0);
    expect(locked.exitCode).toBe(0);
    expect(epochOne.exitCode).toBe(0);
    expect(epochOneFail.exitCode).toBe(0);
    expect(epochOneConfirmation.exitCode).toBe(0);
    expect(epochOneLocked.exitCode).toBe(0);
    expect(epochTwo.exitCode).toBe(0);
    expect(attemptEvents(cwd).map((event) => [event.epoch, event.decision])).toEqual([
      [0, "awaiting-confirmation"],
      [0, "confirmation-permitted"],
      [0, "locked"],
      [1, "changed-permitted"],
      [1, "awaiting-confirmation"],
      [1, "confirmation-permitted"],
      [1, "locked"],
      [2, "changed-permitted"],
    ]);
    expect(resumed.stdout).toContain(`${FINGERPRINT} · epoch 2 · changed-permitted`);
    expect(resumed.stdout).toContain("새 전제 확인 뒤 실패");
  });

  test("partial unchanged reused and escaping retries use stable exits", () => {
    // Given: a locked fingerprint and one already-used evidence hash.
    const empty = tempRepo();
    const partialBeforeState = runCli(empty, [
      ...retryArgs("partial"),
      "--changed",
      "code",
    ]);
    const cwd = tempRepo();
    initWork(cwd);
    lockFingerprint(cwd);
    const lockedBytes = journalBytes(cwd);
    const unchanged = runCli(cwd, retryArgs("a4"));
    const afterUnchanged = journalBytes(cwd);
    const wrongFingerprint = runCli(
      cwd,
      retryArgs("wrong").map((value) => (value === FINGERPRINT ? "fp-0000000000000000" : value)),
    );
    const afterWrongFingerprint = journalBytes(cwd);
    const original = evidence(cwd, "original.txt", "same evidence\n");
    expect(
      runCli(cwd, [...retryArgs("a5"), "--changed", "code", "--evidence", original]).exitCode,
    ).toBe(0);
    expect(runCli(cwd, failArgs("a6", "변경 뒤 실패")).exitCode).toBe(0);
    expect(runCli(cwd, retryArgs("a7")).exitCode).toBe(0);
    expect(runCli(cwd, failArgs("a8", "변경 확인 뒤 실패")).exitCode).toBe(0);
    const copy = join("evidence", "copied.txt");
    copyFileSync(join(cwd, original), join(cwd, copy));
    const beforeStale = journalBytes(cwd);

    // When: reused content and unsafe path forms try to open another epoch.
    const stale = runCli(cwd, [...retryArgs("a9"), "--changed", "input", "--evidence", copy]);
    const outside = evidence(tempRepo(), "outside.txt", "outside\n");
    const outsideAbsolute = join(tmpdir(), outside);
    const linkedTarget = evidence(tempRepo(), "linked.txt", "linked\n");
    const link = join(cwd, "evidence", "link.txt");
    symlinkSync(join(tmpdir(), linkedTarget), link);
    const unsafePaths = [
      outsideAbsolute,
      "../escape.txt",
      "evidence/link.txt",
      "\\\\server\\share",
      "https://private.example/evidence",
      "evidence/ghp_private",
    ];
    const rejected = unsafePaths.map((path, index) => ({
      path,
      result: runCli(cwd, [
        ...retryArgs(`unsafe${index}`),
        "--changed",
        "permission",
        "--evidence",
        path,
      ]),
    }));

    // Then: schema is exit 2, transition conflicts 3, policy denials 4, and paths 5 without mutation.
    expect(partialBeforeState.exitCode).toBe(2);
    expect(existsSync(join(empty, ".gdm"))).toBe(false);
    expect(unchanged.exitCode).toBe(4);
    expect(afterUnchanged).toBe(lockedBytes);
    expect(wrongFingerprint.exitCode).toBe(3);
    expect(afterWrongFingerprint).toBe(lockedBytes);
    expect(stale.exitCode).toBe(4);
    expect(journalBytes(cwd)).toBe(beforeStale);
    for (const item of rejected) {
      expect(item.result.exitCode).toBe(5);
      expect(`${item.result.stdout}${item.result.stderr}`).not.toContain(item.path);
      expect(journalBytes(cwd)).toBe(beforeStale);
    }
  });

  test("all change categories and capability fingerprints are accepted", () => {
    // Given: every declared changed-precondition category.
    const categories = ["dependency", "input", "code", "environment", "permission"] as const;

    // When: each category opens a locked fingerprint with a unique contained file.
    const exits = categories.map((category) => {
      const cwd = tempRepo();
      initWork(cwd);
      lockFingerprint(cwd, category.slice(0, 2));
      const path = evidence(cwd, `${category}.txt`, `${category}\n`);
      return runCli(cwd, [
        ...retryArgs(`${category}-changed`),
        "--changed",
        parseChangeCategory(category),
        "--evidence",
        path,
      ]).exitCode;
    });
    const capabilityCwd = tempRepo();
    initWork(capabilityCwd);
    const capability = runCli(capabilityCwd, [
      "attempt",
      "fail",
      "--slug",
      "sample",
      "--attempt-id",
      "cap1",
      "--capability",
      "host.lookup",
      "--target",
      "binary",
      "--error-code",
      "MISSING",
      "--hypothesis",
      "실행 파일 누락",
    ]);
    const ambiguous = runCli(capabilityCwd, [
      ...failArgs("cap2"),
      "--capability",
      "host.lookup",
    ]);

    // Then: all enums pass and command versus capability remains exclusive.
    expect(exits).toEqual([0, 0, 0, 0, 0]);
    expect(capability.exitCode).toBe(0);
    expect(ambiguous.exitCode).toBe(2);
  }, 15_000); // This integration case starts 28 CLI processes, including coverage runs.

  test("secret-shaped attempt fields reject without reflection", () => {
    // Given: a valid work and secret-shaped identifiers or hypothesis.
    const cases = [
      { field: "attempt-id", value: "ghp_private", args: failArgs("ghp_private") },
      {
        field: "hypothesis",
        value: "Bearer private-token",
        args: failArgs("secret-hypothesis", "Bearer private-token"),
      },
      {
        field: "command",
        value: "sk-private",
        args: failArgs("secret-command").map((value) => (value === "build.test" ? "sk-private" : value)),
      },
    ];

    // When: each case reaches the privacy boundary.
    const results = cases.map((item) => {
      const cwd = tempRepo();
      initWork(cwd);
      const before = journalBytes(cwd);
      const result = runCli(cwd, item.args);
      return { ...item, before, after: journalBytes(cwd), result };
    });

    // Then: every result is exit 5, byte-atomic, and does not echo the rejected value.
    for (const item of results) {
      expect(item.result.exitCode).toBe(5);
      expect(item.after).toBe(item.before);
      expect(`${item.result.stdout}${item.result.stderr}`).not.toContain(item.value);
    }
  });
});
