import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersionMetrics,
  createAdoption,
  createEvaluation,
  createObservation,
  createProposal,
  createRetirement,
  habitMetrics,
  metricContribution,
  parseObservationRecord,
  reduceHabitEvents,
  type HabitEvent,
  type HabitMutation,
} from "../src/habit.ts";
import { appendHabitEvents, habitLedgerPath, readHabitLedger } from "../src/habit-store.ts";
import { addCheck, closeWork, initWork, passCheck } from "../src/state.ts";
import type { ActiveHabit, Work } from "../src/types.ts";

const NOW = "2026-07-10T00:00:00.000Z";
const LATER = "2026-07-10T01:00:00.000Z";
const PATTERN = "learning.minimal-rule-after-recurrence";
const STATEMENT = "같은 실패가 반복되면 재시도 규칙 하나만 추가한다";
const HABIT_ID = "h-26e6439115bc8179";
const RULE_HASH = "a".repeat(64);
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "gdm-habit-test-"));
}

function apply(events: readonly HabitEvent[], mutation: HabitMutation): readonly HabitEvent[] {
  return mutation.changed ? [...events, mutation.event] : events;
}

function completedWork(slug: string, active = false): Work {
  let work = initWork(slug, "습관 평가", NOW);
  if (active) {
    const activation: ActiveHabit = {
      habitId: HABIT_ID,
      version: 1,
      ruleRef: "rules/repeated-failure.md",
      ruleHash: RULE_HASH,
      activatedAt: NOW,
    };
    work = { ...work, contract: { ...work.contract, activeHabits: [activation] } };
  }
  ({ work } = addCheck(work, { desc: "검증", cmd: "true", expect: "exit 0" }));
  work = passCheck(
    work,
    "c1",
    { observed: "out/c1.txt", sha256: "evidence", manual: false },
    NOW,
  );
  return closeWork(work, NOW);
}

function baseEvents(): readonly HabitEvent[] {
  let events: readonly HabitEvent[] = [];
  events = apply(
    events,
    createObservation(
      events,
      {
        pattern: PATTERN,
        taxonomy: "recovery",
        sourceToken: "src-principle",
        sourceGroup: "grp-principle",
        sourceKind: "principle",
      },
      NOW,
    ),
  );
  events = apply(
    events,
    createObservation(
      events,
      {
        pattern: PATTERN,
        taxonomy: "recovery",
        sourceToken: "src-incident",
        sourceGroup: "grp-incident",
        sourceKind: "incident",
      },
      NOW,
    ),
  );
  const sourceEventIds = events.map((event) => event.eventId);
  events = apply(events, createProposal(events, { pattern: PATTERN, statement: STATEMENT, sourceEventIds }, NOW));
  events = apply(
    events,
    createAdoption(
      events,
      {
        habitId: HABIT_ID,
        version: 1,
        ruleRef: "rules/repeated-failure.md",
        ruleHash: RULE_HASH,
        reason: "사용자 명시 승인",
      },
      NOW,
    ),
  );
  return events;
}

describe("habit domain", () => {
  test("incident plus principle closes one versioned metric loop", () => {
    // Given: two independent observations including one real incident and an adopted proposal.
    let events = baseEvents();
    expect(events[2]).toMatchObject({ kind: "proposal", habitId: HABIT_ID, version: 1 });
    const evaluated: { readonly work: Work; readonly outcome: "ineligible" | "skipped" | "clean" | "recurred" }[] = [
      { work: completedWork("work-ineligible"), outcome: "ineligible" },
      { work: completedWork("work-skipped"), outcome: "skipped" },
      { work: completedWork("work-clean", true), outcome: "clean" },
      { work: completedWork("work-recurred", true), outcome: "recurred" },
    ];

    // When: all four outcomes are recorded, a third application is added, and recurrence is corrected.
    for (const item of evaluated) {
      events = apply(
        events,
        createEvaluation(
          events,
          item.work,
          { habitId: HABIT_ID, version: 1, outcome: item.outcome },
          NOW,
        ),
      );
    }
    expect(habitMetrics(events, HABIT_ID, 1)).toEqual({
      eligible: 3,
      applied: 2,
      recurred: 1,
      applicationRate: 2 / 3,
      recurrenceRate: 0.5,
      verdict: "insufficient",
    });
    events = apply(
      events,
      createEvaluation(
        events,
        completedWork("work-clean-two", true),
        { habitId: HABIT_ID, version: 1, outcome: "clean" },
        NOW,
      ),
    );
    const recurrence = reduceHabitEvents(events).latestEvaluations.get(`${HABIT_ID}@1@work-recurred`);
    if (recurrence === undefined) throw new Error("missing recurrence evaluation");
    const correction = createEvaluation(
      events,
      completedWork("work-recurred", true),
      {
        habitId: HABIT_ID,
        version: 1,
        outcome: "clean",
        correct: recurrence.eventId,
        reason: "판정 근거 수정",
      },
      LATER,
    );
    events = apply(events, correction);
    const correctionReplay = createEvaluation(
      events,
      completedWork("work-recurred", true),
      {
        habitId: HABIT_ID,
        version: 1,
        outcome: "clean",
        correct: recurrence.eventId,
        reason: "판정 근거 수정",
      },
      LATER,
    );

    // Then: correction supersedes rather than double-counts and observed metrics remain descriptive.
    expect(correctionReplay.changed).toBe(false);
    const current = habitMetrics(events, HABIT_ID, 1);
    expect(current).toEqual({
      eligible: 4,
      applied: 3,
      recurred: 0,
      applicationRate: 0.75,
      recurrenceRate: 0,
      verdict: "observed",
    });
    expect(metricContribution("ineligible")).toEqual({ eligible: 0, applied: 0, recurred: 0 });
    expect(metricContribution("skipped")).toEqual({ eligible: 1, applied: 0, recurred: 0 });
    expect(metricContribution("clean")).toEqual({ eligible: 1, applied: 1, recurred: 0 });
    expect(metricContribution("recurred")).toEqual({ eligible: 1, applied: 1, recurred: 1 });
    expect(compareVersionMetrics({ version: 1, ...current }, { version: 2, ...current })).toEqual({
      kind: "descriptive",
      priorVersion: 1,
      currentVersion: 2,
      applicationRateDelta: 0,
      recurrenceRateDelta: 0,
    });
    expect(
      compareVersionMetrics(
        { version: 1, ...current },
        { version: 2, ...current, applied: 2, verdict: "insufficient" },
      ),
    ).toEqual({ kind: "insufficient", priorVersion: 1, currentVersion: 2 });
  });

  test("lifecycle transitions are replay-safe and versioned after retirement", () => {
    // Given: observations that separately exercise same-group and no-incident proposal failures.
    let events: readonly HabitEvent[] = [];
    const observations = [
      { sourceToken: "src-a", sourceGroup: "grp-a", sourceKind: "principle" as const },
      { sourceToken: "src-b", sourceGroup: "grp-a", sourceKind: "incident" as const },
      { sourceToken: "src-c", sourceGroup: "grp-c", sourceKind: "principle" as const },
      { sourceToken: "src-d", sourceGroup: "grp-d", sourceKind: "incident" as const },
    ];
    for (const item of observations) {
      events = apply(
        events,
        createObservation(events, { pattern: PATTERN, taxonomy: "recovery", ...item }, NOW),
      );
    }
    const ids = events.map((event) => event.eventId);

    // When: invalid proposals are rejected and the valid version is adopted then retired.
    expect(() =>
      createProposal(events, { pattern: PATTERN, statement: STATEMENT, sourceEventIds: [ids[0] ?? ""] }, NOW),
    ).toThrow();
    expect(() =>
      createProposal(
        events,
        { pattern: PATTERN, statement: STATEMENT, sourceEventIds: [ids[0] ?? "", ids[1] ?? ""] },
        NOW,
      ),
    ).toThrow();
    expect(() =>
      createProposal(
        events,
        { pattern: PATTERN, statement: STATEMENT, sourceEventIds: [ids[0] ?? "", ids[2] ?? ""] },
        NOW,
      ),
    ).toThrow();
    const proposal = createProposal(
      events,
      { pattern: PATTERN, statement: STATEMENT, sourceEventIds: [ids[0] ?? "", ids[3] ?? ""] },
      NOW,
    );
    events = apply(events, proposal);
    expect(createProposal(events, { pattern: PATTERN, statement: STATEMENT, sourceEventIds: [ids[3] ?? "", ids[0] ?? ""] }, NOW).changed).toBe(false);
    const adoption = createAdoption(
      events,
      {
        habitId: HABIT_ID,
        version: 1,
        ruleRef: "rules/repeated-failure.md",
        ruleHash: RULE_HASH,
        reason: "사용자 명시 승인",
      },
      NOW,
    );
    events = apply(events, adoption);
    expect(createAdoption(events, {
      habitId: HABIT_ID,
      version: 1,
      ruleRef: "rules/repeated-failure.md",
      ruleHash: RULE_HASH,
      reason: "사용자 명시 승인",
    }, LATER).changed).toBe(false);
    expect(() => createAdoption(events, {
      habitId: HABIT_ID,
      version: 1,
      ruleRef: "rules/repeated-failure.md",
      ruleHash: RULE_HASH,
      reason: "다른 승인 사유",
    }, LATER)).toThrow();
    const retirement = createRetirement(
      events,
      { habitId: HABIT_ID, version: 1, reason: "새 규칙 실험" },
      LATER,
    );
    events = apply(events, retirement);
    expect(createRetirement(events, { habitId: HABIT_ID, version: 1, reason: "새 규칙 실험" }, LATER).changed).toBe(false);
    const next = createProposal(
      events,
      {
        pattern: PATTERN,
        statement: "같은 실패 뒤 확인 절차를 한 단계로 줄인다",
        sourceEventIds: [ids[0] ?? "", ids[3] ?? ""],
        habitId: HABIT_ID,
      },
      LATER,
    );

    // Then: the retired version stays terminal and the same lineage advances to version 2.
    expect(proposal.event).toMatchObject({ habitId: HABIT_ID, version: 1 });
    expect(adoption.event.kind).toBe("adoption");
    expect(retirement.event.kind).toBe("retirement");
    expect(next.event).toMatchObject({ habitId: HABIT_ID, version: 2, kind: "proposal" });
  });

  test("ledger round trip is atomic and corruption reports only a line number", () => {
    // Given: a valid four-event lifecycle batch.
    const cwd = tempRepo();
    const events = baseEvents();

    // When: the batch is appended, replayed, conflicted, and finally corrupted on a new line.
    const first = appendHabitEvents(cwd, events);
    const ledger = habitLedgerPath(cwd);
    const firstBytes = readFileSync(ledger, "utf8");
    const replay = appendHabitEvents(cwd, events);
    const replayBytes = readFileSync(ledger, "utf8");
    const firstObservation = events[0];
    if (firstObservation?.kind !== "observation") throw new Error("missing observation");
    const conflicting: HabitEvent = { ...firstObservation, taxonomy: "intent" };
    expect(() => appendHabitEvents(cwd, [conflicting])).toThrow();
    expect(readFileSync(ledger, "utf8")).toBe(firstBytes);
    writeFileSync(ledger, `${firstBytes}{private broken json\n`);
    let corruption = "";
    try {
      readHabitLedger(cwd);
    } catch (error) {
      corruption = error instanceof Error ? error.message : String(error);
    }

    // Then: only ledger.jsonl exists, replay changes no bytes, and corruption reflects no source bytes.
    expect(first.appended).toBe(events.length);
    expect(replay.appended).toBe(0);
    expect(replayBytes).toBe(firstBytes);
    expect(readdirSync(join(cwd, ".gdm", "habits"))).toEqual(["ledger.jsonl"]);
    expect(corruption).toContain(`line=${events.length + 1}`);
    expect(corruption).not.toContain("private broken json");
    for (const event of events) {
      expect(Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8")).toBeLessThan(2048);
    }
  });

  test("privacy v1 rejects without reflection or mutation", () => {
    // Given: every raw-source detector class plus oversized and unknown provider fields.
    const cwd = tempRepo();
    appendHabitEvents(cwd, baseEvents());
    const before = readFileSync(habitLedgerPath(cwd), "utf8");
    const unsafe = [
      "/Users/person/private",
      "C:\\private\\note",
      "\\\\server\\share",
      "file:/private/note",
      "ghp_private",
      "BEGIN PRIVATE KEY",
      "user: hidden prompt",
      "const hidden",
      "diff --git hidden",
      "first line\nsecond line",
      "a".repeat(2100),
    ];

    // When: unsafe values and an unknown raw field enter the provider parser.
    for (const value of unsafe) {
      let message = "";
      try {
        parseObservationRecord({
          schemaVersion: 1,
          pattern: PATTERN,
          taxonomy: "recovery",
          sourceToken: value,
          sourceGroup: "grp-safe",
          sourceKind: "incident",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("privacyPolicyVersion=1");
      expect(message).not.toContain(value);
      expect(readFileSync(habitLedgerPath(cwd), "utf8")).toBe(before);
    }
    let unknownMessage = "";
    try {
      parseObservationRecord({
        schemaVersion: 1,
        pattern: PATTERN,
        taxonomy: "recovery",
        sourceToken: "src-safe",
        sourceGroup: "grp-safe",
        sourceKind: "incident",
        summary: "private source text",
      });
    } catch (error) {
      unknownMessage = error instanceof Error ? error.message : String(error);
    }

    // Then: every failure is generic, unknown keys are refused, and the ledger remains byte-identical.
    expect(unknownMessage).toContain("privacyPolicyVersion=1");
    expect(unknownMessage).not.toContain("private source text");
    expect(readFileSync(habitLedgerPath(cwd), "utf8")).toBe(before);
  });

  test("ledger containment and validators reject hidden boundary escapes", () => {
    // Given: a symlinked habit directory, a nonexistent calendar date, and a punctuation-prefixed URI.
    const cwd = tempRepo();
    const outside = tempRepo();
    mkdirSync(join(cwd, ".gdm"), { recursive: true });
    symlinkSync(outside, join(cwd, ".gdm", "habits"));
    const observation = createObservation([], {
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-safe",
      sourceGroup: "grp-safe",
      sourceKind: "incident",
    }, NOW);
    const sources = baseEvents().slice(0, 2);

    // When: each value crosses its persistence boundary.
    const writeOutside = () => appendHabitEvents(cwd, [observation.event]);
    const invalidDate = () => createObservation([], {
      pattern: PATTERN,
      taxonomy: "recovery",
      sourceToken: "src-date",
      sourceGroup: "grp-date",
      sourceKind: "incident",
    }, "2026-02-31T00:00:00.000Z");
    const hiddenUri = () => createProposal(sources, {
      pattern: PATTERN,
      statement: "메모,data:note",
      sourceEventIds: sources.map((event) => event.eventId),
    }, NOW);

    // Then: no external ledger is created and both malformed values are rejected.
    expect(writeOutside).toThrow();
    expect(existsSync(join(outside, "ledger.jsonl"))).toBe(false);
    expect(invalidDate).toThrow();
    expect(hiddenUri).toThrow();
  });

  test("concurrent appends preserve every successful observation", async () => {
    // Given: independent observation commands targeting one previously absent ledger.
    const cwd = tempRepo();
    const count = 32;

    // When: all processes append concurrently.
    const processes = Array.from({ length: count }, (_, index) => Bun.spawn([
      "bun", CLI, "habit", "observe",
      "--pattern", "tooling.concurrent-observation",
      "--taxonomy", "tooling",
      "--source-token", `src-${index}`,
      "--source-group", `grp-${index}`,
      "--source-kind", "incident",
    ], { cwd, stdout: "ignore", stderr: "ignore" }));
    const exits = await Promise.all(processes.map((process) => process.exited));

    // Then: every successful command has one durable event rather than last-writer loss.
    expect(exits).toEqual(Array.from({ length: count }, () => 0));
    expect(readHabitLedger(cwd)).toHaveLength(count);
  });
});
