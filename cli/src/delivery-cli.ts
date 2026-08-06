import { currentGitPosition } from "./audit-integrity.ts";
import { ensureFlags, readFlag, requiredFlag } from "./cli-args.ts";
import {
  approveDeliveryMerge,
  assertDeliveryMergeAllowed,
  prepareDelivery,
  recordDeliveryCi,
  recordDeliveryMerged,
  recordDeliveryPr,
} from "./delivery.ts";
import { GdmError } from "./state.ts";
import { appendJournal, resolveWorkForRead, saveWork } from "./store.ts";

function assertCurrentGitPosition(cwd: string, head: string, branch?: string): void {
  const current = currentGitPosition(cwd);
  if (current === null) throw new GdmError("delivery는 커밋이 있는 Git 브랜치에서만 사용할 수 있습니다", "delivery_gate");
  if (current.head !== head.toLowerCase()) throw new GdmError("현재 Git HEAD가 delivery HEAD와 다릅니다", "delivery_gate");
  if (branch !== undefined && current.branch !== branch) throw new GdmError("현재 Git 브랜치가 delivery branch와 다릅니다", "delivery_gate");
}

export function cmdDelivery(cwd: string, args: string[], ts: string): void {
  const [sub, ...rest] = args;
  if (sub === "prepare") {
    ensureFlags(rest, ["slug", "issue", "branch", "head"]);
    const work = resolveWorkForRead(cwd, readFlag(rest, "slug"));
    const branch = requiredFlag(rest, "branch");
    const head = requiredFlag(rest, "head");
    assertCurrentGitPosition(cwd, head, branch);
    const next = prepareDelivery(work, requiredFlag(rest, "issue"), branch, head, ts);
    appendJournal(cwd, work.slug, { ts, event: "delivery.prepare", ...next.delivery });
    saveWork(cwd, next);
    console.log(`delivery 준비: ${next.delivery!.branch} ${next.delivery!.head}`);
    return;
  }
  if (sub === "pr") {
    ensureFlags(rest, ["slug", "number", "head"]);
    const work = resolveWorkForRead(cwd, readFlag(rest, "slug"));
    const head = requiredFlag(rest, "head");
    assertCurrentGitPosition(cwd, head, work.delivery?.branch);
    const next = recordDeliveryPr(work, requiredFlag(rest, "number"), head, ts);
    appendJournal(cwd, work.slug, { ts, event: "delivery.pr", ...next.delivery!.pr });
    saveWork(cwd, next);
    console.log(`PR 기록: ${next.delivery!.pr!.number}`);
    return;
  }
  if (sub === "ci") {
    ensureFlags(rest, ["slug", "status", "head", "run"]);
    const status = requiredFlag(rest, "status");
    if (status !== "passed" && status !== "failed") throw new GdmError("--status는 passed 또는 failed여야 합니다", "usage");
    const work = resolveWorkForRead(cwd, readFlag(rest, "slug"));
    const head = requiredFlag(rest, "head");
    assertCurrentGitPosition(cwd, head, work.delivery?.branch);
    const next = recordDeliveryCi(work, status, head, requiredFlag(rest, "run"), ts);
    appendJournal(cwd, work.slug, { ts, event: "delivery.ci", ...next.delivery!.ci });
    saveWork(cwd, next);
    console.log(`CI 기록: ${status} (${next.delivery!.ci!.run})`);
    return;
  }
  if (sub === "approve-merge") {
    ensureFlags(rest, ["slug", "head", "reason"]);
    const work = resolveWorkForRead(cwd, readFlag(rest, "slug"));
    const head = requiredFlag(rest, "head");
    assertCurrentGitPosition(cwd, head, work.delivery?.branch);
    const next = approveDeliveryMerge(work, head, requiredFlag(rest, "reason"), ts);
    appendJournal(cwd, work.slug, { ts, event: "delivery.merge-approved", ...next.delivery!.mergeApproval });
    saveWork(cwd, next);
    console.log(`머지 승인 기록: ${next.delivery!.head}`);
    return;
  }
  if (sub === "check-merge") {
    ensureFlags(rest, ["slug", "head"]);
    const work = resolveWorkForRead(cwd, readFlag(rest, "slug"));
    const head = requiredFlag(rest, "head");
    assertCurrentGitPosition(cwd, head, work.delivery?.branch);
    const delivery = assertDeliveryMergeAllowed(work, head);
    console.log(`머지 가능: PR ${delivery.pr!.number} · CI ${delivery.ci?.run ?? "체크 없음"} · HEAD ${delivery.head}`);
    return;
  }
  if (sub === "merged") {
    ensureFlags(rest, ["slug", "head", "merge-sha"]);
    const work = resolveWorkForRead(cwd, readFlag(rest, "slug"));
    const next = recordDeliveryMerged(work, requiredFlag(rest, "head"), requiredFlag(rest, "merge-sha"), ts);
    appendJournal(cwd, work.slug, { ts, event: "delivery.merged", ...next.delivery!.merged });
    saveWork(cwd, next);
    console.log(`머지 기록: ${next.delivery!.merged!.sha}`);
    return;
  }
  throw new GdmError("delivery 하위 명령을 확인하세요", "usage");
}
