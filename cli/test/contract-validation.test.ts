import { describe, expect, test } from "bun:test";
import { assertNoSensitiveRaw, normalizeContract } from "../src/contract.ts";
import { GdmError } from "../src/state.ts";
import type { HabitEvent } from "../src/habit-types.ts";
import { validateHabitEventFields } from "../src/habit-validation.ts";

const NOW = "2026-07-10T00:00:00.000Z";
const HABIT_ID = "h-26e6439115bc8179";
const RULE_HASH = "a".repeat(64);

const ACTIVE_HABIT = {
  habitId: HABIT_ID,
  version: 1,
  ruleRef: "rules/repeated-failure.md",
  ruleHash: RULE_HASH,
  activatedAt: NOW,
} as const;

function captureGdmError(action: () => void): GdmError {
  try {
    action();
  } catch (error) {
    if (error instanceof GdmError) return error;
    throw error;
  }
  throw new Error("expected GdmError");
}

function contractWith(activeHabit: unknown): Readonly<Record<string, unknown>> {
  return {
    required: [],
    forbidden: [],
    activeHabits: [activeHabit],
    commit: "forbidden",
  };
}

describe("contract validation boundaries", () => {
  test("punctuation cannot hide a URI scheme", () => {
    // Given: URI schemes immediately preceded by punctuation rather than whitespace.
    const unsafe = ["메모,data:note", "[data:note]"] as const;

    // When: the raw values cross the privacy boundary.
    const errors = unsafe.map((value) => captureGdmError(() => assertNoSensitiveRaw(value, "constraint")));

    // Then: each is rejected without reflecting its source value.
    expect(errors.map((error) => error.code)).toEqual(unsafe.map(() => "privacy_rejected"));
    expect(errors.every((error, index) => !error.message.includes(unsafe[index] ?? ""))).toBe(true);
  });

  test("canonical timestamps are not mistaken for URI schemes", () => {
    // Given: a canonical timestamp containing a letter followed later by a colon.
    const timestamp = "2026-07-10T08:38:00.000Z";

    // When: the timestamp crosses the generic raw privacy boundary.
    const validate = () => assertNoSensitiveRaw(timestamp, "timestamp");

    // Then: its time separator is not classified as a URI scheme.
    expect(validate).not.toThrow();
  });

  test("habit event timestamps require a real canonical instant", () => {
    // Given: a syntactically shaped timestamp whose calendar date does not exist.
    const event: HabitEvent = {
      schemaVersion: 1,
      eventId: "ev-1234567890abcdef",
      at: "2026-02-31T00:00:00.000Z",
      kind: "evaluation",
      habitId: HABIT_ID,
      version: 1,
      workSlug: "valid-work",
      outcome: "clean",
      revision: 0,
      predecessorEventId: null,
    };

    // When: the event fields cross the ledger validation boundary.
    const error = captureGdmError(() => validateHabitEventFields(event));

    // Then: calendar normalization is refused as an event conflict.
    expect(error.code).toBe("event_conflict");
  });

  test("valid persisted active habits are preserved", () => {
    // Given: a complete canonical active-habit record.
    const raw = contractWith(ACTIVE_HABIT);

    // When: the persisted contract is normalized.
    const contract = normalizeContract(raw);

    // Then: the activation survives without migration or field loss.
    expect(contract.activeHabits).toEqual([ACTIVE_HABIT]);
  });

  test("malformed persisted active habits fail with one static error", () => {
    // Given: records that violate every persisted active-habit boundary.
    const malformed: readonly unknown[] = [
      { ...ACTIVE_HABIT, marker: "extra-private-value" },
      { ...ACTIVE_HABIT, habitId: "h-invalid-private-value" },
      { ...ACTIVE_HABIT, version: 0 },
      { ...ACTIVE_HABIT, version: 1.5 },
      { ...ACTIVE_HABIT, ruleRef: "../private-rule.md" },
      { ...ACTIVE_HABIT, ruleRef: ".obsidian/private-rule.md" },
      { ...ACTIVE_HABIT, ruleRef: "notes/obsidian/private-rule.md" },
      { ...ACTIVE_HABIT, ruleRef: "session/private-rule.md" },
      { ...ACTIVE_HABIT, ruleRef: "notes/sessions/private-rule.md" },
      { ...ACTIVE_HABIT, ruleHash: "A".repeat(64) },
      { ...ACTIVE_HABIT, ruleHash: "private-hash" },
      { ...ACTIVE_HABIT, activatedAt: "2026-02-31T00:00:00.000Z" },
      { ...ACTIVE_HABIT, activatedAt: "2026-07-10T00:00:00Z" },
    ];

    // When: each malformed record crosses the persisted-state boundary.
    const errors = malformed.map((value) => captureGdmError(() => normalizeContract(contractWith(value))));

    // Then: every failure is state_corrupt and no rejected value is reflected.
    expect(errors.map((error) => error.code)).toEqual(malformed.map(() => "state_corrupt"));
    expect(new Set(errors.map((error) => error.message)).size).toBe(1);
    expect(errors.every((error) => !error.message.includes("private"))).toBe(true);
  });
});
