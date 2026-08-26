import { createHash } from "node:crypto";
import { assertNoSensitiveRaw, safeText } from "./contract.ts";
import { GdmError, validateSlug } from "./state.ts";
import type { JournalEvent } from "./types.ts";
import { isCanonicalTimestamp } from "./validation-boundary.ts";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const EVENT_ID_RE = /^h-[0-9a-f]{16}$/u;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const HANDOFF_KEYS = [
  "schemaVersion", "event", "eventId", "handoffId", "revision", "predecessorEventId", "ts", "slug",
  "from", "to", "intent", "planFingerprint", "stateFingerprint", "sourceFingerprint",
] as const;
const RECEIPT_KEYS = [
  "schemaVersion", "event", "eventId", "receiptId", "revision", "predecessorEventId", "ts", "slug",
  "stage", "handoffEventId", "claimId", "bundleSha256", "receiver", "capabilityProfile",
  "planFingerprint", "stateFingerprint", "sourceFingerprint",
] as const;

export function normalizeProtocolObservationText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new GdmError(`--${field}는 240자 이하의 한 줄 텍스트여야 합니다`, "usage");
  }
  assertNoSensitiveRaw(normalized, field);
  return normalized;
}

export type ProtocolReceiptStage = "claimed" | "exited" | "adopted" | "abandoned";
export type ProtocolExitStatus = "succeeded" | "blocked" | "failed";

export interface ProtocolRunnerObserved {
  readonly providerTarget: string;
  readonly modelRequested?: string;
  readonly adapterVersion: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly executableVersion: string;
  readonly argvPolicyId: string;
  readonly outputArtifact: ProtocolArtifact;
  readonly exitCode: number;
  readonly status: ProtocolExitStatus;
  readonly failureCode?: string;
}

export interface ProtocolReceiptEvent extends JournalEvent {
  readonly schemaVersion: "gdm-protocol-receipt/v1";
  readonly event: "protocol_receipt";
  readonly eventId: string;
  readonly receiptId: string;
  readonly revision: number;
  readonly predecessorEventId: string | null;
  readonly ts: string;
  readonly slug: string;
  readonly stage: ProtocolReceiptStage;
  readonly handoffEventId: string;
  readonly claimId: string;
  readonly bundleSha256: string;
  readonly receiver: ProtocolParty;
  readonly capabilityProfile: "gdm-read-only-specialist/v1";
  readonly modelRequested?: string;
  readonly planFingerprint: string;
  readonly stateFingerprint: string;
  readonly sourceFingerprint: string;
  readonly runnerObserved?: ProtocolRunnerObserved;
  readonly reason?: string;
}

export interface ProtocolParty {
  readonly role: string;
  readonly provider?: string;
}

export interface ProtocolArtifact {
  readonly path: string;
  readonly sha256: string;
}

export interface ProtocolHandoffEvent extends JournalEvent {
  readonly schemaVersion: "gdm-handoff/v1";
  readonly event: "protocol_handoff";
  readonly eventId: string;
  readonly handoffId: string;
  readonly revision: number;
  readonly predecessorEventId: string | null;
  readonly ts: string;
  readonly slug: string;
  readonly from: ProtocolParty;
  readonly to: ProtocolParty;
  readonly intent: string;
  readonly artifact?: ProtocolArtifact;
  readonly planFingerprint: string;
  readonly stateFingerprint: string;
  readonly sourceFingerprint: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParty(value: unknown): value is ProtocolParty {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!Object.hasOwn(value, "role") || !keys.every((key) => key === "role" || key === "provider")) return false;
  return (
    typeof value.role === "string" && OPAQUE_ID_RE.test(value.role) &&
    (value.provider === undefined || (typeof value.provider === "string" && OPAQUE_ID_RE.test(value.provider)))
  );
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function isArtifact(value: unknown): value is ProtocolArtifact {
  if (
    !isRecord(value) || Object.keys(value).length !== 2 ||
    typeof value.path !== "string" || value.path.length === 0 || value.path.includes("\\") ||
    typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256)
  ) return false;
  const parts = value.path.split("/");
  if (value.path.startsWith("/") || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return false;
  }
  try {
    assertNoSensitiveRaw(value.path, "artifact");
    for (const part of parts) assertNoSensitiveRaw(part, "artifact-component");
    return true;
  } catch {
    return false;
  }
}

function isProtocolHandoffEvent(value: JournalEvent): value is ProtocolHandoffEvent {
  if (!hasExactKeys(value, HANDOFF_KEYS, ["artifact"])) return false;
  if (
    value.event !== "protocol_handoff" || value.schemaVersion !== "gdm-handoff/v1" ||
    typeof value.eventId !== "string" || !EVENT_ID_RE.test(value.eventId) ||
    typeof value.handoffId !== "string" || !OPAQUE_ID_RE.test(value.handoffId) ||
    typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    (value.predecessorEventId !== null &&
      (typeof value.predecessorEventId !== "string" || !EVENT_ID_RE.test(value.predecessorEventId))) ||
    typeof value.ts !== "string" || !isCanonicalTimestamp(value.ts) || typeof value.slug !== "string" ||
    !isParty(value.from) || !isParty(value.to) || typeof value.intent !== "string" ||
    (value.artifact !== undefined && !isArtifact(value.artifact)) ||
    typeof value.planFingerprint !== "string" || !SHA256_RE.test(value.planFingerprint) ||
    typeof value.stateFingerprint !== "string" || !SHA256_RE.test(value.stateFingerprint) ||
    typeof value.sourceFingerprint !== "string" || !SHA256_RE.test(value.sourceFingerprint)
  ) return false;
  try {
    validateSlug(value.slug);
    for (const [field, party] of [["from", value.from], ["to", value.to]] as const) {
      const parsed = party as ProtocolParty;
      assertNoSensitiveRaw(parsed.role, `${field}-role`);
      if (parsed.provider !== undefined) assertNoSensitiveRaw(parsed.provider, `${field}-provider`);
    }
    if (safeText(value.intent, "intent") !== value.intent) return false;
    return true;
  } catch {
    return false;
  }
}

function isRunnerObserved(value: unknown): value is ProtocolRunnerObserved {
  if (!isRecord(value)) return false;
  const required = [
    "providerTarget", "adapterVersion", "executable", "executableSha256", "executableVersion",
    "argvPolicyId", "outputArtifact", "exitCode", "status",
  ] as const;
  if (!hasExactKeys(value, required, ["modelRequested", "failureCode"])) return false;
  if (
    typeof value.providerTarget !== "string" || !OPAQUE_ID_RE.test(value.providerTarget) ||
    (value.modelRequested !== undefined &&
      (typeof value.modelRequested !== "string" || !OPAQUE_ID_RE.test(value.modelRequested))) ||
    typeof value.adapterVersion !== "string" || !OPAQUE_ID_RE.test(value.adapterVersion) ||
    typeof value.executable !== "string" || !value.executable.startsWith("/") || value.executable.includes("\0") ||
    typeof value.executableSha256 !== "string" || !SHA256_RE.test(value.executableSha256) ||
    typeof value.executableVersion !== "string" ||
    typeof value.argvPolicyId !== "string" || !OPAQUE_ID_RE.test(value.argvPolicyId) ||
    !isArtifact(value.outputArtifact) || typeof value.exitCode !== "number" ||
    !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 ||
    (value.status !== "succeeded" && value.status !== "blocked" && value.status !== "failed") ||
    (value.failureCode !== undefined &&
      (typeof value.failureCode !== "string" || !OPAQUE_ID_RE.test(value.failureCode))) ||
    (value.status === "succeeded" && value.exitCode !== 0) ||
    (value.status === "succeeded" && value.failureCode !== undefined)
  ) return false;
  try {
    if (normalizeProtocolObservationText(value.executableVersion, "executable-version") !== value.executableVersion) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isProtocolReceiptEvent(value: JournalEvent): value is ProtocolReceiptEvent {
  if (!hasExactKeys(value, RECEIPT_KEYS, ["modelRequested", "runnerObserved", "reason"])) return false;
  if (
    value.event !== "protocol_receipt" || value.schemaVersion !== "gdm-protocol-receipt/v1" ||
    typeof value.eventId !== "string" || !/^r-[0-9a-f]{16}$/u.test(value.eventId) ||
    typeof value.receiptId !== "string" || !OPAQUE_ID_RE.test(value.receiptId) ||
    typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    (value.predecessorEventId !== null &&
      (typeof value.predecessorEventId !== "string" || !/^r-[0-9a-f]{16}$/u.test(value.predecessorEventId))) ||
    typeof value.ts !== "string" || !isCanonicalTimestamp(value.ts) || typeof value.slug !== "string" ||
    (value.stage !== "claimed" && value.stage !== "exited" && value.stage !== "adopted" && value.stage !== "abandoned") ||
    typeof value.handoffEventId !== "string" || !EVENT_ID_RE.test(value.handoffEventId) ||
    typeof value.claimId !== "string" || !OPAQUE_ID_RE.test(value.claimId) ||
    typeof value.bundleSha256 !== "string" || !SHA256_RE.test(value.bundleSha256) ||
    !isParty(value.receiver) || value.capabilityProfile !== "gdm-read-only-specialist/v1" ||
    (value.modelRequested !== undefined &&
      (typeof value.modelRequested !== "string" || !OPAQUE_ID_RE.test(value.modelRequested))) ||
    typeof value.planFingerprint !== "string" || !SHA256_RE.test(value.planFingerprint) ||
    typeof value.stateFingerprint !== "string" || !SHA256_RE.test(value.stateFingerprint) ||
    typeof value.sourceFingerprint !== "string" || !SHA256_RE.test(value.sourceFingerprint) ||
    (value.runnerObserved !== undefined && !isRunnerObserved(value.runnerObserved)) ||
    (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.stage === "exited" || value.stage === "adopted") !== (value.runnerObserved !== undefined) ||
    (value.stage === "abandoned") !== (value.reason !== undefined)
  ) return false;
  try {
    validateSlug(value.slug);
    if (value.reason !== undefined && safeText(value.reason, "reason") !== value.reason) return false;
    return true;
  } catch {
    return false;
  }
}

function protocolLike(value: JournalEvent): boolean {
  return (
    (typeof value.schemaVersion === "string" &&
      (value.schemaVersion.startsWith("gdm-handoff/") || value.schemaVersion.startsWith("gdm-protocol-"))) ||
    Object.hasOwn(value, "handoffId") || Object.hasOwn(value, "handoffEventId") ||
    Object.hasOwn(value, "claimId") || Object.hasOwn(value, "receiptId") || Object.hasOwn(value, "bundleSha256")
  );
}

export function assertProtocolJournal(journal: readonly JournalEvent[]): void {
  for (const event of journal) {
    if (!protocolLike(event)) continue;
    if (!isProtocolHandoffEvent(event) && !isProtocolReceiptEvent(event)) {
      throw new GdmError("protocol journal discriminator 또는 형식이 잘못됐습니다", "state_corrupt");
    }
  }
}

/** Validate the complete protocol_handoff subsequence and its causal chain. */
export function readProtocolHandoffEvents(journal: readonly JournalEvent[]): readonly ProtocolHandoffEvent[] {
  assertProtocolJournal(journal);
  const relevant = journal.filter((event) => event.event === "protocol_handoff");
  if (relevant.some((event) => !isProtocolHandoffEvent(event))) {
    throw new GdmError("protocol handoff journal 형식이 잘못됐습니다", "state_corrupt");
  }
  const events = relevant.filter(isProtocolHandoffEvent);
  const seenIds = new Set<string>();
  const seenHandoffs = new Set<string>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const predecessor = index === 0 ? null : events[index - 1]!.eventId;
    const predecessorTs = index === 0 ? null : events[index - 1]!.ts;
    const expectedEventId =
      `h-${createHash("sha256").update(`${event.slug}\0${event.handoffId}`).digest("hex").slice(0, 16)}`;
    if (
      event.eventId !== expectedEventId || event.revision !== index + 1 || event.predecessorEventId !== predecessor ||
      (predecessorTs !== null && event.ts < predecessorTs) ||
      seenIds.has(event.eventId) || seenHandoffs.has(event.handoffId)
    ) {
      throw new GdmError("protocol handoff journal causal chain이 잘못됐습니다", "state_corrupt");
    }
    seenIds.add(event.eventId);
    seenHandoffs.add(event.handoffId);
  }
  return events;
}

export function readProtocolReceiptEvents(journal: readonly JournalEvent[]): readonly ProtocolReceiptEvent[] {
  assertProtocolJournal(journal);
  const events = journal.filter(isProtocolReceiptEvent);
  const latestByClaim = new Map<string, ProtocolReceiptEvent>();
  const seenIds = new Set<string>();
  for (const event of events) {
    const prior = latestByClaim.get(event.claimId);
    const expectedId = `r-${createHash("sha256")
      .update(`${event.slug}\0${event.claimId}\0${event.revision}\0${event.stage}`)
      .digest("hex").slice(0, 16)}`;
    if (
      event.eventId !== expectedId || event.revision !== (prior?.revision ?? 0) + 1 ||
      event.predecessorEventId !== (prior?.eventId ?? null) ||
      (prior !== undefined && event.ts < prior.ts) || seenIds.has(event.eventId) ||
      (prior !== undefined && (
        event.handoffEventId !== prior.handoffEventId || event.receiver.role !== prior.receiver.role ||
        event.receiver.provider !== prior.receiver.provider || event.capabilityProfile !== prior.capabilityProfile ||
        event.modelRequested !== prior.modelRequested ||
        event.bundleSha256 !== prior.bundleSha256 || event.planFingerprint !== prior.planFingerprint ||
        event.stateFingerprint !== prior.stateFingerprint || event.sourceFingerprint !== prior.sourceFingerprint
      ))
    ) throw new GdmError("protocol receipt causal chain이 잘못됐습니다", "state_corrupt");
    if (
      prior === undefined ? event.stage !== "claimed" :
        prior.stage === "claimed" ? event.stage !== "exited" && event.stage !== "abandoned" :
        prior.stage === "exited" ? event.stage !== "adopted" : true
    ) throw new GdmError("protocol receipt transition이 잘못됐습니다", "state_corrupt");
    seenIds.add(event.eventId);
    latestByClaim.set(event.claimId, event);
  }
  return events;
}
