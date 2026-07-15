import { createHash } from "node:crypto";
import { assertNoSensitiveRaw, opaqueId, safeText } from "./contract.ts";
import { readContainedFile } from "./contained-file.ts";
import { GdmError } from "./state.ts";
import type { JournalEvent } from "./types.ts";

const FINGERPRINT_RE = /^fp-[0-9a-f]{16}$/u;
const CHANGE_CATEGORIES = ["dependency", "input", "code", "environment", "permission"] as const;

export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];
export type AttemptDecision =
  | "awaiting-confirmation"
  | "confirmation-permitted"
  | "locked"
  | "changed-permitted";

export interface AttemptEvent extends JournalEvent {
  readonly schemaVersion: 1;
  readonly event: "attempt";
  readonly action: "fail" | "retry";
  readonly attemptId: string;
  readonly sourceKind: "command" | "capability";
  readonly sourceId: string;
  readonly target: string;
  readonly errorCode: string;
  readonly fingerprint: string;
  readonly epoch: number;
  readonly failureCount: number;
  readonly hypothesis: string;
  readonly decision: AttemptDecision;
  readonly changed?: ChangeCategory;
  readonly evidence?: string;
  readonly evidenceSha256?: string;
}

export type FailureInput = {
  readonly attemptId: string;
  readonly sourceKind: "command" | "capability";
  readonly sourceId: string;
  readonly target: string;
  readonly errorCode: string;
  readonly fingerprint: string;
  readonly hypothesis: string;
};

export type RetryInput = {
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly changed?: ChangeCategory;
  readonly evidence?: string;
};

export type AttemptMutation = {
  readonly event: AttemptEvent;
  readonly changed: boolean;
};

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function attemptFingerprint(input: {
  readonly sourceId: string;
  readonly target: string;
  readonly errorCode: string;
}): string {
  const identity = `${normalized(input.sourceId)}\0${normalized(input.target)}\0${input.errorCode}`;
  return `fp-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

export function parseChangeCategory(value: string): ChangeCategory {
  assertNoSensitiveRaw(value, "changed");
  const category = CHANGE_CATEGORIES.find((candidate) => candidate === value);
  if (category === undefined) throw new GdmError("field=changed enum 형식이 잘못됐습니다", "usage");
  return category;
}

export function prepareFailure(input: {
  readonly attemptId: string;
  readonly sourceKind: "command" | "capability";
  readonly sourceId: string;
  readonly target: string;
  readonly errorCode: string;
  readonly hypothesis: string;
}): FailureInput {
  const attemptId = opaqueId(input.attemptId, "attempt-id");
  const sourceId = opaqueId(normalized(input.sourceId), input.sourceKind);
  const target = opaqueId(normalized(input.target), "target");
  const errorCode = opaqueId(input.errorCode, "error-code");
  const hypothesis = safeText(input.hypothesis, "hypothesis");
  return {
    attemptId,
    sourceKind: input.sourceKind,
    sourceId,
    target,
    errorCode,
    fingerprint: attemptFingerprint({ sourceId, target, errorCode }),
    hypothesis,
  };
}

export function prepareRetry(input: {
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly changed?: string;
  readonly evidence?: string;
}): RetryInput {
  const attemptId = opaqueId(input.attemptId, "attempt-id");
  assertNoSensitiveRaw(input.fingerprint, "fingerprint");
  if (!FINGERPRINT_RE.test(input.fingerprint)) {
    throw new GdmError("field=fingerprint 형식이 잘못됐습니다", "usage");
  }
  if ((input.changed === undefined) !== (input.evidence === undefined)) {
    throw new GdmError("--changed와 --evidence는 함께 필요합니다", "usage");
  }
  if (input.changed === undefined) return { attemptId, fingerprint: input.fingerprint };
  return {
    attemptId,
    fingerprint: input.fingerprint,
    changed: parseChangeCategory(input.changed),
    evidence: input.evidence,
  };
}

function latestFor(events: readonly AttemptEvent[], fingerprint: string): AttemptEvent | undefined {
  return events.filter((event) => event.fingerprint === fingerprint).at(-1);
}

function sameFailure(event: AttemptEvent, input: FailureInput): boolean {
  return (
    event.action === "fail" &&
    event.fingerprint === input.fingerprint &&
    event.sourceKind === input.sourceKind &&
    event.sourceId === input.sourceId &&
    event.target === input.target &&
    event.errorCode === input.errorCode &&
    event.hypothesis === input.hypothesis
  );
}

export function recordFailure(
  events: readonly AttemptEvent[],
  input: FailureInput,
  at: string,
): AttemptMutation {
  const replay = events.find((event) => event.attemptId === input.attemptId);
  if (replay !== undefined) {
    if (sameFailure(replay, input)) return { event: replay, changed: false };
    throw new GdmError("attempt-id가 다른 요청에 이미 사용됐습니다", "attempt_id_conflict");
  }
  const latest = latestFor(events, input.fingerprint);
  if (
    latest !== undefined &&
    (latest.sourceKind !== input.sourceKind ||
      latest.sourceId !== input.sourceId ||
      latest.target !== input.target ||
      latest.errorCode !== input.errorCode)
  ) {
    throw new GdmError("fingerprint 필드가 이전 실패와 일치하지 않습니다", "attempt_transition");
  }
  if (latest !== undefined && latest.decision !== "confirmation-permitted" && latest.decision !== "changed-permitted") {
    throw new GdmError("현재 상태에서는 같은 실패를 기록할 수 없습니다", "attempt_transition");
  }
  const epoch = latest?.epoch ?? 0;
  const decision = latest?.decision === "confirmation-permitted" ? "locked" : "awaiting-confirmation";
  const event: AttemptEvent = {
    schemaVersion: 1,
    event: "attempt",
    action: "fail",
    attemptId: input.attemptId,
    ts: at,
    at,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    target: input.target,
    errorCode: input.errorCode,
    fingerprint: input.fingerprint,
    epoch,
    failureCount: decision === "locked" ? 2 : 1,
    hypothesis: input.hypothesis,
    decision,
  };
  return { event, changed: true };
}

function sameRetry(
  event: AttemptEvent,
  input: RetryInput,
  evidence: { readonly path: string; readonly sha256: string } | undefined,
): boolean {
  return (
    event.action === "retry" &&
    event.fingerprint === input.fingerprint &&
    event.changed === input.changed &&
    event.evidence === evidence?.path &&
    event.evidenceSha256 === evidence?.sha256
  );
}

export function recordRetry(
  cwd: string,
  events: readonly AttemptEvent[],
  input: RetryInput,
  at: string,
): AttemptMutation {
  const evidence = input.evidence === undefined ? undefined : readContainedFile(cwd, input.evidence, "evidence");
  const replay = events.find((event) => event.attemptId === input.attemptId);
  if (replay !== undefined) {
    if (sameRetry(replay, input, evidence)) return { event: replay, changed: false };
    throw new GdmError("attempt-id가 다른 요청에 이미 사용됐습니다", "attempt_id_conflict");
  }
  const latest = latestFor(events, input.fingerprint);
  if (latest === undefined) throw new GdmError("fingerprint에 해당하는 실패가 없습니다", "attempt_not_found");
  if (input.changed === undefined) {
    if (latest.decision === "locked") throw new GdmError("unchanged_retry", "unchanged_retry");
    if (latest.decision !== "awaiting-confirmation") {
      throw new GdmError("확인 재시도를 사용할 수 없는 상태입니다", "attempt_transition");
    }
  } else {
    if (latest.decision !== "locked") throw new GdmError("변경 재시도는 잠금 뒤에만 가능합니다", "attempt_transition");
    if (evidence === undefined) throw new GdmError("--evidence가 필요합니다", "usage");
    const reused = events.some(
      (event) => event.fingerprint === input.fingerprint && event.evidenceSha256 === evidence.sha256,
    );
    if (reused) throw new GdmError("stale_evidence", "stale_evidence");
  }
  const changed = input.changed !== undefined;
  const event: AttemptEvent = {
    schemaVersion: 1,
    event: "attempt",
    action: "retry",
    attemptId: input.attemptId,
    ts: at,
    at,
    sourceKind: latest.sourceKind,
    sourceId: latest.sourceId,
    target: latest.target,
    errorCode: latest.errorCode,
    fingerprint: input.fingerprint,
    epoch: changed ? latest.epoch + 1 : latest.epoch,
    failureCount: changed ? 0 : latest.failureCount,
    hypothesis: latest.hypothesis,
    decision: changed ? "changed-permitted" : "confirmation-permitted",
    ...(input.changed === undefined ? {} : { changed: input.changed }),
    ...(evidence === undefined ? {} : { evidence: evidence.path, evidenceSha256: evidence.sha256 }),
  };
  return { event, changed: true };
}
