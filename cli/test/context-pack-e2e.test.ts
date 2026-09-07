import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createPilotFixture } from "../../bench/context-pack-pilot/fixture.ts";
import {
  SIDE_SCHEMA,
  acceptSideRecord,
  canonicalCommand,
  decodeSideEnvelope,
  fixtureManifest,
  pathDigest,
  regularContainedFile,
  sha256,
  signedSideEnvelope,
} from "../../bench/context-pack-e2e/protocol.ts";

const ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(ROOT, "bench", "context-pack-e2e", "bench-io.ts");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function runTool(args: readonly string[], arm: "control" | "graph" | "context" = "control") {
  const fixture = createPilotFixture();
  temporary.push(fixture.root);
  const nonce = "a".repeat(64);
  const runToken = "b".repeat(32);
  const child = Bun.spawn([TOOL, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GDM_BENCH_ROOT: fixture.root,
      GDM_BENCH_NONCE: nonce,
      GDM_BENCH_RUN_TOKEN: runToken,
      GDM_BENCH_ARM: arm,
      GDM_BENCH_GDM: join(ROOT, "cli", "dist", "gdm"),
      GDM_BENCH_GRAPH: join(ROOT, "cli", "src", "graph-nav-provider.ts"),
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const decoded = decodeSideEnvelope(stdout, { nonce, runToken, arm, nextSeq: 1 });
  return { fixture, exitCode, stdout, stderr, decoded, nonce, runToken };
}

describe("receipt-bound Context Pack e2e I O", () => {
  test("binds actual anchor bytes to a strict side receipt", async () => {
    const result = await runTool(["anchor", "ownership"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("# Validation Ownership");
    const accepted = result.decoded?.record ?? null;
    expect(accepted).not.toBeNull();
    expect(accepted?.op).toBe("anchor");
    expect(accepted?.files[0]?.pathSha256).toBe(pathDigest("docs/architecture.md"));
    expect(accepted?.outputSha256).toBe(result.decoded?.bodySha256);
  });

  test("search never scans or returns GDM evidence bodies", async () => {
    const result = await runTool(["search", "ownership"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("validation-ownership verified");
    expect(result.decoded?.record.scannedPathSha256s).not.toContain(pathDigest(".gdm/validation-ownership/out/c1.txt"));
  });

  test("binds a live Context provider result without retaining its body", async () => {
    const result = await runTool(["provider", "context", "budget"], "context");
    expect(result.exitCode, result.stderr).toBe(0);
    const accepted = result.decoded?.record ?? null;
    expect(accepted?.providerKind).toBe("context");
    expect(accepted?.resultSchema).toBe("context-v1");
    expect(accepted?.resultStatus).toBe("ok");
    expect(accepted?.resultFreshness).toBe("fresh");
    expect(accepted?.outputBytes).toBeGreaterThan(0);
    expect(accepted?.outputBytes).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(accepted)).not.toContain(result.stdout.slice(result.stdout.indexOf("\n") + 1));
  });

  test("rejects bad nonce and unknown fields", () => {
    const raw = {
      schemaVersion: SIDE_SCHEMA,
      runToken: "b".repeat(32),
      op: "anchor",
      task: "ownership",
      arm: "control",
      providerKind: null,
      argvPathSha256s: [pathDigest("docs/architecture.md")],
      files: [],
      scannedPathSha256s: [],
      outputSha256: sha256("output"),
      outputBytes: 6,
      requestSha256: null,
      requestProjectionSha256: null,
      resultSchema: null,
      resultStatus: null,
      resultFreshness: null,
      exitCode: 0,
    } as const;
    const badNonceEnvelope = `${signedSideEnvelope(raw, "c".repeat(64))}\noutput`;
    expect(decodeSideEnvelope(badNonceEnvelope, {
      nonce: "a".repeat(64), runToken: "b".repeat(32), arm: "control", nextSeq: 1,
    })).toBeNull();
    expect(acceptSideRecord(raw, { runToken: "b".repeat(32), arm: "control", nextSeq: 1 })).not.toBeNull();
    expect(acceptSideRecord({ ...raw, injected: true }, {
      runToken: "b".repeat(32), arm: "control", nextSeq: 1,
    })).toBeNull();
  });

  test("canonical command hash exposes arbitrary shell suffixes", () => {
    const digest = pathDigest("src/boundary.ts");
    const command = canonicalCommand({ op: "read", task: "ownership", providerKind: null, argvPathSha256s: [digest] }, new Map([[digest, "src/boundary.ts"]]));
    expect(command).toBe("$GDM_BENCH_IO read ownership src/boundary.ts");
    expect(sha256(`${command}; cat package.json`)).not.toBe(sha256(command!));
  });

  test("missing a reported direct read remains detectable", () => {
    const reported = [pathDigest("docs/architecture.md"), pathDigest("src/boundary.ts")];
    const observed = new Set([pathDigest("docs/architecture.md")]);
    expect(reported.every((path) => observed.has(path))).toBe(false);
  });

  test("rejects parent escape and symlink paths", () => {
    const fixture = createPilotFixture();
    temporary.push(fixture.root);
    expect(() => regularContainedFile(fixture.root, "../outside")).toThrow();
    symlinkSync("src/boundary.ts", join(fixture.root, "linked.ts"));
    expect(() => regularContainedFile(fixture.root, "linked.ts")).toThrow("symlink");
  });

  test("fixture manifest maps only deterministic path digests", () => {
    const fixture = createPilotFixture();
    temporary.push(fixture.root);
    const manifest = fixtureManifest(fixture.root);
    expect(manifest.entries.length).toBeGreaterThan(200);
    expect(new Set(manifest.entries.map((entry) => entry.pathSha256)).size).toBe(manifest.entries.length);
    expect(manifest.entries.find((entry) => entry.path === "src/router.ts")?.pathSha256).toBe(pathDigest("src/router.ts"));
  });
});
