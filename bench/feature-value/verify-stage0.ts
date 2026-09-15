#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  CU_LIVE_TRIALS,
  MEMORY_SCENARIOS,
  REGISTRATION_ARMS,
  REGISTRATION_REPETITIONS,
  acceptStage0Summary,
} from "./protocol.ts";
import { currentPointer, readPublished, resultsRootFromPointer } from "./result.ts";
import { currentSourceCommitment } from "./stage0.ts";

const DEFAULT_RESULTS = resolve(import.meta.dir, "results");

export function verifyStage0(input: {
  readonly pointerPath?: string;
  readonly resultsRoot?: string;
  readonly requireCuLive?: boolean;
}) {
  const resultsRoot = resolve(input.resultsRoot ?? (input.pointerPath ? resultsRootFromPointer(input.pointerPath) : DEFAULT_RESULTS));
  const pointerPath = input.pointerPath ?? currentPointer(resultsRoot);
  const published = readPublished(pointerPath, resultsRoot);
  const summary = acceptStage0Summary(published.summary);
  if (summary === null) throw new Error("Stage 0 summary schema rejected");
  const current = currentSourceCommitment();
  if (JSON.stringify(summary.source) !== JSON.stringify(current.source) || summary.sourceSha256 !== current.sourceSha256) {
    throw new Error("Stage 0 source commitment is stale");
  }
  const source = new Map(summary.source.map((artifact) => [artifact.id, artifact]));
  if (source.get("memory-extension")?.sha256 !== source.get("installed-memory-extension")?.sha256) {
    throw new Error("memory source and installed extension differ");
  }
  if (source.get("computer-use-extension")?.sha256 !== source.get("installed-computer-use-extension")?.sha256) {
    throw new Error("Computer Use source and installed extension differ");
  }
  if (source.get("source-launcher")?.sha256 === source.get("installed-launcher")?.sha256) {
    throw new Error("source and installed launcher no longer preserve the documented local status integration difference");
  }
  if (summary.registration.repetitions !== REGISTRATION_REPETITIONS || summary.registration.arms.length !== REGISTRATION_ARMS.length) {
    throw new Error("Stage 0 registration matrix is incomplete");
  }
  const arms = new Map(summary.registration.arms.map((arm) => [arm.arm, arm]));
  const expectedTools = { baseline: 0, memory: 1, "computer-use": 1, both: 2, status: 0, all: 2 } as const;
  for (const arm of REGISTRATION_ARMS) {
    if (arms.get(arm)?.toolCount !== expectedTools[arm]) throw new Error(`unexpected tool count for ${arm}`);
  }
  const memory = arms.get("memory")!;
  const computerUse = arms.get("computer-use")!;
  const both = arms.get("both")!;
  if (both.toolSchemaBytes !== memory.toolSchemaBytes + computerUse.toolSchemaBytes ||
      both.promptMetadataBytes !== memory.promptMetadataBytes + computerUse.promptMetadataBytes) {
    throw new Error("combined tool metadata does not equal the two product tools");
  }
  const status = arms.get("status")!;
  if (status.toolCount !== 0 || status.toolSchemaBytes !== 0 || status.promptMetadataBytes !== 0 ||
      status.statusIntervalMs !== 1000 || status.statusFetchCalls !== 0 || status.statusFormattingValid !== true ||
      status.statusProviderHideValid !== true || summary.statusline.piCodexLimitIncluded !== false) {
    throw new Error("statusline incremental scope or correctness failed");
  }
  if (summary.memory.syntheticOnly !== true || summary.memory.scenarios.length !== MEMORY_SCENARIOS.length ||
      summary.memory.scenarios.find((scenario) => scenario.id === "irrelevant-200")?.selectedProject !== 6 ||
      summary.memory.scenarios.find((scenario) => scenario.id === "irrelevant-200")?.selectedGlobal !== 4 ||
      summary.memory.scenarios.find((scenario) => scenario.id === "irrelevant-200")?.renderedBytes === 0 ||
      summary.memory.scenarios.find((scenario) => scenario.id === "relevant-200")?.relevantEntryFirst !== true ||
      summary.memory.zeroOverlapInjects !== true) {
    throw new Error("synthetic memory Stage 0 contract failed");
  }
  if (summary.contextCarryForward.measurementValid !== false || summary.contextCarryForward.validRuns !== 13 ||
      summary.contextCarryForward.totalRuns !== 18 || summary.contextCarryForward.tokenConclusion !== "invalid-not-evidence" ||
      summary.contextCarryForward.promotionEligible !== false || summary.contextCarryForward.defaultActivation !== "blocked") {
    throw new Error("Context Pack negative conclusion was not preserved");
  }
  if (input.requireCuLive && (summary.computerUse.trialsPlanned !== CU_LIVE_TRIALS ||
      summary.computerUse.trials.length !== CU_LIVE_TRIALS || !summary.computerUse.liveValid ||
      summary.computerUse.safetyViolations !== 0 || summary.computerUse.trials.some((trial) => !trial.valid ||
        trial.hostFocusChanges !== 0 || trial.hostTcpListenerLines !== 0 || trial.hostSentinelCreated ||
        !trial.guestWriteVerified || !trial.cleanupVerified || trial.pngBytes <= 0 || trial.frameWidth <= 0 || trial.frameHeight <= 0))) {
    throw new Error("Computer Use live Stage 0 contract failed");
  }
  if (!summary.measurementValid || !summary.stage1Eligible || !Object.values(summary.gates).every(Boolean) ||
      summary.utilityConclusion !== "not-measured" || summary.freshInputConclusion !== "not-measured" ||
      summary.promotionEligible !== false || summary.removalEligible !== false || summary.defaultActivation !== "unchanged") {
    throw new Error("Stage 0 validity or non-claim boundary failed");
  }
  return {
    verified: true,
    protocol: summary.protocol,
    runId: summary.runId,
    measurementValid: summary.measurementValid,
    stage1Eligible: summary.stage1Eligible,
    utilityConclusion: summary.utilityConclusion,
    freshInputConclusion: summary.freshInputConclusion,
    contextTokenConclusion: summary.contextCarryForward.tokenConclusion,
    computerUseTrials: summary.computerUse.trials.length,
    computerUseSafetyViolations: summary.computerUse.safetyViolations,
  } as const;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const requireCuLive = args.includes("--require-cu-live");
  const filtered = args.filter((argument) => argument !== "--require-cu-live");
  let pointerPath: string | undefined;
  if (filtered.length === 1 && filtered[0] === "--current") pointerPath = undefined;
  else if (filtered.length === 1 && filtered[0]?.startsWith("/")) pointerPath = filtered[0];
  else {
    console.error("usage: verify-stage0.ts --current [--require-cu-live] | <absolute-pointer> [--require-cu-live]");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(verifyStage0({ pointerPath, requireCuLive })));
  } catch (error) {
    console.error(`feature value Stage 0 verification failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
