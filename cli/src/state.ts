import { createHash } from "node:crypto";
import { defaultContract, normalizeContract } from "./contract.ts";
import type {
  Audit,
  Check,
  CheckKind,
  Evidence,
  Work,
  WorkContract,
  WorkspaceFingerprint,
} from "./types.ts";
import { isCanonicalTimestamp } from "./validation-boundary.ts";

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
  baseline?: WorkspaceFingerprint | null,
): Work {
  validateSlug(slug);
  const trimmed = brief.trim();
  if (!trimmed) throw new GdmError("brief(작업 설명)가 비어 있습니다", "empty_brief");
  return {
    slug,
    brief: trimmed,
    createdAt: now,
    done: false,
    auditRequired,
    ...(baseline === undefined ? {} : { baseline }),
    checks: [],
    contract,
  };
}

export function checksHash(work: Work): string {
  return createHash("sha256").update(JSON.stringify(work.checks)).digest("hex");
}

/**
 * Hash only the user-approved verification plan. Runtime fields such as check
 * status and evidence are intentionally excluded so executing the plan does
 * not change its identity.
 */
export function verificationPlanFingerprint(work: Work): string {
  const hash = createHash("sha256");
  const appendCount = (count: number): void => {
    const encoded = Buffer.allocUnsafe(8);
    encoded.writeBigUInt64BE(BigInt(count));
    hash.update(encoded);
  };
  const appendString = (value: string): void => {
    const encoded = Buffer.from(value, "utf8");
    appendCount(encoded.byteLength);
    hash.update(encoded);
  };
  const appendBool = (value: boolean): void => {
    hash.update(Uint8Array.of(value ? 1 : 0));
  };
  const appendStrings = (values: readonly string[]): void => {
    appendCount(values.length);
    for (const value of values) appendString(value);
  };
  const appendNullableString = (value: string | null | undefined): void => {
    if (value === null || value === undefined) {
      hash.update(Uint8Array.of(0));
      return;
    }
    hash.update(Uint8Array.of(1));
    appendString(value);
  };

  // Work loaded through validateWork always has a normalized contract. The
  // fallbacks also make the canonical format explicit for legacy producers.
  const contract = work.contract as Partial<WorkContract> | undefined;
  appendString("gidem-verification-plan-v1");
  appendString(work.brief);
  appendBool(work.auditRequired ?? false);
  appendStrings(contract?.required ?? []);
  appendStrings(contract?.forbidden ?? []);
  appendString(contract?.commit ?? "forbidden");
  appendStrings(contract?.assumptions ?? []);
  appendStrings(contract?.uncertainties ?? []);
  appendStrings(contract?.allowedPaths ?? ["."]);
  appendStrings(contract?.forbiddenPaths ?? []);
  appendStrings(contract?.stopConditions ?? []);
  appendString(contract?.risk ?? "low");
  appendString(contract?.verification ?? "deterministic");
  appendBool(contract?.simplificationRequired ?? false);
  if (contract?.outcome !== undefined) {
    appendString("gidem-outcome-intent-v1");
    appendString(contract.outcome.bottleneck);
    appendString(contract.outcome.desiredOutcome);
    appendString(contract.outcome.baseline);
    appendString(contract.outcome.target);
    appendString(contract.outcome.unit);
    appendString(contract.outcome.interveneIf);
  }
  appendCount(work.checks.length);
  for (const check of work.checks) {
    appendString(check.id);
    appendString(check.desc);
    appendNullableString(check.cmd);
    appendString(check.expect);
    appendBool(check.manual);
    appendString(check.kind ?? (check.manual ? "manual" : "behavior"));
    appendBool(check.expert ?? false);
  }
  return hash.digest("hex");
}

export function recordVerificationPlanSourceFingerprint(work: Work, fingerprint: string): Work {
  if (work.done) throw new GdmError("완료된 작업의 source fingerprint는 바꿀 수 없습니다", "work_done");
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new GdmError("--fingerprint는 소문자 64자리 SHA-256이어야 합니다", "usage");
  }
  return { ...work, verificationPlanSourceFingerprint: fingerprint };
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
  kind?: CheckKind;
  expert?: boolean;
}

export function parseCheckKind(value: string | undefined): CheckKind | undefined {
  if (value === undefined) return undefined;
  if (value === "regression" || value === "behavior" || value === "edge" || value === "static" || value === "manual") {
    return value;
  }
  throw new GdmError("--kind는 regression, behavior, edge, static, manual 중 하나여야 합니다", "usage");
}

export function checkKind(check: Check): CheckKind {
  return check.kind ?? (check.manual ? "manual" : "behavior");
}

export function addCheck(work: Work, input: CheckInput): { work: Work; check: Check } {
  if (work.done) throw new GdmError("완료된 작업에는 항목을 추가할 수 없습니다", "work_done");
  const desc = input.desc?.trim();
  if (!desc) throw new GdmError("desc(항목 설명)가 비어 있습니다", "empty_desc");
  const manual = input.manual ?? false;
  const kind = input.kind ?? (manual ? "manual" : "behavior");
  const expert = input.expert ?? false;
  const cmd = input.cmd?.trim() || null;
  const expect = input.expect?.trim() ?? "";
  if (!manual && !cmd) {
    throw new GdmError(
      "자동 항목에는 재현 명령(--cmd)이 필수입니다. 수동 확인 항목이면 --manual을 붙이세요",
      "cmd_required",
    );
  }
  if (!expect) throw new GdmError("기대 관찰(--expect)이 필수입니다", "expect_required");
  if ((manual && kind !== "manual") || (!manual && kind === "manual")) {
    throw new GdmError("manual kind와 --manual은 함께 지정해야 합니다", "usage");
  }
  if (expert && !manual) {
    throw new GdmError("--expert는 --manual 전문가 확인 항목에만 쓸 수 있습니다", "usage");
  }
  const maxN = work.checks.reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0);
  const check: Check = { id: `c${maxN + 1}`, desc, cmd, expect, manual, kind, expert, status: "open" };
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
  if (checkKind(check) === "regression" && !check.redEvidence) {
    throw new GdmError(
      `${id}는 regression 항목입니다. 먼저 gdm pass ${id} --red로 실패를 재현하세요`,
      "red_evidence_required",
    );
  }
  if (check.redEvidence && check.redEvidence.at > now) {
    throw new GdmError("regression green 증거는 red 증거보다 먼저 기록될 수 없습니다", "red_evidence_required");
  }
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
  if (check.expert && (!evidence.reviewer?.trim() || !evidence.note?.trim())) {
    throw new GdmError(
      `${id}는 전문가 확인 항목입니다. --reviewer와 --note에 검토자와 판단 근거를 기록하세요`,
      "expert_evidence_required",
    );
  }
  return replaceCheck(work, { ...check, status: "proven", evidence: { ...evidence, at: now } });
}

export function recordRedEvidence(
  work: Work,
  id: string,
  evidence: Omit<Evidence, "at">,
  now: string,
): Work {
  const check = assertPassable(work, id);
  if (checkKind(check) !== "regression" || check.manual) {
    throw new GdmError(`${id}는 regression 자동 항목이 아닙니다. --red를 제거하세요`, "red_not_allowed");
  }
  if (evidence.manual || evidence.exitCode === undefined || evidence.exitCode === 0) {
    throw new GdmError("red 증거는 동일 자동 명령의 non-zero 종료여야 합니다", "red_expected_failure");
  }
  if (!evidence.observed?.trim() || !evidence.sha256?.trim()) {
    throw new GdmError("red 증거 파일과 해시가 필요합니다", "red_evidence_required");
  }
  return replaceCheck(work, { ...check, redEvidence: { ...evidence, at: now } });
}

export interface CheckPatch {
  desc?: string;
  cmd?: string;
  expect?: string;
  kind?: CheckKind;
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
  if (patch.kind !== undefined && patch.kind !== checkKind(check)) {
    next.kind = patch.kind;
    changed = true;
  }
  if (!changed) throw new GdmError("바뀐 내용이 없습니다", "no_changes");
  if (!next.manual && !next.cmd) {
    throw new GdmError("자동 항목에서 재현 명령(cmd)을 비울 수 없습니다", "cmd_required");
  }
  if (!next.expect) throw new GdmError("기대 관찰(expect)을 비울 수 없습니다", "expect_required");
  if ((next.manual && checkKind(next) !== "manual") || (!next.manual && checkKind(next) === "manual")) {
    throw new GdmError("manual kind는 수동 항목에만 사용할 수 있습니다", "usage");
  }
  const reverted = check.status === "proven";
  next.status = "open";
  delete next.evidence;
  delete next.redEvidence;
  return { work: replaceCheck(work, next), reverted };
}

export function revertChecks(work: Work, ids: string[], clearRedIds: readonly string[] = []): Work {
  return {
    ...work,
    checks: work.checks.map((c) =>
      ids.includes(c.id)
        ? {
            ...c,
            status: "open" as const,
            evidence: undefined,
            ...(clearRedIds.includes(c.id) ? { redEvidence: undefined } : {}),
          }
        : c,
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

export type CompletionBlockerCode =
  | "no_checks"
  | "unproven"
  | "simplification_required"
  | "expert_review_required"
  | "audit_required"
  | "audit_failed"
  | "audit_stale";

export interface CompletionBlocker {
  readonly code: CompletionBlockerCode;
  readonly message: string;
}

/**
 * Project the persisted-state prerequisites that closeWork owns. Filesystem
 * scope, automatic command replay, and evidence/audit file integrity remain
 * gdm done responsibilities and are intentionally not predicted here.
 */
export function completionBlockers(work: Work): readonly CompletionBlocker[] {
  if (work.done) return [];
  const blockers: CompletionBlocker[] = [];
  if (work.checks.length === 0) {
    blockers.push({
      code: "no_checks",
      message: "확인 항목이 하나도 없습니다. gdm plan add로 항목부터 세우세요",
    });
  }
  const open = work.checks.filter((check) => check.status !== "proven");
  if (open.length > 0) {
    const list = open.map((check) => `${check.id}(${check.desc})`).join(", ");
    blockers.push({ code: "unproven", message: `미통과 항목 ${open.length}개: ${list}` });
  }
  if (work.contract.simplificationRequired) {
    const staticProof = work.checks.some((check) => check.status === "proven" && checkKind(check) === "static");
    if (!staticProof) {
      blockers.push({
        code: "simplification_required",
        message: "간소화 확인이 필요합니다. --kind static 항목을 추가하고 불필요한 복잡성이 없음을 증명하세요",
      });
    }
  }
  if (work.contract.risk === "high" && work.contract.verification === "opaque") {
    const expertProof = work.checks.some(
      (check) => check.status === "proven" && check.expert === true && check.manual &&
        Boolean(check.evidence?.reviewer?.trim()) && Boolean(check.evidence?.note?.trim()),
    );
    if (!expertProof) {
      blockers.push({
        code: "expert_review_required",
        message: "high+opaque 작업은 전문가 확인이 필요합니다. --manual --expert 항목과 reviewer·판단 근거를 제출하세요",
      });
    }
  }
  if (work.auditRequired || work.contract.risk === "high") {
    if (!work.audit) {
      blockers.push({
        code: "audit_required",
        message: "검수가 필요한 작업입니다. gdm audit brief → 검수자 → gdm audit verdict",
      });
    } else if (work.audit.result !== "pass") {
      blockers.push({ code: "audit_failed", message: "검수가 반려됐습니다. 반려 사유를 해결하고 재검수하세요" });
    } else if (work.audit.stateHash !== checksHash(work)) {
      blockers.push({ code: "audit_stale", message: "검수 이후 항목 상태가 바뀌었습니다. 재검수가 필요합니다" });
    }
  }
  return blockers;
}

export function closeWork(work: Work, now: string): Work {
  if (work.done) throw new GdmError("이미 완료된 작업입니다", "work_done");
  const blocker = completionBlockers(work)[0];
  if (blocker !== undefined) throw new GdmError(blocker.message, blocker.code);
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
  if (
    work.verificationPlanSourceFingerprint !== undefined &&
    !/^[0-9a-f]{64}$/u.test(work.verificationPlanSourceFingerprint)
  ) bad("verificationPlanSourceFingerprint 형태 오류");
  if (!Array.isArray(work.checks)) bad("checks가 배열이 아님");
  try {
    validateSlug(work.slug);
  } catch {
    bad("slug 형태 오류");
  }
  if (typeof work.createdAt !== "string" || !isCanonicalTimestamp(work.createdAt)) {
    bad("createdAt canonical timestamp 오류");
  }
  if (work.auditRequired !== undefined && typeof work.auditRequired !== "boolean") {
    bad("auditRequired 형태 오류");
  }
  if (work.doneAt !== undefined && (typeof work.doneAt !== "string" || !isCanonicalTimestamp(work.doneAt))) {
    bad("doneAt canonical timestamp 오류");
  }
  if (work.done !== (work.doneAt !== undefined)) bad("done/doneAt 상태 불일치");
  if (work.doneAt !== undefined && work.doneAt < work.createdAt) bad("doneAt이 createdAt보다 빠름");
  const checks: Check[] = [];
  for (const check of work.checks) {
    if (
      typeof check !== "object" || check === null || typeof check.id !== "string" ||
      typeof check.desc !== "string" || (typeof check.cmd !== "string" && check.cmd !== null) ||
      typeof check.expect !== "string" || typeof check.manual !== "boolean"
    ) bad("check 형태 오류");
    if (check.status !== "open" && check.status !== "proven") bad(`${check.id}: status 값 오류`);
    const validEvidence = (evidence: Evidence | undefined): evidence is Evidence =>
      evidence !== undefined && typeof evidence === "object" &&
      typeof evidence.observed === "string" && evidence.observed.length > 0 &&
      typeof evidence.sha256 === "string" && /^[0-9a-f]{64}$/u.test(evidence.sha256) &&
      typeof evidence.manual === "boolean" && typeof evidence.at === "string" &&
      isCanonicalTimestamp(evidence.at) &&
      (
        evidence.exitCode === undefined ||
        (typeof evidence.exitCode === "number" && Number.isSafeInteger(evidence.exitCode))
      ) &&
      (evidence.note === undefined || typeof evidence.note === "string") &&
      (evidence.reviewer === undefined || typeof evidence.reviewer === "string");
    if (check.evidence !== undefined && !validEvidence(check.evidence)) bad(`${check.id}: evidence 형태 오류`);
    if (check.status === "proven" && !validEvidence(check.evidence)) {
      bad(`${check.id}: 증거 없이 proven — 상태 파일이 gdm 외부에서 수정됨`);
    }
    if (check.evidence !== undefined && check.evidence.manual !== check.manual) {
      bad(`${check.id}: evidence manual 불일치`);
    }
    const kind = check.kind === undefined ? (check.manual ? "manual" : "behavior") : check.kind;
    if (kind !== "regression" && kind !== "behavior" && kind !== "edge" && kind !== "static" && kind !== "manual") {
      bad(`${check.id}: kind 값 오류`);
    }
    if ((check.manual && kind !== "manual") || (!check.manual && kind === "manual")) {
      bad(`${check.id}: manual/kind 불일치`);
    }
    if (check.expert !== undefined && typeof check.expert !== "boolean") bad(`${check.id}: expert 값 오류`);
    if (check.expert && !check.manual) bad(`${check.id}: expert 자동 항목 오류`);
    if (
      check.redEvidence !== undefined &&
      (
        !validEvidence(check.redEvidence) || kind !== "regression" ||
        check.redEvidence.manual || typeof check.redEvidence.exitCode !== "number" ||
        check.redEvidence.exitCode === 0 ||
        (check.evidence?.at !== undefined && check.redEvidence.at > check.evidence.at)
      )
    ) {
      bad(`${check.id}: red 증거 형태 또는 순서 오류`);
    }
    // Preserve legacy check object bytes semantically: adding default fields here would
    // change checksHash and invalidate an audit recorded by an older gdm version.
    checks.push(check);
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
  if (work.audit !== undefined) {
    const audit = work.audit;
    if (
      typeof audit !== "object" || audit === null ||
      (audit.result !== "pass" && audit.result !== "fail") ||
      typeof audit.report !== "string" || audit.report.length === 0 ||
      typeof audit.stateHash !== "string" || !/^[0-9a-f]{64}$/u.test(audit.stateHash) ||
      typeof audit.at !== "string" || !isCanonicalTimestamp(audit.at) ||
      (
        audit.reportSha256 !== undefined &&
        (typeof audit.reportSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(audit.reportSha256))
      ) ||
      (audit.implementationModel !== undefined && typeof audit.implementationModel !== "string") ||
      (audit.auditModel !== undefined && typeof audit.auditModel !== "string")
    ) bad("audit 형태 오류");
    if (audit.workspace !== undefined && audit.workspace !== null) validateFingerprint(audit.workspace, bad);
  }
  if (work.baseline !== undefined && work.baseline !== null) validateFingerprint(work.baseline, bad);
  const validated = { ...work, checks, contract: normalizeContract(work.contract) };
  if (validated.done) {
    const blockers = completionBlockers({ ...validated, done: false, doneAt: undefined });
    if (blockers.length > 0) {
      bad(`완료 상태가 선행 조건과 모순됨: ${blockers.map((blocker) => blocker.code).join(", ")}`);
    }
  }
  return validated;
}

function validateFingerprint(fingerprint: WorkspaceFingerprint, bad: (why: string) => never): void {
  if (
    fingerprint.kind !== "git" || typeof fingerprint.head !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64}|unborn)$/u.test(fingerprint.head) ||
    typeof fingerprint.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(fingerprint.sha256)
  ) bad("baseline 형태 오류");
  if (
    fingerprint.files !== undefined &&
    (!Array.isArray(fingerprint.files) || fingerprint.files.some(
      (file) => {
        if (typeof file?.path !== "string" || !/^[0-9a-f]{64}$/u.test(file?.sha256 ?? "")) return true;
        const segments = file.path.split("/");
        return file.path.length === 0 || file.path.startsWith("/") ||
          segments.some((segment: string) => segment === "" || segment === "." || segment === "..") ||
          file.path === ".gdm" || file.path.startsWith(".gdm/");
      },
    ))
  ) bad("baseline.files 형태 오류");
  if (fingerprint.files && new Set(fingerprint.files.map((file) => file.path)).size !== fingerprint.files.length) {
    bad("baseline.files 중복 경로");
  }
}
