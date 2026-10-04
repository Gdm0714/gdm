export const GDM_PROCESS_TIMEOUT_MS: number;
export const GDM_PROCESS_MAX_BYTES: number;
export const CONTRACT_CHECK_TIMEOUT_MS: number;
export const CONTRACT_CHECK_MAX_TOKENS: number;
export const CONTRACT_CHECK_SUITE_VERSION: string;
export const GDM_HARNESS_VERSION: string;
export const CONTRACT_CHECK_ENTRY_TYPE: string;
export const CONTRACT_CHECK_CASES: readonly {
  readonly id: string;
  readonly answer: "A" | "B" | "C";
  readonly question: string;
  readonly choices: Readonly<Record<"A" | "B" | "C", string>>;
}[];

export type GdmProcessResult = {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string;
};

export function runBoundedGdm(
  executable: string,
  cwd: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number; readonly maxBytes?: number },
): Promise<GdmProcessResult>;

export function selectGdmWork(works: readonly Record<string, unknown>[]): Record<string, unknown> | undefined;
export function nextGdmAction(work: Record<string, any> | undefined): string;
export function formatGdmSummary(works: readonly Record<string, any>[], retro: Record<string, any>): string;
export function parseFeedbackArgs(raw: string): { readonly value: "good" | "bad"; readonly reason?: string };
export function scoreContractCheck(text: string): {
  readonly passed: number;
  readonly total: number;
  readonly caseResults: Readonly<Record<string, boolean>>;
};

export type GdmCommandsDependencies = {
  readonly runGdm?: (cwd: string, args: readonly string[]) => Promise<GdmProcessResult>;
  readonly now?: () => string;
  readonly newSessionId?: () => string;
  readonly contractCheckTimeoutMs?: number;
};

export function installGdmCommands(pi: any, dependencies?: GdmCommandsDependencies): boolean;
