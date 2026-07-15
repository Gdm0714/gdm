import type { Work } from "./types.ts";

export type HabitTaxonomy =
  | "intent"
  | "delivery"
  | "retry"
  | "review"
  | "verification"
  | "tooling"
  | "recovery";
export type HabitSourceKind = "incident" | "principle";
export type HabitOutcome = "ineligible" | "skipped" | "clean" | "recurred";

type HabitEventBase = {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly at: string;
};

export type ObservationEvent = HabitEventBase & {
  readonly kind: "observation";
  readonly pattern: string;
  readonly taxonomy: HabitTaxonomy;
  readonly sourceToken: string;
  readonly sourceGroup: string;
  readonly sourceKind: HabitSourceKind;
};

export type ProposalEvent = HabitEventBase & {
  readonly kind: "proposal";
  readonly habitId: string;
  readonly version: number;
  readonly pattern: string;
  readonly statement: string;
  readonly sourceEventIds: readonly string[];
};

export type AdoptionEvent = HabitEventBase & {
  readonly kind: "adoption";
  readonly habitId: string;
  readonly version: number;
  readonly ruleRef: string;
  readonly ruleHash: string;
  readonly reason: string;
};

export type RetirementEvent = HabitEventBase & {
  readonly kind: "retirement";
  readonly habitId: string;
  readonly version: number;
  readonly reason: string;
};

export type EvaluationEvent = HabitEventBase & {
  readonly kind: "evaluation";
  readonly habitId: string;
  readonly version: number;
  readonly workSlug: string;
  readonly outcome: HabitOutcome;
  readonly revision: number;
  readonly predecessorEventId: string | null;
  readonly reason?: string;
};

export type HabitEvent =
  | ObservationEvent
  | ProposalEvent
  | AdoptionEvent
  | RetirementEvent
  | EvaluationEvent;

export type HabitVersionState = {
  readonly proposal: ProposalEvent;
  readonly adoption?: AdoptionEvent;
  readonly retirement?: RetirementEvent;
};

export type HabitState = {
  readonly eventsById: ReadonlyMap<string, HabitEvent>;
  readonly observationsByIdentity: ReadonlyMap<string, ObservationEvent>;
  readonly versions: ReadonlyMap<string, HabitVersionState>;
  readonly latestEvaluations: ReadonlyMap<string, EvaluationEvent>;
};

export type HabitMutation = {
  readonly event: HabitEvent;
  readonly changed: boolean;
};

export type HabitMetric = {
  readonly eligible: number;
  readonly applied: number;
  readonly recurred: number;
  readonly applicationRate: number | null;
  readonly recurrenceRate: number | null;
  readonly verdict: "insufficient" | "observed";
};

export type VersionMetric = HabitMetric & { readonly version: number };

export type EvaluationInput = {
  readonly habitId: string;
  readonly version: number;
  readonly outcome: HabitOutcome;
  readonly correct?: string;
  readonly reason?: string;
};

export type EvaluatedWork = Work;
