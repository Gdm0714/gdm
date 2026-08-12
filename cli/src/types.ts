export type CheckStatus = "open" | "proven";
export type CheckKind = "regression" | "behavior" | "edge" | "static" | "manual";
export type RiskLevel = "low" | "medium" | "high";
export type VerificationMode = "deterministic" | "inspectable" | "opaque";

export interface Evidence {
  observed: string;
  sha256: string;
  exitCode?: number;
  manual: boolean;
  note?: string;
  reviewer?: string;
  at: string;
}

export interface Check {
  id: string;
  desc: string;
  cmd: string | null;
  expect: string;
  manual: boolean;
  kind?: CheckKind;
  expert?: boolean;
  status: CheckStatus;
  redEvidence?: Evidence;
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
  readonly files?: readonly WorkspaceFileFingerprint[];
}

export interface WorkspaceFileFingerprint {
  readonly path: string;
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
  readonly assumptions?: readonly string[];
  readonly uncertainties?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly stopConditions?: readonly string[];
  readonly risk?: RiskLevel;
  readonly verification?: VerificationMode;
  readonly simplificationRequired?: boolean;
  readonly scopeAmendments?: readonly ScopeAmendment[];
}

export interface ScopeAmendment {
  readonly addedAllowed: readonly string[];
  readonly addedForbidden: readonly string[];
  readonly removedAllowed: readonly string[];
  readonly removedForbidden: readonly string[];
  readonly reason: string;
  readonly at: string;
}

export interface Work {
  slug: string;
  brief: string;
  createdAt: string;
  done: boolean;
  doneAt?: string;
  verificationPlanSourceFingerprint?: string;
  auditRequired?: boolean;
  audit?: Audit;
  delivery?: DeliveryState;
  baseline?: WorkspaceFingerprint | null;
  checks: Check[];
  contract: WorkContract;
}

export interface JournalEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}
