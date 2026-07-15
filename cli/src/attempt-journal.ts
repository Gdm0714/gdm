import { GdmError } from "./state.ts";
import type { AttemptDecision, AttemptEvent } from "./attempt.ts";
import type { JournalEvent } from "./types.ts";

function isDecision(value: unknown): value is AttemptDecision {
  return (
    value === "awaiting-confirmation" ||
    value === "confirmation-permitted" ||
    value === "locked" ||
    value === "changed-permitted"
  );
}

function isAttemptEvent(value: JournalEvent): value is AttemptEvent {
  return (
    value.event === "attempt" &&
    value.schemaVersion === 1 &&
    (value.action === "fail" || value.action === "retry") &&
    typeof value.attemptId === "string" &&
    (value.sourceKind === "command" || value.sourceKind === "capability") &&
    typeof value.sourceId === "string" &&
    typeof value.target === "string" &&
    typeof value.errorCode === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.at === "string" &&
    typeof value.epoch === "number" &&
    typeof value.failureCount === "number" &&
    typeof value.hypothesis === "string" &&
    isDecision(value.decision)
  );
}

export function readAttemptEvents(journal: readonly JournalEvent[]): readonly AttemptEvent[] {
  const relevant = journal.filter((event) => event.event === "attempt");
  if (relevant.some((event) => !isAttemptEvent(event))) {
    throw new GdmError("attempt journal 형식이 잘못됐습니다", "state_corrupt");
  }
  return relevant.filter(isAttemptEvent);
}

export function latestAttemptStates(journal: readonly JournalEvent[]): readonly AttemptEvent[] {
  const latest = new Map<string, AttemptEvent>();
  for (const event of readAttemptEvents(journal)) latest.set(event.fingerprint, event);
  return [...latest.values()];
}
