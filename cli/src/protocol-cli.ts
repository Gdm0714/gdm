import { ensureFlags, hasFlag, readFlag, requiredFlag } from "./cli-args.ts";
import {
  adoptProtocolClaim,
  buildWorkSnapshot,
  claimProtocolHandoff,
  finishProtocolClaim,
  protocolLifecycleStatus,
  projectProtocolDispatchModelView,
  recordProtocolHandoff,
  recordProtocolOffer,
  recoverProtocolClaim,
} from "./protocol.ts";
import { GdmError } from "./state.ts";
import { appendJournal, readJournal, resolveWorkForRead } from "./store.ts";
import { captureSourceFingerprint } from "./source-fingerprint.ts";

const FINGERPRINT_RE = /^[0-9a-f]{64}$/u;
const EXPECTED_FINGERPRINT_FLAGS = [
  "expected-plan-fingerprint",
  "expected-state-fingerprint",
  "expected-source-fingerprint",
] as const;

function optionalFingerprint(args: string[], flag: (typeof EXPECTED_FINGERPRINT_FLAGS)[number]): string | undefined {
  const value = readFlag(args, flag);
  if (value !== undefined && !FINGERPRINT_RE.test(value)) {
    throw new GdmError(`--${flag}는 소문자 64자리 SHA-256이어야 합니다`, "usage");
  }
  return value;
}

function assertExpectedFingerprint(
  field: "plan" | "state" | "source",
  expected: string | undefined,
  actual: string,
): void {
  if (expected === undefined || expected === actual) return;
  throw new GdmError(
    `${field} fingerprint가 일치하지 않습니다 (expected ${expected}, actual ${actual})`,
    `${field}_fingerprint_mismatch`,
  );
}

function outputJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function cmdProtocol(cwd: string, args: string[], ts: string): void {
  const [subcommand, ...rest] = args;
  if (subcommand === "export") {
    ensureFlags(rest, ["slug", ...EXPECTED_FINGERPRINT_FLAGS]);
    const work = resolveWorkForRead(cwd, readFlag(rest, "slug"));
    const source = captureSourceFingerprint(cwd);
    const snapshot = buildWorkSnapshot(work, source, readJournal(cwd, work.slug), cwd);
    assertExpectedFingerprint(
      "plan",
      optionalFingerprint(rest, "expected-plan-fingerprint"),
      snapshot.work.planFingerprint,
    );
    assertExpectedFingerprint(
      "state",
      optionalFingerprint(rest, "expected-state-fingerprint"),
      snapshot.work.stateFingerprint,
    );
    assertExpectedFingerprint(
      "source",
      optionalFingerprint(rest, "expected-source-fingerprint"),
      snapshot.work.sourceFingerprint.sha256,
    );
    outputJson(snapshot);
    return;
  }

  if (subcommand === "handoff") {
    ensureFlags(rest, [
      "slug",
      "handoff-id",
      "from-role",
      "from-provider",
      "to-role",
      "to-provider",
      "intent",
      "artifact",
      ...EXPECTED_FINGERPRINT_FLAGS,
    ]);
    const work = resolveWorkForRead(cwd, requiredFlag(rest, "slug"));
    const journal = readJournal(cwd, work.slug);
    const source = captureSourceFingerprint(cwd);
    const result = recordProtocolHandoff(
      cwd,
      work,
      journal,
      source,
      {
        handoffId: requiredFlag(rest, "handoff-id"),
        fromRole: requiredFlag(rest, "from-role"),
        fromProvider: readFlag(rest, "from-provider"),
        toRole: requiredFlag(rest, "to-role"),
        toProvider: readFlag(rest, "to-provider"),
        intent: requiredFlag(rest, "intent"),
        artifact: readFlag(rest, "artifact"),
        expectedPlanFingerprint: optionalFingerprint(rest, "expected-plan-fingerprint"),
        expectedStateFingerprint: optionalFingerprint(rest, "expected-state-fingerprint"),
        expectedSourceFingerprint: optionalFingerprint(rest, "expected-source-fingerprint"),
      },
      ts,
    );
    if (result.changed) appendJournal(cwd, work.slug, result.event);
    outputJson(result.event);
    return;
  }

  if (subcommand === "offer") {
    ensureFlags(rest, [
      "slug", "handoff-id", "from-role", "from-provider", "to-role", "to-provider", "intent", "artifact",
      ...EXPECTED_FINGERPRINT_FLAGS,
    ]);
    const work = resolveWorkForRead(cwd, requiredFlag(rest, "slug"));
    const journal = readJournal(cwd, work.slug);
    const source = captureSourceFingerprint(cwd);
    const expectedPlanFingerprint = requiredFingerprint(rest, "expected-plan-fingerprint");
    const expectedStateFingerprint = requiredFingerprint(rest, "expected-state-fingerprint");
    const expectedSourceFingerprint = requiredFingerprint(rest, "expected-source-fingerprint");
    const result = recordProtocolOffer(cwd, work, journal, source, {
      handoffId: requiredFlag(rest, "handoff-id"),
      fromRole: requiredFlag(rest, "from-role"),
      fromProvider: readFlag(rest, "from-provider"),
      toRole: requiredFlag(rest, "to-role"),
      toProvider: readFlag(rest, "to-provider"),
      intent: requiredFlag(rest, "intent"),
      artifact: readFlag(rest, "artifact"),
      expectedPlanFingerprint,
      expectedStateFingerprint,
      expectedSourceFingerprint,
    }, ts);
    if (result.changed) appendJournal(cwd, work.slug, result.event);
    outputJson(result.event);
    return;
  }

  if (subcommand === "claim") {
    ensureFlags(rest, [
      "slug", "handoff-event-id", "claim-id", "receiver-role", "receiver-provider", "capability-profile",
      "model-requested",
    ], ["model-view"]);
    const work = resolveWorkForRead(cwd, requiredFlag(rest, "slug"));
    const result = claimProtocolHandoff(
      cwd,
      work,
      readJournal(cwd, work.slug),
      captureSourceFingerprint(cwd),
      {
        handoffEventId: requiredFlag(rest, "handoff-event-id"),
        claimId: requiredFlag(rest, "claim-id"),
        receiverRole: requiredFlag(rest, "receiver-role"),
        receiverProvider: readFlag(rest, "receiver-provider"),
        capabilityProfile: requiredFlag(rest, "capability-profile"),
        modelRequested: readFlag(rest, "model-requested"),
      },
      ts,
    );
    if (result.changed) appendJournal(cwd, work.slug, result.event);
    outputJson(hasFlag(rest, "model-view") ? projectProtocolDispatchModelView(result.bundle) : result.bundle);
    return;
  }

  if (subcommand === "finish") {
    ensureFlags(rest, [
      "slug", "claim-id", "exit-code", "output-artifact", "provider-target",
      "adapter-version", "executable", "executable-sha256", "executable-version", "argv-policy-id",
      "model-requested", "failure-code",
    ]);
    const work = resolveWorkForRead(cwd, requiredFlag(rest, "slug"));
    const result = finishProtocolClaim(cwd, work, readJournal(cwd, work.slug), captureSourceFingerprint(cwd), {
      claimId: requiredFlag(rest, "claim-id"),
      exitCode: requiredFlag(rest, "exit-code"),
      outputArtifact: requiredFlag(rest, "output-artifact"),
      providerTarget: requiredFlag(rest, "provider-target"),
      adapterVersion: requiredFlag(rest, "adapter-version"),
      executable: requiredFlag(rest, "executable"),
      executableSha256: requiredFingerprint(rest, "executable-sha256"),
      executableVersion: requiredFlag(rest, "executable-version"),
      argvPolicyId: requiredFlag(rest, "argv-policy-id"),
      modelRequested: readFlag(rest, "model-requested"),
      failureCode: readFlag(rest, "failure-code"),
    }, ts);
    if (result.changed) appendJournal(cwd, work.slug, result.event);
    if (result.rejectedCode === "receiver_ack_invalid") {
      throw new GdmError("receiver ACK가 없거나 claim과 일치하지 않습니다", "receiver_ack_invalid");
    }
    if (result.rejectedCode === "receiver_blocked") {
      throw new GdmError("receiver가 blocked disposition을 반환했습니다", "receiver_blocked");
    }
    if (result.rejectedCode === "provider_executable_changed") {
      throw new GdmError("provider executable이 실행 중 변경됐습니다", "provider_executable_changed");
    }
    outputJson(result.event);
    return;
  }

  if (subcommand === "adopt") {
    ensureFlags(rest, ["slug", "claim-id"]);
    const work = resolveWorkForRead(cwd, requiredFlag(rest, "slug"));
    const result = adoptProtocolClaim(cwd, work, readJournal(cwd, work.slug), captureSourceFingerprint(cwd), {
      claimId: requiredFlag(rest, "claim-id"),
    }, ts);
    if (result.changed) appendJournal(cwd, work.slug, result.event);
    outputJson(result.event);
    return;
  }

  if (subcommand === "recover") {
    ensureFlags(rest, ["slug", "claim-id", "reason"]);
    const work = resolveWorkForRead(cwd, requiredFlag(rest, "slug"));
    const result = recoverProtocolClaim(work, readJournal(cwd, work.slug), {
      claimId: requiredFlag(rest, "claim-id"),
      reason: requiredFlag(rest, "reason"),
    }, ts);
    if (result.changed) appendJournal(cwd, work.slug, result.event);
    outputJson(result.event);
    return;
  }

  if (subcommand === "status") {
    ensureFlags(rest, ["slug"]);
    const work = resolveWorkForRead(cwd, readFlag(rest, "slug"));
    outputJson(protocolLifecycleStatus(
      cwd,
      work,
      readJournal(cwd, work.slug),
      captureSourceFingerprint(cwd),
    ));
    return;
  }

  throw new GdmError("protocol 하위 명령을 확인하세요", "usage");
}

function requiredFingerprint(args: string[], flag: (typeof EXPECTED_FINGERPRINT_FLAGS)[number] | "executable-sha256"): string {
  const value = requiredFlag(args, flag);
  if (!FINGERPRINT_RE.test(value)) throw new GdmError(`--${flag}는 소문자 64자리 SHA-256이어야 합니다`, "usage");
  return value;
}
