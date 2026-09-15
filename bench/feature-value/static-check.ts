#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CU_LIVE_TRIALS,
  MEMORY_SCENARIOS,
  PROTOCOL,
  REGISTRATION_ARMS,
  REGISTRATION_REPETITIONS,
  RETENTION,
} from "./protocol.ts";

const HERE = import.meta.dir;
const FILES = [
  "protocol.ts", "probe-child.ts", "stage0.ts", "result.ts", "publish-stage0.ts", "verify-stage0.ts", "static-check.ts",
] as const;

function fail(message: string): never {
  throw new Error(`feature value static check failed: ${message}`);
}

if (PROTOCOL !== "gdm-feature-value-stage0/v1" || RETENTION !== "hashes-counts-bytes-timings-no-bodies" ||
    REGISTRATION_REPETITIONS !== 10 || CU_LIVE_TRIALS !== 3 || REGISTRATION_ARMS.length !== 6 || MEMORY_SCENARIOS.length !== 4) {
  fail("protocol constants changed without a version bump");
}

const sources = FILES.map((file) => ({ file, text: readFileSync(join(HERE, file), "utf8") }));
const transpiler = new Bun.Transpiler({ loader: "ts" });
for (const source of sources) {
  try { transpiler.transformSync(source.text); } catch (error) { fail(`${source.file} syntax: ${(error as Error).message}`); }
}
const joined = sources.filter((source) => source.file !== "static-check.ts").map((source) => source.text).join("\n");
if (/\b(?:codex\s+exec|claude\s+-p|gdm-pi\s+.*--mode)\b/iu.test(joined)) fail("Stage 0 must not invoke an LLM");
if (joined.includes(".pi/agent/memory") || joined.includes("global.jsonl")) fail("benchmark source references the real memory store layout");
if (/writeFileSync\([^\n]*(?:agents\/pi|cli\/src|context-pack-e2e|context-pack-pilot)/u.test(joined)) {
  fail("benchmark contains a write expression targeting a protected source or prior result");
}
if (!joined.includes('utilityConclusion: "not-measured"') || !joined.includes('freshInputConclusion: "not-measured"') ||
    !joined.includes("promotionEligible: false") || !joined.includes("removalEligible: false") ||
    !joined.includes('defaultActivation: "unchanged"')) fail("non-claim decision boundary is missing");
if (!joined.includes('piCodexLimitIncluded: false') || !joined.includes('measurementScope: "display-extension-only"')) {
  fail("statusline incremental scope is missing");
}
if (!joined.includes("invalid-not-evidence") || !joined.includes('defaultActivation: "blocked"')) {
  fail("Context Pack negative carry-forward is missing");
}
if (!joined.includes("GDM_BENCH_AGENT_DIR") || !joined.includes("syntheticOnly: true")) fail("synthetic memory isolation is missing");
if (!joined.includes('flag: "wx"') || !joined.includes("published Stage 0 artifact is writable")) fail("create-only immutable result checks are missing");

console.log(JSON.stringify({
  staticCheck: "pass",
  protocol: PROTOCOL,
  files: FILES.length,
  registrationArms: REGISTRATION_ARMS.length,
  memoryScenarios: MEMORY_SCENARIOS.length,
  llmCalls: 0,
  utilityClaims: 0,
}));
