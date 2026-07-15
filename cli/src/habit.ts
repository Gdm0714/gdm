import { opaqueId, privacyError, safeText } from "./contract.ts";
import {
  habitEventId,
  habitMutation,
  proposedHabitId,
  reduceHabitEvents,
} from "./habit-state.ts";
import {
  eventId,
  habitId,
  patternId,
  positiveVersion,
  ruleHash as validateRuleHash,
  ruleReference,
  scanProviderValue,
  sourceKind,
  taxonomy,
} from "./habit-validation.ts";
import { GdmError } from "./state.ts";
import type {
  AdoptionEvent,
  HabitEvent,
  HabitMutation,
  HabitSourceKind,
  HabitTaxonomy,
  ObservationEvent,
  ProposalEvent,
  RetirementEvent,
} from "./habit-types.ts";

export {
  compareVersionMetrics,
  createEvaluation,
  habitMetrics,
  metricContribution,
} from "./habit-metrics.ts";
export { reduceHabitEvents } from "./habit-state.ts";
export type * from "./habit-types.ts";

export type ObservationInput = {
  readonly pattern: string;
  readonly taxonomy: HabitTaxonomy;
  readonly sourceToken: string;
  readonly sourceGroup: string;
  readonly sourceKind: HabitSourceKind;
};

export type ProposalInput = {
  readonly pattern: string;
  readonly statement: string;
  readonly sourceEventIds: readonly string[];
  readonly habitId?: string;
};

export type AdoptionInput = {
  readonly habitId: string;
  readonly version: number;
  readonly ruleRef: string;
  readonly ruleHash: string;
  readonly reason: string;
};

export type RetirementInput = {
  readonly habitId: string;
  readonly version: number;
  readonly reason: string;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactObservationKeys(value: Readonly<Record<string, unknown>>): void {
  const required = ["schemaVersion", "pattern", "taxonomy", "sourceToken", "sourceGroup", "sourceKind"];
  const keys = Object.keys(value);
  if (keys.length !== required.length || required.some((key) => !keys.includes(key))) {
    throw privacyError("observation");
  }
}

export function parseObservationRecord(raw: unknown): ObservationInput {
  scanProviderValue(raw);
  if (!isRecord(raw)) throw new GdmError("observation record는 객체여야 합니다", "usage");
  exactObservationKeys(raw);
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.pattern !== "string" ||
    typeof raw.taxonomy !== "string" ||
    typeof raw.sourceToken !== "string" ||
    typeof raw.sourceGroup !== "string" ||
    typeof raw.sourceKind !== "string"
  ) {
    throw new GdmError("observation record 필드 형식이 잘못됐습니다", "usage");
  }
  return {
    pattern: patternId(raw.pattern),
    taxonomy: taxonomy(raw.taxonomy),
    sourceToken: opaqueId(raw.sourceToken, "source-token"),
    sourceGroup: opaqueId(raw.sourceGroup, "source-group"),
    sourceKind: sourceKind(raw.sourceKind),
  };
}

export function createObservation(
  events: readonly HabitEvent[],
  input: ObservationInput,
  at: string,
): HabitMutation {
  const normalized = {
    pattern: patternId(input.pattern),
    taxonomy: taxonomy(input.taxonomy),
    sourceToken: opaqueId(input.sourceToken, "source-token"),
    sourceGroup: opaqueId(input.sourceGroup, "source-group"),
    sourceKind: sourceKind(input.sourceKind),
  };
  const event: ObservationEvent = {
    schemaVersion: 1,
    eventId: habitEventId("observation", [normalized.sourceGroup, normalized.sourceToken, normalized.pattern]),
    at,
    kind: "observation",
    ...normalized,
  };
  return habitMutation(events, event);
}

function canonicalSources(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => eventId(value, "source-event")))].sort();
}

function proposalVersion(events: readonly HabitEvent[], requestedHabit: string): number {
  const lineage = [...reduceHabitEvents(events).versions.values()]
    .filter((version) => version.proposal.habitId === requestedHabit)
    .sort((left, right) => right.proposal.version - left.proposal.version);
  const latest = lineage[0];
  if (latest === undefined) throw new GdmError("habit lineage가 없습니다", "habit_transition");
  return latest.retirement === undefined ? latest.proposal.version : latest.proposal.version + 1;
}

export function createProposal(
  events: readonly HabitEvent[],
  input: ProposalInput,
  at: string,
): HabitMutation {
  const pattern = patternId(input.pattern);
  const statement = safeText(input.statement, "statement", 160);
  const sourceEventIds = canonicalSources(input.sourceEventIds);
  let selectedHabitId: string;
  let version: number;
  if (input.habitId === undefined) {
    selectedHabitId = proposedHabitId(pattern, statement);
    version = 1;
  } else {
    selectedHabitId = habitId(input.habitId);
    version = proposalVersion(events, selectedHabitId);
  }
  const event: ProposalEvent = {
    schemaVersion: 1,
    eventId: habitEventId("proposal", [selectedHabitId, version]),
    at,
    kind: "proposal",
    habitId: selectedHabitId,
    version,
    pattern,
    statement,
    sourceEventIds,
  };
  return habitMutation(events, event);
}

export function createAdoption(
  events: readonly HabitEvent[],
  input: AdoptionInput,
  at: string,
): HabitMutation {
  const normalizedHabitId = habitId(input.habitId);
  const version = positiveVersion(input.version);
  const event: AdoptionEvent = {
    schemaVersion: 1,
    eventId: habitEventId("adoption", [normalizedHabitId, version]),
    at,
    kind: "adoption",
    habitId: normalizedHabitId,
    version,
    ruleRef: ruleReference(input.ruleRef),
    ruleHash: validateRuleHash(input.ruleHash),
    reason: safeText(input.reason, "reason"),
  };
  return habitMutation(events, event);
}

export function createRetirement(
  events: readonly HabitEvent[],
  input: RetirementInput,
  at: string,
): HabitMutation {
  const normalizedHabitId = habitId(input.habitId);
  const version = positiveVersion(input.version);
  const event: RetirementEvent = {
    schemaVersion: 1,
    eventId: habitEventId("retirement", [normalizedHabitId, version]),
    at,
    kind: "retirement",
    habitId: normalizedHabitId,
    version,
    reason: safeText(input.reason, "reason"),
  };
  return habitMutation(events, event);
}
