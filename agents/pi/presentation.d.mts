export const LONG_RUN_NOTIFICATION_MS: number;
export const JOKER_WORKING_INDICATOR: Readonly<{
  readonly frames: readonly string[];
  readonly intervalMs: number;
}>;
export const COMPLETION_NOTIFICATION: string;

export function completionNotificationDue(
  startedAt: number | null,
  endedAt: number,
  hasUI: boolean | undefined,
  isTTY: boolean,
): boolean;

export type GdmPresentationDependencies = {
  readonly now?: () => number;
  readonly isTTY?: () => boolean;
  readonly write?: (value: string) => unknown;
};

export function installGdmPresentation(
  pi: any,
  dependencies?: GdmPresentationDependencies,
): boolean;
