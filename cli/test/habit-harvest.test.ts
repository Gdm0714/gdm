import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import {
  createAdoption,
  createEvaluation,
  createObservation,
  createProposal,
  type HabitEvent,
  type HabitMutation,
} from "../src/habit.ts";
import { appendHabitEvents, readHabitLedger } from "../src/habit-store.ts";
import { addCheck, closeWork, initWork, passCheck } from "../src/state.ts";
import type { ActiveHabit, Work } from "../src/types.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const decoder = new TextDecoder();
const NOW = "2026-07-10T00:00:00.000Z";
const PATTERN = "learning.minimal-rule-after-recurrence";
const STATEMENT = "같은 실패가 반복되면 재시도 규칙 하나만 추가한다";
const HABIT = "h-26e6439115bc8179";
const RULE_HASH = "a".repeat(64);

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

function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error("expected JSON object");
  return value;
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "gdm-harvest-test-"));
}

function writeWork(cwd: string, slug: string, lines: readonly string[]): void {
  const dir = join(cwd, ".gdm", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "checks.json"), `${JSON.stringify({
    slug,
    brief: "수확 테스트",
    createdAt: NOW,
    done: false,
    checks: [],
    contract: { required: [], forbidden: [], activeHabits: [], commit: "forbidden" },
  }, null, 2)}\n`);
  writeFileSync(join(dir, "journal.jsonl"), `${lines.join("\n")}\n`);
}

function jsonLine(value: JsonObject): string {
  return JSON.stringify(value);
}

function apply(events: readonly HabitEvent[], mutation: HabitMutation, additions: HabitEvent[]): readonly HabitEvent[] {
  if (!mutation.changed) return events;
  additions.push(mutation.event);
  return [...events, mutation.event];
}

function completedWork(slug: string): Work {
  const active: ActiveHabit = {
    habitId: HABIT,
    version: 1,
    ruleRef: "rules/repeated-failure.md",
    ruleHash: RULE_HASH,
    activatedAt: NOW,
  };
  let work = initWork(slug, "습관 평가", NOW);
  work = { ...work, contract: { ...work.contract, activeHabits: [active] } };
  ({ work } = addCheck(work, { desc: "검증", cmd: "true", expect: "exit 0" }));
  work = passCheck(work, "c1", { observed: "out/c1.txt", sha256: "evidence", manual: false }, NOW);
  return closeWork(work, NOW);
}

function appendObservedMetrics(cwd: string): void {
  let events = readHabitLedger(cwd);
  const additions: HabitEvent[] = [];
  events = apply(events, createObservation(events, {
    pattern: PATTERN,
    taxonomy: "recovery",
    sourceToken: "src-principle",
    sourceGroup: "grp-principle",
    sourceKind: "principle",
  }, NOW), additions);
  events = apply(events, createObservation(events, {
    pattern: PATTERN,
    taxonomy: "recovery",
    sourceToken: "src-incident",
    sourceGroup: "grp-incident",
    sourceKind: "incident",
  }, NOW), additions);
  const sources = events.filter((event) => event.kind === "observation" && event.pattern === PATTERN).map((event) => event.eventId);
  events = apply(events, createProposal(events, { pattern: PATTERN, statement: STATEMENT, sourceEventIds: sources }, NOW), additions);
  events = apply(events, createAdoption(events, {
    habitId: HABIT,
    version: 1,
    ruleRef: "rules/repeated-failure.md",
    ruleHash: RULE_HASH,
    reason: "사용자 명시 승인",
  }, NOW), additions);
  for (const slug of ["metric-a", "metric-b", "metric-c"]) {
    events = apply(events, createEvaluation(events, completedWork(slug), {
      habitId: HABIT,
      version: 1,
      outcome: slug === "metric-a" ? "recurred" : "clean",
    }, NOW), additions);
  }
  const current = [...events].reverse().find((event) => event.kind === "evaluation" && event.workSlug === "metric-a");
  if (current?.kind !== "evaluation") throw new Error("missing evaluation");
  events = apply(events, createEvaluation(events, completedWork("metric-a"), {
    habitId: HABIT,
    version: 1,
    outcome: "clean",
    correct: current.eventId,
    reason: "판정 근거 수정",
  }, NOW), additions);
  appendHabitEvents(cwd, additions);
}

describe("habit harvest", () => {
  test("harvest is idempotent and metrics use only latest evaluations", () => {
    // Given: four recognized journal shapes plus unsafe and unrecognized physical lines across two works.
    const cwd = tempRepo();
    const rawMiss = "RAW_MISS_TEXT";
    const rawReason = "RAW_EDIT_REASON";
    const secret = "ghp_private_harvest";
    writeWork(cwd, "alpha-work", [
      jsonLine({ ts: NOW, event: "miss", desc: rawMiss }),
      jsonLine({ ts: NOW, event: "denied", code: "repeat-code" }),
      jsonLine({ ts: NOW, event: "denied", code: "repeat-code" }),
      jsonLine({ ts: NOW, event: "unknown" }),
      jsonLine({ ts: NOW, event: "unknown", extra: "x".repeat(2048) }),
      jsonLine({ ts: NOW, event: "unknown", extra: secret }),
    ]);
    writeWork(cwd, "beta-work", [
      jsonLine({ ts: NOW, event: "unknown" }),
      jsonLine({ ts: NOW, event: "denied", code: "repeat-code" }),
      jsonLine({ ts: NOW, event: "recheck", ok: false }),
      jsonLine({ ts: NOW, event: "plan.edit", reason: rawReason }),
    ]);

    // When: harvest runs twice and corrected evaluation history is added without unrelated denominators.
    const first = runCli(cwd, ["habit", "harvest", "--json"]);
    const firstLedger = readFileSync(join(cwd, ".gdm", "habits", "ledger.jsonl"), "utf8");
    const second = runCli(cwd, ["habit", "harvest", "--json"]);
    const secondLedger = readFileSync(join(cwd, ".gdm", "habits", "ledger.jsonl"), "utf8");
    appendObservedMetrics(cwd);
    const status = parseObject(runCli(cwd, ["habit", "status", "--json"]).stdout);
    const firstResult = parseObject(first.stdout);
    const secondResult = parseObject(second.stdout);
    const harvested = readHabitLedger(cwd).filter((event) => event.kind === "observation" && event.pattern !== PATTERN);

    // Then: identities use fixed physical positions, no raw-derived bytes survive, and only latest evaluations count.
    expect(first.exitCode).toBe(0);
    expect(firstResult).toMatchObject({ scanned: 10, mapped: 4, appended: 4, replayed: 0, skippedUnsafe: 2, skippedUnrecognized: 4 });
    expect(secondResult).toMatchObject({ scanned: 10, mapped: 4, appended: 0, replayed: 4, skippedUnsafe: 2, skippedUnrecognized: 4 });
    expect(secondLedger).toBe(firstLedger);
    expect(harvested).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceGroup: "grp-805987669e95f654", sourceToken: "src-ca7f212132b7c5d6", pattern: "verification.escape-after-done" }),
      expect.objectContaining({ sourceGroup: "grp-805987669e95f654", sourceToken: "src-8238c9c5e6815e75", pattern: "recovery.repeated-denial" }),
      expect.objectContaining({ sourceGroup: "grp-ed31fc973c128b4f", sourceToken: "src-2f1909e5df53c1fd", pattern: "verification.failed-recheck" }),
      expect.objectContaining({ sourceGroup: "grp-ed31fc973c128b4f", sourceToken: "src-e2cf0706ded141cc", pattern: "intent.criteria-revised" }),
    ]));
    const finalLedger = readFileSync(join(cwd, ".gdm", "habits", "ledger.jsonl"), "utf8");
    for (const raw of [rawMiss, rawReason, secret, createHash("sha256").update(rawMiss).digest("hex")]) {
      expect(finalLedger).not.toContain(raw);
    }
    if (!Array.isArray(status.versions)) throw new Error("missing versions");
    const version = status.versions.find((value) => isObject(value) && value.habitId === HABIT);
    if (!isObject(version) || !isObject(version.metrics)) throw new Error("missing metrics");
    expect(version.metrics).toEqual({ eligible: 3, applied: 3, recurred: 0, applicationRate: 1, recurrenceRate: 0, verdict: "observed" });
    expect(runCli(cwd, ["--version"]).stdout.trim()).toBe(packageJson.version);
    expect(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))).toMatchObject({ version: packageJson.version });
  });

  test("unsafe journal content is skipped without reflection", () => {
    // Given: a structurally recognized miss containing a secret in an irrelevant field and one safe miss.
    const cwd = tempRepo();
    const secret = "ghp_private_source";
    writeWork(cwd, "safe-work", [
      jsonLine({ ts: NOW, event: "miss", desc: "검증 누락", extra: secret }),
      jsonLine({ ts: NOW, event: "miss", desc: secret }),
      jsonLine({ ts: NOW, event: "miss", desc: "두 번째 누락" }),
    ]);

    // When: the privacy-first harvest runs twice.
    const first = runCli(cwd, ["habit", "harvest", "--json"]);
    const second = runCli(cwd, ["habit", "harvest", "--json"]);
    const ledger = readFileSync(join(cwd, ".gdm", "habits", "ledger.jsonl"), "utf8");

    // Then: only a count represents the unsafe line and no source bytes or raw hash are reflected.
    expect(first.exitCode).toBe(0);
    expect(parseObject(first.stdout)).toMatchObject({ scanned: 3, mapped: 1, appended: 1, skippedUnsafe: 2 });
    expect(parseObject(second.stdout)).toMatchObject({ scanned: 3, mapped: 1, appended: 0, replayed: 1, skippedUnsafe: 2 });
    for (const output of [first.stdout, first.stderr, second.stdout, second.stderr, ledger]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(createHash("sha256").update(secret).digest("hex"));
    }
  });

  test("corrupt journal fails closed before habit ledger mutation", () => {
    const cwd = tempRepo();
    writeWork(cwd, "corrupt-work", [
      jsonLine({ ts: NOW, event: "miss", desc: "반영되면 안 됨" }),
      "{malformed",
    ]);

    const result = runCli(cwd, ["habit", "harvest", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("오류(state_corrupt)");
    expect(existsSync(join(cwd, ".gdm", "habits", "ledger.jsonl"))).toBe(false);
  });

  test("harvest maps message-bearing events yet still skips foreign secrets", () => {
    // Given: production-shaped journal lines whose gdm-owned message/patch fields carry
    // newlines and symbols, plus a line with a secret in an unrelated field.
    const cwd = tempRepo();
    const rechkMsg = "검증 명령이 실패했습니다 (exit 1). 출력: .gdm/w/out/c1.txt\n$ grep -q OK a.txt\n(exit 1)";
    const denyMsg = "검증 명령이 실패했습니다 (exit 1). 출력: .gdm/w/out/c2.txt\ntail=broken";
    const secret = "ghp_leak_harvest";
    writeWork(cwd, "prod-work", [
      jsonLine({ ts: NOW, event: "recheck", check: "c1", ok: false, message: rechkMsg }),
      jsonLine({ ts: NOW, event: "denied", action: "pass", code: "cmd_failed", message: denyMsg, check: "c2" }),
      jsonLine({ ts: NOW, event: "denied", action: "pass", code: "cmd_failed", message: denyMsg, check: "c2" }),
      jsonLine({ ts: NOW, event: "plan.edit", check: "c1", patch: { cmd: "grep -q OK a=b" }, reason: "기준 조정" }),
      jsonLine({ ts: NOW, event: "miss", desc: "권한검사 누락", extra: secret }),
      jsonLine({ ts: NOW, event: "miss", desc: "문서 갱신 누락" }),
    ]);

    // When: harvest runs over the journal.
    const result = parseObject(runCli(cwd, ["habit", "harvest", "--json"]).stdout);
    const ledger = readFileSync(join(cwd, ".gdm", "habits", "ledger.jsonl"), "utf8");
    const patterns = readHabitLedger(cwd)
      .filter((event) => event.kind === "observation")
      .map((event) => (event.kind === "observation" ? event.pattern : ""));

    // Then: recheck-failed, the repeated denial, the reverted edit, and the safe miss are all
    // mapped (previously the message/patch newlines got the whole lines skipped as unsafe),
    // while the foreign secret's line is skipped and the secret never reaches the ledger.
    expect(result).toMatchObject({ scanned: 6, mapped: 4, appended: 4, skippedUnsafe: 1, skippedUnrecognized: 1 });
    expect(patterns).toEqual(expect.arrayContaining([
      "verification.failed-recheck",
      "recovery.repeated-denial",
      "intent.criteria-revised",
      "verification.escape-after-done",
    ]));
    expect(ledger).not.toContain(secret);
  });

  test("harvest separates misses by --type into distinct patterns", () => {
    // Given: two misses of different types plus one untyped miss in one work.
    const cwd = tempRepo();
    writeWork(cwd, "typed-work", [
      jsonLine({ ts: NOW, event: "miss", desc: "문서 누락", type: "docs" }),
      jsonLine({ ts: NOW, event: "miss", desc: "권한검사 누락", type: "security" }),
      jsonLine({ ts: NOW, event: "miss", desc: "타입 없는 누락" }),
    ]);

    // When: harvest maps them.
    runCli(cwd, ["habit", "harvest", "--json"]);
    const patterns = readHabitLedger(cwd)
      .filter((event) => event.kind === "observation")
      .map((event) => (event.kind === "observation" ? event.pattern : ""));

    // Then: distinct types get distinct patterns (no false "repeat" merge), untyped keeps the base.
    expect(new Set(patterns).size).toBe(3);
    expect(patterns).toContain("verification.escape-after-done");
    expect(patterns.filter((pattern) => pattern.startsWith("verification.escape-after-done-")).length).toBe(2);
  });

  test("evaluation rejects a work completed before the habit was adopted", () => {
    // Given: a ledger whose habit is adopted at NOW.
    let events: readonly HabitEvent[] = [];
    const additions: HabitEvent[] = [];
    events = apply(events, createObservation(events, {
      pattern: PATTERN, taxonomy: "recovery", sourceToken: "src-principle", sourceGroup: "grp-principle", sourceKind: "principle",
    }, NOW), additions);
    events = apply(events, createObservation(events, {
      pattern: PATTERN, taxonomy: "recovery", sourceToken: "src-incident", sourceGroup: "grp-incident", sourceKind: "incident",
    }, NOW), additions);
    const sources = events.filter((event) => event.kind === "observation").map((event) => event.eventId);
    events = apply(events, createProposal(events, { pattern: PATTERN, statement: STATEMENT, sourceEventIds: sources }, NOW), additions);
    events = apply(events, createAdoption(events, {
      habitId: HABIT, version: 1, ruleRef: "rules/repeated-failure.md", ruleHash: RULE_HASH, reason: "사용자 명시 승인",
    }, NOW), additions);

    // And: a work completed before that adoption.
    const earlier = "2026-07-01T00:00:00.000Z";
    let work = initWork("old-work", "예전 작업", earlier);
    ({ work } = addCheck(work, { desc: "검증", cmd: "true", expect: "exit 0" }));
    work = passCheck(work, "c1", { observed: "out/c1.txt", sha256: "e", manual: false }, earlier);
    work = closeWork(work, earlier);

    // Then: counting it as skipped is rejected (it predates the habit); ineligible is allowed.
    expect(() => createEvaluation(events, work, { habitId: HABIT, version: 1, outcome: "skipped" }, NOW)).toThrow();
    expect(createEvaluation(events, work, { habitId: HABIT, version: 1, outcome: "ineligible" }, NOW).changed).toBe(true);
  });

  test("aggregate retro keeps legacy fields and adds habit next action", () => {
    // Given: one ordinary work journal and one currently adopted habit version.
    const cwd = tempRepo();
    writeWork(cwd, "retro-work", [jsonLine({ ts: NOW, event: "miss", desc: "검증 누락" })]);
    appendObservedMetrics(cwd);

    // When: the aggregate retro is requested as JSON.
    const result = runCli(cwd, ["retro", "--all", "--json"]);
    const report = parseObject(result.stdout);

    // Then: every legacy field remains and additive habit counts point to status.
    expect(result.exitCode).toBe(0);
    for (const key of ["works", "done", "events", "denied", "misses", "editCount", "recheckFails", "suggestions"]) {
      expect(Object.hasOwn(report, key)).toBe(true);
    }
    expect(report).toMatchObject({ habitCandidates: 0, habitAdopted: 1, habitNext: "gdm habit status" });
  });
});
