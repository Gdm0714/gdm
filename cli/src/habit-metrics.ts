import { safeText } from "./contract.ts";
import {
  evaluationKey,
  habitEventId,
  habitMutation,
  habitVersionKey,
  reduceHabitEvents,
} from "./habit-state.ts";
import { eventId, habitId, outcome, positiveVersion, workSlug } from "./habit-validation.ts";
import { GdmError } from "./state.ts";
import type {
  EvaluatedWork,
  EvaluationEvent,
  EvaluationInput,
  HabitEvent,
  HabitMetric,
  HabitMutation,
  HabitOutcome,
  VersionMetric,
} from "./habit-types.ts";

type MetricContribution = {
  readonly eligible: number;
  readonly applied: number;
  readonly recurred: number;
};

export type VersionComparison =
  | { readonly kind: "insufficient"; readonly priorVersion: number; readonly currentVersion: number }
  | {
      readonly kind: "descriptive";
      readonly priorVersion: number;
      readonly currentVersion: number;
      readonly applicationRateDelta: number;
      readonly recurrenceRateDelta: number;
    };

export function metricContribution(value: HabitOutcome): MetricContribution {
  switch (value) {
    case "ineligible":
      return { eligible: 0, applied: 0, recurred: 0 };
    case "skipped":
      return { eligible: 1, applied: 0, recurred: 0 };
    case "clean":
      return { eligible: 1, applied: 1, recurred: 0 };
    case "recurred":
      return { eligible: 1, applied: 1, recurred: 1 };
  }
}

function assertActivation(work: EvaluatedWork, targetHabitId: string, version: number, value: HabitOutcome): void {
  const sameHabit = work.contract.activeHabits.filter((active) => active.habitId === targetHabitId);
  const exact = sameHabit.some((active) => active.version === version);
  const activeOutcome = value === "clean" || value === "recurred";
  if ((sameHabit.length === 0 && activeOutcome) || (exact && !activeOutcome) || (sameHabit.length > 0 && !exact)) {
    throw new GdmError("evaluation outcome과 work activation이 일치하지 않습니다", "evaluation_activation_mismatch");
  }
}

function correctionReplay(
  current: EvaluationEvent,
  value: HabitOutcome,
  correct: string,
  reason: string,
): HabitMutation | undefined {
  if (
    current.predecessorEventId === correct &&
    current.outcome === value &&
    current.reason === reason
  ) {
    return { event: current, changed: false };
  }
  return undefined;
}

export function createEvaluation(
  events: readonly HabitEvent[],
  work: EvaluatedWork,
  input: EvaluationInput,
  at: string,
): HabitMutation {
  const targetHabitId = habitId(input.habitId);
  const version = positiveVersion(input.version);
  const value = outcome(input.outcome);
  const slug = workSlug(work.slug);
  if (!work.done) throw new GdmError("완료된 work만 평가할 수 있습니다", "habit_transition");
  const state = reduceHabitEvents(events);
  const lifecycle = state.versions.get(habitVersionKey(targetHabitId, version));
  if (lifecycle?.adoption === undefined || lifecycle.retirement !== undefined) {
    throw new GdmError("현재 adopted habit만 평가할 수 있습니다", "habit_transition");
  }
  assertActivation(work, targetHabitId, version, value);
  if (value !== "ineligible" && work.doneAt !== undefined && work.doneAt < lifecycle.adoption.at) {
    throw new GdmError("채택 이전에 완료된 작업은 적용 대상이 아닙니다 (ineligible만 기록 가능)", "habit_transition");
  }
  const current = state.latestEvaluations.get(evaluationKey(targetHabitId, version, slug));
  if (current === undefined) {
    if (input.correct !== undefined || input.reason !== undefined) {
      throw new GdmError("첫 평가는 correction을 받을 수 없습니다", "stale_correction");
    }
    const event: EvaluationEvent = {
      schemaVersion: 1,
      eventId: habitEventId("evaluation", [targetHabitId, version, slug, 0, null]),
      at,
      kind: "evaluation",
      habitId: targetHabitId,
      version,
      workSlug: slug,
      outcome: value,
      revision: 0,
      predecessorEventId: null,
    };
    return habitMutation(events, event);
  }
  if (input.correct === undefined) {
    if (input.reason !== undefined) throw new GdmError("--reason에는 --correct가 필요합니다", "usage");
    if (current.revision === 0 && current.outcome === value) return { event: current, changed: false };
    throw new GdmError("기존 평가는 --correct와 --reason으로 수정해야 합니다", "stale_correction");
  }
  const correct = eventId(input.correct, "correct");
  if (input.reason === undefined) throw new GdmError("correction에는 reason이 필요합니다", "usage");
  const reason = safeText(input.reason, "reason");
  const replay = correctionReplay(current, value, correct, reason);
  if (replay !== undefined) return replay;
  if (current.eventId !== correct) throw new GdmError("최신 evaluation만 수정할 수 있습니다", "stale_correction");
  if (current.outcome === value) throw new GdmError("evaluation outcome이 바뀌지 않았습니다", "usage");
  const revision = current.revision + 1;
  const event: EvaluationEvent = {
    schemaVersion: 1,
    eventId: habitEventId("evaluation", [targetHabitId, version, slug, revision, current.eventId]),
    at,
    kind: "evaluation",
    habitId: targetHabitId,
    version,
    workSlug: slug,
    outcome: value,
    revision,
    predecessorEventId: current.eventId,
    reason,
  };
  return habitMutation(events, event);
}

export function habitMetrics(events: readonly HabitEvent[], targetHabitId: string, version: number): HabitMetric {
  const state = reduceHabitEvents(events);
  const totals = [...state.latestEvaluations.values()]
    .filter((event) => event.habitId === targetHabitId && event.version === version)
    .map((event) => metricContribution(event.outcome))
    .reduce(
      (sum, item) => ({
        eligible: sum.eligible + item.eligible,
        applied: sum.applied + item.applied,
        recurred: sum.recurred + item.recurred,
      }),
      { eligible: 0, applied: 0, recurred: 0 },
    );
  return {
    ...totals,
    applicationRate: totals.eligible === 0 ? null : totals.applied / totals.eligible,
    recurrenceRate: totals.applied === 0 ? null : totals.recurred / totals.applied,
    verdict: totals.applied < 3 ? "insufficient" : "observed",
  };
}

export function compareVersionMetrics(prior: VersionMetric, current: VersionMetric): VersionComparison {
  if (
    prior.verdict !== "observed" ||
    current.verdict !== "observed" ||
    prior.applicationRate === null ||
    current.applicationRate === null ||
    prior.recurrenceRate === null ||
    current.recurrenceRate === null
  ) {
    return { kind: "insufficient", priorVersion: prior.version, currentVersion: current.version };
  }
  return {
    kind: "descriptive",
    priorVersion: prior.version,
    currentVersion: current.version,
    applicationRateDelta: current.applicationRate - prior.applicationRate,
    recurrenceRateDelta: current.recurrenceRate - prior.recurrenceRate,
  };
}
