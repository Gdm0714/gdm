import { createHash } from "node:crypto";
import { defaultContract, normalizeContract } from "./contract.ts";
import type { Audit, Check, Evidence, Work, WorkContract, WorkspaceFingerprint } from "./types.ts";

export class GdmError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "GdmError";
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,50}$/;

export function validateSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new GdmError(`슬러그는 소문자 영문/숫자/하이픈 2~51자여야 합니다: "${slug}"`, "bad_slug");
  }
  return slug;
}

export function initWork(
  slug: string,
  brief: string,
  now: string,
  auditRequired = false,
  contract: WorkContract = defaultContract(),
): Work {
  validateSlug(slug);
  const trimmed = brief.trim();
  if (!trimmed) throw new GdmError("brief(작업 설명)가 비어 있습니다", "empty_brief");
  return { slug, brief: trimmed, createdAt: now, done: false, auditRequired, checks: [], contract };
}

export function checksHash(work: Work): string {
  return createHash("sha256").update(JSON.stringify(work.checks)).digest("hex");
}

export function recordAudit(
  work: Work,
  result: Audit["result"],
  report: string,
  reportSha256: string,
  implementationModel: string,
  auditModel: string,
  workspace: WorkspaceFingerprint | null,
  now: string,
): Work {
  if (work.done) throw new GdmError("이미 완료된 작업입니다", "work_done");
  const open = work.checks.filter((c) => c.status !== "proven");
  if (work.checks.length === 0 || open.length > 0) {
    throw new GdmError(
      `검수는 모든 항목 통과 후에 가능합니다 (미통과: ${open.map((c) => c.id).join(", ") || "항목 없음"})`,
      "audit_premature",
    );
  }
  if (!report?.trim()) throw new GdmError("검수보고 파일 경로(report)가 필요합니다", "report_required");
  if (!reportSha256?.trim()) throw new GdmError("검수보고 해시가 필요합니다", "report_required");
  if (!implementationModel?.trim() || !auditModel?.trim()) {
    throw new GdmError("구현 모델과 검수 모델이 필요합니다", "audit_models_required");
  }
  if (implementationModel.trim().toLowerCase() === auditModel.trim().toLowerCase()) {
    throw new GdmError("구현 모델과 검수 모델은 달라야 합니다", "audit_independence");
  }
  return {
    ...work,
    audit: {
      result,
      report,
      reportSha256,
      implementationModel: implementationModel.trim(),
      auditModel: auditModel.trim(),
      workspace,
      stateHash: checksHash(work),
      at: now,
    },
  };
}

export interface CheckInput {
  desc: string;
  cmd?: string | null;
  expect?: string;
  manual?: boolean;
}

export function addCheck(work: Work, input: CheckInput): { work: Work; check: Check } {
  if (work.done) throw new GdmError("완료된 작업에는 항목을 추가할 수 없습니다", "work_done");
  const desc = input.desc?.trim();
  if (!desc) throw new GdmError("desc(항목 설명)가 비어 있습니다", "empty_desc");
  const manual = input.manual ?? false;
  const cmd = input.cmd?.trim() || null;
  const expect = input.expect?.trim() ?? "";
  if (!manual && !cmd) {
    throw new GdmError(
      "자동 항목에는 재현 명령(--cmd)이 필수입니다. 수동 확인 항목이면 --manual을 붙이세요",
      "cmd_required",
    );
  }
  if (!expect) throw new GdmError("기대 관찰(--expect)이 필수입니다", "expect_required");
  const maxN = work.checks.reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0);
  const check: Check = { id: `c${maxN + 1}`, desc, cmd, expect, manual, status: "open" };
  return { work: { ...work, checks: [...work.checks, check] }, check };
}

export function findCheck(work: Work, id: string): Check {
  const check = work.checks.find((c) => c.id === id);
  if (!check) {
    const ids = work.checks.map((c) => c.id).join(", ") || "없음";
    throw new GdmError(`항목 ${id}가 없습니다 (현재 항목: ${ids})`, "check_not_found");
  }
  return check;
}

function replaceCheck(work: Work, next: Check): Work {
  return { ...work, checks: work.checks.map((c) => (c.id === next.id ? next : c)) };
}

export function assertPassable(work: Work, id: string): Check {
  if (work.done) throw new GdmError("이미 완료된 작업입니다", "work_done");
  const check = findCheck(work, id);
  if (check.status === "proven") throw new GdmError(`${id}는 이미 통과했습니다`, "already_proven");
  return check;
}

export function passCheck(work: Work, id: string, evidence: Omit<Evidence, "at">, now: string): Work {
  const check = assertPassable(work, id);
  if (!check.manual && evidence.manual) {
    throw new GdmError(`${id}는 자동 검증 항목입니다. 수동 증거로는 통과할 수 없습니다`, "manual_not_allowed");
  }
  if (check.manual && !evidence.manual) {
    throw new GdmError(
      `${id}는 수동 확인 항목입니다. --manual과 함께 확인 기록(스크린샷 등) 경로를 제출하세요`,
      "manual_required",
    );
  }
  if (!evidence.observed?.trim()) {
    throw new GdmError("증거 파일 경로(observed)가 필요합니다", "observed_required");
  }
  if (!evidence.sha256?.trim()) {
    throw new GdmError("증거 파일 해시(sha256)가 필요합니다", "sha256_required");
  }
  return replaceCheck(work, { ...check, status: "proven", evidence: { ...evidence, at: now } });
}

export interface CheckPatch {
  desc?: string;
  cmd?: string;
  expect?: string;
}

export function editCheck(
  work: Work,
  id: string,
  patch: CheckPatch,
  reason: string,
): { work: Work; reverted: boolean } {
  if (work.done) throw new GdmError("이미 완료된 작업입니다", "work_done");
  if (!reason?.trim()) throw new GdmError("항목 수정에는 --reason(사유)이 필수입니다", "reason_required");
  const check = findCheck(work, id);
  const next: Check = { ...check };
  let changed = false;
  if (patch.desc !== undefined && patch.desc.trim() !== check.desc) {
    if (!patch.desc.trim()) throw new GdmError("desc(항목 설명)를 비울 수 없습니다", "empty_desc");
    next.desc = patch.desc.trim();
    changed = true;
  }
  if (patch.cmd !== undefined && (patch.cmd.trim() || null) !== check.cmd) {
    next.cmd = patch.cmd.trim() || null;
    changed = true;
  }
  if (patch.expect !== undefined && patch.expect.trim() !== check.expect) {
    next.expect = patch.expect.trim();
    changed = true;
  }
  if (!changed) throw new GdmError("바뀐 내용이 없습니다", "no_changes");
  if (!next.manual && !next.cmd) {
    throw new GdmError("자동 항목에서 재현 명령(cmd)을 비울 수 없습니다", "cmd_required");
  }
  if (!next.expect) throw new GdmError("기대 관찰(expect)을 비울 수 없습니다", "expect_required");
  const reverted = check.status === "proven";
  if (reverted) {
    next.status = "open";
    delete next.evidence;
  }
  return { work: replaceCheck(work, next), reverted };
}

export function revertChecks(work: Work, ids: string[]): Work {
  return {
    ...work,
    checks: work.checks.map((c) =>
      ids.includes(c.id) ? { ...c, status: "open" as const, evidence: undefined } : c,
    ),
  };
}

export function refreshEvidence(work: Work, id: string, evidence: Omit<Evidence, "at">, now: string): Work {
  const check = findCheck(work, id);
  if (check.status !== "proven") {
    throw new GdmError(`${id}는 통과 상태가 아닙니다. gdm pass를 쓰세요`, "not_proven");
  }
  if (check.manual) throw new GdmError(`${id}는 수동 항목이라 재검증할 수 없습니다`, "manual_not_allowed");
  return replaceCheck(work, { ...check, evidence: { ...evidence, at: now } });
}

export function closeWork(work: Work, now: string): Work {
  if (work.done) throw new GdmError("이미 완료된 작업입니다", "work_done");
  if (work.checks.length === 0) {
    throw new GdmError("확인 항목이 하나도 없습니다. gdm plan add로 항목부터 세우세요", "no_checks");
  }
  const open = work.checks.filter((c) => c.status !== "proven");
  if (open.length > 0) {
    const list = open.map((c) => `${c.id}(${c.desc})`).join(", ");
    throw new GdmError(`미통과 항목 ${open.length}개: ${list}`, "unproven");
  }
  if (work.auditRequired) {
    if (!work.audit) {
      throw new GdmError("검수가 필요한 작업입니다. gdm audit brief → 검수자 → gdm audit verdict", "audit_required");
    }
    if (work.audit.result !== "pass") {
      throw new GdmError("검수가 반려됐습니다. 반려 사유를 해결하고 재검수하세요", "audit_failed");
    }
    if (work.audit.stateHash !== checksHash(work)) {
      throw new GdmError("검수 이후 항목 상태가 바뀌었습니다. 재검수가 필요합니다", "audit_stale");
    }
  }
  return { ...work, done: true, doneAt: now };
}

export function provenCount(work: Work): { proven: number; total: number } {
  return {
    proven: work.checks.filter((c) => c.status === "proven").length,
    total: work.checks.length,
  };
}

export function validateWork(raw: unknown, source: string): Work {
  const bad = (why: string): never => {
    throw new GdmError(`상태 파일이 손상됐습니다 (${source}): ${why}`, "state_corrupt");
  };
  if (typeof raw !== "object" || raw === null) bad("객체가 아님");
  const work = raw as Work;
  if (typeof work.slug !== "string" || typeof work.brief !== "string") bad("slug/brief 누락");
  if (typeof work.done !== "boolean") bad("done 누락");
  if (!Array.isArray(work.checks)) bad("checks가 배열이 아님");
  for (const check of work.checks) {
    if (typeof check?.id !== "string" || typeof check?.desc !== "string") bad("check 형태 오류");
    if (check.status !== "open" && check.status !== "proven") bad(`${check.id}: status 값 오류`);
    if (check.status === "proven" && !check.evidence?.sha256) {
      bad(`${check.id}: 증거 없이 proven — 상태 파일이 gdm 외부에서 수정됨`);
    }
  }
  if (work.delivery !== undefined) {
    const delivery = work.delivery;
    if (
      typeof delivery !== "object" || delivery === null || typeof delivery.issue !== "string" ||
      typeof delivery.branch !== "string" || typeof delivery.head !== "string" ||
      typeof delivery.preparedAt !== "string"
    ) bad("delivery 형태 오류");
    if (delivery.pr && (typeof delivery.pr.number !== "string" || typeof delivery.pr.head !== "string")) {
      bad("delivery.pr 형태 오류");
    }
    if (
      delivery.ci &&
      ((delivery.ci.status !== "passed" && delivery.ci.status !== "failed") ||
        typeof delivery.ci.head !== "string" || typeof delivery.ci.run !== "string")
    ) bad("delivery.ci 형태 오류");
    if (
      delivery.mergeApproval &&
      (typeof delivery.mergeApproval.head !== "string" || typeof delivery.mergeApproval.reason !== "string")
    ) bad("delivery.mergeApproval 형태 오류");
    if (delivery.merged && typeof delivery.merged.sha !== "string") bad("delivery.merged 형태 오류");
  }
  return { ...work, contract: normalizeContract(work.contract) };
}
