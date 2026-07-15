import { reduceHabitEvents } from "./habit.ts";
import { readHabitLedger } from "./habit-store.ts";

export type HabitOverview = {
  readonly candidates: number;
  readonly adopted: number;
  readonly next: "gdm habit harvest" | "gdm habit status";
};

export function habitOverview(cwd: string): HabitOverview {
  const events = readHabitLedger(cwd);
  const versions = [...reduceHabitEvents(events).versions.values()];
  return {
    candidates: versions.filter((version) => version.adoption === undefined).length,
    adopted: versions.filter((version) => version.adoption !== undefined && version.retirement === undefined).length,
    next: events.length === 0 ? "gdm habit harvest" : "gdm habit status",
  };
}
