import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  JOURNAL_FORMAT_BYTES,
  JOURNAL_FAILPOINT_ENV,
  JOURNAL_FAILPOINT_EXIT_CODE,
  journalAnchorPath,
  journalFilePath,
  journalFormatPath,
  readCommittedJournal,
  type JournalAnchor,
} from "../src/journal-file.ts";
import type { JournalEvent } from "../src/types.ts";

const SLUG = "crash-recovery";
const JOURNAL_MODULE = pathToFileURL(join(import.meta.dir, "..", "src", "journal-file.ts")).href;
const LOCK_MODULE = pathToFileURL(join(import.meta.dir, "..", "src", "repository-lock.ts")).href;
const roots: string[] = [];

function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), "gdm-journal-crash-"));
  roots.push(path);
  return path;
}

function event(name: string, sequence: number): JournalEvent {
  return { ts: `2026-08-12T00:00:${String(sequence).padStart(2, "0")}.000Z`, event: name, sequence };
}

function createLegacyJournal(cwd: string, value: JournalEvent): void {
  mkdirSync(join(cwd, ".gdm", SLUG), { recursive: true });
  writeFileSync(journalFilePath(cwd, SLUG), `${JSON.stringify(value)}\n`);
}

function runLockedWriter(
  cwd: string,
  value: JournalEvent,
  failpoint?: "after-data-fsync" | "after-anchor-rename",
): ReturnType<typeof Bun.spawnSync> {
  const source = [
    `import { appendCommittedJournal } from ${JSON.stringify(JOURNAL_MODULE)};`,
    `import { acquireRepositoryLock } from ${JSON.stringify(LOCK_MODULE)};`,
    `const release = acquireRepositoryLock(${JSON.stringify(cwd)});`,
    "try {",
    `  appendCommittedJournal(${JSON.stringify(cwd)}, ${JSON.stringify(SLUG)}, [${JSON.stringify(value)}]);`,
    "} finally {",
    "  release();",
    "}",
  ].join("\n");
  const env = { ...process.env } as Record<string, string>;
  delete env[JOURNAL_FAILPOINT_ENV];
  if (failpoint !== undefined) env[JOURNAL_FAILPOINT_ENV] = failpoint;
  return Bun.spawnSync(["bun", "--eval", source], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readAnchor(cwd: string): JournalAnchor {
  return JSON.parse(readFileSync(journalAnchorPath(cwd, SLUG), "utf8")) as JournalAnchor;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("journal crash commit points", () => {
  test("exit after data fsync exposes the old prefix and retry removes the orphan batch", () => {
    const cwd = temporary();
    const initial = event("initial", 1);
    const retried = event("retry-me", 2);
    createLegacyJournal(cwd, initial);

    const crashed = runLockedWriter(cwd, retried, "after-data-fsync");
    expect(crashed.exitCode, crashed.stderr?.toString()).toBe(JOURNAL_FAILPOINT_EXIT_CODE);
    const oldAnchor = readAnchor(cwd);
    expect(readCommittedJournal(cwd, SLUG)).toEqual([initial]);
    expect(() => lstatSync(journalFormatPath(cwd, SLUG))).toThrow();
    expect(lstatSync(journalFilePath(cwd, SLUG)).size).toBeGreaterThan(oldAnchor.byteLength);

    const recovered = runLockedWriter(cwd, retried);
    expect(recovered.exitCode, recovered.stderr?.toString()).toBe(0);
    expect(readCommittedJournal(cwd, SLUG)).toEqual([initial, retried]);
    expect(readFileSync(journalFilePath(cwd, SLUG), "utf8").match(/retry-me/gu)).toHaveLength(1);
    expect(readAnchor(cwd).byteLength).toBe(lstatSync(journalFilePath(cwd, SLUG)).size);
    expect(readFileSync(journalFormatPath(cwd, SLUG), "utf8")).toBe(JOURNAL_FORMAT_BYTES);
  });

  test("exit after anchor rename exposes the new prefix and the next locked write converges", () => {
    const cwd = temporary();
    const initial = event("initial", 1);
    const committed = event("committed-before-exit", 2);
    const next = event("next-writer", 3);
    createLegacyJournal(cwd, initial);

    const crashed = runLockedWriter(cwd, committed, "after-anchor-rename");
    expect(crashed.exitCode, crashed.stderr?.toString()).toBe(JOURNAL_FAILPOINT_EXIT_CODE);
    expect(readCommittedJournal(cwd, SLUG)).toEqual([initial, committed]);
    expect(() => lstatSync(journalFormatPath(cwd, SLUG))).toThrow();
    expect(readAnchor(cwd).byteLength).toBe(lstatSync(journalFilePath(cwd, SLUG)).size);

    const recovered = runLockedWriter(cwd, next);
    expect(recovered.exitCode, recovered.stderr?.toString()).toBe(0);
    expect(readCommittedJournal(cwd, SLUG)).toEqual([initial, committed, next]);
    expect(readAnchor(cwd).byteLength).toBe(lstatSync(journalFilePath(cwd, SLUG)).size);
    expect(readFileSync(journalFormatPath(cwd, SLUG), "utf8")).toBe(JOURNAL_FORMAT_BYTES);
  });
});
