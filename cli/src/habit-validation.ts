import { assertNoSensitiveRaw, opaqueId, privacyError, safeText } from "./contract.ts";
import { GdmError } from "./state.ts";
import type { HabitEvent, HabitOutcome, HabitSourceKind, HabitTaxonomy } from "./habit-types.ts";
import { isCanonicalTimestamp, isSafeContainedRuleReference } from "./validation-boundary.ts";

const PATTERN_RE = /^[a-z0-9][a-z0-9.-]{2,63}$/u;
const HABIT_ID_RE = /^h-[0-9a-f]{16}$/u;
const EVENT_ID_RE = /^ev-[0-9a-f]{16}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
const WORK_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,50}$/u;
const TAXONOMIES: readonly HabitTaxonomy[] = [
  "intent",
  "delivery",
  "retry",
  "review",
  "verification",
  "tooling",
  "recovery",
];
const SOURCE_KINDS: readonly HabitSourceKind[] = ["incident", "principle"];
const OUTCOMES: readonly HabitOutcome[] = ["ineligible", "skipped", "clean", "recurred"];

export function patternId(value: string, field = "pattern"): string {
  assertNoSensitiveRaw(value, field);
  if (!PATTERN_RE.test(value)) throw new GdmError(`field=${field} pattern 형식이 잘못됐습니다`, "usage");
  return value;
}

export function habitId(value: string, field = "habit"): string {
  assertNoSensitiveRaw(value, field);
  if (!HABIT_ID_RE.test(value)) throw new GdmError(`field=${field} habit ID 형식이 잘못됐습니다`, "usage");
  return value;
}

export function eventId(value: string, field = "event-id"): string {
  assertNoSensitiveRaw(value, field);
  if (!EVENT_ID_RE.test(value)) throw new GdmError(`field=${field} event ID 형식이 잘못됐습니다`, "usage");
  return value;
}

export function positiveVersion(value: number, field = "version"): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GdmError(`field=${field} version은 양의 정수여야 합니다`, "usage");
  }
  return value;
}

export function nonnegativeRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GdmError("revision은 0 이상의 정수여야 합니다", "usage");
  }
  return value;
}

export function taxonomy(value: string): HabitTaxonomy {
  assertNoSensitiveRaw(value, "taxonomy");
  const found = TAXONOMIES.find((candidate) => candidate === value);
  if (found === undefined) throw new GdmError("taxonomy 값이 잘못됐습니다", "usage");
  return found;
}

export function sourceKind(value: string): HabitSourceKind {
  assertNoSensitiveRaw(value, "source-kind");
  const found = SOURCE_KINDS.find((candidate) => candidate === value);
  if (found === undefined) throw new GdmError("source-kind 값이 잘못됐습니다", "usage");
  return found;
}

export function outcome(value: string): HabitOutcome {
  assertNoSensitiveRaw(value, "outcome");
  const found = OUTCOMES.find((candidate) => candidate === value);
  if (found === undefined) throw new GdmError("outcome 값이 잘못됐습니다", "usage");
  return found;
}

export function ruleHash(value: string): string {
  assertNoSensitiveRaw(value, "rule-hash");
  if (!HASH_RE.test(value)) throw new GdmError("rule hash 형식이 잘못됐습니다", "usage");
  return value;
}

export function ruleReference(value: string): string {
  if (!isSafeContainedRuleReference(value)) throw privacyError("rule-ref");
  return value;
}

export function workSlug(value: string): string {
  assertNoSensitiveRaw(value, "work");
  if (!WORK_SLUG_RE.test(value)) throw new GdmError("work slug 형식이 잘못됐습니다", "usage");
  return value;
}

function timestamp(value: string): void {
  if (!isCanonicalTimestamp(value)) {
    throw new GdmError("habit event timestamp 형식이 잘못됐습니다", "event_conflict");
  }
}

function canonicalSourceIds(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function validateHabitEventFields(event: HabitEvent): void {
  timestamp(event.at);
  eventId(event.eventId);
  if (event.kind === "observation") {
    patternId(event.pattern);
    taxonomy(event.taxonomy);
    opaqueId(event.sourceToken, "source-token");
    opaqueId(event.sourceGroup, "source-group");
    sourceKind(event.sourceKind);
  } else if (event.kind === "proposal") {
    habitId(event.habitId);
    positiveVersion(event.version);
    patternId(event.pattern);
    safeText(event.statement, "statement", 160);
    const canonical = canonicalSourceIds(event.sourceEventIds.map((value) => eventId(value, "source-event")));
    if (canonical.length !== event.sourceEventIds.length || canonical.some((value, index) => value !== event.sourceEventIds[index])) {
      throw new GdmError("proposal source events는 중복 없이 정렬되어야 합니다", "event_conflict");
    }
  } else if (event.kind === "adoption") {
    habitId(event.habitId);
    positiveVersion(event.version);
    ruleReference(event.ruleRef);
    ruleHash(event.ruleHash);
    safeText(event.reason, "reason");
  } else if (event.kind === "retirement") {
    habitId(event.habitId);
    positiveVersion(event.version);
    safeText(event.reason, "reason");
  } else {
    habitId(event.habitId);
    positiveVersion(event.version);
    workSlug(event.workSlug);
    outcome(event.outcome);
    nonnegativeRevision(event.revision);
    if (event.predecessorEventId !== null) eventId(event.predecessorEventId, "predecessor-event");
    if (event.reason !== undefined) safeText(event.reason, "reason");
  }
  if (Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8") >= 2048) {
    throw privacyError("habit-event");
  }
}

export function scanProviderValue(value: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      assertNoSensitiveRaw(candidate, "observation");
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (seen.has(candidate)) throw privacyError("observation");
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const key of Object.keys(candidate)) {
      assertNoSensitiveRaw(key, "observation");
      visit(Object.getOwnPropertyDescriptor(candidate, key)?.value);
    }
  };
  visit(value);
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw privacyError("observation");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") >= 2048) {
    throw privacyError("observation");
  }
}
