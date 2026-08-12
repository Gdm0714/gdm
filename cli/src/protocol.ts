import { createHash } from "node:crypto";
import { opaqueId, privacyError, safeText } from "./contract.ts";
import { readContainedFile } from "./contained-file.ts";
import {
  type ProtocolArtifact,
  type ProtocolHandoffEvent,
  type ProtocolExitStatus,
  type ProtocolReceiptEvent,
  type ProtocolRunnerObserved,
  normalizeProtocolObservationText,
  readProtocolHandoffEvents,
  readProtocolReceiptEvents,
} from "./protocol-journal.ts";
import type { SourceFingerprint } from "./source-fingerprint.ts";
import {
  checkKind,
  checksHash,
  completionBlockers,
  GdmError,
  verificationPlanFingerprint,
} from "./state.ts";
import type { Evidence, JournalEvent, Work } from "./types.ts";
import { isCanonicalTimestamp } from "./validation-boundary.ts";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const SOURCE_FINGERPRINT_KEYS = ["schemaVersion", "sha256", "fileCount"] as const;
const OPENAI_KEY_RE = /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]+/iu;
const CREDENTIAL_RE = /(?:ghp_|github_pat_|AKIA|Bearer |BEGIN [A-Z ]*PRIVATE KEY)/iu;
const JWT_RE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u;
export const PROTOCOL_ARTIFACT_MAX_BYTES = 1024 * 1024;
export const PROTOCOL_LEGACY_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const PROTOCOL_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const PROTOCOL_BUNDLE_MAX_BYTES = 4 * 1024 * 1024;

export interface RawProtocolHandoffRequest {
  readonly handoffId: string;
  readonly fromRole: string;
  readonly fromProvider?: string;
  readonly toRole: string;
  readonly toProvider?: string;
  readonly intent: string;
  readonly artifact?: string;
  readonly expectedPlanFingerprint?: string;
  readonly expectedStateFingerprint?: string;
  readonly expectedSourceFingerprint?: string;
}

export const READ_ONLY_SPECIALIST_PROFILE = "gdm-read-only-specialist/v1" as const;

export interface ProtocolDispatchBundlePayload {
  readonly schemaVersion: "gdm-dispatch-bundle/v1";
  readonly claimId: string;
  readonly handoff: ProtocolHandoffEvent;
  readonly snapshot: WorkSnapshot;
  readonly receiver: { readonly role: string };
  readonly capabilityProfile: typeof READ_ONLY_SPECIALIST_PROFILE;
  readonly artifact: ({ readonly text: string; readonly bytesBase64: string } & ProtocolArtifact) | null;
}

export interface ProtocolDispatchBundle extends ProtocolDispatchBundlePayload {
  readonly bundleSha256: string;
}

export interface ProtocolDispatchModelView extends Omit<ProtocolDispatchBundle, "schemaVersion" | "artifact"> {
  readonly schemaVersion: "gdm-dispatch-model-view/v1";
  readonly artifact: ({ readonly text: string } & ProtocolArtifact) | null;
}

export interface RawProtocolClaimRequest {
  readonly handoffEventId: string;
  readonly claimId: string;
  readonly receiverRole: string;
  readonly receiverProvider?: string;
  readonly capabilityProfile: string;
  readonly modelRequested?: string;
}

export interface RawProtocolFinishRequest {
  readonly claimId: string;
  readonly exitCode: string;
  readonly outputArtifact: string;
  readonly providerTarget: string;
  readonly adapterVersion: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly executableVersion: string;
  readonly argvPolicyId: string;
  readonly modelRequested?: string;
  readonly failureCode?: string;
}

export interface RawProtocolAdoptRequest {
  readonly claimId: string;
}

export interface RawProtocolRecoverRequest extends RawProtocolAdoptRequest {
  readonly reason: string;
}

export interface ProtocolMutation<T> {
  readonly event: T;
  readonly changed: boolean;
  readonly rejectedCode?: string;
}

export interface ProtocolLifecycleStatus {
  readonly schemaVersion: "gdm-protocol-status/v1";
  readonly slug: string;
  readonly lifecycles: readonly {
    readonly claimId: string;
    readonly stage: ProtocolReceiptEvent["stage"];
    readonly handoffEventId: string;
    readonly bundleSha256: string;
    readonly receiver: ProtocolReceiptEvent["receiver"];
    readonly capabilityProfile: typeof READ_ONLY_SPECIALIST_PROFILE;
    readonly runnerObserved: ProtocolRunnerObserved | null;
    readonly stale: boolean;
    readonly staleReasons: readonly string[];
  }[];
}

export interface WorkSnapshot {
  readonly schemaVersion: "gdm-work-snapshot/v1";
  readonly work: {
    readonly slug: string;
    readonly brief: string;
    readonly createdAt: string;
    readonly doneAt: string | null;
    readonly phase: "planning" | "executing" | "auditing" | "completed";
    readonly planFingerprint: string;
    readonly stateFingerprint: string;
    readonly planSourceFingerprint: string | null;
    readonly sourceFingerprint: SourceFingerprint;
  };
  readonly contract: Readonly<Record<string, unknown>>;
  readonly checks: readonly Readonly<Record<string, unknown>>[];
  readonly audit: Readonly<Record<string, unknown>>;
  readonly completion: {
    readonly state: "blocked" | "ready-to-validate" | "completed";
    readonly blockers: readonly { readonly code: string; readonly message: string }[];
    readonly validationCommand: string | null;
  };
  readonly latestHandoff: Readonly<Record<string, unknown>> | null;
}

type PreparedProtocolHandoff = Omit<RawProtocolHandoffRequest,
  "expectedPlanFingerprint" | "expectedStateFingerprint" | "expectedSourceFingerprint"> & {
    readonly expectedPlanFingerprint?: string;
    readonly expectedStateFingerprint?: string;
    readonly expectedSourceFingerprint?: string;
  };

export type ProtocolHandoffMutation = {
  readonly event: ProtocolHandoffEvent;
  readonly changed: boolean;
};

function appendHashValue(hash: ReturnType<typeof createHash>, value: unknown): void {
  if (value === null) {
    hash.update(Uint8Array.of(0));
    return;
  }
  if (typeof value === "boolean") {
    hash.update(Uint8Array.of(value ? 2 : 1));
    return;
  }
  if (typeof value === "number") {
    hash.update(Uint8Array.of(3));
    const encoded = Buffer.from(String(value), "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(encoded.byteLength));
    hash.update(length).update(encoded);
    return;
  }
  if (typeof value === "string") {
    hash.update(Uint8Array.of(4));
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(encoded.byteLength));
    hash.update(length).update(encoded);
    return;
  }
  if (Array.isArray(value)) {
    hash.update(Uint8Array.of(5));
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(value.length));
    hash.update(length);
    for (const entry of value) appendHashValue(hash, entry);
    return;
  }
  if (typeof value === "object" && value !== null) {
    hash.update(Uint8Array.of(6));
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(entries.length));
    hash.update(length);
    for (const [key, entry] of entries) {
      appendHashValue(hash, key);
      appendHashValue(hash, entry);
    }
    return;
  }
  throw new GdmError("protocol state fingerprint가 지원하지 않는 값입니다", "state_corrupt");
}

/** Hash core Work state while intentionally excluding optional delivery state. */
export function protocolStateFingerprint(work: Work): string {
  const hash = createHash("sha256");
  appendHashValue(hash, "gdm-work-state-v1");
  const contract = work.contract;
  appendHashValue(hash, {
    slug: work.slug,
    brief: work.brief,
    createdAt: work.createdAt,
    done: work.done,
    doneAt: work.doneAt ?? null,
    verificationPlanSourceFingerprint: work.verificationPlanSourceFingerprint ?? null,
    auditRequired: work.auditRequired ?? false,
    audit: work.audit === undefined ? null : {
      result: work.audit.result,
      report: work.audit.report,
      reportSha256: work.audit.reportSha256 ?? null,
      implementationModel: work.audit.implementationModel ?? null,
      auditModel: work.audit.auditModel ?? null,
      workspace: work.audit.workspace ?? null,
      stateHash: work.audit.stateHash,
      at: work.audit.at,
    },
    baseline: work.baseline === undefined ? null : work.baseline,
    checks: work.checks.map((check) => ({
      id: check.id,
      desc: check.desc,
      cmd: check.cmd,
      expect: check.expect,
      manual: check.manual,
      kind: checkKind(check),
      expert: check.expert ?? false,
      status: check.status,
      redEvidence: check.redEvidence ?? null,
      evidence: check.evidence ?? null,
    })),
    contract: {
      required: contract.required,
      forbidden: contract.forbidden,
      activeHabits: contract.activeHabits,
      commit: contract.commit,
      latestCommitTransition: contract.latestCommitTransition ?? null,
      assumptions: contract.assumptions ?? [],
      uncertainties: contract.uncertainties ?? [],
      allowedPaths: contract.allowedPaths ?? ["."],
      forbiddenPaths: contract.forbiddenPaths ?? [],
      stopConditions: contract.stopConditions ?? [],
      risk: contract.risk ?? "low",
      verification: contract.verification ?? "deterministic",
      simplificationRequired: contract.simplificationRequired ?? false,
      scopeAmendments: contract.scopeAmendments ?? [],
    },
  });
  return hash.digest("hex");
}

function evidenceProjection(evidence: Evidence | undefined): Readonly<Record<string, unknown>> | null {
  if (evidence === undefined) return null;
  return {
    observed: evidence.observed,
    sha256: evidence.sha256,
    exitCode: evidence.exitCode ?? null,
    manual: evidence.manual,
    reviewer: evidence.reviewer ?? null,
    notePresent: Boolean(evidence.note?.trim()),
    at: evidence.at,
  };
}

function auditProjection(work: Work): Readonly<Record<string, unknown>> {
  const required = Boolean(work.auditRequired || work.contract.risk === "high");
  if (!required) return { required: false, state: "not-required", record: null };
  if (!work.audit) return { required: true, state: "missing", record: null };
  const state = work.audit.result !== "pass"
    ? "failed"
    : work.audit.stateHash !== checksHash(work)
    ? "stale"
    : "passed-recorded";
  return {
    required: true,
    state,
    record: {
      result: work.audit.result,
      report: work.audit.report,
      reportSha256: work.audit.reportSha256 ?? null,
      implementationModel: work.audit.implementationModel ?? null,
      auditModel: work.audit.auditModel ?? null,
      workspace: work.audit.workspace ?? null,
      stateHash: work.audit.stateHash,
      at: work.audit.at,
    },
  };
}

function phase(work: Work, blockerCodes: readonly string[]): WorkSnapshot["work"]["phase"] {
  if (work.done) return "completed";
  if (work.checks.length === 0) return "planning";
  if (blockerCodes.length > 0 && blockerCodes.every((code) => code.startsWith("audit_"))) return "auditing";
  return "executing";
}

function handoffProjection(
  event: ProtocolHandoffEvent | undefined,
  current: { readonly plan: string; readonly state: string; readonly source: string },
  artifactStatus?: "artifact_missing" | "artifact_changed",
): Readonly<Record<string, unknown>> | null {
  if (event === undefined) return null;
  const staleReasons: string[] = [];
  if (event.planFingerprint !== current.plan) staleReasons.push("plan_changed");
  if (event.stateFingerprint !== current.state) staleReasons.push("state_changed");
  if (event.sourceFingerprint !== current.source) staleReasons.push("source_changed");
  if (artifactStatus !== undefined) staleReasons.push(artifactStatus);
  return {
    eventId: event.eventId,
    handoffId: event.handoffId,
    revision: event.revision,
    predecessorEventId: event.predecessorEventId,
    ts: event.ts,
    from: event.from,
    to: event.to,
    intent: event.intent,
    artifact: event.artifact ?? null,
    planFingerprint: event.planFingerprint,
    stateFingerprint: event.stateFingerprint,
    sourceFingerprint: event.sourceFingerprint,
    stale: staleReasons.length > 0,
    staleReasons,
  };
}

function artifactFreshness(cwd: string | undefined, event: ProtocolHandoffEvent | undefined): "artifact_missing" | "artifact_changed" | undefined {
  if (cwd === undefined || event?.artifact === undefined) return undefined;
  try {
    const current = readContainedFile(cwd, event.artifact.path, "artifact", {
      maxBytes: PROTOCOL_LEGACY_ARTIFACT_MAX_BYTES,
      tooLargeCode: "artifact_too_large",
    });
    return current.sha256 === event.artifact.sha256 ? undefined : "artifact_changed";
  } catch (error) {
    if (error instanceof GdmError && error.code === "path_rejected") return "artifact_missing";
    throw error;
  }
}

function outputFreshness(
  cwd: string,
  event: ProtocolReceiptEvent,
): "output_missing" | "output_changed" | undefined {
  const observed = event.runnerObserved?.outputArtifact;
  if (observed === undefined) return undefined;
  try {
    const current = readContainedFile(cwd, observed.path, "output-artifact", {
      maxBytes: PROTOCOL_OUTPUT_MAX_BYTES,
      tooLargeCode: "output_too_large",
    });
    return current.sha256 === observed.sha256 ? undefined : "output_changed";
  } catch (error) {
    if (error instanceof GdmError && error.code === "path_rejected") return "output_missing";
    if (error instanceof GdmError && error.code === "output_too_large") return "output_changed";
    throw error;
  }
}

function assertHandoffArtifactFresh(cwd: string, handoff: ProtocolHandoffEvent): void {
  if (handoff.artifact === undefined) return;
  try {
    const current = automaticArtifact(cwd, handoff.artifact.path);
    if (current.sha256 !== handoff.artifact.sha256) {
      throw new GdmError("handoff artifact가 변경됐습니다", "artifact_changed");
    }
  } catch (error) {
    if (error instanceof GdmError && error.code === "path_rejected") {
      throw new GdmError("handoff artifact가 없습니다", "artifact_missing");
    }
    throw error;
  }
}

function automaticArtifactFreshness(
  cwd: string,
  handoff: ProtocolHandoffEvent | undefined,
): "artifact_missing" | "artifact_changed" | undefined {
  if (handoff?.artifact === undefined) return undefined;
  try {
    const current = automaticArtifact(cwd, handoff.artifact.path);
    return current.sha256 === handoff.artifact.sha256 ? undefined : "artifact_changed";
  } catch (error) {
    if (error instanceof GdmError && error.code === "path_rejected") return "artifact_missing";
    throw error;
  }
}

function canonicalSourceFingerprint(sourceFingerprint: SourceFingerprint): SourceFingerprint {
  if (typeof sourceFingerprint !== "object" || sourceFingerprint === null || Array.isArray(sourceFingerprint)) {
    throw new GdmError("protocol source fingerprint 형식이 잘못됐습니다", "state_corrupt");
  }
  const keys = Reflect.ownKeys(sourceFingerprint);
  if (
    keys.length !== SOURCE_FINGERPRINT_KEYS.length ||
    SOURCE_FINGERPRINT_KEYS.some((key) => !Object.hasOwn(sourceFingerprint, key)) ||
    keys.some((key) => typeof key !== "string" || !SOURCE_FINGERPRINT_KEYS.includes(key as typeof SOURCE_FINGERPRINT_KEYS[number])) ||
    sourceFingerprint.schemaVersion !== 1 || !SHA256_RE.test(sourceFingerprint.sha256) ||
    !Number.isSafeInteger(sourceFingerprint.fileCount) || sourceFingerprint.fileCount < 0
  ) throw new GdmError("protocol source fingerprint 형식이 잘못됐습니다", "state_corrupt");
  return {
    schemaVersion: 1,
    sha256: sourceFingerprint.sha256,
    fileCount: sourceFingerprint.fileCount,
  };
}

function assertProtocolStateBoundary(work: Work, sourceFingerprint: SourceFingerprint): SourceFingerprint {
  const canonicalSource = canonicalSourceFingerprint(sourceFingerprint);
  if (!isCanonicalTimestamp(work.createdAt) || (work.doneAt !== undefined && !isCanonicalTimestamp(work.doneAt))) {
    throw new GdmError("protocol work timestamp 형식이 잘못됐습니다", "state_corrupt");
  }
  return canonicalSource;
}

function readWorkProtocolHandoffs(
  work: Work,
  journal: readonly JournalEvent[],
): readonly ProtocolHandoffEvent[] {
  const events = readProtocolHandoffEvents(journal);
  if (events.some((event) => event.slug !== work.slug)) {
    throw new GdmError("protocol handoff journal slug가 작업과 일치하지 않습니다", "state_corrupt");
  }
  if (events[0] !== undefined && events[0].ts < work.createdAt) {
    throw new GdmError("protocol handoff journal 시각이 작업 생성보다 빠릅니다", "state_corrupt");
  }
  return events;
}

function readWorkProtocolReceipts(
  work: Work,
  journal: readonly JournalEvent[],
): readonly ProtocolReceiptEvent[] {
  const handoffs = readWorkProtocolHandoffs(work, journal);
  const byId = new Map(handoffs.map((event) => [event.eventId, event]));
  const receipts = readProtocolReceiptEvents(journal);
  for (const receipt of receipts) {
    const handoff = byId.get(receipt.handoffEventId);
    if (
      receipt.slug !== work.slug || handoff === undefined || receipt.ts < work.createdAt || receipt.ts < handoff.ts ||
      receipt.receiver.role !== handoff.to.role ||
      (handoff.to.provider !== undefined && receipt.receiver.provider !== handoff.to.provider) ||
      receipt.planFingerprint !== handoff.planFingerprint || receipt.stateFingerprint !== handoff.stateFingerprint ||
      receipt.sourceFingerprint !== handoff.sourceFingerprint
    ) throw new GdmError("protocol receipt가 Work 또는 handoff와 일치하지 않습니다", "state_corrupt");
  }
  return receipts;
}

function containsCredentialSignature(value: string): boolean {
  return OPENAI_KEY_RE.test(value) || CREDENTIAL_RE.test(value) || JWT_RE.test(value);
}

function automaticArtifact(cwd: string, path: string) {
  const contained = readContainedFile(cwd, path, "artifact", {
    maxBytes: PROTOCOL_ARTIFACT_MAX_BYTES,
    tooLargeCode: "artifact_too_large",
  });
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(contained.bytes);
  } catch {
    throw new GdmError("자동 protocol artifact는 유효한 UTF-8 텍스트여야 합니다", "artifact_encoding_invalid");
  }
  assertNoCredentialSignatures(content, "artifact");
  return contained;
}

function assertNoCredentialSignatures(value: unknown, field = "snapshot"): void {
  if (typeof value === "string") {
    if (containsCredentialSignature(value)) throw privacyError(field);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialSignatures(entry, `${field}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoCredentialSignatures(entry, `${field}.${key}`);
    }
  }
}

function assertCompletedArtifactIntegrity(cwd: string | undefined, work: Work): void {
  if (cwd === undefined || !work.done) return;
  const evidence = work.checks.flatMap((check) => [
    ...(check.redEvidence === undefined ? [] : [{ label: `${check.id} red evidence`, value: check.redEvidence }]),
    ...(check.evidence === undefined ? [] : [{ label: `${check.id} evidence`, value: check.evidence }]),
  ]);
  for (const item of evidence) {
    try {
      const contained = readContainedFile(cwd, item.value.observed, item.label);
      if (contained.sha256 !== item.value.sha256) {
        throw new GdmError(`완료된 작업의 ${item.label} 해시가 저장된 상태와 다릅니다`, "state_corrupt");
      }
    } catch (error) {
      if (error instanceof GdmError && error.code === "state_corrupt") throw error;
      throw new GdmError(`완료된 작업의 ${item.label} 파일을 안전하게 검증할 수 없습니다`, "state_corrupt");
    }
  }
  if (work.audit !== undefined) {
    if (work.audit.reportSha256 === undefined) {
      throw new GdmError("완료된 작업의 audit report 해시가 없습니다", "state_corrupt");
    }
    try {
      const report = readContainedFile(cwd, work.audit.report, "audit report");
      if (report.sha256 !== work.audit.reportSha256) {
        throw new GdmError("완료된 작업의 audit report가 판정 후 변경됐습니다", "state_corrupt");
      }
    } catch (error) {
      if (error instanceof GdmError && error.code === "state_corrupt") throw error;
      throw new GdmError("완료된 작업의 audit report를 안전하게 검증할 수 없습니다", "state_corrupt");
    }
  }
}

export function buildWorkSnapshot(
  work: Work,
  sourceFingerprint: SourceFingerprint,
  journal: readonly JournalEvent[],
  cwd?: string,
): WorkSnapshot {
  const canonicalSource = assertProtocolStateBoundary(work, sourceFingerprint);
  assertCompletedArtifactIntegrity(cwd, work);
  const planFingerprint = verificationPlanFingerprint(work);
  const stateFingerprint = protocolStateFingerprint(work);
  const blockers = completionBlockers(work);
  const audit = auditProjection(work);
  const handoffs = readWorkProtocolHandoffs(work, journal);
  const snapshot: WorkSnapshot = {
    schemaVersion: "gdm-work-snapshot/v1",
    work: {
      slug: work.slug,
      brief: work.brief,
      createdAt: work.createdAt,
      doneAt: work.doneAt ?? null,
      phase: phase(work, blockers.map((blocker) => blocker.code)),
      planFingerprint,
      stateFingerprint,
      planSourceFingerprint: work.verificationPlanSourceFingerprint ?? null,
      sourceFingerprint: canonicalSource,
    },
    contract: {
      required: work.contract.required,
      forbidden: work.contract.forbidden,
      assumptions: work.contract.assumptions ?? [],
      uncertainties: work.contract.uncertainties ?? [],
      allowedPaths: work.contract.allowedPaths ?? ["."],
      forbiddenPaths: work.contract.forbiddenPaths ?? [],
      stopConditions: work.contract.stopConditions ?? [],
      risk: work.contract.risk ?? "low",
      verification: work.contract.verification ?? "deterministic",
      simplificationRequired: work.contract.simplificationRequired ?? false,
      activeHabits: work.contract.activeHabits,
      commit: {
        state: work.contract.commit,
        latestTransition: work.contract.latestCommitTransition ?? null,
      },
      scopeAmendments: work.contract.scopeAmendments ?? [],
    },
    checks: work.checks.map((check) => ({
      id: check.id,
      kind: checkKind(check),
      description: check.desc,
      status: check.status,
      command: check.cmd,
      expect: check.expect,
      manual: check.manual,
      expert: check.expert ?? false,
      redEvidence: evidenceProjection(check.redEvidence),
      evidence: evidenceProjection(check.evidence),
    })),
    audit,
    completion: {
      state: work.done ? "completed" : blockers.length > 0 ? "blocked" : "ready-to-validate",
      blockers,
      validationCommand: work.done ? null : `gdm done --slug ${work.slug}`,
    },
    latestHandoff: handoffProjection(handoffs.at(-1), {
      plan: planFingerprint,
      state: stateFingerprint,
      source: canonicalSource.sha256,
    }, artifactFreshness(cwd, handoffs.at(-1))),
  };
  assertNoCredentialSignatures(snapshot);
  return snapshot;
}

function expectedFingerprint(value: string | undefined, flag: string): string | undefined {
  if (value !== undefined && !SHA256_RE.test(value)) {
    throw new GdmError(`--${flag}는 소문자 64자리 SHA-256이어야 합니다`, "usage");
  }
  return value;
}

export function prepareProtocolHandoff(raw: RawProtocolHandoffRequest): PreparedProtocolHandoff {
  return {
    handoffId: opaqueId(raw.handoffId, "handoff-id"),
    fromRole: opaqueId(raw.fromRole, "from-role"),
    ...(raw.fromProvider === undefined ? {} : { fromProvider: opaqueId(raw.fromProvider, "from-provider") }),
    toRole: opaqueId(raw.toRole, "to-role"),
    ...(raw.toProvider === undefined ? {} : { toProvider: opaqueId(raw.toProvider, "to-provider") }),
    intent: safeText(raw.intent, "intent"),
    ...(raw.artifact === undefined ? {} : { artifact: raw.artifact }),
    expectedPlanFingerprint: expectedFingerprint(raw.expectedPlanFingerprint, "expected-plan-fingerprint"),
    expectedStateFingerprint: expectedFingerprint(raw.expectedStateFingerprint, "expected-state-fingerprint"),
    expectedSourceFingerprint: expectedFingerprint(raw.expectedSourceFingerprint, "expected-source-fingerprint"),
  };
}

function assertExpected(actual: string, expected: string | undefined, code: string, label: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new GdmError(`${label} 지문이 일치하지 않습니다 (expected ${expected}, actual ${actual})`, code);
  }
}

function sameHandoff(
  event: ProtocolHandoffEvent,
  input: PreparedProtocolHandoff,
  artifact: ProtocolArtifact | undefined,
  fingerprints: { readonly plan: string; readonly state: string; readonly source: string },
): boolean {
  return event.from.role === input.fromRole && event.from.provider === input.fromProvider && event.to.role === input.toRole &&
    event.to.provider === input.toProvider && event.intent === input.intent &&
    event.artifact?.path === artifact?.path && event.artifact?.sha256 === artifact?.sha256 &&
    event.planFingerprint === fingerprints.plan && event.stateFingerprint === fingerprints.state &&
    event.sourceFingerprint === fingerprints.source;
}

function recordProtocolHandoffInternal(
  cwd: string,
  work: Work,
  journal: readonly JournalEvent[],
  sourceFingerprint: SourceFingerprint,
  raw: RawProtocolHandoffRequest,
  at: string,
  automatic: boolean,
): ProtocolHandoffMutation {
  if (!isCanonicalTimestamp(at)) throw new GdmError("protocol handoff timestamp 형식이 잘못됐습니다", "usage");
  const canonicalSource = assertProtocolStateBoundary(work, sourceFingerprint);
  const input = prepareProtocolHandoff(raw);
  const plan = verificationPlanFingerprint(work);
  const state = protocolStateFingerprint(work);
  const source = canonicalSource.sha256;
  assertExpected(plan, input.expectedPlanFingerprint, "plan_fingerprint_mismatch", "검증 계획");
  assertExpected(state, input.expectedStateFingerprint, "state_fingerprint_mismatch", "작업 상태");
  assertExpected(source, input.expectedSourceFingerprint, "source_fingerprint_mismatch", "source");
  const contained = input.artifact === undefined
    ? undefined
    : automatic
    ? automaticArtifact(cwd, input.artifact)
    : readContainedFile(cwd, input.artifact, "artifact", {
      maxBytes: PROTOCOL_LEGACY_ARTIFACT_MAX_BYTES,
      tooLargeCode: "artifact_too_large",
    });
  const artifact = contained === undefined ? undefined : { path: contained.path, sha256: contained.sha256 };
  const events = readWorkProtocolHandoffs(work, journal);
  const replay = events.find((event) => event.handoffId === input.handoffId);
  if (replay !== undefined) {
    if (sameHandoff(replay, input, artifact, { plan, state, source })) return { event: replay, changed: false };
    throw new GdmError("handoff-id가 다른 요청에 이미 사용됐습니다", "handoff_id_conflict");
  }
  const latest = events.at(-1);
  if (at < (latest?.ts ?? work.createdAt)) {
    throw new GdmError("handoff 시각은 작업 생성 및 직전 handoff보다 빠를 수 없습니다", "handoff_time_invalid");
  }
  const identity = `${work.slug}\0${input.handoffId}`;
  const event: ProtocolHandoffEvent = {
    schemaVersion: "gdm-handoff/v1",
    event: "protocol_handoff",
    eventId: `h-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    handoffId: input.handoffId,
    revision: (latest?.revision ?? 0) + 1,
    predecessorEventId: latest?.eventId ?? null,
    ts: at,
    slug: work.slug,
    from: { role: input.fromRole, ...(input.fromProvider === undefined ? {} : { provider: input.fromProvider }) },
    to: { role: input.toRole, ...(input.toProvider === undefined ? {} : { provider: input.toProvider }) },
    intent: input.intent,
    ...(artifact === undefined ? {} : { artifact }),
    planFingerprint: plan,
    stateFingerprint: state,
    sourceFingerprint: source,
  };
  return { event, changed: true };
}

export function recordProtocolHandoff(
  cwd: string,
  work: Work,
  journal: readonly JournalEvent[],
  sourceFingerprint: SourceFingerprint,
  raw: RawProtocolHandoffRequest,
  at: string,
): ProtocolHandoffMutation {
  return recordProtocolHandoffInternal(cwd, work, journal, sourceFingerprint, raw, at, false);
}

export function recordProtocolOffer(
  cwd: string,
  work: Work,
  journal: readonly JournalEvent[],
  sourceFingerprint: SourceFingerprint,
  raw: RawProtocolHandoffRequest,
  at: string,
): ProtocolHandoffMutation {
  return recordProtocolHandoffInternal(cwd, work, journal, sourceFingerprint, raw, at, true);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function assertCanonicalDispatchBundle(bundle: ProtocolDispatchBundle): void {
  if (!hasExactKeys(bundle as unknown as Readonly<Record<string, unknown>>, [
    "schemaVersion", "claimId", "handoff", "snapshot", "receiver", "capabilityProfile", "artifact", "bundleSha256",
  ])) throw new GdmError("canonical dispatch bundle 형식이 잘못됐습니다", "bundle_mismatch");
  const { bundleSha256, ...payload } = bundle;
  if (!SHA256_RE.test(bundleSha256) || sha256(canonicalJson(payload)) !== bundleSha256) {
    throw new GdmError("canonical dispatch bundle hash가 일치하지 않습니다", "bundle_mismatch");
  }
  if (bundle.artifact === null) return;
  if (!hasExactKeys(bundle.artifact, ["path", "sha256", "text", "bytesBase64"])) {
    throw new GdmError("canonical dispatch artifact 형식이 잘못됐습니다", "bundle_mismatch");
  }
  let decoded: Buffer;
  let decodedText: string;
  try {
    decoded = Buffer.from(bundle.artifact.bytesBase64, "base64");
    decodedText = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new GdmError("canonical dispatch artifact 인코딩이 잘못됐습니다", "bundle_mismatch");
  }
  if (
    decoded.toString("base64") !== bundle.artifact.bytesBase64 ||
    sha256(decoded) !== bundle.artifact.sha256 ||
    decodedText !== bundle.artifact.text
  ) throw new GdmError("canonical dispatch artifact identity가 일치하지 않습니다", "bundle_mismatch");
}

export function projectProtocolDispatchModelView(bundle: ProtocolDispatchBundle): ProtocolDispatchModelView {
  assertCanonicalDispatchBundle(bundle);
  return {
    schemaVersion: "gdm-dispatch-model-view/v1",
    claimId: bundle.claimId,
    handoff: bundle.handoff,
    snapshot: bundle.snapshot,
    receiver: bundle.receiver,
    capabilityProfile: bundle.capabilityProfile,
    artifact: bundle.artifact === null
      ? null
      : { path: bundle.artifact.path, sha256: bundle.artifact.sha256, text: bundle.artifact.text },
    bundleSha256: bundle.bundleSha256,
  };
}

function lifecycleEventId(slug: string, claimId: string, revision: number, stage: ProtocolReceiptEvent["stage"]): string {
  return `r-${sha256(`${slug}\0${claimId}\0${revision}\0${stage}`).slice(0, 16)}`;
}

function receiptId(slug: string, claimId: string, revision: number): string {
  return `receipt-${sha256([slug, claimId, String(revision)].join("\0")).slice(0, 16)}`;
}

function currentFingerprints(work: Work, source: SourceFingerprint): {
  readonly plan: string;
  readonly state: string;
  readonly source: string;
} {
  return {
    plan: verificationPlanFingerprint(work),
    state: protocolStateFingerprint(work),
    source: canonicalSourceFingerprint(source).sha256,
  };
}

function assertLifecycleFresh(
  work: Work,
  source: SourceFingerprint,
  event: ProtocolHandoffEvent | ProtocolReceiptEvent,
): void {
  const current = currentFingerprints(work, source);
  assertExpected(current.plan, event.planFingerprint, "plan_fingerprint_mismatch", "검증 계획");
  assertExpected(current.state, event.stateFingerprint, "state_fingerprint_mismatch", "작업 상태");
  assertExpected(current.source, event.sourceFingerprint, "source_fingerprint_mismatch", "source");
}

function requireHandoff(
  work: Work,
  journal: readonly JournalEvent[],
  eventId: string,
): ProtocolHandoffEvent {
  const normalized = opaqueId(eventId, "handoff-event-id");
  const handoff = readWorkProtocolHandoffs(work, journal).find((event) => event.eventId === normalized);
  if (handoff === undefined) throw new GdmError("handoff event를 찾을 수 없습니다", "handoff_not_found");
  return handoff;
}

function latestReceipts(journal: readonly JournalEvent[]): Map<string, ProtocolReceiptEvent> {
  const latest = new Map<string, ProtocolReceiptEvent>();
  for (const event of readProtocolReceiptEvents(journal)) latest.set(event.claimId, event);
  return latest;
}

function claimReceipt(
  work: Work,
  handoff: ProtocolHandoffEvent,
  bundle: ProtocolDispatchBundle,
  receiver: ProtocolReceiptEvent["receiver"],
  modelRequested: string | undefined,
  at: string,
): ProtocolReceiptEvent {
  return {
    schemaVersion: "gdm-protocol-receipt/v1",
    event: "protocol_receipt",
    eventId: lifecycleEventId(work.slug, bundle.claimId, 1, "claimed"),
    receiptId: receiptId(work.slug, bundle.claimId, 1),
    revision: 1,
    predecessorEventId: null,
    ts: at,
    slug: work.slug,
    stage: "claimed",
    handoffEventId: handoff.eventId,
    claimId: bundle.claimId,
    bundleSha256: bundle.bundleSha256,
    receiver,
    capabilityProfile: READ_ONLY_SPECIALIST_PROFILE,
    ...(modelRequested === undefined ? {} : { modelRequested }),
    planFingerprint: handoff.planFingerprint,
    stateFingerprint: handoff.stateFingerprint,
    sourceFingerprint: handoff.sourceFingerprint,
  };
}

function assertReceiptTime(at: string, notBefore: string): void {
  if (!isCanonicalTimestamp(at)) throw new GdmError("protocol receipt timestamp 형식이 잘못됐습니다", "usage");
  if (at < notBefore) throw new GdmError("protocol receipt 시각이 이전 lifecycle보다 빠릅니다", "receipt_time_invalid");
}

function sameClaim(
  event: ProtocolReceiptEvent,
  input: RawProtocolClaimRequest,
): boolean {
  return event.handoffEventId === input.handoffEventId && event.receiver.role === input.receiverRole &&
    event.receiver.provider === input.receiverProvider && event.capabilityProfile === input.capabilityProfile &&
    event.modelRequested === input.modelRequested;
}

export function claimProtocolHandoff(
  cwd: string,
  work: Work,
  journal: readonly JournalEvent[],
  source: SourceFingerprint,
  raw: RawProtocolClaimRequest,
  at: string,
): ProtocolMutation<ProtocolReceiptEvent> & { readonly bundle: ProtocolDispatchBundle } {
  if (!isCanonicalTimestamp(at)) throw new GdmError("protocol receipt timestamp 형식이 잘못됐습니다", "usage");
  const input: RawProtocolClaimRequest = {
    handoffEventId: opaqueId(raw.handoffEventId, "handoff-event-id"),
    claimId: opaqueId(raw.claimId, "claim-id"),
    receiverRole: opaqueId(raw.receiverRole, "receiver-role"),
    ...(raw.receiverProvider === undefined ? {} : {
      receiverProvider: opaqueId(raw.receiverProvider, "receiver-provider"),
    }),
    capabilityProfile: raw.capabilityProfile,
    ...(raw.modelRequested === undefined ? {} : { modelRequested: opaqueId(raw.modelRequested, "model-requested") }),
  };
  if (input.capabilityProfile !== READ_ONLY_SPECIALIST_PROFILE) {
    throw new GdmError("지원하지 않는 capability profile입니다", "capability_unsupported");
  }
  const handoff = requireHandoff(work, journal, input.handoffEventId);
  assertReceiptTime(at, handoff.ts);
  assertLifecycleFresh(work, source, handoff);
  if (handoff.to.role !== input.receiverRole ||
    (handoff.to.provider !== undefined && handoff.to.provider !== input.receiverProvider)) {
    throw new GdmError("handoff receiver와 claim receiver가 일치하지 않습니다", "receiver_mismatch");
  }
  const allReceipts = readWorkProtocolReceipts(work, journal);
  const latest = latestReceipts(journal);
  const existing = latest.get(input.claimId);
  if (existing !== undefined) {
    if (!sameClaim(existing, input)) throw new GdmError("claim-id가 다른 요청에 이미 사용됐습니다", "claim_id_conflict");
    if (existing.stage !== "claimed") {
      throw new GdmError("claim은 현재 claimed 상태일 때만 replay할 수 있습니다", "receipt_transition");
    }
    const bundle = rebuildDispatchBundle(cwd, work, journal, source, handoff, input);
    if (bundle.bundleSha256 !== existing.bundleSha256) {
      throw new GdmError("claim bundle이 현재 입력과 일치하지 않습니다", "bundle_mismatch");
    }
    return { event: existing, changed: false, bundle };
  }
  const latestForClaim = new Map<string, ProtocolReceiptEvent>();
  for (const event of allReceipts) latestForClaim.set(event.claimId, event);
  const competing = [...latestForClaim.values()].find((event) =>
    event.handoffEventId === handoff.eventId && event.claimId !== input.claimId && event.stage !== "abandoned"
  );
  if (competing !== undefined) throw new GdmError("handoff가 이미 claim됐습니다", "claim_conflict");
  const bundle = rebuildDispatchBundle(cwd, work, journal, source, handoff, input);
  const receiver = {
    role: input.receiverRole,
    ...(input.receiverProvider === undefined ? {} : { provider: input.receiverProvider }),
  };
  const event = claimReceipt(work, handoff, bundle, receiver, input.modelRequested, at);
  return { event, changed: true, bundle };
}

function rebuildDispatchBundle(
  cwd: string,
  work: Work,
  journal: readonly JournalEvent[],
  source: SourceFingerprint,
  handoff: ProtocolHandoffEvent,
  input: RawProtocolClaimRequest,
): ProtocolDispatchBundle {
  let artifact: ProtocolDispatchBundlePayload["artifact"] = null;
  if (handoff.artifact !== undefined) {
    let contained;
    try {
      contained = automaticArtifact(cwd, handoff.artifact.path);
    } catch (error) {
      if (error instanceof GdmError && error.code === "path_rejected") {
        throw new GdmError("handoff artifact를 읽을 수 없습니다", "artifact_missing");
      }
      throw error;
    }
    if (contained.sha256 !== handoff.artifact.sha256) {
      throw new GdmError("handoff artifact가 변경됐습니다", "artifact_changed");
    }
    artifact = {
      path: contained.path,
      sha256: contained.sha256,
      text: contained.content,
      bytesBase64: Buffer.from(contained.bytes).toString("base64"),
    };
  }
  const snapshot = buildWorkSnapshot(work, source, journal, cwd);
  const payload: ProtocolDispatchBundlePayload = {
    schemaVersion: "gdm-dispatch-bundle/v1",
    claimId: input.claimId,
    handoff,
    snapshot,
    receiver: { role: input.receiverRole },
    capabilityProfile: READ_ONLY_SPECIALIST_PROFILE,
    artifact,
  };
  const payloadJson = canonicalJson(payload);
  const bundle = { ...payload, bundleSha256: sha256(payloadJson) };
  const bundleBytes = Buffer.byteLength(canonicalJson(bundle), "utf8");
  if (bundleBytes > PROTOCOL_BUNDLE_MAX_BYTES) {
    throw new GdmError(
      `dispatch bundle이 ${PROTOCOL_BUNDLE_MAX_BYTES}바이트 상한을 초과했습니다`,
      "bundle_too_large",
    );
  }
  assertCanonicalDispatchBundle(bundle);
  return bundle;
}

function requireLatestReceipt(work: Work, journal: readonly JournalEvent[], rawClaimId: string): ProtocolReceiptEvent {
  const claimId = opaqueId(rawClaimId, "claim-id");
  readWorkProtocolReceipts(work, journal);
  const receipt = latestReceipts(journal).get(claimId);
  if (receipt === undefined) throw new GdmError("claim을 찾을 수 없습니다", "claim_not_found");
  return receipt;
}

function appendReceiptStage(
  prior: ProtocolReceiptEvent,
  stage: ProtocolReceiptEvent["stage"],
  at: string,
  extra: Pick<ProtocolReceiptEvent, "runnerObserved" | "reason">,
): ProtocolReceiptEvent {
  const revision = prior.revision + 1;
  return {
    ...prior,
    eventId: lifecycleEventId(prior.slug, prior.claimId, revision, stage),
    receiptId: receiptId(prior.slug, prior.claimId, revision),
    revision,
    predecessorEventId: prior.eventId,
    ts: at,
    stage,
    ...(stage === "exited" || stage === "adopted" ? {} : { runnerObserved: undefined }),
    ...(stage === "abandoned" ? {} : { reason: undefined }),
    ...(extra.runnerObserved === undefined ? {} : { runnerObserved: extra.runnerObserved }),
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
  };
}

function parseExitCode(value: string): number {
  if (!/^\d{1,3}$/u.test(value)) throw new GdmError("--exit-code는 0~255 정수여야 합니다", "usage");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new GdmError("--exit-code는 0~255 정수여야 합니다", "usage");
  }
  return parsed;
}

const RECEIVER_ACK_PREFIX = "GDM_RECEIVER_ACK_V1=";

function receiverAckStatus(output: string, prior: ProtocolReceiptEvent): "succeeded" | "blocked" | "invalid" {
  const line = output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).at(-1);
  if (line === undefined || !line.startsWith(RECEIVER_ACK_PREFIX)) {
    return "invalid";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(RECEIVER_ACK_PREFIX.length));
  } catch {
    return "invalid";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "invalid";
  }
  const ack = parsed as Record<string, unknown>;
  const keys = Object.keys(ack).sort();
  if (
    keys.join("\0") !== ["bundleSha256", "claimId", "disposition", "handoffEventId", "schemaVersion"].join("\0") ||
    ack.schemaVersion !== "gdm-receiver-ack/v1" || ack.claimId !== prior.claimId ||
    ack.handoffEventId !== prior.handoffEventId || ack.bundleSha256 !== prior.bundleSha256 ||
    (ack.disposition !== "completed" && ack.disposition !== "blocked")
  ) return "invalid";
  return ack.disposition === "completed" ? "succeeded" : "blocked";
}

export function finishProtocolClaim(
  cwd: string,
  work: Work,
  journal: readonly JournalEvent[],
  source: SourceFingerprint,
  raw: RawProtocolFinishRequest,
  at: string,
): ProtocolMutation<ProtocolReceiptEvent> {
  const prior = requireLatestReceipt(work, journal, raw.claimId);
  assertReceiptTime(at, prior.ts);
  const exitCode = parseExitCode(raw.exitCode);
  const existing = readProtocolReceiptEvents(journal).find((event) => event.claimId === prior.claimId && event.stage === "exited");
  const output = readContainedFile(cwd, raw.outputArtifact, "output-artifact", {
    maxBytes: PROTOCOL_OUTPUT_MAX_BYTES,
    tooLargeCode: "output_too_large",
  });
  const ackStatus = exitCode === 0 ? receiverAckStatus(output.content, prior) : undefined;
  const ackInvalid = ackStatus === "invalid";
  const status: ProtocolExitStatus = exitCode === 0
    ? ackInvalid ? "failed" : ackStatus!
    : "failed";
  const runnerObserved: ProtocolRunnerObserved = {
    providerTarget: opaqueId(raw.providerTarget, "provider-target"),
    ...(raw.modelRequested === undefined ? {} : { modelRequested: opaqueId(raw.modelRequested, "model-requested") }),
    adapterVersion: opaqueId(raw.adapterVersion, "adapter-version"),
    executable: raw.executable,
    executableSha256: expectedFingerprint(raw.executableSha256, "executable-sha256")!,
    executableVersion: normalizeProtocolObservationText(raw.executableVersion, "executable-version"),
    argvPolicyId: opaqueId(raw.argvPolicyId, "argv-policy-id"),
    outputArtifact: { path: output.path, sha256: output.sha256 },
    exitCode,
    status,
    ...(ackInvalid
      ? { failureCode: "receiver_ack_invalid" }
      : raw.failureCode === undefined ? {} : { failureCode: opaqueId(raw.failureCode, "failure-code") }),
  };
  if (!raw.executable.startsWith("/") || raw.executable.includes("\0")) {
    throw new GdmError("--executable은 절대 경로여야 합니다", "usage");
  }
  if (status === "succeeded" && runnerObserved.failureCode !== undefined) {
    throw new GdmError("succeeded에는 failure-code를 쓸 수 없습니다", "runner_observation_invalid");
  }
  if (status !== "failed" && runnerObserved.failureCode !== undefined) {
    throw new GdmError("clean receiver ACK에는 failure-code를 쓸 수 없습니다", "runner_observation_invalid");
  }
  if (runnerObserved.failureCode === "provider_executable_changed" && exitCode !== 70) {
    throw new GdmError("provider_executable_changed는 observed exit 70과 함께 기록해야 합니다", "runner_observation_invalid");
  }
  if (prior.receiver.provider !== undefined && runnerObserved.providerTarget !== prior.receiver.provider) {
    throw new GdmError("provider target이 claim receiver와 일치하지 않습니다", "receiver_mismatch");
  }
  if (runnerObserved.modelRequested !== prior.modelRequested) {
    throw new GdmError("requested model이 claim bundle과 일치하지 않습니다", "receiver_mismatch");
  }
  if (existing !== undefined) {
    if (canonicalJson(existing.runnerObserved) !== canonicalJson(runnerObserved)) {
      throw new GdmError("finish replay가 기존 observation과 다릅니다", "receipt_conflict");
    }
    return {
      event: existing,
      changed: false,
      ...(existing.runnerObserved?.failureCode === "receiver_ack_invalid"
        ? { rejectedCode: "receiver_ack_invalid" }
        : existing.runnerObserved?.failureCode === "provider_executable_changed"
        ? { rejectedCode: "provider_executable_changed" }
        : existing.runnerObserved?.status === "blocked"
        ? { rejectedCode: "receiver_blocked" }
        : {}),
    };
  }
  if (prior.stage !== "claimed") throw new GdmError("claimed 상태에서만 finish할 수 있습니다", "receipt_transition");
  assertLifecycleFresh(work, source, prior);
  const handoff = requireHandoff(work, journal, prior.handoffEventId);
  assertHandoffArtifactFresh(cwd, handoff);
  return {
    event: appendReceiptStage(prior, "exited", at, { runnerObserved }),
    changed: true,
    ...(ackInvalid
      ? { rejectedCode: "receiver_ack_invalid" }
      : runnerObserved.failureCode === "provider_executable_changed"
      ? { rejectedCode: "provider_executable_changed" }
      : status === "blocked" ? { rejectedCode: "receiver_blocked" } : {}),
  };
}

export function adoptProtocolClaim(
  cwd: string,
  work: Work,
  journal: readonly JournalEvent[],
  source: SourceFingerprint,
  raw: RawProtocolAdoptRequest,
  at: string,
): ProtocolMutation<ProtocolReceiptEvent> {
  const prior = requireLatestReceipt(work, journal, raw.claimId);
  assertReceiptTime(at, prior.ts);
  if ((prior.stage !== "exited" && prior.stage !== "adopted") || prior.runnerObserved?.status !== "succeeded") {
    throw new GdmError("succeeded exit만 adopt할 수 있습니다", "receipt_transition");
  }
  assertLifecycleFresh(work, source, prior);
  const outputReason = outputFreshness(cwd, prior);
  if (outputReason !== undefined) throw new GdmError("runner output artifact가 변경됐거나 없습니다", outputReason);
  const handoff = requireHandoff(work, journal, prior.handoffEventId);
  assertHandoffArtifactFresh(cwd, handoff);
  if (prior.stage === "adopted") return { event: prior, changed: false };
  return { event: appendReceiptStage(prior, "adopted", at, {}), changed: true };
}

export function recoverProtocolClaim(
  work: Work,
  journal: readonly JournalEvent[],
  raw: RawProtocolRecoverRequest,
  at: string,
): ProtocolMutation<ProtocolReceiptEvent> {
  const prior = requireLatestReceipt(work, journal, raw.claimId);
  assertReceiptTime(at, prior.ts);
  const reason = safeText(raw.reason, "reason");
  const abandoned = readProtocolReceiptEvents(journal).find((event) => event.claimId === prior.claimId && event.stage === "abandoned");
  if (abandoned !== undefined) {
    if (abandoned.reason !== reason) throw new GdmError("recover replay 사유가 다릅니다", "receipt_conflict");
    return { event: abandoned, changed: false };
  }
  if (prior.stage !== "claimed") throw new GdmError("claimed 상태에서만 recover할 수 있습니다", "receipt_transition");
  return { event: appendReceiptStage(prior, "abandoned", at, { reason }), changed: true };
}

export function protocolLifecycleStatus(
  cwd: string,
  work: Work,
  journal: readonly JournalEvent[],
  source: SourceFingerprint,
): ProtocolLifecycleStatus {
  const current = currentFingerprints(work, source);
  const handoffs = readWorkProtocolHandoffs(work, journal);
  readWorkProtocolReceipts(work, journal);
  const byHandoff = new Map(handoffs.map((event) => [event.eventId, event]));
  return {
    schemaVersion: "gdm-protocol-status/v1",
    slug: work.slug,
    lifecycles: [...latestReceipts(journal).values()].map((event) => {
      const staleReasons: string[] = [];
      if (event.planFingerprint !== current.plan) staleReasons.push("plan_changed");
      if (event.stateFingerprint !== current.state) staleReasons.push("state_changed");
      if (event.sourceFingerprint !== current.source) staleReasons.push("source_changed");
      const handoff = byHandoff.get(event.handoffEventId);
      const artifactReason = automaticArtifactFreshness(cwd, handoff);
      if (artifactReason !== undefined) staleReasons.push(artifactReason);
      const outputReason = outputFreshness(cwd, event);
      if (outputReason !== undefined) staleReasons.push(outputReason);
      return {
        claimId: event.claimId,
        stage: event.stage,
        handoffEventId: event.handoffEventId,
        bundleSha256: event.bundleSha256,
        receiver: event.receiver,
        capabilityProfile: READ_ONLY_SPECIALIST_PROFILE,
        runnerObserved: event.runnerObserved ?? null,
        stale: staleReasons.length > 0,
        staleReasons,
      };
    }),
  };
}

export { readProtocolHandoffEvents, readProtocolReceiptEvents } from "./protocol-journal.ts";
export type { ProtocolHandoffEvent, ProtocolReceiptEvent } from "./protocol-journal.ts";
