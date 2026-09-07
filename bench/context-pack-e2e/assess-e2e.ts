#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, resolvePointer } from "./protocol.ts";

const pointer = process.argv[2];
if (process.argv.length !== 3 || pointer === undefined) {
  console.error("usage: assess-e2e.ts <results/current.json>");
  process.exit(2);
}

const verification = Bun.spawnSync([process.execPath, join(import.meta.dir, "verify-e2e.ts"), pointer], {
  stdout: "pipe",
  stderr: "pipe",
});
if (verification.exitCode !== 0) {
  throw new Error(`measurement verifier rejected receipts: ${new TextDecoder().decode(verification.stderr).slice(-1000)}`);
}

const resolved = resolvePointer(pointer);
const summary = JSON.parse(readFileSync(join(resolved.runDirectory, "summary.json"), "utf8")) as unknown;
if (!isRecord(summary) || !Array.isArray(summary.runs) || summary.runs.length !== 18) throw new Error("invalid e2e summary");
const runs = summary.runs.map((run) => {
  if (!isRecord(run) || (run.arm !== "control" && run.arm !== "graph" && run.arm !== "context") ||
      (run.task !== "ownership" && run.task !== "budget") || typeof run.measurementValid !== "boolean" ||
      typeof run.qualityValid !== "boolean" || typeof run.recall !== "number" || typeof run.freshInputTokens !== "number") {
    throw new Error("invalid run projection");
  }
  return run;
});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

const allRunsValid = runs.every((run) => run.measurementValid === true);
const qualityParity = runs.every((run) => run.qualityValid === true && run.recall === 1);
const byArm = Object.fromEntries(["control", "graph", "context"].map((arm) => {
  const selected = runs.filter((run) => run.arm === arm);
  if (!allRunsValid || selected.length !== 6) return [arm, null];
  const fresh = selected.map((run) => run.freshInputTokens as number);
  return [arm, { runs: selected.length, medianFreshInputTokens: median(fresh), rangeFreshInputTokens: [Math.min(...fresh), Math.max(...fresh)] }];
})) as Record<string, null | { readonly medianFreshInputTokens: number }>;
const tokenMetricsUsable = allRunsValid && qualityParity;
const controlMedian = byArm.control?.medianFreshInputTokens ?? null;
const graphMedian = byArm.graph?.medianFreshInputTokens ?? null;
const contextMedian = byArm.context?.medianFreshInputTokens ?? null;
const versusControl = controlMedian === null || contextMedian === null ? null : (controlMedian - contextMedian) / controlMedian;
const versusGraph = graphMedian === null || contextMedian === null ? null : (graphMedian - contextMedian) / graphMedian;
const directionalSignal = tokenMetricsUsable && versusControl !== null && versusGraph !== null
  ? { controlReduction25Percent: versusControl >= 0.25, graphReduction10Percent: versusGraph >= 0.10 }
  : null;

const result = {
  assessed: true,
  scale: "smoke",
  runId: summary.runId,
  measurementValid: tokenMetricsUsable,
  validRuns: runs.filter((run) => run.measurementValid === true).length,
  totalRuns: runs.length,
  qualityParity,
  tokenConclusion: tokenMetricsUsable ? "directional-smoke-only" : "invalid-not-evidence",
  byArm,
  reduction: { versusControl, versusGraph },
  directionalSignal,
  promotionEligible: false,
  nextPhase: "blocked-pending-expanded-benchmark-and-audit",
  defaultActivation: "blocked",
  priorP1Conclusion: "invalid-not-evidence-no-promotion-preserved",
} as const;
if (result.promotionEligible !== false || result.defaultActivation !== "blocked") throw new Error("promotion safety invariant");
console.log(JSON.stringify(result));
