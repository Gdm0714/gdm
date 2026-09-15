#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { listPointers, publishSummary, readPublished } from "./result.ts";
import { currentSourceCommitment, runStage0 } from "./stage0.ts";
import { verifyStage0 } from "./verify-stage0.ts";

const RESULTS = resolve(import.meta.dir, "results");

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("publish-stage0.ts takes no arguments");
  const current = currentSourceCommitment();
  for (const pointerPath of [...listPointers(RESULTS)].reverse()) {
    try {
      const published = readPublished(pointerPath, RESULTS);
      if (published.summary.sourceSha256 !== current.sourceSha256 || !published.summary.measurementValid) continue;
      const verified = verifyStage0({ pointerPath, resultsRoot: RESULTS, requireCuLive: true });
      console.log(JSON.stringify({ published: false, reused: true, ...verified }));
      return;
    } catch {
      // Preserve stale or invalid pointers; a new create-only run is the only recovery path.
    }
  }

  const runId = randomBytes(16).toString("hex");
  const summary = await runStage0({ runId });
  const written = publishSummary(summary, RESULTS, summary.measurementValid);
  if (!summary.measurementValid || written.pointerPath === undefined) {
    console.error(JSON.stringify({
      published: false,
      reused: false,
      runId,
      measurementValid: summary.measurementValid,
      safetyViolations: summary.computerUse.safetyViolations,
      failedGateCount: Object.values(summary.gates).filter((gate) => !gate).length,
      invalidRunPreserved: true,
    }));
    process.exit(1);
  }
  const verified = verifyStage0({ pointerPath: written.pointerPath, resultsRoot: RESULTS, requireCuLive: true });
  console.log(JSON.stringify({ published: true, reused: false, ...verified }));
}

main().catch((error) => {
  console.error(`feature value Stage 0 publish failed: ${(error as Error).message}`);
  process.exit(1);
});
