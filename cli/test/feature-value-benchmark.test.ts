import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRememberEvent,
  renderMemoryBlock,
  selectMemories,
} from "../../tests/integrations/oracles/memory-core.ts";
import {
  CHILD_SCHEMA,
  MANIFEST_SCHEMA,
  MEMORY_SCENARIOS,
  POINTER_SCHEMA,
  PROTOCOL,
  REGISTRATION_ARMS,
  RETENTION,
  SOURCE_IDS,
  SUMMARY_SCHEMA,
  acceptChildProbe,
  acceptStage0Summary,
  distribution,
  scanSensitive,
  sha256,
  type Distribution,
  type RegistrationArm,
  type Stage0Summary,
} from "../../bench/feature-value/protocol.ts";
import {
  publishSummary,
  readPublished,
  writeExclusive,
} from "../../bench/feature-value/result.ts";

const roots: string[] = [];
const HASH = "a".repeat(64);

function metric(samples = 1): Distribution {
  return { samples, min: 1, median: 1, p95: 1, max: 1 };
}

function arm(name: RegistrationArm, repetitions = 1) {
  const toolCount = name === "baseline" || name === "status" ? 0 : name === "both" || name === "all" ? 2 : 1;
  const status = name === "status" || name === "all";
  return {
    arm: name,
    repetitions,
    toolCount,
    toolSchemaBytes: toolCount * 100,
    promptMetadataBytes: toolCount * 200,
    toolDefinitionBytes: toolCount * 300,
    statusIntervalMs: status ? 1000 : null,
    statusFetchCalls: 0,
    statusSetCalls: status ? 3 : 0,
    statusFormattingValid: status ? true : null,
    statusProviderHideValid: status ? true : null,
    processWallMs: metric(repetitions),
    loadMs: metric(repetitions),
    cpuUserMicros: metric(repetitions),
    cpuSystemMicros: metric(repetitions),
    rssBytes: metric(repetitions),
    heapUsedBytes: metric(repetitions),
  } as const;
}

function fixtureSummary(runId = "b".repeat(32)): Stage0Summary {
  const source = SOURCE_IDS.map((id) => ({ id, sha256: sha256(id), bytes: 1 }));
  return {
    schemaVersion: SUMMARY_SCHEMA,
    protocol: PROTOCOL,
    scale: "local-stage0",
    runId,
    createdAt: "2026-09-04T00:00:00.000Z",
    retention: RETENTION,
    measurementScope: "cost-and-safety-only",
    utilityConclusion: "not-measured",
    freshInputConclusion: "not-measured",
    promotionEligible: false,
    removalEligible: false,
    defaultActivation: "unchanged",
    source,
    sourceSha256: sha256(JSON.stringify(source)),
    registration: { repetitions: 1, arms: REGISTRATION_ARMS.map((name) => arm(name)) },
    memory: {
      syntheticOnly: true,
      corpusSha256: HASH,
      selectionIterations: 1,
      storeReadIterations: 1,
      zeroOverlapInjects: true,
      scenarios: MEMORY_SCENARIOS.map((id) => ({
        id,
        totalEntries: id === "empty" ? 0 : id === "irrelevant-10" ? 10 : 200,
        selectedProject: id === "empty" ? 0 : 6,
        selectedGlobal: id === "empty" ? 0 : 4,
        renderedChars: id === "empty" ? 0 : 100,
        renderedBytes: id === "empty" ? 0 : 100,
        selectedSha256: HASH,
        storeBytes: id === "empty" ? 0 : 100,
        relevantEntryFirst: id === "relevant-200" ? true : null,
        selectionMs: metric(),
        storeReadMs: metric(),
      })),
    },
    computerUse: {
      trialsPlanned: 1,
      trials: [{
        trial: 1,
        startMs: 1,
        screenshotMs: 1,
        guiMutationMs: 1,
        stopMs: 1,
        pngBytes: 1,
        frameWidth: 1,
        frameHeight: 1,
        vmProcessCount: 1,
        vmRssBytes: 1,
        vmCpuPercent: 1,
        vmDiskBytesBefore: 1,
        vmDiskBytesAfter: 1,
        hostFocusChanges: 0,
        hostTcpListenerLines: 0,
        hostSentinelCreated: false,
        guestWriteVerified: true,
        cleanupVerified: true,
        failureCode: null,
        valid: true,
      }],
      safetyViolations: 0,
      liveValid: true,
    },
    statusline: {
      measurementScope: "display-extension-only",
      piCodexLimitIncluded: false,
      qualityConclusion: "not-measured",
      available: true,
      intervalMs: 1000,
      fetchCalls: 0,
      formattingValid: true,
      providerHideValid: true,
    },
    contextCarryForward: {
      measurementValid: false,
      validRuns: 13,
      totalRuns: 18,
      tokenConclusion: "invalid-not-evidence",
      promotionEligible: false,
      defaultActivation: "blocked",
    },
    gates: {
      sourceBound: true,
      syntheticOnly: true,
      bodyFree: true,
      registrationComplete: true,
      memoryComplete: true,
      statusComplete: true,
      contextCarryForwardValid: true,
      computerUseComplete: true,
      computerUseSafety: true,
    },
    measurementValid: true,
    stage1Eligible: true,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("recent feature value Stage 0 benchmark", () => {
  test("computes bounded distributions deterministically", () => {
    expect(distribution([9, 1, 5, 3, 7])).toEqual({ samples: 5, min: 1, median: 5, p95: 9, max: 9 });
    expect(() => distribution([])).toThrow();
    expect(() => distribution([1, Number.NaN])).toThrow();
  });

  test("accepts only exact body-free child probe records", () => {
    const probe = {
      schemaVersion: CHILD_SCHEMA,
      arm: "memory",
      loadMs: 1,
      cpuUserMicros: 1,
      cpuSystemMicros: 1,
      rssBytes: 1,
      heapUsedBytes: 1,
      toolCount: 1,
      toolSchemaBytes: 1,
      promptMetadataBytes: 1,
      toolDefinitionBytes: 1,
      statusIntervalMs: null,
      statusFetchCalls: 0,
      statusSetCalls: 0,
      statusFormattingValid: null,
      statusProviderHideValid: null,
    } as const;
    expect(acceptChildProbe(probe, "memory")).not.toBeNull();
    expect(acceptChildProbe({ ...probe, body: "synthetic output" }, "memory")).toBeNull();
    expect(acceptChildProbe({ ...probe, arm: "status" }, "memory")).toBeNull();
  });

  test("selects bounded zero-overlap memories and ranks a lexical match first", () => {
    const project = Array.from({ length: 100 }, (_, index) => createRememberEvent({
      scope: "project",
      text: index === 0 ? "Quartz policy requires cobalt output" : `Synthetic amber preference ${index}`,
      source: "tool-auto",
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      projectRealpath: "/tmp/gdm-feature-value-test-project",
    }));
    const global = Array.from({ length: 100 }, (_, index) => createRememberEvent({
      scope: "global",
      text: `Synthetic global amber preference ${index}`,
      source: "tool-auto",
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    }));
    const irrelevant = selectMemories({ prompt: "quartz cobalt", project: project.slice(1), global });
    expect(irrelevant.project).toHaveLength(6);
    expect(irrelevant.global).toHaveLength(4);
    expect(renderMemoryBlock(irrelevant).length).toBeGreaterThan(0);
    const relevant = selectMemories({ prompt: "quartz cobalt", project, global });
    expect(relevant.project[0]?.id).toBe(project[0]?.id);
    expect(renderMemoryBlock(relevant).length).toBeLessThanOrEqual(2400);
  });

  test("rejects unexpected body keys, secret-shaped values, and inconsistent validity", () => {
    const summary = fixtureSummary();
    expect(acceptStage0Summary(summary)).not.toBeNull();
    expect(acceptStage0Summary({ ...summary, response: "raw" })).toBeNull();
    expect(() => scanSensitive({ note: "api_key=not-allowed-in-results" })).toThrow("secret-shaped");
    expect(acceptStage0Summary({ ...summary, measurementValid: false })).toBeNull();
    const preservedInvalid = {
      ...summary,
      computerUse: { ...summary.computerUse, trialsPlanned: 3, liveValid: false },
      gates: { ...summary.gates, computerUseComplete: false },
      measurementValid: false,
      stage1Eligible: false,
    };
    expect(acceptStage0Summary(preservedInvalid)).not.toBeNull();
    expect(acceptStage0Summary({ ...summary, sourceSha256: HASH })).toBeNull();
  });

  test("publishes create-only immutable runs and rejects symlink pointers", () => {
    const root = mkdtempSync(join(tmpdir(), "gdm-feature-value-result-test-"));
    roots.push(root);
    const summary = fixtureSummary();
    const published = publishSummary(summary, root);
    expect(published.pointerPath).toBeDefined();
    expect(readPublished(published.pointerPath!, root).summary.runId).toBe(summary.runId);
    expect(() => publishSummary(summary, root)).toThrow();
    const linked = join(root, "linked.json");
    symlinkSync(published.pointerPath!, linked);
    expect(() => readPublished(linked, root)).toThrow("unsafe result file");
  });

  test("exclusive writes never replace an existing artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "gdm-feature-value-exclusive-test-"));
    roots.push(root);
    const path = join(root, "artifact.json");
    writeExclusive(path, "one\n");
    chmodSync(path, 0o644);
    expect(() => writeExclusive(path, "two\n")).toThrow();
  });

  test("keeps manifest and pointer protocol identifiers distinct", () => {
    expect(MANIFEST_SCHEMA).not.toBe(POINTER_SCHEMA);
    expect(PROTOCOL).toBe("gdm-feature-value-stage0/v1");
  });
});
