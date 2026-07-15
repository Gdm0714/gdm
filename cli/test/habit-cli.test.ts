import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();
const PATTERN = "learning.minimal-rule-after-recurrence";
const STATEMENT = "같은 실패가 반복되면 재시도 규칙 하나만 추가한다";
const HABIT = "h-26e6439115bc8179";
const RULE_REF = "rules/repeated-failure.md";

type CliResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
type JsonObject = { readonly [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
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
  return mkdtempSync(join(tmpdir(), "gdm-habit-cli-test-"));
}

function ledgerPath(cwd: string): string {
  return join(cwd, ".gdm", "habits", "ledger.jsonl");
}

function ledgerEvents(cwd: string): readonly JsonObject[] {
  if (!existsSync(ledgerPath(cwd))) return [];
  return readFileSync(ledgerPath(cwd), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(isObject);
}

function writeRule(cwd: string, body = STATEMENT): string {
  mkdirSync(join(cwd, "rules"), { recursive: true });
  writeFileSync(join(cwd, RULE_REF), body);
  return body;
}

function writeObservations(cwd: string, name = "observations.jsonl"): string {
  const records = [
    {
      schemaVersion: 1,
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-principle",
      sourceGroup: "grp-principle",
      sourceKind: "principle",
    },
    {
      schemaVersion: 1,
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-incident",
      sourceGroup: "grp-incident",
      sourceKind: "incident",
    },
  ];
  writeFileSync(join(cwd, name), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return name;
}

function importAndPropose(cwd: string): void {
  const imported = runCli(cwd, ["habit", "import", "--file", writeObservations(cwd)]);
  if (imported.exitCode !== 0) throw new Error(imported.stderr);
  const sourceIds = ledgerEvents(cwd)
    .filter((event) => event.kind === "observation")
    .map((event) => event.eventId)
    .filter((value): value is string => typeof value === "string");
  const proposed = runCli(cwd, [
    "habit",
    "propose",
    "--pattern",
    PATTERN,
    "--statement",
    STATEMENT,
    ...sourceIds.flatMap((eventId) => ["--source-event", eventId]),
  ]);
  if (proposed.exitCode !== 0) throw new Error(proposed.stderr);
}

function initWork(cwd: string, slug: string): void {
  const result = runCli(cwd, [
    "plan",
    "init",
    "--slug",
    slug,
    "--brief",
    "습관 적용 검증",
    "--require",
    "채택 규칙 적용",
    "--forbid",
    "자동 커밋",
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

describe("habit CLI", () => {
  test("human adoption activates before work and counts one clean result", () => {
    // Given: independent normalized observations and a user-authored rule file.
    const cwd = tempRepo();
    const ruleBytes = writeRule(cwd);
    importAndPropose(cwd);

    // When: a human adoption is recorded, activated before proof, and evaluated after completion.
    expect(runCli(cwd, [
      "habit", "adopt", `${HABIT}@1`, "--rule-ref", RULE_REF, "--reason", "사용자 명시 승인",
    ]).exitCode).toBe(0);
    initWork(cwd, "clean-work");
    expect(runCli(cwd, [
      "plan", "contract", "--slug", "clean-work", "--activate-habit", `${HABIT}@1`,
    ]).exitCode).toBe(0);
    expect(runCli(cwd, [
      "plan", "add", "--slug", "clean-work", "--desc", "검증", "--cmd", "true", "--expect", "exit 0",
    ]).exitCode).toBe(0);
    expect(runCli(cwd, ["pass", "c1", "--slug", "clean-work"]).exitCode).toBe(0);
    expect(runCli(cwd, [
      "plan", "contract", "--slug", "clean-work", "--activate-habit", `${HABIT}@1`,
    ]).exitCode).toBe(0);
    expect(runCli(cwd, ["done", "--slug", "clean-work"]).exitCode).toBe(0);
    expect(runCli(cwd, [
      "habit", "evaluate", `${HABIT}@1`, "--work", "clean-work", "--outcome", "clean",
    ]).exitCode).toBe(0);
    const status = runCli(cwd, ["habit", "status", "--json"]);
    const parsed: unknown = JSON.parse(status.stdout);
    if (!isObject(parsed) || !Array.isArray(parsed.versions)) throw new Error("invalid habit status");
    const version = parsed.versions.find(isObject);
    if (version === undefined || !isObject(version.metrics)) throw new Error("missing version metrics");
    const work: unknown = JSON.parse(readFileSync(join(cwd, ".gdm", "clean-work", "checks.json"), "utf8"));
    if (!isObject(work) || !isObject(work.contract)) throw new Error("invalid work contract");

    // Then: the rule is untouched, activation persists, and only the completed clean work contributes.
    expect(status.exitCode).toBe(0);
    expect(readFileSync(join(cwd, RULE_REF), "utf8")).toBe(ruleBytes);
    expect(work.contract.activeHabits).toEqual([
      expect.objectContaining({ habitId: HABIT, version: 1, ruleRef: RULE_REF }),
    ]);
    expect(version).toMatchObject({ habitId: HABIT, version: 1, lifecycle: "adopted" });
    expect(version.metrics).toEqual({
      eligible: 1,
      applied: 1,
      recurred: 0,
      applicationRate: 1,
      recurrenceRate: 0,
      verdict: "insufficient",
    });
  });

  test("invalid import and retroactive activation are atomic", () => {
    // Given: a mixed import whose second record contains a forbidden unknown raw field.
    const cwd = tempRepo();
    const validFile = writeObservations(cwd);
    const validLines = readFileSync(join(cwd, validFile), "utf8").trim().split("\n");
    writeFileSync(
      join(cwd, "invalid.jsonl"),
      `${validLines[0]}\n${JSON.stringify({ ...JSON.parse(validLines[1] ?? "{}"), summary: "private source text" })}\n`,
    );

    // When: the invalid batch is refused, then a valid lifecycle reaches its first proven check.
    const invalid = runCli(cwd, ["habit", "import", "--file", "invalid.jsonl"]);
    expect(invalid.exitCode).toBe(5);
    expect(existsSync(ledgerPath(cwd))).toBe(false);
    writeRule(cwd);
    expect(runCli(cwd, ["habit", "import", "--file", validFile]).exitCode).toBe(0);
    const importedBytes = readFileSync(ledgerPath(cwd), "utf8");
    expect(runCli(cwd, [
      "habit", "adopt", `${HABIT}@1`, "--rule-ref", RULE_REF, "--reason", "사용자 명시 승인",
    ]).exitCode).toBe(3);
    expect(runCli(cwd, ["habit", "adopt", `${HABIT}@1`, "--rule-ref", RULE_REF]).exitCode).toBe(2);
    expect(runCli(cwd, [
      "habit", "adopt", `${HABIT}@1`, "--rule-ref", "rules/missing.md", "--reason", "사용자 명시 승인",
    ]).exitCode).toBe(5);
    const first: unknown = JSON.parse(validLines[0] ?? "{}");
    if (!isObject(first)) throw new Error("invalid observation fixture");
    writeFileSync(join(cwd, "collision.jsonl"), `${JSON.stringify({ ...first, taxonomy: "intent" })}\n`);
    expect(runCli(cwd, ["habit", "import", "--file", "collision.jsonl"]).exitCode).toBe(3);
    expect(readFileSync(ledgerPath(cwd), "utf8")).toBe(importedBytes);
    importAndPropose(cwd);
    mkdirSync(join(cwd, ".obsidian"), { recursive: true });
    writeFileSync(join(cwd, ".obsidian", "rule.md"), STATEMENT);
    const beforeObsidian = readFileSync(ledgerPath(cwd), "utf8");
    expect(runCli(cwd, [
      "habit", "adopt", `${HABIT}@1`, "--rule-ref", ".obsidian/rule.md", "--reason", "사용자 명시 승인",
    ]).exitCode).toBe(5);
    expect(readFileSync(ledgerPath(cwd), "utf8")).toBe(beforeObsidian);
    expect(runCli(cwd, [
      "habit", "adopt", `${HABIT}@1`, "--rule-ref", RULE_REF, "--reason", "사용자 명시 승인",
    ]).exitCode).toBe(0);
    expect(runCli(cwd, ["plan", "contract", "--activate-habit", `${HABIT}@1`]).exitCode).toBe(2);
    initWork(cwd, "late-work");
    expect(runCli(cwd, [
      "plan", "add", "--slug", "late-work", "--desc", "검증", "--cmd", "true", "--expect", "exit 0",
    ]).exitCode).toBe(0);
    expect(runCli(cwd, ["pass", "c1", "--slug", "late-work"]).exitCode).toBe(0);
    expect(runCli(cwd, [
      "plan", "edit", "--slug", "late-work", "--check", "c1", "--desc", "수정된 검증", "--reason", "기준 수정",
    ]).exitCode).toBe(0);
    const workPath = join(cwd, ".gdm", "late-work", "checks.json");
    const late = runCli(cwd, [
      "plan", "contract", "--slug", "late-work", "--activate-habit", `${HABIT}@1`,
    ]);
    expect(runCli(cwd, ["pass", "c1", "--slug", "late-work"]).exitCode).toBe(0);
    expect(runCli(cwd, ["done", "--slug", "late-work"]).exitCode).toBe(0);
    const workBefore = readFileSync(workPath, "utf8");
    const ledgerBefore = readFileSync(ledgerPath(cwd), "utf8");
    const mismatch = runCli(cwd, [
      "habit", "evaluate", `${HABIT}@1`, "--work", "late-work", "--outcome", "clean",
    ]);
    initWork(cwd, "changed-rule");
    const changedWorkPath = join(cwd, ".gdm", "changed-rule", "checks.json");
    const changedWorkBefore = readFileSync(changedWorkPath, "utf8");
    writeFileSync(join(cwd, RULE_REF), "채택 뒤 바뀐 규칙");
    const changedRule = runCli(cwd, [
      "plan", "contract", "--slug", "changed-rule", "--activate-habit", `${HABIT}@1`,
    ]);
    writeRule(cwd);
    initWork(cwd, "active-work");
    expect(runCli(cwd, [
      "plan", "contract", "--slug", "active-work", "--activate-habit", `${HABIT}@1`,
    ]).exitCode).toBe(0);
    expect(runCli(cwd, [
      "plan", "add", "--slug", "active-work", "--desc", "검증", "--cmd", "true", "--expect", "exit 0",
    ]).exitCode).toBe(0);
    expect(runCli(cwd, ["pass", "c1", "--slug", "active-work"]).exitCode).toBe(0);
    expect(runCli(cwd, ["done", "--slug", "active-work"]).exitCode).toBe(0);
    writeFileSync(join(cwd, RULE_REF), "활성화 뒤 바뀐 규칙");
    const changedAfterActivation = runCli(cwd, [
      "habit", "evaluate", `${HABIT}@1`, "--work", "active-work", "--outcome", "clean",
    ]);
    writeRule(cwd);
    const activeMismatch = runCli(cwd, [
      "habit", "evaluate", `${HABIT}@1`, "--work", "active-work", "--outcome", "skipped",
    ]);

    // Then: both policy failures use stable exits and leave work, ledger, and rejected bytes unchanged.
    expect(invalid.stderr).not.toContain("private source text");
    expect(late.exitCode).toBe(3);
    expect(mismatch.exitCode).toBe(3);
    expect(changedRule.exitCode).toBe(3);
    expect(changedAfterActivation.exitCode).toBe(3);
    expect(activeMismatch.exitCode).toBe(3);
    expect(readFileSync(workPath, "utf8")).toBe(workBefore);
    expect(readFileSync(changedWorkPath, "utf8")).toBe(changedWorkBefore);
    expect(readFileSync(ledgerPath(cwd), "utf8")).toBe(ledgerBefore);
  });

  test("privacy scanning covers duplicate inputs before state access", () => {
    // Given: an adopted habit, a completed but unevaluated active work, and a byte-stable ledger.
    const cwd = tempRepo();
    writeRule(cwd);
    importAndPropose(cwd);
    expect(runCli(cwd, [
      "habit", "adopt", `${HABIT}@1`, "--rule-ref", RULE_REF, "--reason", "사용자 명시 승인",
    ]).exitCode).toBe(0);
    initWork(cwd, "correction-work");
    expect(runCli(cwd, [
      "plan", "contract", "--slug", "correction-work", "--activate-habit", `${HABIT}@1`,
    ]).exitCode).toBe(0);
    expect(runCli(cwd, [
      "plan", "add", "--slug", "correction-work", "--desc", "검증", "--cmd", "true", "--expect", "exit 0",
    ]).exitCode).toBe(0);
    expect(runCli(cwd, ["pass", "c1", "--slug", "correction-work"]).exitCode).toBe(0);
    expect(runCli(cwd, ["done", "--slug", "correction-work"]).exitCode).toBe(0);
    const before = readFileSync(ledgerPath(cwd), "utf8");

    // When: hidden duplicate values, unknown secret flags, late-file secrets, and punctuation URIs enter commands.
    const duplicateFlag = runCli(cwd, [
      "habit", "observe", "--pattern", PATTERN, "--taxonomy", "recovery",
      "--source-token", "src-safe", "--source-token", "ghp_private",
      "--source-group", "grp-safe", "--source-kind", "incident",
    ]);
    const unknownFlag = runCli(cwd, ["habit", "status", "--ghp_private"]);
    const validRecord = {
      schemaVersion: 1,
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-late",
      sourceGroup: "grp-late",
      sourceKind: "incident",
    };
    writeFileSync(join(cwd, "late-secret.jsonl"), `${JSON.stringify({ ...validRecord, schemaVersion: 2 })}\n${JSON.stringify({ ...validRecord, sourceToken: "ghp_private" })}\n`);
    const lateSecret = runCli(cwd, ["habit", "import", "--file", "late-secret.jsonl"]);
    writeFileSync(
      join(cwd, "duplicate-key.jsonl"),
      `{"schemaVersion":1,"pattern":"${PATTERN}","taxonomy":"recovery","sourceToken":"ghp_private","sourceToken":"src-safe","sourceGroup":"grp-safe","sourceKind":"incident"}\n`,
    );
    const duplicateKey = runCli(cwd, ["habit", "import", "--file", "duplicate-key.jsonl"]);
    const uri = runCli(cwd, [
      "habit", "propose", "--pattern", PATTERN, "--statement", "메모,data:note",
      ...ledgerEvents(cwd).filter((event) => event.kind === "observation").slice(0, 2)
        .flatMap((event) => typeof event.eventId === "string" ? ["--source-event", event.eventId] : []),
    ]);
    const partialCorrection = runCli(cwd, [
      "habit", "evaluate", `${HABIT}@1`, "--work", "correction-work", "--outcome", "clean", "--reason", "판정 수정",
    ]);

    // Then: privacy failures are non-reflecting exit 5, grammar is exit 2, and no command mutates the ledger.
    for (const result of [duplicateFlag, unknownFlag, lateSecret, duplicateKey, uri]) {
      expect(result.exitCode).toBe(5);
      expect(`${result.stdout}${result.stderr}`).not.toContain("ghp_private");
    }
    expect(partialCorrection.exitCode).toBe(2);
    expect(readFileSync(ledgerPath(cwd), "utf8")).toBe(before);
  });

  test("stale ledger lock left by a crash is reclaimed", () => {
    // Given: a lock file older than the staleness window, as if a process died mid-write.
    const cwd = tempRepo();
    const habits = join(cwd, ".gdm", "habits");
    mkdirSync(habits, { recursive: true });
    const lock = join(habits, ".ledger.lock");
    writeFileSync(lock, "");
    const stale = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, stale, stale);

    // When: a habit write runs against the stale lock.
    const observed = runCli(cwd, [
      "habit", "observe", "--pattern", "verification.escape-after-done", "--taxonomy", "verification",
      "--source-token", "src-reclaim", "--source-group", "grp-reclaim", "--source-kind", "incident",
    ]);

    // Then: the write reclaims the lock and succeeds instead of failing as busy/corrupt.
    expect(observed.exitCode).toBe(0);
    expect(existsSync(ledgerPath(cwd))).toBe(true);
  });
});
