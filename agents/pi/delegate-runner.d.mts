export type BoundedChildResult<Metadata extends Record<string, unknown>> = Metadata & {
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
