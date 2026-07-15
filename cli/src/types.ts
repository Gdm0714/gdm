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
  stateHash: string;
  at: string;
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
  checks: Check[];
  contract: WorkContract;
}

export interface JournalEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}
