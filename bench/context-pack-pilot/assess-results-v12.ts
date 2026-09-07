#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

const path = process.argv[2];
if (process.argv.length !== 3 || path === undefined) {
  console.error("usage: assess-results.ts <summary.json>");
  process.exit(2);
}

function fail(message: string): never {
  throw new Error(`context-pack pilot assessment failed: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const verification = Bun.spawnSync([process.execPath, join(import.meta.dir, "verify-results.ts"), path], {
  stdout: "pipe",
  stderr: "pipe",
});
if (verification.exitCode !== 0) {
  fail(`measurement verifier rejected the receipts: ${new TextDecoder().decode(verification.stderr).slice(-1000)}`);
}

const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
if (!record(raw) || raw.schemaVersion !== "gdm-context-pack-pilot/v14" ||
    raw.protocol !== "fair-anchor-receipts/v12" || !Array.isArray(raw.runs) || raw.runs.length !== 18) {
  fail("receipt-bound summary contract mismatch");
}

const byArm = new Map<string, Record<string, unknown>[]>([["control", []], ["graph", []], ["context", []]]);
for (const value of raw.runs) {
  if (!record(value) || !byArm.has(String(value.arm)) || typeof value.freshInputTokens !== "number" ||
      typeof value.recall !== "number" || typeof value.providerContractValid !== "boolean" ||
      typeof value.directReadsValid !== "boolean" || typeof value.anchorFirstValid !== "boolean" ||
      typeof value.commandPolicyValid !== "boolean" || typeof value.qualityValid !== "boolean") {
    fail("invalid run assessment projection");
  }
  byArm.get(String(value.arm))!.push(value);
}
for (const values of byArm.values()) if (values.length !== 6) fail("each arm requires six runs");

const fresh = (arm: string): number[] => byArm.get(arm)!.map((value) => value.freshInputTokens as number);
const recall = (arm: string): number[] => byArm.get(arm)!.map((value) => value.recall as number);
const controlMedian = median(fresh("control"));
const graphMedian = median(fresh("graph"));
const contextMedian = median(fresh("context"));
const controlReduction = (controlMedian - contextMedian) / controlMedian;
const graphReduction = (graphMedian - contextMedian) / graphMedian;
const providerGate = [...byArm.values()].flat().every((value) => value.providerContractValid === true);
const directReadGate = [...byArm.values()].flat().every((value) => value.directReadsValid === true);
const anchorFirstGate = [...byArm.values()].flat().every((value) => value.anchorFirstValid === true);
const commandPolicyGate = [...byArm.values()].flat().every((value) => value.commandPolicyValid === true);
const treatmentQualityGate = [...byArm.get("graph")!, ...byArm.get("context")!]
  .every((value) => value.qualityValid === true);
const contextAtLeastControl = recall("context").reduce((sum, value) => sum + value, 0) >=
  recall("control").reduce((sum, value) => sum + value, 0);
const contextPackBytes = byArm.get("context")!.map((value) => value.contextPackBytes);
const packGate = contextPackBytes.every((value) => typeof value === "number" && value > 0 && value <= 4096);
const reductionGate = controlReduction >= 0.25;
const graphComparisonGate = graphReduction >= 0.10;
const gates = {
  privacyTrustStaleRegression: record(raw.staticGate) && raw.staticGate.passed === true && raw.staticGate.exitCode === 0,
  providerContract: providerGate,
  directReads: directReadGate,
  anchorFirst: anchorFirstGate,
  commandPolicy: commandPolicyGate,
  treatmentQuality: treatmentQualityGate,
  contextAtLeastControl,
  contextPackHardCap: packGate,
  controlMedianReduction25Percent: reductionGate,
  graphMedianReduction10Percent: graphComparisonGate,
};
const missedGates = Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name);
const promotionEligible = missedGates.length === 0;
const stopRequired = !promotionEligible;

console.log(JSON.stringify({
  assessed: true,
  promotionEligible,
  stopRequired,
  gates,
  missedGates,
  medianFreshInput: { control: controlMedian, graph: graphMedian, context: contextMedian },
  reduction: { versusControl: controlReduction, versusGraph: graphReduction },
  nextPhase: promotionEligible ? "separate-p2-work-eligible" : "blocked",
  defaultActivation: "blocked-pending-expanded-benchmark-and-audit",
}));
