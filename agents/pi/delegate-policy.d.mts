export const MAX_CONCURRENT_CHILDREN: number;
export const MAX_TOTAL_CHILDREN: number;
export const MAX_TASK_BYTES: number;
export const MAX_OUTPUT_BYTES: number;
export const MAX_EVENT_STREAM_BYTES: number;
export const MAX_EVENT_LINE_BYTES: number;
export const MAX_STDERR_BYTES: number;
export const DEFAULT_CHILD_TIMEOUT_MS: number;
export const DEFAULT_MODEL: string;
export const DEFAULT_THINKING: string;

export function validModel(value: unknown): value is string;
export function validThinking(value: unknown): value is string;
export function resolveChildConfiguration(
  role: "scout" | "design" | "reviewer",
  env?: Readonly<Record<string, string | undefined>>,
  thinkingOverride?: "medium" | "high",
): { readonly model: string; readonly thinking: string };
export function childTimeout(value: string | undefined): number;
export function credentialSignature(value: string): boolean;
export function validateDelegationRequest(params: unknown): string | null;

export class DelegateBudget {
  reserve(count: number): string | null;
  release(count: number): void;
  snapshot(): { readonly active: number; readonly total: number };
}

export function buildChildArguments(input: {
  readonly model: string;
  readonly thinking: string;
  readonly systemPrompt: string;
  readonly task: string;
}): string[];
