import { createHash } from "node:crypto";
import { GdmError } from "./state.ts";
import type { ActiveHabit, CommitState, CommitTransition, Work, WorkContract } from "./types.ts";
import {
  containsSensitiveRaw,
  isCanonicalTimestamp,
  isSafeContainedRuleReference,
} from "./validation-boundary.ts";

export const PRIVACY_POLICY_VERSION = 1;

const SAFE_TEXT_RE = /^[\p{L}\p{N}\p{M} .,:;!?()\[\]_-]+$/u;
const SAFE_TEXT_CHAR_RE = /[\p{L}\p{N}\p{M} .,:;!?()\[\]_-]/u;
const SAFE_TEXT_ALLOWED = "한글·영문·숫자·공백과 .,:;!?()[]_-";
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const HABIT_ID_RE = /^h-[0-9a-f]{16}$/u;
const RULE_HASH_RE = /^[0-9a-f]{64}$/u;
const ACTIVE_HABIT_KEYS = ["habitId", "version", "ruleRef", "ruleHash", "activatedAt"] as const;

type ConstraintInput = {
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
};

export type ContractMutation = {
  readonly work: Work;
  readonly changed: boolean;
  readonly addedRequired: readonly string[];
  readonly addedForbidden: readonly string[];
};

export type CommitMutation = {
  readonly work: Work;
  readonly changed: boolean;
  readonly transition?: CommitTransition;
};

export function privacyError(field: string, count = 1, detail?: string): GdmError {
  return new GdmError(
    `privacyPolicyVersion=${PRIVACY_POLICY_VERSION} field=${field} count=${count}${detail ? ` — ${detail}` : ""}`,
    "privacy_rejected",
  );
}

export function assertNoSensitiveRaw(value: string, field: string): void {
  if (containsSensitiveRaw(value)) throw privacyError(field);
}

export function safeText(value: string, field: string, maxLength = 240): string {
  assertNoSensitiveRaw(value, field);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw privacyError(field, 1, "값이 비어 있습니다");
  if (trimmed.length > maxLength) {
    throw privacyError(field, 1, `${maxLength}자 제한 초과 (${trimmed.length}자)`);
  }
  if (!SAFE_TEXT_RE.test(trimmed)) {
    const chars = [...trimmed];
    const index = chars.findIndex((ch) => !SAFE_TEXT_CHAR_RE.test(ch));
    if (index < 0) throw privacyError(field);
    const repeatHint =
      field === "require" || field === "forbid"
        ? " · 여러 조건은 --require/--forbid 플래그를 반복해 전달하세요"
        : "";
    throw privacyError(
      field,
      1,
      `허용되지 않는 문자 "${chars[index]}" (${index + 1}번째) — 허용: ${SAFE_TEXT_ALLOWED}${repeatHint}`,
    );
  }
  return trimmed;
}

export function opaqueId(value: string, field: string): string {
  assertNoSensitiveRaw(value, field);
  if (!OPAQUE_ID_RE.test(value)) {
    throw new GdmError(`field=${field} opaque identifier 형식이 잘못됐습니다`, "usage");
  }
  return value;
}

function unique(values: readonly string[]): readonly string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function parseConstraints(
  requiredValues: readonly string[],
  forbiddenValues: readonly string[],
): ConstraintInput {
  const required = unique(requiredValues.map((value) => safeText(value, "require")));
  const forbidden = unique(forbiddenValues.map((value) => safeText(value, "forbid")));
  if (required.some((value) => forbidden.includes(value))) {
    throw new GdmError("동일한 제약은 필수와 금지에 함께 둘 수 없습니다", "contract_conflict");
  }
  return { required, forbidden };
}

export function defaultContract(): WorkContract {
  return { required: [], forbidden: [], activeHabits: [], commit: "forbidden" };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new GdmError(`상태 파일의 ${field} 형식이 잘못됐습니다`, "state_corrupt");
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function activeHabit(value: unknown): ActiveHabit {
  const corrupt = (): never => {
    throw new GdmError("상태 파일의 contract.activeHabits 형식이 잘못됐습니다", "state_corrupt");
  };
  if (!isRecord(value)) return corrupt();
  if (Object.keys(value).length !== ACTIVE_HABIT_KEYS.length) return corrupt();
  if (ACTIVE_HABIT_KEYS.some((key) => !Object.hasOwn(value, key))) return corrupt();
  const { habitId, version, ruleRef, ruleHash, activatedAt } = value;
  if (
    typeof habitId !== "string" ||
    !HABIT_ID_RE.test(habitId) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof ruleRef !== "string" ||
    !isSafeContainedRuleReference(ruleRef) ||
    typeof ruleHash !== "string" ||
    !RULE_HASH_RE.test(ruleHash) ||
    typeof activatedAt !== "string" ||
    !isCanonicalTimestamp(activatedAt)
  ) {
    return corrupt();
  }
  return { habitId, version, ruleRef, ruleHash, activatedAt };
}

export function normalizeContract(value: unknown): WorkContract {
  if (value === undefined) return defaultContract();
  if (!isRecord(value)) throw new GdmError("상태 파일의 contract 형식이 잘못됐습니다", "state_corrupt");
  const required = stringList(value.required, "contract.required");
  const forbidden = stringList(value.forbidden, "contract.forbidden");
  if (!Array.isArray(value.activeHabits)) {
    throw new GdmError("상태 파일의 contract.activeHabits 형식이 잘못됐습니다", "state_corrupt");
  }
  if (value.commit !== "forbidden" && value.commit !== "explicitly-approved") {
    throw new GdmError("상태 파일의 contract.commit 형식이 잘못됐습니다", "state_corrupt");
  }
  const base: WorkContract = {
    required,
    forbidden,
    activeHabits: value.activeHabits.map(activeHabit),
    commit: value.commit,
  };
  if (value.latestCommitTransition === undefined) return base;
  const transition = parseTransition(value.latestCommitTransition);
  return { ...base, latestCommitTransition: transition };
}

function parseTransition(value: unknown): CommitTransition {
  if (!isRecord(value)) throw new GdmError("상태 파일의 commit transition 형식이 잘못됐습니다", "state_corrupt");
  const from = value.from;
  const to = value.to;
  if ((from !== "forbidden" && from !== "explicitly-approved") || (to !== "forbidden" && to !== "explicitly-approved")) {
    throw new GdmError("상태 파일의 commit transition 값이 잘못됐습니다", "state_corrupt");
  }
  if (
    typeof value.eventId !== "string" ||
    typeof value.transitionRevision !== "number" ||
    typeof value.reason !== "string" ||
    typeof value.at !== "string" ||
    (value.predecessorEventId !== null && typeof value.predecessorEventId !== "string")
  ) {
    throw new GdmError("상태 파일의 commit transition 필드가 잘못됐습니다", "state_corrupt");
  }
  return {
    eventId: value.eventId,
    transitionRevision: value.transitionRevision,
    predecessorEventId: value.predecessorEventId,
    from,
    to,
    reason: value.reason,
    at: value.at,
  };
}

export function createContract(input: ConstraintInput): WorkContract {
  if (input.required.length === 0 && input.forbidden.length === 0) {
    throw new GdmError("constraint_required: --require 또는 --forbid가 필요합니다", "constraint_required");
  }
  return { ...defaultContract(), required: input.required, forbidden: input.forbidden };
}

export function addConstraints(work: Work, input: ConstraintInput): ContractMutation {
  const required = unique([...work.contract.required, ...input.required]);
  const forbidden = unique([...work.contract.forbidden, ...input.forbidden]);
  if (required.some((value) => forbidden.includes(value))) {
    throw new GdmError("동일한 제약은 필수와 금지에 함께 둘 수 없습니다", "contract_conflict");
  }
  const addedRequired = required.slice(work.contract.required.length);
  const addedForbidden = forbidden.slice(work.contract.forbidden.length);
  if (addedRequired.length === 0 && addedForbidden.length === 0) {
    return { work, changed: false, addedRequired, addedForbidden };
  }
  if (work.done || work.checks.some((check) => check.status === "proven")) {
    throw new GdmError("첫 확인 항목 통과 뒤에는 작업 제약을 추가할 수 없습니다", "contract_locked");
  }
  return {
    work: { ...work, contract: { ...work.contract, required, forbidden } },
    changed: true,
    addedRequired,
    addedForbidden,
  };
}

export function parseCommitState(value: string): CommitState {
  if (value !== "forbidden" && value !== "explicitly-approved") {
    throw new GdmError("--commit은 forbidden 또는 explicitly-approved여야 합니다", "usage");
  }
  return value;
}

export function transitionCommit(
  work: Work,
  to: CommitState,
  reasonValue: string,
  at: string,
): CommitMutation {
  const reason = safeText(reasonValue, "reason");
  const latest = work.contract.latestCommitTransition;
  if (work.contract.commit === to) {
    if (latest?.to === to && latest.reason === reason) return { work, changed: false };
    throw new GdmError("현재 커밋 상태와 충돌하는 전환입니다", "commit_transition_conflict");
  }
  const transitionRevision = (latest?.transitionRevision ?? 0) + 1;
  const predecessorEventId = latest?.eventId ?? null;
  const identity = `${work.slug}\0${transitionRevision}\0${predecessorEventId ?? ""}\0${to}\0${reason}`;
  const eventId = `commit-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
  const transition: CommitTransition = {
    eventId,
    transitionRevision,
    predecessorEventId,
    from: work.contract.commit,
    to,
    reason,
    at,
  };
  return {
    work: { ...work, contract: { ...work.contract, commit: to, latestCommitTransition: transition } },
    changed: true,
    transition,
  };
}

export function assertCommitAllowed(work: Work): void {
  if (work.contract.commit === "forbidden") {
    throw new GdmError("commit_forbidden: 명시적 승인 전에는 커밋할 수 없습니다", "commit_forbidden");
  }
}
