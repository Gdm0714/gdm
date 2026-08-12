import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SLUG = "integrity-v2";
const roots: string[] = [];

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function tempDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function tempRepository(): string {
  const cwd = tempDirectory("gdm-protocol-integrity-");
  const initialized = Bun.spawnSync(["git", "init", "-q"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(initialized.exitCode).toBe(0);
  writeFileSync(join(cwd, "src.txt"), "stable source\n");
  return cwd;
}

function runCli(cwd: string, args: readonly string[]): CliResult {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function initializeWork(cwd: string): void {
  const initialized = runCli(cwd, [
    "plan",
    "init",
    "--slug",
    SLUG,
    "--brief",
    "protocol trust boundary regression",
    "--require",
    "persisted state integrity",
    "--forbid",
    "outside writes",
  ]);
  expect(initialized).toMatchObject({ exitCode: 0, stderr: "" });
  const added = runCli(cwd, [
    "plan",
    "add",
    "--slug",
    SLUG,
    "--desc",
    "source remains readable",
    "--cmd",
    "test -f src.txt",
    "--expect",
    "exit 0",
    "--kind",
    "behavior",
  ]);
  expect(added).toMatchObject({ exitCode: 0, stderr: "" });
}

function workPath(cwd: string): string {
  return join(cwd, ".gdm", SLUG, "checks.json");
}

function journalPath(cwd: string): string {
  return join(cwd, ".gdm", SLUG, "journal.jsonl");
}

function readJournal(cwd: string): Record<string, any>[] {
  return readFileSync(journalPath(cwd), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function writeJournal(cwd: string, events: readonly Record<string, any>[]): void {
  writeFileSync(journalPath(cwd), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

function handoffArgs(id: string, artifact?: string): string[] {
  return [
    "protocol",
    "handoff",
    "--slug",
    SLUG,
    "--handoff-id",
    id,
    "--from-role",
    "implementer",
    "--to-role",
    "auditor",
    "--intent",
    "review persisted protocol integrity",
    ...(artifact === undefined ? [] : ["--artifact", artifact]),
  ];
}

function expectStateCorrupt(result: CliResult): void {
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("오류(state_corrupt)");
  expect(result.stderr).not.toContain("오류(internal)");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("protocol v2 persisted-state integrity", () => {
  test("journal symlink cannot append outside the repository", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    const outside = tempDirectory("gdm-protocol-outside-");
    const outsideJournal = join(outside, "outside.jsonl");
    writeFileSync(outsideJournal, "");
    unlinkSync(journalPath(cwd));
    symlinkSync(outsideJournal, journalPath(cwd));

    const result = runCli(cwd, handoffArgs("outside-journal"));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/^오류\((?!internal\))[^)]+\):/u);
    expect(readFileSync(outsideJournal, "utf8")).toBe("");
  });

  test("forged completed Work with an open check is state_corrupt", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    const work = JSON.parse(readFileSync(workPath(cwd), "utf8")) as Record<string, any>;
    work.done = true;
    work.doneAt = work.createdAt;
    writeFileSync(workPath(cwd), JSON.stringify(work, null, 2) + "\n");

    expectStateCorrupt(runCli(cwd, ["protocol", "export", "--slug", SLUG]));
  });

  test("a damaged handoff event discriminator is state_corrupt", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    expect(runCli(cwd, handoffArgs("valid-before-damage"))).toMatchObject({ exitCode: 0, stderr: "" });
    const events = readJournal(cwd);
    const handoff = events.find((event) => event.event === "protocol_handoff");
    expect(handoff).toBeDefined();
    handoff!.event = "protocol_handoff_damaged";
    writeJournal(cwd, events);

    expectStateCorrupt(runCli(cwd, ["protocol", "export", "--slug", SLUG]));
  });

  test("changed handoff artifact is reported as artifact_changed", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    const artifact = `.gdm/${SLUG}/handoff-artifact.md`;
    writeFileSync(join(cwd, artifact), "original artifact bytes\n");
    expect(runCli(cwd, handoffArgs("artifact-bound", artifact))).toMatchObject({ exitCode: 0, stderr: "" });
    writeFileSync(join(cwd, artifact), "changed artifact bytes\n");

    const exported = runCli(cwd, ["protocol", "export", "--slug", SLUG]);
    expect(exported).toMatchObject({ exitCode: 0, stderr: "" });
    const snapshot = JSON.parse(exported.stdout) as Record<string, any>;
    expect(snapshot.latestHandoff).toMatchObject({
      handoffId: "artifact-bound",
      stale: true,
      staleReasons: ["artifact_changed"],
    });
  });

  test("truncated malformed journal is normalized to state_corrupt", () => {
    const cwd = tempRepository();
    initializeWork(cwd);
    writeFileSync(journalPath(cwd), '{"ts":"2026-08-12T00:00:00.000Z","event":"protocol_handoff"');

    expectStateCorrupt(runCli(cwd, ["protocol", "export", "--slug", SLUG]));
  });
});
