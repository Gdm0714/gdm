import { assertCommitAllowed, safeText } from "./contract.ts";
import { GdmError } from "./state.ts";
import type { DeliveryState, Work } from "./types.ts";

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const ID_RE = /^[A-Za-z0-9#._-]{1,128}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function sha(value: string, field: string): string {
  if (!SHA_RE.test(value)) throw new GdmError(`${field}는 Git SHA여야 합니다`, "delivery_invalid");
  return value.toLowerCase();
}

function id(value: string, field: string): string {
  if (!ID_RE.test(value)) throw new GdmError(`${field} 형식이 올바르지 않습니다`, "delivery_invalid");
  return value;
}

function branch(value: string): string {
  if (!BRANCH_RE.test(value) || value.includes("..") || value.endsWith("/") || value.includes("//")) {
    throw new GdmError("branch 형식이 올바르지 않습니다", "delivery_invalid");
  }
  return value;
}

function assertReadyWork(work: Work): void {
  if (!work.done) throw new GdmError("검증 완료 전에는 delivery를 시작할 수 없습니다", "delivery_gate");
  assertCommitAllowed(work);
}

export function prepareDelivery(
  work: Work,
  issueValue: string,
  branchValue: string,
  headValue: string,
  at: string,
): Work {
  assertReadyWork(work);
  const next: DeliveryState = {
    issue: id(issueValue, "issue"),
    branch: branch(branchValue),
    head: sha(headValue, "head"),
    preparedAt: at,
  };
  return { ...work, delivery: next };
}

function prepared(work: Work): DeliveryState {
  assertReadyWork(work);
  if (!work.delivery) throw new GdmError("delivery prepare가 필요합니다", "delivery_gate");
  return work.delivery;
}

function matchingHead(delivery: DeliveryState, value: string): string {
  const normalized = sha(value, "head");
  if (normalized !== delivery.head) throw new GdmError("delivery HEAD가 준비된 커밋과 다릅니다", "delivery_gate");
  return normalized;
}

export function recordDeliveryPr(work: Work, numberValue: string, headValue: string, at: string): Work {
  const delivery = prepared(work);
  const head = matchingHead(delivery, headValue);
  return {
    ...work,
    delivery: { ...delivery, pr: { number: id(numberValue, "pr"), head, at }, ci: undefined, mergeApproval: undefined, merged: undefined },
  };
}

export function recordDeliveryCi(
  work: Work,
  status: "passed" | "failed",
  headValue: string,
  runValue: string,
  at: string,
): Work {
  const delivery = prepared(work);
  const head = matchingHead(delivery, headValue);
  if (!delivery.pr || delivery.pr.head !== head) throw new GdmError("현재 HEAD의 PR 기록이 필요합니다", "delivery_gate");
  return {
    ...work,
    delivery: {
      ...delivery,
      ci: { status, head, run: id(runValue, "run"), at },
      mergeApproval: undefined,
      merged: undefined,
    },
  };
}

export function approveDeliveryMerge(work: Work, headValue: string, reasonValue: string, at: string): Work {
  const delivery = prepared(work);
  const head = matchingHead(delivery, headValue);
  if (!delivery.pr || delivery.pr.head !== head) throw new GdmError("현재 HEAD의 PR 기록이 필요합니다", "delivery_gate");
  const reason = safeText(reasonValue, "reason");
  return { ...work, delivery: { ...delivery, mergeApproval: { head, reason, at }, merged: undefined } };
}

export function assertDeliveryMergeAllowed(work: Work, headValue: string): DeliveryState {
  const delivery = prepared(work);
  const head = matchingHead(delivery, headValue);
  if (!delivery.pr || delivery.pr.head !== head) throw new GdmError("현재 HEAD의 PR 기록이 없습니다", "delivery_gate");
  if (delivery.ci?.head === head && delivery.ci.status === "failed") {
    throw new GdmError("현재 HEAD의 CI 실패 기록이 있습니다", "delivery_gate");
  }
  if (!delivery.mergeApproval || delivery.mergeApproval.head !== head) {
    throw new GdmError("현재 HEAD의 명시적 머지 승인이 없습니다", "delivery_gate");
  }
  return delivery;
}

export function recordDeliveryMerged(work: Work, headValue: string, mergeShaValue: string, at: string): Work {
  const delivery = assertDeliveryMergeAllowed(work, headValue);
  return { ...work, delivery: { ...delivery, merged: { sha: sha(mergeShaValue, "merge-sha"), at } } };
}
