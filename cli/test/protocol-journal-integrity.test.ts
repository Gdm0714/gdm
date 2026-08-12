import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCommittedJournal,
  JOURNAL_ANCHOR_SCHEMA_VERSION,
  JOURNAL_FORMAT_BYTES,
  journalAnchorPath,
  journalFilePath,
  journalFormatPath,
  readCommittedJournal,
  type JournalAnchor,
} from "../src/journal-file.ts";
import { GdmError } from "../src/state.ts";
import type { JournalEvent } from "../src/types.ts";

const SLUG = "journal-integrity";
const roots: string[] = [];

function temporary(prefix = "gdm-journal-integrity-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function event(name: string, sequence: number): JournalEvent {
  return { ts: `2026-08-12T00:00:${String(sequence).padStart(2, "0")}.000Z`, event: name, sequence };
}

function expectCorrupt(action: () => unknown): void {
  try {
    action();
    throw new Error("state_corrupt가 필요합니다");
  } catch (error) {
    expect(error).toBeInstanceOf(GdmError);
    expect((error as GdmError).code).toBe("state_corrupt");
  }
}

function anchor(cwd: string): JournalAnchor {
  return JSON.parse(readFileSync(journalAnchorPath(cwd, SLUG), "utf8")) as JournalAnchor;
}

function initialize(cwd: string): JournalEvent[] {
  const events = [event("first", 1), event("second", 2)];
  appendCommittedJournal(cwd, SLUG, events);
  return events;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("committed-prefix journal integrity", () => {
  test("anchor binds schema, committed byte length, line count, and SHA-256", () => {
    const cwd = temporary();
    const events = initialize(cwd);
    const bytes = readFileSync(journalFilePath(cwd, SLUG));
    const committed = anchor(cwd);

    expect(Object.keys(committed).sort()).toEqual(["byteLength", "lineCount", "schemaVersion", "sha256"]);
    expect(committed).toEqual({
      schemaVersion: JOURNAL_ANCHOR_SCHEMA_VERSION,
      byteLength: bytes.byteLength,
      lineCount: events.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(bytes.at(-1)).toBe(0x0a);
    expect(readFileSync(journalFormatPath(cwd, SLUG), "utf8")).toBe(JOURNAL_FORMAT_BYTES);
    expect(readCommittedJournal(cwd, SLUG)).toEqual(events);
  });

  test("once migrated, deleting only the anchor cannot downgrade to legacy parsing", () => {
    const cwd = temporary();
    initialize(cwd);
    unlinkSync(journalAnchorPath(cwd, SLUG));

    expectCorrupt(() => readCommittedJournal(cwd, SLUG));
    expectCorrupt(() => appendCommittedJournal(cwd, SLUG, [event("never", 3)]));
  });

  test("a corrupt or symlinked format marker fails closed without touching its target", () => {
    const corruptCwd = temporary();
    initialize(corruptCwd);
    writeFileSync(journalFormatPath(corruptCwd, SLUG), "legacy\n");
    expectCorrupt(() => readCommittedJournal(corruptCwd, SLUG));
    expectCorrupt(() => appendCommittedJournal(corruptCwd, SLUG, [event("never", 3)]));

    const symlinkCwd = temporary();
    initialize(symlinkCwd);
    const outside = join(temporary("gdm-format-outside-"), "target");
    const unchanged = "outside marker target\n";
    writeFileSync(outside, unchanged);
    unlinkSync(journalFormatPath(symlinkCwd, SLUG));
    symlinkSync(outside, journalFormatPath(symlinkCwd, SLUG));
    expectCorrupt(() => readCommittedJournal(symlinkCwd, SLUG));
    expectCorrupt(() => appendCommittedJournal(symlinkCwd, SLUG, [event("never", 3)]));
    expect(readFileSync(outside, "utf8")).toBe(unchanged);
  });

  test("flip, truncate, delete, and reorder of the committed prefix fail closed", () => {
    const mutations: readonly ((cwd: string) => void)[] = [
      (cwd) => {
        const path = journalFilePath(cwd, SLUG);
        const bytes = readFileSync(path);
        const index = bytes.indexOf(Buffer.from("first", "utf8"));
        bytes[index] = bytes[index]! ^ 1;
        writeFileSync(path, bytes);
      },
      (cwd) => {
        const path = journalFilePath(cwd, SLUG);
        const bytes = readFileSync(path);
        writeFileSync(path, bytes.subarray(0, bytes.byteLength - 1));
      },
      (cwd) => unlinkSync(journalFilePath(cwd, SLUG)),
      (cwd) => {
        const path = journalFilePath(cwd, SLUG);
        const lines = readFileSync(path, "utf8").trimEnd().split("\n");
        writeFileSync(path, `${lines.reverse().join("\n")}\n`);
      },
    ];

    for (const mutate of mutations) {
      const cwd = temporary();
      initialize(cwd);
      mutate(cwd);
      expectCorrupt(() => readCommittedJournal(cwd, SLUG));
    }
  });

  test("an orphan suffix is invisible and the next writer truncates it before committing", () => {
    const cwd = temporary();
    const initial = initialize(cwd);
    const path = journalFilePath(cwd, SLUG);
    const oldAnchor = anchor(cwd);
    appendFileSync(path, '{"event":"orphan","partial":');

    expect(readCommittedJournal(cwd, SLUG)).toEqual(initial);
    expect(lstatSync(path).size).toBeGreaterThan(oldAnchor.byteLength);

    const next = event("after-recovery", 3);
    appendCommittedJournal(cwd, SLUG, [next]);
    expect(readCommittedJournal(cwd, SLUG)).toEqual([...initial, next]);
    expect(readFileSync(path, "utf8")).not.toContain("orphan");
    expect(anchor(cwd).byteLength).toBe(lstatSync(path).size);
  });

  test("a strict legacy journal remains byte-compatible and gains an anchor on first mutation", () => {
    const cwd = temporary();
    const directory = join(cwd, ".gdm", SLUG);
    mkdirSync(directory, { recursive: true });
    const legacy = `${JSON.stringify(event("legacy-one", 1))}\n${JSON.stringify(event("legacy-two", 2))}\n`;
    writeFileSync(journalFilePath(cwd, SLUG), legacy);

    expect(readCommittedJournal(cwd, SLUG).map((item) => item.event)).toEqual(["legacy-one", "legacy-two"]);
    expect(() => lstatSync(journalAnchorPath(cwd, SLUG))).toThrow();

    appendCommittedJournal(cwd, SLUG, [event("v2", 3)]);
    const migrated = readFileSync(journalFilePath(cwd, SLUG), "utf8");
    expect(migrated.startsWith(legacy)).toBe(true);
    expect(anchor(cwd).lineCount).toBe(3);
  });

  test("malformed legacy JSON is normalized to state_corrupt", () => {
    const cwd = temporary();
    const directory = join(cwd, ".gdm", SLUG);
    mkdirSync(directory, { recursive: true });
    writeFileSync(journalFilePath(cwd, SLUG), '{"event":"truncated"');
    expectCorrupt(() => readCommittedJournal(cwd, SLUG));
    expectCorrupt(() => appendCommittedJournal(cwd, SLUG, [event("never", 1)]));
  });

  test("journal and work-directory symlinks never touch an outside target", () => {
    const outside = temporary("gdm-journal-outside-");
    const outsideFile = join(outside, "target.jsonl");
    writeFileSync(outsideFile, "outside remains unchanged\n");

    const finalLinkCwd = temporary();
    mkdirSync(join(finalLinkCwd, ".gdm", SLUG), { recursive: true });
    symlinkSync(outsideFile, journalFilePath(finalLinkCwd, SLUG));
    expectCorrupt(() => readCommittedJournal(finalLinkCwd, SLUG));
    expectCorrupt(() => appendCommittedJournal(finalLinkCwd, SLUG, [event("escape", 1)]));

    const directoryLinkCwd = temporary();
    mkdirSync(join(directoryLinkCwd, ".gdm"));
    symlinkSync(outside, join(directoryLinkCwd, ".gdm", SLUG));
    expectCorrupt(() => appendCommittedJournal(directoryLinkCwd, SLUG, [event("escape", 2)]));
    expect(readFileSync(outsideFile, "utf8")).toBe("outside remains unchanged\n");
  });

  test("a non-regular journal is rejected before open", () => {
    const cwd = temporary();
    const directory = join(cwd, ".gdm", SLUG);
    mkdirSync(journalFilePath(cwd, SLUG), { recursive: true });
    expectCorrupt(() => readCommittedJournal(cwd, SLUG));
    expectCorrupt(() => appendCommittedJournal(cwd, SLUG, [event("never", 1)]));
    expect(lstatSync(directory).isDirectory()).toBe(true);
  });

  test("oversized sparse anchor, marker, and committed prefix fail before allocation", () => {
    const anchorCwd = temporary();
    initialize(anchorCwd);
    truncateSync(journalAnchorPath(anchorCwd, SLUG), 4 * 1024 + 1);
    expectCorrupt(() => readCommittedJournal(anchorCwd, SLUG));

    const markerCwd = temporary();
    initialize(markerCwd);
    truncateSync(journalFormatPath(markerCwd, SLUG), 129);
    expectCorrupt(() => readCommittedJournal(markerCwd, SLUG));

    const journalCwd = temporary();
    const directory = join(journalCwd, ".gdm", SLUG);
    mkdirSync(directory, { recursive: true });
    writeFileSync(journalFilePath(journalCwd, SLUG), "");
    truncateSync(journalFilePath(journalCwd, SLUG), 64 * 1024 * 1024 + 1);
    writeFileSync(journalAnchorPath(journalCwd, SLUG), `${JSON.stringify({
      schemaVersion: JOURNAL_ANCHOR_SCHEMA_VERSION,
      byteLength: 64 * 1024 * 1024 + 1,
      lineCount: 1,
      sha256: "0".repeat(64),
    })}\n`);
    writeFileSync(journalFormatPath(journalCwd, SLUG), JOURNAL_FORMAT_BYTES);
    expectCorrupt(() => readCommittedJournal(journalCwd, SLUG));
  });
});
