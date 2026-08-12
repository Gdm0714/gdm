import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SLUG = "concurrency";
const roots: string[] = [];

function run(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-protocol-concurrency-"));
  roots.push(cwd);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd }).exitCode).toBe(0);
  writeFileSync(join(cwd, "source.txt"), "source\n");
  expect(run(cwd, [
    "plan", "init", "--slug", SLUG, "--brief", "concurrent claim", "--require", "single winner",
    "--forbid", "duplicate claim",
  ]).exitCode).toBe(0);
  expect(run(cwd, [
    "plan", "add", "--slug", SLUG, "--desc", "source", "--cmd", "test -f source.txt",
    "--expect", "exit 0", "--kind", "behavior",
  ]).exitCode).toBe(0);
  return cwd;
}

function currentSnapshot(cwd: string): Record<string, any> {
  const exported = run(cwd, ["protocol", "export", "--slug", SLUG]);
  expect(exported).toMatchObject({ exitCode: 0, stderr: "" });
  return JSON.parse(exported.stdout) as Record<string, any>;
}

function offerArgs(snapshot: Record<string, any>, handoffId: string): string[] {
  return [
    "protocol", "offer", "--slug", SLUG, "--handoff-id", handoffId,
    "--from-role", "coordinator", "--to-role", "reviewer", "--intent", "concurrent offer",
    "--expected-plan-fingerprint", snapshot.work.planFingerprint,
    "--expected-state-fingerprint", snapshot.work.stateFingerprint,
    "--expected-source-fingerprint", snapshot.work.sourceFingerprint.sha256,
  ];
}

async function runConcurrent(cwd: string, commands: readonly (readonly string[])[]) {
  const processes = commands.map((args) => Bun.spawn(
    ["bun", CLI, ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  ));
  return Promise.all(processes.map(async (process) => ({
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  })));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("protocol writer linearizability", () => {
  test("concurrent claims for one handoff have exactly one winner without journal loss", async () => {
    const cwd = repository();
    const snapshot = currentSnapshot(cwd);
    const offered = run(cwd, [
      "protocol", "offer", "--slug", SLUG, "--handoff-id", "one-offer",
      "--from-role", "coordinator", "--to-role", "reviewer", "--intent", "single winner claim",
      "--expected-plan-fingerprint", snapshot.work.planFingerprint,
      "--expected-state-fingerprint", snapshot.work.stateFingerprint,
      "--expected-source-fingerprint", snapshot.work.sourceFingerprint.sha256,
    ]);
    expect(offered.exitCode).toBe(0);
    const handoff = JSON.parse(offered.stdout) as Record<string, any>;

    const contenders = Array.from({ length: 8 }, (_, index) => Bun.spawn([
      "bun", CLI, "protocol", "claim", "--slug", SLUG, "--handoff-event-id", handoff.eventId,
      "--claim-id", `claim-${index}`, "--receiver-role", "reviewer",
      "--capability-profile", "gdm-read-only-specialist/v1",
    ], { cwd, stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(contenders.map(async (process) => ({
      exitCode: await process.exited,
      stdout: await new Response(process.stdout).text(),
      stderr: await new Response(process.stderr).text(),
    })));

    const winners = results.filter((result) => result.exitCode === 0);
    expect(winners).toHaveLength(1);
    expect(JSON.parse(winners[0]!.stdout)).toMatchObject({ schemaVersion: "gdm-dispatch-bundle/v1" });
    const losers = results.filter((result) => result.exitCode !== 0);
    expect(losers).toHaveLength(7);
    expect(losers.every((result) => result.stderr.includes("오류(claim_conflict)"))).toBe(true);

    const journal = readFileSync(join(cwd, ".gdm", SLUG, "journal.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    const claimed = journal.filter((event) => event.event === "protocol_receipt" && event.stage === "claimed");
    expect(claimed).toHaveLength(1);
    const status = run(cwd, ["protocol", "status", "--slug", SLUG]);
    expect(status).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(status.stdout).lifecycles).toHaveLength(1);
  });

  test("concurrent exact offer replay appends one deterministic event", async () => {
    const cwd = repository();
    const snapshot = currentSnapshot(cwd);
    const args = offerArgs(snapshot, "same-offer");
    const results = await runConcurrent(cwd, Array.from({ length: 8 }, () => args));

    expect(results.every((result) => result.exitCode === 0 && result.stderr === "")).toBe(true);
    expect(new Set(results.map((result) => result.stdout)).size).toBe(1);
    const handoffs = readFileSync(join(cwd, ".gdm", SLUG, "journal.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.event === "protocol_handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ handoffId: "same-offer", revision: 1, predecessorEventId: null });
  });

  test("concurrent distinct offers form one lossless causal chain", async () => {
    const cwd = repository();
    const snapshot = currentSnapshot(cwd);
    const count = 8;
    const results = await runConcurrent(
      cwd,
      Array.from({ length: count }, (_, index) => offerArgs(snapshot, `offer-${index}`)),
    );

    expect(results.every((result) => result.exitCode === 0 && result.stderr === "")).toBe(true);
    const handoffs = readFileSync(join(cwd, ".gdm", SLUG, "journal.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.event === "protocol_handoff")
      .sort((left, right) => left.revision - right.revision);
    expect(handoffs).toHaveLength(count);
    expect(new Set(handoffs.map((event) => event.handoffId)).size).toBe(count);
    expect(handoffs.map((event) => event.revision)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(handoffs.map((event) => event.predecessorEventId)).toEqual([
      null,
      ...handoffs.slice(0, -1).map((event) => event.eventId),
    ]);
  });
});
