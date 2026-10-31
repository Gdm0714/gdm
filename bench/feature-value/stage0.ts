// Pi extension measurement is retired. Keep result/protocol readers for archived evidence.
import type { SourceArtifact, Stage0Summary } from "./protocol.ts";

const RETIRED = "Retired benchmark: Pi integration was removed. Historical results are preserved; use the native GDM/gid benchmarks for new runs.";

export function currentSourceCommitment(): { readonly source: readonly SourceArtifact[]; readonly sourceSha256: string } {
  throw new Error(RETIRED);
}

export async function runStage0(_input: {
  readonly runId: string;
  readonly registrationRepetitions?: number;
  readonly memorySelectionIterations?: number;
  readonly memoryStoreReadIterations?: number;
  readonly computerUseTrials?: number;
}): Promise<Stage0Summary> {
  throw new Error(RETIRED);
}

if (import.meta.main) throw new Error(RETIRED);
