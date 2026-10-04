export type BoundedChildResult<Metadata extends Record<string, unknown>> = Metadata & {
  readonly model: string;
  readonly thinking: string;
  readonly spawned: boolean;
  readonly elapsedMs: number;
  readonly assistantTurns: number;
  readonly reportedModels: readonly string[];
  readonly toolCalls: readonly { readonly name: string; readonly path?: string; readonly isError: boolean }[];
  readonly stopReason: string | null;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
    readonly reasoning: number | null;
    readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number;
      readonly cacheWrite: number; readonly total: number };
  } | null;
  readonly usageComplete: boolean;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly output: string;
  readonly error: string;
};

export function runBoundedChild<Metadata extends Record<string, unknown>>(input: {
  readonly executable: string;
  readonly cwd: string;
  readonly model: string;
  readonly thinking: string;
  readonly systemPrompt: string;
  readonly taskText: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Metadata;
}): Promise<BoundedChildResult<Metadata>>;
