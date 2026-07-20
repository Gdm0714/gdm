export type CheckStatus = "open" | "proven";

export interface Evidence {
  observed: string;
  sha256: string;
  exitCode?: number;
  manual: boolean;
  note?: string;
  at: string;
}

export interface Check {
  id: string;
  desc: string;
  cmd: string | null;
  expect: string;
  manual: boolean;
  status: CheckStatus;
  evidence?: Evidence;
}

export interface Audit {
  result: "pass" | "fail";
  report: string;
  reportSha256?: string;
  implementationModel?: string;
  auditModel?: string;
  workspace?: WorkspaceFingerprint | null;
  stateHash: string;
  at: string;
}

export interface WorkspaceFingerprint {
  readonly kind: "git";
  readonly head: string;
  readonly sha256: string;
}

export interface DeliveryState {
  readonly issue: string;
  readonly branch: string;
  readonly head: string;
  readonly preparedAt: string;
  readonly pr?: { readonly number: string; readonly head: string; readonly at: string };
  readonly ci?: {
    readonly status: "passed" | "failed";
    readonly head: string;
    readonly run: string;
    readonly at: string;
  };
  readonly mergeApproval?: { readonly head: string; readonly reason: string; readonly at: string };
  readonly merged?: { readonly sha: string; readonly at: string };
}

export type CommitState = "forbidden" | "explicitly-approved";

export interface CommitTransition {
  readonly eventId: string;
  readonly transitionRevision: number;
  readonly predecessorEventId: string | null;
  readonly from: CommitState;
  readonly to: CommitState;
  readonly reason: string;
  readonly at: string;
}

export interface ActiveHabit {
  readonly habitId: string;
  readonly version: number;
  readonly ruleRef: string;
  readonly ruleHash: string;
  readonly activatedAt: string;
}

export interface WorkContract {
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
  readonly activeHabits: readonly ActiveHabit[];
  readonly commit: CommitState;
  readonly latestCommitTransition?: CommitTransition;
}

export interface Work {
  slug: string;
  brief: string;
  createdAt: string;
  done: boolean;
  doneAt?: string;
  auditRequired?: boolean;
  audit?: Audit;
  delivery?: DeliveryState;
  checks: Check[];
  contract: WorkContract;
}

export interface JournalEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}
