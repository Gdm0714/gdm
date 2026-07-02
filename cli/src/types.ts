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

export interface Work {
  slug: string;
  brief: string;
  createdAt: string;
  done: boolean;
  doneAt?: string;
  auditRequired?: boolean;
  audit?: Audit;
  checks: Check[];
}

export interface JournalEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}
