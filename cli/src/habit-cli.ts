import { readContainedFile } from "./contained-file.ts";
import { assertNoSensitiveRaw, privacyError, safeText } from "./contract.ts";
import {
  ensureFlags,
  leadingReference,
  readFlag,
  readFlags,
  requiredFlag,
  scanHabitArgs,
} from "./habit-cli-args.ts";
import { harvestHabits } from "./habit-harvest.ts";
import { parsePrivacyJson, scanJsonStringTokens } from "./habit-json.ts";
import {
  createAdoption,
  createEvaluation,
  createObservation,
  createProposal,
  createRetirement,
  habitMetrics,
  parseObservationRecord,
  reduceHabitEvents,
} from "./habit.ts";
import { appendHabitEvents, readHabitLedger } from "./habit-store.ts";
import { eventId, habitId, outcome, patternId, positiveVersion, workSlug } from "./habit-validation.ts";
import { GdmError } from "./state.ts";
import { appendJournal, loadWork, readJournal, saveWork } from "./store.ts";
import type { ActiveHabit, Work } from "./types.ts";
import type { HabitEvent, HabitMutation, ObservationInput } from "./habit.ts";

type HabitVersionRef = { readonly habitId: string; readonly version: number };

type EvaluationRuleContext = {
  readonly cwd: string;
  readonly work: Work;
  readonly target: HabitVersionRef;
  readonly events: readonly HabitEvent[];
};

function versionRef(value: string): HabitVersionRef {
  assertNoSensitiveRaw(value, "habit-reference");
  const separator = value.lastIndexOf("@");
  const rawVersion = separator < 0 ? "" : value.slice(separator + 1);
  if (!/^[1-9][0-9]*$/u.test(rawVersion)) throw new GdmError("habit reference는 <habit-id>@<version> 형식입니다", "usage");
  return { habitId: habitId(value.slice(0, separator)), version: positiveVersion(Number(rawVersion)) };
}

function appendMutation(cwd: string, mutation: HabitMutation): void {
  if (mutation.changed) appendHabitEvents(cwd, [mutation.event]);
  console.log(`${mutation.event.kind}: ${mutation.event.eventId}${mutation.changed ? "" : " (변경 없음)"}`);
}

function commandObserve(cwd: string, args: readonly string[], at: string): void {
  ensureFlags(args, { valued: ["pattern", "taxonomy", "source-token", "source-group", "source-kind"] });
  const input = parseObservationRecord({
    schemaVersion: 1,
    pattern: requiredFlag(args, "pattern"),
    taxonomy: requiredFlag(args, "taxonomy"),
    sourceToken: requiredFlag(args, "source-token"),
    sourceGroup: requiredFlag(args, "source-group"),
    sourceKind: requiredFlag(args, "source-kind"),
  });
  appendMutation(cwd, createObservation(readHabitLedger(cwd), input, at));
}

function importRecords(cwd: string, file: string, at: string): void {
  const contained = readContainedFile(cwd, file, "observation-file");
  const lines = contained.content.split("\n");
  const rawLines: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0 && index === lines.length - 1) continue;
    if (line.length === 0 || Buffer.byteLength(line, "utf8") >= 2048) throw privacyError("observation-import");
    scanJsonStringTokens(line, "observation-import");
    rawLines.push(line);
  }
  const inputs: ObservationInput[] = [];
  for (const line of rawLines) inputs.push(parseObservationRecord(parsePrivacyJson(line, "observation-import")));
  if (inputs.length === 0) throw new GdmError("observation file이 비어 있습니다", "usage");
  let working = readHabitLedger(cwd);
  const additions: HabitEvent[] = [];
  for (const input of inputs) {
    const mutation = createObservation(working, input, at);
    if (mutation.changed) {
      additions.push(mutation.event);
      working = [...working, mutation.event];
    }
  }
  const result = appendHabitEvents(cwd, additions);
  console.log(`observation import: ${result.appended}개 추가`);
}

function commandPropose(cwd: string, args: readonly string[], at: string): void {
  ensureFlags(args, {
    valued: ["pattern", "statement", "source-event", "habit"],
    repeatable: ["source-event"],
  });
  const requestedHabit = readFlag(args, "habit");
  const pattern = patternId(requiredFlag(args, "pattern"));
  const statement = safeText(requiredFlag(args, "statement"), "statement", 160);
  const sourceEventIds = readFlags(args, "source-event").map((value) => eventId(value, "source-event"));
  const selectedHabit = requestedHabit === undefined ? undefined : habitId(requestedHabit);
  const mutation = createProposal(
    readHabitLedger(cwd),
    { pattern, statement, sourceEventIds, habitId: selectedHabit },
    at,
  );
  appendMutation(cwd, mutation);
}

function commandAdopt(cwd: string, args: readonly string[], at: string): void {
  const { reference, flags } = leadingReference(args);
  ensureFlags(flags, { valued: ["rule-ref", "reason"] });
  const target = versionRef(reference);
  const reason = safeText(requiredFlag(flags, "reason"), "reason");
  const rule = readContainedFile(cwd, requiredFlag(flags, "rule-ref"), "rule-ref");
  appendMutation(cwd, createAdoption(readHabitLedger(cwd), {
    ...target,
    ruleRef: rule.path,
    ruleHash: rule.sha256,
    reason,
  }, at));
}

function commandRetire(cwd: string, args: readonly string[], at: string): void {
  const { reference, flags } = leadingReference(args);
  ensureFlags(flags, { valued: ["reason"] });
  const target = versionRef(reference);
  const reason = safeText(requiredFlag(flags, "reason"), "reason");
  appendMutation(cwd, createRetirement(readHabitLedger(cwd), {
    ...target,
    reason,
  }, at));
}

function commandEvaluate(cwd: string, args: readonly string[], at: string): void {
  const { reference, flags } = leadingReference(args);
  ensureFlags(flags, { valued: ["work", "outcome", "correct", "reason"] });
  const requestedCorrect = readFlag(flags, "correct");
  const requestedReason = readFlag(flags, "reason");
  if ((requestedCorrect === undefined) !== (requestedReason === undefined)) {
    throw new GdmError("correction에는 --correct와 --reason이 함께 필요합니다", "usage");
  }
  const target = versionRef(reference);
  const slug = workSlug(requiredFlag(flags, "work"));
  const result = outcome(requiredFlag(flags, "outcome"));
  const correct = requestedCorrect === undefined ? undefined : eventId(requestedCorrect, "correct");
  const reason = requestedReason === undefined ? undefined : safeText(requestedReason, "reason");
  const events = readHabitLedger(cwd);
  const work = loadWork(cwd, slug);
  assertEvaluationRule({ cwd, work, target, events });
  appendMutation(cwd, createEvaluation(events, work, {
    ...target,
    outcome: result,
    correct,
    reason,
  }, at));
}

function assertEvaluationRule(context: EvaluationRuleContext): void {
  const active = context.work.contract.activeHabits.find(
    (candidate) => candidate.habitId === context.target.habitId && candidate.version === context.target.version,
  );
  if (active === undefined) return;
  const lifecycle = reduceHabitEvents(context.events).versions.get(
    `${context.target.habitId}@${context.target.version}`,
  );
  if (
    lifecycle?.adoption === undefined ||
    lifecycle.adoption.ruleRef !== active.ruleRef ||
    lifecycle.adoption.ruleHash !== active.ruleHash
  ) {
    throw new GdmError("work activation과 habit adoption이 일치하지 않습니다", "evaluation_activation_mismatch");
  }
  const rule = readContainedFile(context.cwd, active.ruleRef, "rule-ref");
  if (rule.sha256 !== active.ruleHash) {
    throw new GdmError("활성화 뒤 rule 파일이 바뀌었습니다", "habit_rule_changed");
  }
}

function commandStatus(cwd: string, args: readonly string[]): void {
  ensureFlags(args, { valued: [], boolean: ["json"] });
  const events = readHabitLedger(cwd);
  const versions = [...reduceHabitEvents(events).versions.values()]
    .sort((left, right) => left.proposal.habitId.localeCompare(right.proposal.habitId) || left.proposal.version - right.proposal.version)
    .map((state) => ({
      habitId: state.proposal.habitId,
      version: state.proposal.version,
      pattern: state.proposal.pattern,
      statement: state.proposal.statement,
      lifecycle: state.retirement === undefined ? (state.adoption === undefined ? "proposed" : "adopted") : "retired",
      ...(state.adoption === undefined ? {} : { ruleRef: state.adoption.ruleRef, ruleHash: state.adoption.ruleHash }),
      metrics: habitMetrics(events, state.proposal.habitId, state.proposal.version),
    }));
  if (args.includes("--json")) console.log(JSON.stringify({ schemaVersion: 1, versions }, null, 2));
  else for (const version of versions) console.log(`${version.habitId}@${version.version} · ${version.lifecycle} · applied ${version.metrics.applied}`);
}

export function activateHabit(cwd: string, slug: string, value: string, at: string): void {
  const target = versionRef(value);
  const state = reduceHabitEvents(readHabitLedger(cwd));
  const version = state.versions.get(`${target.habitId}@${target.version}`);
  if (version?.adoption === undefined || version.retirement !== undefined) {
    throw new GdmError("현재 adopted habit만 활성화할 수 있습니다", "habit_transition");
  }
  const rule = readContainedFile(cwd, version.adoption.ruleRef, "rule-ref");
  if (rule.sha256 !== version.adoption.ruleHash) throw new GdmError("채택 뒤 rule 파일이 바뀌었습니다", "habit_rule_changed");
  const work = loadWork(cwd, workSlug(slug));
  const existing = work.contract.activeHabits.find(
    (active) => active.habitId === target.habitId && active.version === target.version,
  );
  if (existing !== undefined) {
    if (existing.ruleRef === rule.path && existing.ruleHash === rule.sha256) {
      console.log(`habit 활성화 변경 없음: ${target.habitId}@${target.version}`);
      return;
    }
    throw new GdmError("같은 habit version의 다른 활성화가 이미 있습니다", "habit_activation_conflict");
  }
  const passedBefore = readJournal(cwd, work.slug).some((event) => event.event === "pass");
  if (passedBefore || work.done || work.checks.some((check) => check.status === "proven")) {
    throw new GdmError("첫 확인 항목 통과 뒤에는 habit을 활성화할 수 없습니다", "habit_activation_locked");
  }
  const active: ActiveHabit = { ...target, ruleRef: rule.path, ruleHash: rule.sha256, activatedAt: at };
  const next = { ...work, contract: { ...work.contract, activeHabits: [...work.contract.activeHabits, active] } };
  appendJournal(cwd, work.slug, { ts: at, event: "contract.habit-activated", ...active });
  saveWork(cwd, next);
  console.log(`habit 활성화: ${target.habitId}@${target.version}`);
}

export function cmdHabit(cwd: string, args: readonly string[], at: string): void {
  scanHabitArgs(args);
  const [command, ...rest] = args;
  if (command === "observe") commandObserve(cwd, rest, at);
  else if (command === "import") {
    ensureFlags(rest, { valued: ["file"] });
    importRecords(cwd, requiredFlag(rest, "file"), at);
  } else if (command === "propose") commandPropose(cwd, rest, at);
  else if (command === "adopt") commandAdopt(cwd, rest, at);
  else if (command === "retire") commandRetire(cwd, rest, at);
  else if (command === "evaluate") commandEvaluate(cwd, rest, at);
  else if (command === "status") commandStatus(cwd, rest);
  else if (command === "harvest") {
    ensureFlags(rest, { valued: [], boolean: ["json"] });
    const result = harvestHabits(cwd, at);
    if (rest.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else console.log(`habit 수확: ${result.appended}개 추가 · ${result.replayed}개 재사용 · ${result.skippedUnsafe}개 안전 제외`);
  }
  else throw new GdmError("habit 명령이 잘못됐습니다", "usage");
}
