import { describe, expect, test } from "bun:test";
import * as delivery from './cli/src/delivery.ts';
import * as state from './cli/src/state.ts';
import * as contract from './cli/src/contract.ts';
const {
  prepareDelivery, recordDeliveryPr, recordDeliveryCi, approveDeliveryMerge,
  assertDeliveryMergeAllowed, recordDeliveryMerged,
} = delivery;
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const stamp = (n: number) => `2026-09-09T00:00:${String(n).padStart(2, "0")}.000Z`;

function completedWork() {
  let work = state.initWork("delivery-replay", "delivery transition replay", stamp(0));
  work = state.addCheck(work, { desc: "ready", cmd: "true", expect: "exit 0" }).work;
  work = state.passCheck(work, "c1", {
    observed: ".gdm/delivery-replay/out/c1.txt", sha256: "d".repeat(64),
    manual: false, exitCode: 0,
  }, stamp(1));
  work = state.closeWork(work, stamp(2));
  return contract.transitionCommit(work, "explicitly-approved", "user requested delivery", stamp(3)).work;
}

function preparedWork() {
  return prepareDelivery(completedWork(), "#12", "feature/delivery", HEAD, stamp(4));
}

function approvedWork() {
  let work = recordDeliveryPr(preparedWork(), "#13", HEAD, stamp(5));
  work = recordDeliveryCi(work, "passed", HEAD, "run-1", stamp(6));
  return approveDeliveryMerge(work, HEAD, "user requested merge", stamp(7));
}

function mustReject(fn: () => unknown, expectedCode = "delivery_gate") {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeDefined();
  expect((caught as { code?: string }).code).toBe(expectedCode);
}

describe("delivery replay primary defect groups", () => {
  test("D03: replacing PR at the same HEAD requires fresh downstream evidence", () => {
    const before = recordDeliveryMerged(approvedWork(), HEAD, MERGE, stamp(8));
    const next = recordDeliveryPr(before, "#14", HEAD, stamp(9));
    expect(next.delivery.pr.number).toBe("#14");
    expect(next.delivery.ci).toBeUndefined();
    expect(next.delivery.mergeApproval).toBeUndefined();
    expect(next.delivery.merged).toBeUndefined();
    mustReject(() => assertDeliveryMergeAllowed(next, HEAD));
    mustReject(() => approveDeliveryMerge(next, HEAD, "new merge request", stamp(10)));
    let recovered = recordDeliveryCi(next, "passed", HEAD, "run-2", stamp(11));
    mustReject(() => assertDeliveryMergeAllowed(recovered, HEAD));
    recovered = approveDeliveryMerge(recovered, HEAD, "new merge request", stamp(12));
    expect(assertDeliveryMergeAllowed(recovered, HEAD).pr.number).toBe("#14");
  });

  test("D04: new CI observations clear old approval and merge records even at the same HEAD", () => {
    // passed/failed are the only valid historical statuses; there is no pending status.
    for (const status of ["failed", "passed"] as const) {
      const before = recordDeliveryMerged(approvedWork(), HEAD, MERGE, stamp(8));
      const next = recordDeliveryCi(before, status, HEAD, `run-${status}`, stamp(9));
      expect(next.delivery.ci.status).toBe(status);
      expect(next.delivery.mergeApproval).toBeUndefined();
      expect(next.delivery.merged).toBeUndefined();
      mustReject(() => assertDeliveryMergeAllowed(next, HEAD));
    }
    const failed = recordDeliveryCi(approvedWork(), "failed", HEAD, "run-failed", stamp(9));
    const retryPassed = recordDeliveryCi(failed, "passed", HEAD, "run-retry", stamp(10));
    mustReject(() => assertDeliveryMergeAllowed(retryPassed, HEAD));
    const reapproved = approveDeliveryMerge(retryPassed, HEAD, "approve successful retry", stamp(11));
    expect(assertDeliveryMergeAllowed(reapproved, HEAD).ci.run).toBe("run-retry");
  });
});

describe("delivery replay independent preservation guards", () => {
  test("G1: normal ordered delivery permits merge and records its SHA", () => {
    const approved = approvedWork();
    expect(assertDeliveryMergeAllowed(approved, HEAD).ci.status).toBe("passed");
    const merged = recordDeliveryMerged(approved, HEAD, MERGE.toUpperCase(), stamp(8));
    expect(merged.delivery.merged.sha).toBe(MERGE);
    expect(merged.delivery.pr.number).toBe("#13");
    expect(merged.done).toBe(true);
  });

  test("G2: unfinished work and work without delivery permission stay blocked", () => {
    const incomplete = state.initWork("incomplete-work", "unfinished", stamp(0));
    mustReject(() => prepareDelivery(incomplete, "#12", "main", HEAD, stamp(1)));
    const revoked = contract.transitionCommit(completedWork(), "forbidden", "delivery permission revoked", stamp(4)).work;
    mustReject(() => prepareDelivery(revoked, "#12", "main", HEAD, stamp(5)), "commit_forbidden");
  });

  test("G3: every downstream transition rejects a different HEAD", () => {
    const approved = approvedWork();
    mustReject(() => recordDeliveryPr(approved, "#14", OTHER_HEAD, stamp(8)));
    mustReject(() => recordDeliveryCi(approved, "passed", OTHER_HEAD, "run-2", stamp(8)));
    mustReject(() => approveDeliveryMerge(approved, OTHER_HEAD, "merge request", stamp(8)));
    mustReject(() => assertDeliveryMergeAllowed(approved, OTHER_HEAD));
    mustReject(() => recordDeliveryMerged(approved, OTHER_HEAD, MERGE, stamp(8)));
  });

  test("G4: CI needs a PR and failed CI cannot receive merge approval", () => {
    const prepared = preparedWork();
    mustReject(() => recordDeliveryCi(prepared, "passed", HEAD, "run-1", stamp(5)));
    const pr = recordDeliveryPr(prepared, "#13", HEAD, stamp(5));
    const failed = recordDeliveryCi(pr, "failed", HEAD, "run-1", stamp(6));
    mustReject(() => approveDeliveryMerge(failed, HEAD, "merge request", stamp(7)));
    mustReject(() => assertDeliveryMergeAllowed(failed, HEAD));
  });

  test("G5: preparing a new delivery replaces the complete previous chain", () => {
    const before = recordDeliveryMerged(approvedWork(), HEAD, MERGE, stamp(8));
    const next = prepareDelivery(before, "#30", "feature/next", OTHER_HEAD, stamp(9));
    expect(next.delivery.issue).toBe("#30");
    expect(next.delivery.branch).toBe("feature/next");
    expect(next.delivery.head).toBe(OTHER_HEAD);
    expect(next.delivery.pr).toBeUndefined();
    expect(next.delivery.ci).toBeUndefined();
    expect(next.delivery.mergeApproval).toBeUndefined();
    expect(next.delivery.merged).toBeUndefined();
    mustReject(() => assertDeliveryMergeAllowed(next, OTHER_HEAD));
  });

  test("G6: transition calls leave their input state unchanged", () => {
    const before = approvedWork();
    const snapshot = JSON.stringify(before);
    const pr = recordDeliveryPr(before, "#14", HEAD, stamp(9));
    const ci = recordDeliveryCi(before, "failed", HEAD, "run-2", stamp(9));
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(pr).not.toBe(before);
    expect(ci).not.toBe(before);
    expect(pr.delivery).not.toBe(before.delivery);
    expect(ci.delivery).not.toBe(before.delivery);
  });
});
