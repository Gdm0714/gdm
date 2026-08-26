import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { opaqueId } from "./contract.ts";
import { parseHarvestJson } from "./habit-json.ts";
import { createObservation } from "./habit.ts";
import { appendHabitEvents, readHabitLedger } from "./habit-store.ts";
import { workSlug } from "./habit-validation.ts";
import { readCommittedJournal } from "./journal-file.ts";
import type { HabitEvent, HabitTaxonomy } from "./habit.ts";

type EventClass = "miss" | "denied-repeat" | "recheck-failed" | "plan-edit";

type Mapping = {
  readonly eventClass: EventClass;
  readonly pattern: string;
  readonly taxonomy: HabitTaxonomy;
};

export type HarvestResult = {
  readonly scanned: number;
  readonly mapped: number;
  readonly appended: number;
  readonly replayed: number;
  readonly skippedUnsafe: number;
  readonly skippedUnrecognized: number;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sourceGroup(slug: string): string {
  return `grp-${hash16(`gdm-harvest-group-v1\0${slug}`)}`;
}

function sourceToken(slug: string, line: number, eventClass: EventClass): string {
  return `src-${hash16(`gdm-harvest-source-v1\0${slug}\0${line}\0${eventClass}`)}`;
}

function mapping(
  value: unknown,
  denied: Map<string, number>,
): Mapping | undefined {
  if (!isRecord(value)) return undefined;
  if (value.event === "miss" && typeof value.desc === "string" && value.desc.trim().length > 0) {
    // 점으로 나뉜 8자+ 세그먼트 3개는 프라이버시 스캐너가 JWT로 오탐하므로 하이픈으로 잇는다.
    const type = typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
    const pattern = type.length > 0
      ? `verification.escape-after-done-${hash16(type)}`
      : "verification.escape-after-done";
    return { eventClass: "miss", pattern, taxonomy: "verification" };
  }
  if (value.event === "recheck" && value.ok === false) {
    return { eventClass: "recheck-failed", pattern: "verification.failed-recheck", taxonomy: "verification" };
  }
  if (value.event === "plan.edit" && typeof value.reason === "string" && value.reason.trim().length > 0) {
    return { eventClass: "plan-edit", pattern: "intent.criteria-revised", taxonomy: "intent" };
  }
  if (value.event !== "denied" || typeof value.code !== "string") return undefined;
  try {
    opaqueId(value.code, "harvest-code");
  } catch {
    return undefined;
  }
  const count = (denied.get(value.code) ?? 0) + 1;
  denied.set(value.code, count);
  return count < 2
    ? undefined
    : { eventClass: "denied-repeat", pattern: "recovery.repeated-denial", taxonomy: "recovery" };
}

function workDirectories(cwd: string): readonly string[] {
  const root = join(cwd, ".gdm");
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return [];
  const slugs: string[] = [];
  for (const name of readdirSync(root).sort()) {
    let slug: string;
    try {
      slug = workSlug(name);
    } catch {
      continue;
    }
    const directory = join(root, name);
    if (
      !existsSync(directory) ||
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink()
    ) continue;
    slugs.push(slug);
  }
  return slugs;
}

export function harvestHabits(cwd: string, at: string): HarvestResult {
  const candidates: { readonly slug: string; readonly line: number; readonly mapping: Mapping }[] = [];
  let scanned = 0;
  let skippedUnsafe = 0;
  let skippedUnrecognized = 0;
  for (const slug of workDirectories(cwd)) {
    const denied = new Map<string, number>();
    const events = readCommittedJournal(cwd, slug);
    for (const [index, event] of events.entries()) {
      scanned++;
      let value: unknown;
      try {
        // Re-run the privacy scanner over the parsed committed event. Array
        // order is the original 1-based JSONL line order, preserving stable
        // sourceToken identities while keeping all file I/O behind the anchor.
        const raw = JSON.stringify(event);
        if (raw.length === 0 || Buffer.byteLength(raw, "utf8") >= 2048) throw new Error("unsafe");
        value = parseHarvestJson(raw, "harvest");
      } catch {
        skippedUnsafe++;
        continue;
      }
      const recognized = mapping(value, denied);
      if (recognized === undefined) {
        skippedUnrecognized++;
        continue;
      }
      candidates.push({ slug, line: index + 1, mapping: recognized });
    }
  }
  let working = readHabitLedger(cwd);
  const additions: HabitEvent[] = [];
  let replayed = 0;
  for (const candidate of candidates) {
    const mutation = createObservation(working, {
      pattern: candidate.mapping.pattern,
      taxonomy: candidate.mapping.taxonomy,
      sourceToken: sourceToken(candidate.slug, candidate.line, candidate.mapping.eventClass),
      sourceGroup: sourceGroup(candidate.slug),
      sourceKind: "incident",
    }, at);
    if (mutation.changed) {
      additions.push(mutation.event);
      working = [...working, mutation.event];
    } else {
      replayed++;
    }
  }
  const appended = appendHabitEvents(cwd, additions).appended;
  return { scanned, mapped: candidates.length, appended, replayed, skippedUnsafe, skippedUnrecognized };
}
