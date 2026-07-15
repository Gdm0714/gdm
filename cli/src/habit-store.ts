import { assertNoSensitiveRaw } from "./contract.ts";
import {
  habitLedgerFilePath,
  readHabitLedgerFile,
  updateHabitLedgerFile,
} from "./habit-ledger-file.ts";
import type { HabitLedgerFileUpdate } from "./habit-ledger-file.ts";
import { reduceHabitEvents } from "./habit-state.ts";
import type { HabitEvent } from "./habit-types.ts";
import { validateHabitEventFields } from "./habit-validation.ts";
import { GdmError } from "./state.ts";

const MAX_EVENT_BYTES = 2048;
const COMMON_KEYS = ["schemaVersion", "eventId", "at", "kind"] as const;
const OBSERVATION_KEYS = [
  ...COMMON_KEYS, "pattern", "taxonomy", "sourceToken", "sourceGroup", "sourceKind",
] as const;
const PROPOSAL_KEYS = [
  ...COMMON_KEYS, "habitId", "version", "pattern", "statement", "sourceEventIds",
] as const;
const ADOPTION_KEYS = [
  ...COMMON_KEYS, "habitId", "version", "ruleRef", "ruleHash", "reason",
] as const;
const RETIREMENT_KEYS = [...COMMON_KEYS, "habitId", "version", "reason"] as const;
const EVALUATION_KEYS = [
  ...COMMON_KEYS, "habitId", "version", "workSlug", "outcome", "revision", "predecessorEventId",
] as const;
const CORRECTION_KEYS = [...EVALUATION_KEYS, "reason"] as const;

type LedgerSnapshot = {
  readonly bytes: string;
  readonly events: readonly HabitEvent[];
};

export type HabitAppendResult = { readonly appended: number };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasCommonFields(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value.schemaVersion === 1 &&
    typeof value.eventId === "string" &&
    typeof value.at === "string"
  );
}

function isHabitEvent(value: unknown): value is HabitEvent {
  if (!isRecord(value) || !hasCommonFields(value)) return false;
  switch (value.kind) {
    case "observation":
      return (
        hasExactKeys(value, OBSERVATION_KEYS) &&
        typeof value.pattern === "string" &&
        typeof value.taxonomy === "string" &&
        typeof value.sourceToken === "string" &&
        typeof value.sourceGroup === "string" &&
        typeof value.sourceKind === "string"
      );
    case "proposal":
      return (
        hasExactKeys(value, PROPOSAL_KEYS) &&
        typeof value.habitId === "string" &&
        Number.isInteger(value.version) &&
        typeof value.pattern === "string" &&
        typeof value.statement === "string" &&
        Array.isArray(value.sourceEventIds) &&
        value.sourceEventIds.every((eventId) => typeof eventId === "string")
      );
    case "adoption":
      return (
        hasExactKeys(value, ADOPTION_KEYS) &&
        typeof value.habitId === "string" &&
        Number.isInteger(value.version) &&
        typeof value.ruleRef === "string" &&
        typeof value.ruleHash === "string" &&
        typeof value.reason === "string"
      );
    case "retirement":
      return (
        hasExactKeys(value, RETIREMENT_KEYS) &&
        typeof value.habitId === "string" &&
        Number.isInteger(value.version) &&
        typeof value.reason === "string"
      );
    case "evaluation":
      return (
        hasExactKeys(value, value.reason === undefined ? EVALUATION_KEYS : CORRECTION_KEYS) &&
        typeof value.habitId === "string" &&
        Number.isInteger(value.version) &&
        typeof value.workSlug === "string" &&
        typeof value.outcome === "string" &&
        Number.isInteger(value.revision) &&
        (value.predecessorEventId === null || typeof value.predecessorEventId === "string") &&
        (value.reason === undefined || typeof value.reason === "string")
      );
    default:
      return false;
  }
}

function scanStrings(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    assertNoSensitiveRaw(value, "habitLedger");
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) throw new GdmError("habit_event_invalid category=cycle", "habit_event_invalid");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) scanStrings(item, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertNoSensitiveRaw(key, "habitLedgerKey");
    scanStrings(item, seen);
  }
}

function corruption(line: number, category: string): GdmError {
  return new GdmError(
    `habit_ledger_corrupt line=${line} category=${category}`,
    "habit_ledger_corrupt",
  );
}

function parseLine(raw: string, line: number): HabitEvent {
  if (Buffer.byteLength(`${raw}\n`, "utf8") >= MAX_EVENT_BYTES) throw corruption(line, "size");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw corruption(line, "json");
    throw error;
  }
  try {
    scanStrings(value);
  } catch (error) {
    if (error instanceof GdmError) throw corruption(line, "privacy");
    throw error;
  }
  if (!isHabitEvent(value)) throw corruption(line, "shape");
  try {
    validateHabitEventFields(value);
  } catch (error) {
    if (error instanceof GdmError) throw corruption(line, "fields");
    throw error;
  }
  return value;
}

function parseSnapshot(bytes: string): LedgerSnapshot {
  const physicalLines = bytes.split("\n");
  const events: HabitEvent[] = [];
  for (const [index, raw] of physicalLines.entries()) {
    const line = index + 1;
    if (raw.length === 0) {
      if (index === physicalLines.length - 1) continue;
      throw corruption(line, "blank");
    }
    const event = parseLine(raw, line);
    try {
      reduceHabitEvents([...events, event]);
    } catch (error) {
      if (error instanceof GdmError) throw corruption(line, "transition");
      throw error;
    }
    events.push(event);
  }
  return { bytes, events };
}

function readSnapshot(cwd: string): LedgerSnapshot {
  return parseSnapshot(readHabitLedgerFile(cwd) ?? "");
}

function serializeCandidate(event: HabitEvent): string {
  try {
    scanStrings(event);
    if (!isHabitEvent(event)) {
      throw new GdmError("habit_event_invalid category=shape", "habit_event_invalid");
    }
    validateHabitEventFields(event);
  } catch (error) {
    if (error instanceof GdmError && error.code === "privacy_rejected") throw error;
    if (error instanceof GdmError) {
      throw new GdmError("habit_event_invalid category=fields", "habit_event_invalid");
    }
    throw error;
  }
  const serialized = JSON.stringify(event);
  if (serialized === undefined || Buffer.byteLength(`${serialized}\n`, "utf8") >= MAX_EVENT_BYTES) {
    throw new GdmError("habit_event_invalid category=size", "habit_event_invalid");
  }
  return serialized;
}

export function habitLedgerPath(cwd: string): string {
  return habitLedgerFilePath(cwd);
}

export function readHabitLedger(cwd: string): readonly HabitEvent[] {
  return readSnapshot(cwd).events;
}

function prepareAppend(
  snapshot: LedgerSnapshot,
  candidates: readonly HabitEvent[],
  serialized: readonly string[],
): HabitLedgerFileUpdate<HabitAppendResult> {
  try {
    reduceHabitEvents([...snapshot.events, ...candidates]);
  } catch (error) {
    if (error instanceof GdmError) {
      throw new GdmError("habit_event_invalid category=transition", "habit_event_invalid");
    }
    throw error;
  }
  const knownIds = new Set(snapshot.events.map((event) => event.eventId));
  const additions: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (knownIds.has(candidate.eventId)) continue;
    knownIds.add(candidate.eventId);
    const line = serialized[index];
    if (line !== undefined) additions.push(line);
  }
  const value = { appended: additions.length };
  if (additions.length === 0) return { kind: "unchanged", value };
  const separator = snapshot.bytes.length > 0 && !snapshot.bytes.endsWith("\n") ? "\n" : "";
  const bytes = `${snapshot.bytes}${separator}${additions.join("\n")}\n`;
  return { kind: "replace", bytes, value };
}

export function appendHabitEvents(
  cwd: string,
  candidates: readonly HabitEvent[],
): HabitAppendResult {
  const serialized = candidates.map((candidate) => serializeCandidate(candidate));
  const preflight = prepareAppend(readSnapshot(cwd), candidates, serialized);
  if (preflight.kind === "unchanged") return preflight.value;
  return updateHabitLedgerFile(cwd, (current) =>
    prepareAppend(parseSnapshot(current ?? ""), candidates, serialized),
  );
}
