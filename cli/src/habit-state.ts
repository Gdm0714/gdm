import { createHash } from "node:crypto";
import { validateHabitEventFields } from "./habit-validation.ts";
import { GdmError } from "./state.ts";
import type {
  EvaluationEvent,
  HabitEvent,
  HabitMutation,
  HabitState,
  HabitVersionState,
  ObservationEvent,
  ProposalEvent,
} from "./habit-types.ts";

export function habitVersionKey(habitId: string, version: number): string {
  return `${habitId}@${version}`;
}

export function evaluationKey(habitId: string, version: number, workSlug: string): string {
  return `${habitId}@${version}@${workSlug}`;
}

function first16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function habitEventId(kind: HabitEvent["kind"], parts: readonly (string | number | null)[]): string {
  return `ev-${first16([kind, ...parts].map((part) => part ?? "").join("\0"))}`;
}

export function proposedHabitId(pattern: string, statement: string): string {
  return `h-${first16(`${pattern}\0${statement}`)}`;
}

export function expectedHabitEventId(event: HabitEvent): string {
  switch (event.kind) {
    case "observation":
      return habitEventId(event.kind, [event.sourceGroup, event.sourceToken, event.pattern]);
    case "proposal":
    case "adoption":
    case "retirement":
      return habitEventId(event.kind, [event.habitId, event.version]);
    case "evaluation":
      return habitEventId(event.kind, [
        event.habitId,
        event.version,
        event.workSlug,
        event.revision,
        event.predecessorEventId,
      ]);
  }
}

export function semanticSignature(event: HabitEvent): string {
  switch (event.kind) {
    case "observation":
      return JSON.stringify([event.kind, event.pattern, event.taxonomy, event.sourceToken, event.sourceGroup, event.sourceKind]);
    case "proposal":
      return JSON.stringify([event.kind, event.habitId, event.version, event.pattern, event.statement, event.sourceEventIds]);
    case "adoption":
      return JSON.stringify([event.kind, event.habitId, event.version, event.ruleRef, event.ruleHash, event.reason]);
    case "retirement":
      return JSON.stringify([event.kind, event.habitId, event.version, event.reason]);
    case "evaluation":
      return JSON.stringify([
        event.kind,
        event.habitId,
        event.version,
        event.workSlug,
        event.outcome,
        event.revision,
        event.predecessorEventId,
        event.reason ?? null,
      ]);
  }
}

function observationIdentity(event: ObservationEvent): string {
  return `${event.sourceGroup}\0${event.sourceToken}\0${event.pattern}`;
}

function sourceEligibility(events: ReadonlyMap<string, HabitEvent>, proposal: ProposalEvent): void {
  const present: ObservationEvent[] = [];
  for (const eventId of proposal.sourceEventIds) {
    const source = events.get(eventId);
    if (source?.kind !== "observation") {
      throw new GdmError("proposal source observation이 없습니다", "habit_transition");
    }
    present.push(source);
  }
  if (present.some((source) => source.pattern !== proposal.pattern)) {
    throw new GdmError("proposal source pattern이 일치하지 않습니다", "habit_transition");
  }
  if (new Set(present.map((source) => source.sourceGroup)).size < 2) {
    throw new GdmError("proposal에는 서로 다른 source group 두 개가 필요합니다", "habit_transition");
  }
  if (!present.some((source) => source.sourceKind === "incident")) {
    throw new GdmError("proposal에는 incident 근거가 필요합니다", "habit_transition");
  }
}

function applyEvent(
  event: HabitEvent,
  state: {
    eventsById: Map<string, HabitEvent>;
    observationsByIdentity: Map<string, ObservationEvent>;
    versions: Map<string, HabitVersionState>;
    latestEvaluations: Map<string, EvaluationEvent>;
  },
): void {
  validateHabitEventFields(event);
  if (event.eventId !== expectedHabitEventId(event)) {
    throw new GdmError("habit event identity가 일치하지 않습니다", "event_conflict");
  }
  const priorId = state.eventsById.get(event.eventId);
  if (priorId !== undefined) {
    if (semanticSignature(priorId) === semanticSignature(event)) return;
    throw new GdmError("habit event identity가 충돌합니다", "event_conflict");
  }
  switch (event.kind) {
    case "observation": {
      const identity = observationIdentity(event);
      const prior = state.observationsByIdentity.get(identity);
      if (prior !== undefined && semanticSignature(prior) !== semanticSignature(event)) {
        throw new GdmError("observation identity가 충돌합니다", "event_conflict");
      }
      state.observationsByIdentity.set(identity, event);
      break;
    }
    case "proposal": {
      sourceEligibility(state.eventsById, event);
      const key = habitVersionKey(event.habitId, event.version);
      if (state.versions.has(key)) throw new GdmError("habit version이 이미 있습니다", "event_conflict");
      const lineage = [...state.versions.values()].filter((version) => version.proposal.habitId === event.habitId);
      if (lineage.length === 0) {
        const samePattern = [...state.versions.values()].some((version) => version.proposal.pattern === event.pattern);
        if (event.version !== 1 || event.habitId !== proposedHabitId(event.pattern, event.statement)) {
          throw new GdmError("첫 habit identity가 일치하지 않습니다", "habit_transition");
        }
        if (samePattern) throw new GdmError("같은 pattern의 parallel proposal은 만들 수 없습니다", "habit_transition");
      } else {
        const latest = lineage.sort((a, b) => b.proposal.version - a.proposal.version)[0];
        if (latest === undefined || latest.retirement === undefined || event.version !== latest.proposal.version + 1) {
          throw new GdmError("retired version 다음에만 새 version을 만들 수 있습니다", "habit_transition");
        }
        if (latest.proposal.pattern !== event.pattern) {
          throw new GdmError("habit lineage pattern은 바꿀 수 없습니다", "habit_transition");
        }
      }
      state.versions.set(key, { proposal: event });
      break;
    }
    case "adoption": {
      const key = habitVersionKey(event.habitId, event.version);
      const version = state.versions.get(key);
      if (version === undefined || version.adoption !== undefined || version.retirement !== undefined) {
        throw new GdmError("proposed habit만 채택할 수 있습니다", "habit_transition");
      }
      state.versions.set(key, { ...version, adoption: event });
      break;
    }
    case "retirement": {
      const key = habitVersionKey(event.habitId, event.version);
      const version = state.versions.get(key);
      if (version === undefined || version.retirement !== undefined) {
        throw new GdmError("존재하고 아직 은퇴하지 않은 habit version만 은퇴할 수 있습니다", "habit_transition");
      }
      state.versions.set(key, { ...version, retirement: event });
      break;
    }
    case "evaluation": {
      const version = state.versions.get(habitVersionKey(event.habitId, event.version));
      if (version?.adoption === undefined || version.retirement !== undefined) {
        throw new GdmError("현재 adopted habit만 평가할 수 있습니다", "habit_transition");
      }
      const key = evaluationKey(event.habitId, event.version, event.workSlug);
      const current = state.latestEvaluations.get(key);
      if (current === undefined) {
        if (event.revision !== 0 || event.predecessorEventId !== null || event.reason !== undefined) {
          throw new GdmError("첫 평가는 revision 0이어야 합니다", "habit_transition");
        }
      } else if (
        event.revision !== current.revision + 1 ||
        event.predecessorEventId !== current.eventId ||
        event.reason === undefined
      ) {
        throw new GdmError("evaluation correction chain이 일치하지 않습니다", "stale_correction");
      }
      state.latestEvaluations.set(key, event);
      break;
    }
  }
  state.eventsById.set(event.eventId, event);
}

export function reduceHabitEvents(events: readonly HabitEvent[]): HabitState {
  const mutable = {
    eventsById: new Map<string, HabitEvent>(),
    observationsByIdentity: new Map<string, ObservationEvent>(),
    versions: new Map<string, HabitVersionState>(),
    latestEvaluations: new Map<string, EvaluationEvent>(),
  };
  for (const event of events) applyEvent(event, mutable);
  return mutable;
}

export function habitMutation(events: readonly HabitEvent[], candidate: HabitEvent): HabitMutation {
  const existing = reduceHabitEvents(events).eventsById.get(candidate.eventId);
  if (existing !== undefined) {
    if (semanticSignature(existing) === semanticSignature(candidate)) return { event: existing, changed: false };
    throw new GdmError("habit event identity가 충돌합니다", "event_conflict");
  }
  reduceHabitEvents([...events, candidate]);
  return { event: candidate, changed: true };
}
