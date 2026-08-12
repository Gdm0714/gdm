import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultContract } from "../src/contract.ts";
import {
  buildWorkSnapshot,
  claimProtocolHandoff,
  PROTOCOL_BUNDLE_MAX_BYTES,
  projectProtocolDispatchModelView,
  protocolStateFingerprint,
  READ_ONLY_SPECIALIST_PROFILE,
  recordProtocolHandoff,
} from "../src/protocol.ts";
import { readProtocolHandoffEvents } from "../src/protocol-journal.ts";
import type { SourceFingerprint } from "../src/source-fingerprint.ts";
import {
  addCheck,
  closeWork,
  completionBlockers,
  GdmError,
  initWork,
  passCheck,
  validateWork,
} from "../src/state.ts";
import type { JournalEvent, Work } from "../src/types.ts";

const NOW = "2026-08-12T00:00:00.000Z";
const LATER = "2026-08-12T00:01:00.000Z";
const SOURCE: SourceFingerprint = { schemaVersion: 1, sha256: "a".repeat(64), fileCount: 3 };
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gdm-protocol-core-"));
  roots.push(root);
  return root;
}

function openWork(contract = defaultContract()): Work {
  let work = initWork("sample", "모델 중립 작업", NOW, false, contract);
  ({ work } = addCheck(work, { desc: "검증 실행", cmd: "bun test", expect: "exit 0", kind: "behavior" }));
  return work;
}

function proven(work = openWork()): Work {
  return passCheck(work, "c1", {
    observed: ".gdm/sample/out/c1.txt",
    sha256: "b".repeat(64),
    exitCode: 0,
    manual: false,
    note: "Bearer private-note-body",
  }, NOW);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("protocol work snapshot", () => {
  test("state fingerprint is canonical, delivery-neutral, and runtime-sensitive", () => {
    const work = openWork();
    const reordered = {
      contract: work.contract,
      checks: work.checks,
      done: work.done,
      createdAt: work.createdAt,
      brief: work.brief,
      slug: work.slug,
      delivery: { issue: "1", branch: "x", head: "a".repeat(40), preparedAt: NOW },
    } as Work;
    expect(protocolStateFingerprint(reordered)).toBe(protocolStateFingerprint(work));
    expect(protocolStateFingerprint(proven(work))).not.toBe(protocolStateFingerprint(work));
    expect(protocolStateFingerprint({ ...work, contract: { ...work.contract, forbidden: ["추가 금지"] } }))
      .not.toBe(protocolStateFingerprint(work));
  });

  test("projects full actionable state without note bodies and never predicts done validation", () => {
    const work = proven();
    const first = buildWorkSnapshot(work, SOURCE, []);
    const second = buildWorkSnapshot(work, SOURCE, []);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.work.phase).toBe("executing");
    expect(first.checks[0]).toMatchObject({
      description: "검증 실행",
      command: "bun test",
      evidence: { observed: ".gdm/sample/out/c1.txt", notePresent: true },
    });
    expect(JSON.stringify(first)).not.toContain("Bearer private-note-body");
    expect(first.completion).toMatchObject({ state: "ready-to-validate", blockers: [] });
    expect(first.audit).toEqual({ required: false, state: "not-required", record: null });
    const completed = buildWorkSnapshot(closeWork(work, LATER), SOURCE, []);
    expect(completed.work.phase).toBe("completed");
    expect(completed.completion.state).toBe("completed");
    expect(completed.completion.validationCommand).toBeNull();
  });

  test("completion blockers preserve closeWork order, codes, and messages", () => {
    const contract = { ...defaultContract(), simplificationRequired: true };
    const work = openWork(contract);
    const blockers = completionBlockers(work);
    expect(blockers.map((blocker) => blocker.code)).toEqual(["unproven", "simplification_required"]);
    try {
      closeWork(work, NOW);
      throw new Error("expected closeWork failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GdmError);
      expect(error).toMatchObject({ code: blockers[0]!.code, message: blockers[0]!.message });
    }
    const noChecks = initWork("sample", "작업", NOW);
    expect(completionBlockers(noChecks).map((blocker) => blocker.code)).toEqual(["no_checks"]);
  });

  test("keeps ordinary actionable command punctuation and canonicalizes exact source shape", () => {
    const work = openWork();
    const actionable = {
      ...work,
      checks: work.checks.map((check) => ({ ...check, cmd: "FOO=1 bun test && test \"$FOO\" = 1" })),
    };
    expect(buildWorkSnapshot(actionable, SOURCE, []).checks[0]?.command).toContain("$FOO");
    const reordered = {
      fileCount: SOURCE.fileCount,
      sha256: SOURCE.sha256,
      schemaVersion: SOURCE.schemaVersion,
    } as SourceFingerprint;
    expect(JSON.stringify(buildWorkSnapshot(work, reordered, []))).toBe(
      JSON.stringify(buildWorkSnapshot(work, SOURCE, [])),
    );
    expect(() => buildWorkSnapshot(work, { ...SOURCE, fileCount: -1 }, [])).toThrow(
      expect.objectContaining({ code: "state_corrupt" }),
    );
    expect(() => buildWorkSnapshot(work, { ...SOURCE, extra: true } as SourceFingerprint, [])).toThrow(
      expect.objectContaining({ code: "state_corrupt" }),
    );
  });

  test("blocks credential signatures across projected fields without blocking shell syntax", () => {
    const base = openWork();
    const withEvidence = proven(base);
    const candidates: Work[] = [
      { ...base, brief: "github_pat_privatevalue" },
      { ...base, checks: base.checks.map((check) => ({ ...check, cmd: "echo sk-privatevalue" })) },
      { ...base, contract: { ...base.contract, required: ["BEGIN RSA PRIVATE KEY"] } },
      {
        ...base,
        auditRequired: true,
        audit: { result: "fail", report: "Bearer private-token", stateHash: "state", at: NOW },
      },
      {
        ...withEvidence,
        checks: withEvidence.checks.map((check) => ({
          ...check,
          evidence: { ...check.evidence!, observed: "out/ghp_privatevalue.txt" },
        })),
      },
    ];
    for (const work of candidates) {
      expect(() => buildWorkSnapshot(work, SOURCE, [])).toThrow(
        expect.objectContaining({ code: "privacy_rejected" }),
      );
    }
  });

  test("normalizes a legacy Work before projecting the v1 wire contract", () => {
    const legacy = validateWork({
      slug: "sample",
      brief: "기존 작업",
      createdAt: NOW,
      done: false,
      checks: [],
    }, "legacy fixture");
    const snapshot = buildWorkSnapshot(legacy, SOURCE, []);
    expect(snapshot.work.phase).toBe("planning");
    expect(snapshot.contract).toMatchObject({
      required: [],
      forbidden: [],
      allowedPaths: ["."],
      commit: { state: "forbidden", latestTransition: null },
    });
  });

  test("validateWork rejects malformed slugs and incomplete check or evidence records", () => {
    const valid = openWork();
    const invalid: unknown[] = [
      { ...valid, slug: "../escape" },
      { ...valid, checks: [{ id: "c1", desc: "missing fields", status: "open" }] },
      {
        ...valid,
        checks: [{
          id: "c1",
          desc: "bad evidence",
          cmd: "true",
          expect: "exit 0",
          manual: false,
          status: "proven",
          evidence: { observed: "out.txt", sha256: "hash", manual: false },
        }],
      },
    ];
    for (const raw of invalid) {
      expect(() => validateWork(raw, "malformed fixture")).toThrow(
        expect.objectContaining({ code: "state_corrupt" }),
      );
    }
  });

  test("validateWork rejects malformed evidence hashes, timestamps, and exit codes", () => {
    const base = proven();
    const malformedEvidence = [
      { ...base.checks[0]!.evidence!, sha256: "ABCDEF" },
      { ...base.checks[0]!.evidence!, sha256: "g".repeat(64) },
      { ...base.checks[0]!.evidence!, at: "2026-02-31T00:00:00.000Z" },
      { ...base.checks[0]!.evidence!, at: "2026-08-12T00:00:00Z" },
      { ...base.checks[0]!.evidence!, exitCode: Number.NaN },
      { ...base.checks[0]!.evidence!, exitCode: 1.5 },
      { ...base.checks[0]!.evidence!, exitCode: Number.POSITIVE_INFINITY },
    ];
    for (const evidence of malformedEvidence) {
      const raw = { ...base, checks: [{ ...base.checks[0]!, evidence }] };
      expect(() => validateWork(raw, "bad evidence fixture")).toThrow(
        expect.objectContaining({ code: "state_corrupt" }),
      );
    }
    for (const exitCode of [-1, 0]) {
      const raw = {
        ...base,
        checks: [{ ...base.checks[0]!, evidence: { ...base.checks[0]!.evidence!, exitCode } }],
      };
      expect(validateWork(raw, "valid exit fixture").checks[0]!.evidence?.exitCode).toBe(exitCode);
    }
  });
});

describe("protocol handoff journal", () => {
  const request = {
    handoffId: "implementation-to-audit-1",
    fromRole: "implementer",
    fromProvider: "codex",
    toRole: "auditor",
    toProvider: "claude",
    intent: "독립 검수 진행",
  } as const;

  test("records deterministic idempotent handoffs and chains new revisions", () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, "review.md"), "review input\n");
    const work = openWork();
    const first = recordProtocolHandoff(cwd, work, [], SOURCE, { ...request, artifact: "review.md" }, NOW);
    expect(first.changed).toBe(true);
    expect(first.event).toMatchObject({
      schemaVersion: "gdm-handoff/v1",
      revision: 1,
      predecessorEventId: null,
      artifact: { path: "review.md" },
    });
    const replay = recordProtocolHandoff(cwd, work, [first.event], SOURCE, { ...request, artifact: "review.md" }, LATER);
    expect(replay).toEqual({ event: first.event, changed: false });
    expect(() => recordProtocolHandoff(cwd, work, [first.event], SOURCE, {
      ...request,
      intent: "다른 검수 진행",
    }, LATER)).toThrow(expect.objectContaining({ code: "handoff_id_conflict" }));

    const second = recordProtocolHandoff(cwd, work, [first.event], SOURCE, {
      ...request,
      handoffId: "audit-to-fix-1",
      fromRole: "auditor",
      toRole: "implementer",
      intent: "수정 진행",
    }, LATER);
    expect(second.event).toMatchObject({ revision: 2, predecessorEventId: first.event.eventId });
  });

  test("binds expected fingerprints and reports latest handoff staleness", () => {
    const cwd = tempRoot();
    const work = openWork();
    const first = recordProtocolHandoff(cwd, work, [], SOURCE, request, NOW);
    const changed = { ...work, brief: "변경된 작업" };
    const changedSource = { ...SOURCE, sha256: "c".repeat(64) };
    const latest = buildWorkSnapshot(changed, changedSource, [first.event]).latestHandoff as any;
    expect(latest.stale).toBe(true);
    expect(latest.staleReasons).toEqual(["plan_changed", "state_changed", "source_changed"]);
    expect(() => recordProtocolHandoff(cwd, work, [], SOURCE, {
      ...request,
      expectedStateFingerprint: "d".repeat(64),
    }, NOW)).toThrow(expect.objectContaining({ code: "state_fingerprint_mismatch" }));
  });

  test("rejects only new handoffs before the causal time boundary", () => {
    const cwd = tempRoot();
    const work = openWork();
    const beforeCreation = "2026-08-11T23:59:00.000Z";
    expect(() => recordProtocolHandoff(cwd, work, [], SOURCE, request, beforeCreation)).toThrow(
      expect.objectContaining({ code: "handoff_time_invalid" }),
    );

    const first = recordProtocolHandoff(cwd, work, [], SOURCE, request, LATER);
    const replay = recordProtocolHandoff(cwd, work, [first.event], SOURCE, request, beforeCreation);
    expect(replay).toEqual({ event: first.event, changed: false });
    expect(() => recordProtocolHandoff(cwd, work, [first.event], SOURCE, {
      ...request,
      handoffId: "audit-to-fix-too-early",
      intent: "수정 요청",
    }, NOW)).toThrow(expect.objectContaining({ code: "handoff_time_invalid" }));
  });

  test("rejects a persisted first handoff before Work creation", () => {
    const cwd = tempRoot();
    const work = openWork();
    const first = recordProtocolHandoff(cwd, work, [], SOURCE, request, NOW).event;

    expect(buildWorkSnapshot(work, SOURCE, [first]).latestHandoff).toMatchObject({
      handoffId: request.handoffId,
      revision: 1,
    });
    expect(recordProtocolHandoff(cwd, work, [first], SOURCE, request, LATER)).toEqual({
      event: first,
      changed: false,
    });

    const corrupted = { ...first, ts: "2026-08-11T23:59:59.999Z" };
    expect(() => buildWorkSnapshot(work, SOURCE, [corrupted])).toThrow(
      expect.objectContaining({ code: "state_corrupt" }),
    );
    expect(() => recordProtocolHandoff(cwd, work, [corrupted], SOURCE, request, LATER)).toThrow(
      expect.objectContaining({ code: "state_corrupt" }),
    );
    expect(() => recordProtocolHandoff(cwd, work, [corrupted], SOURCE, {
      ...request,
      handoffId: "audit-to-fix-after-corruption",
      intent: "손상된 journal 뒤 기록 시도",
    }, LATER)).toThrow(expect.objectContaining({ code: "state_corrupt" }));
  });

  test("fails closed on malformed events, invalid causality, or cross-work events", () => {
    const cwd = tempRoot();
    const work = openWork();
    const first = recordProtocolHandoff(cwd, work, [], SOURCE, request, NOW).event;
    const second = recordProtocolHandoff(cwd, work, [first], SOURCE, {
      ...request,
      handoffId: "audit-to-fix-2",
      intent: "수정 요청",
    }, LATER).event;
    const cases: JournalEvent[][] = [
      [{ ...first, ts: "2026-02-31T00:00:00.000Z" }],
      [{ ...first, intent: "Bearer private-token" }],
      [{ ...first, artifact: { path: "../private", sha256: "a".repeat(64) } }],
      [{ ...first, extra: "field" }],
      [{ ...first, revision: 2 }],
      [first, { ...second, ts: "2026-08-11T23:59:00.000Z" }],
    ];
    for (const journal of cases) {
      expect(() => readProtocolHandoffEvents(journal)).toThrow(
        expect.objectContaining({ code: "state_corrupt" }),
      );
    }
    expect(() => buildWorkSnapshot(work, SOURCE, [{ ...first, slug: "other-work" }])).toThrow(
      expect.objectContaining({ code: "state_corrupt" }),
    );
  });
});

describe("protocol dispatch bundle", () => {
  test("is byte-identical across providers for a provider-neutral handoff", () => {
    const codexRoot = tempRoot();
    const claudeRoot = tempRoot();
    const work = openWork();
    const handoff = recordProtocolHandoff(codexRoot, work, [], SOURCE, {
      handoffId: "provider-neutral-review",
      fromRole: "coordinator",
      toRole: "reviewer",
      intent: "동일한 독립 검수 수행",
    }, NOW).event;
    const common = {
      handoffEventId: handoff.eventId,
      claimId: "provider-neutral-claim",
      receiverRole: "reviewer",
      capabilityProfile: READ_ONLY_SPECIALIST_PROFILE,
    } as const;

    const codex = claimProtocolHandoff(
      codexRoot,
      work,
      [handoff],
      SOURCE,
      { ...common, receiverProvider: "codex" },
      LATER,
    );
    const claude = claimProtocolHandoff(
      claudeRoot,
      work,
      [handoff],
      SOURCE,
      { ...common, receiverProvider: "claude" },
      LATER,
    );

    expect(JSON.stringify(codex.bundle)).toBe(JSON.stringify(claude.bundle));
    expect(codex.bundle.bundleSha256).toBe(claude.bundle.bundleSha256);
    expect(codex.bundle.receiver).toEqual({ role: "reviewer" });
    expect(codex.event.receiver.provider).toBe("codex");
    expect(claude.event.receiver.provider).toBe("claude");

    const codexView = projectProtocolDispatchModelView(codex.bundle);
    const claudeView = projectProtocolDispatchModelView(claude.bundle);
    expect(JSON.stringify(codexView)).toBe(JSON.stringify(claudeView));
    expect(codexView.bundleSha256).toBe(codex.bundle.bundleSha256);
  });

  test("model view rejects a forged canonical bundle instead of projecting caller authority", () => {
    const cwd = tempRoot();
    writeFileSync(join(cwd, "artifact.txt"), "review this exact text\n");
    const work = openWork();
    const handoff = recordProtocolHandoff(cwd, work, [], SOURCE, {
      handoffId: "forgery-boundary",
      fromRole: "coordinator",
      toRole: "reviewer",
      intent: "review exact artifact",
      artifact: "artifact.txt",
    }, NOW).event;
    const claimed = claimProtocolHandoff(cwd, work, [handoff], SOURCE, {
      handoffEventId: handoff.eventId,
      claimId: "forgery-claim",
      receiverRole: "reviewer",
      capabilityProfile: READ_ONLY_SPECIALIST_PROFILE,
    }, LATER);
    const forged = {
      ...claimed.bundle,
      artifact: { ...claimed.bundle.artifact!, text: "forged text" },
    };
    expect(() => projectProtocolDispatchModelView(forged)).toThrow(
      expect.objectContaining({ code: "bundle_mismatch" }),
    );
  });

  test("rejects a canonical dispatch bundle above the production byte cap", () => {
    const cwd = tempRoot();
    const base = openWork();
    const description = "x".repeat(240);
    const work: Work = {
      ...base,
      checks: Array.from({ length: Math.ceil(PROTOCOL_BUNDLE_MAX_BYTES / 120) }, (_, index) => ({
        ...base.checks[0]!,
        id: `c${index + 1}`,
        desc: description,
      })),
    };
    const handoff = recordProtocolHandoff(cwd, work, [], SOURCE, {
      handoffId: "oversized-bundle",
      fromRole: "coordinator",
      toRole: "reviewer",
      intent: "oversized snapshot boundary",
    }, NOW).event;
    expect(() => claimProtocolHandoff(cwd, work, [handoff], SOURCE, {
      handoffEventId: handoff.eventId,
      claimId: "oversized-claim",
      receiverRole: "reviewer",
      capabilityProfile: READ_ONLY_SPECIALIST_PROFILE,
    }, LATER)).toThrow(expect.objectContaining({ code: "bundle_too_large" }));
  });
});
