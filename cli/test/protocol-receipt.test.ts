import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_ARTIFACT_MAX_BYTES,
  PROTOCOL_LEGACY_ARTIFACT_MAX_BYTES,
  PROTOCOL_OUTPUT_MAX_BYTES,
} from "../src/protocol.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SLUG = "receipt";
const OUTPUT = `.gdm/${SLUG}/out/result.txt`;
const roots: string[] = [];

// Coverage instrumentation makes the multi-process CLI lifecycle cases slower
// than Bun's 5-second default on otherwise healthy runs.
setDefaultTimeout(15_000);

type Result = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

function run(cwd: string, args: readonly string[]): Result {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-protocol-receipt-"));
  roots.push(cwd);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd }).exitCode).toBe(0);
  writeFileSync(join(cwd, "source.txt"), "source\n");
  expect(run(cwd, [
    "plan", "init", "--slug", SLUG, "--brief", "receipt lifecycle", "--require", "read only",
    "--forbid", "authority mutation",
  ])).toMatchObject({ exitCode: 0, stderr: "" });
  expect(run(cwd, [
    "plan", "add", "--slug", SLUG, "--desc", "source exists", "--cmd", "test -f source.txt",
    "--expect", "exit 0", "--kind", "behavior",
  ])).toMatchObject({ exitCode: 0, stderr: "" });
  return cwd;
}

function snapshot(cwd: string): Record<string, any> {
  const result = run(cwd, ["protocol", "export", "--slug", SLUG]);
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return JSON.parse(result.stdout) as Record<string, any>;
}

function offerResult(cwd: string, id: string, artifact?: string): Result {
  const current = snapshot(cwd);
  return run(cwd, [
    "protocol", "offer", "--slug", SLUG, "--handoff-id", id,
    "--from-role", "coordinator", "--from-provider", "codex",
    "--to-role", "reviewer", "--to-provider", "claude", "--intent", "review current work",
    "--expected-plan-fingerprint", current.work.planFingerprint,
    "--expected-state-fingerprint", current.work.stateFingerprint,
    "--expected-source-fingerprint", current.work.sourceFingerprint.sha256,
    ...(artifact === undefined ? [] : ["--artifact", artifact]),
  ]);
}

function offer(cwd: string, id: string, artifact?: string): Record<string, any> {
  const result = offerResult(cwd, id, artifact);
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return JSON.parse(result.stdout) as Record<string, any>;
}

function legacyHandoffResult(cwd: string, id: string, artifact: string): Result {
  const current = snapshot(cwd);
  return run(cwd, [
    "protocol", "handoff", "--slug", SLUG, "--handoff-id", id,
    "--from-role", "coordinator", "--from-provider", "codex",
    "--to-role", "reviewer", "--to-provider", "claude", "--intent", "legacy artifact handoff",
    "--artifact", artifact,
    "--expected-plan-fingerprint", current.work.planFingerprint,
    "--expected-state-fingerprint", current.work.stateFingerprint,
    "--expected-source-fingerprint", current.work.sourceFingerprint.sha256,
  ]);
}

function legacyHandoff(cwd: string, id: string, artifact: string): Record<string, any> {
  const result = legacyHandoffResult(cwd, id, artifact);
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return JSON.parse(result.stdout) as Record<string, any>;
}

function claimArgs(handoffEventId: string, claimId = "claim-one", role = "reviewer", provider = "claude"): string[] {
  return [
    "protocol", "claim", "--slug", SLUG, "--handoff-event-id", handoffEventId, "--claim-id", claimId,
    "--receiver-role", role, "--receiver-provider", provider,
    "--capability-profile", "gdm-read-only-specialist/v1", "--model-requested", "claude-sonnet",
  ];
}

function receiverAck(bundle: Record<string, any>, disposition: "completed" | "blocked" = "completed"): string {
  return `GDM_RECEIVER_ACK_V1=${JSON.stringify({
    schemaVersion: "gdm-receiver-ack/v1",
    claimId: bundle.claimId,
    handoffEventId: bundle.handoff.eventId,
    bundleSha256: bundle.bundleSha256,
    disposition,
  })}`;
}

function finishArgs(claimId: string, exitCode = "0"): string[] {
  return [
    "protocol", "finish", "--slug", SLUG, "--claim-id", claimId,
    "--exit-code", exitCode, "--output-artifact", OUTPUT, "--provider-target", "claude",
    "--adapter-version", "adapter-v1", "--executable", "/usr/bin/true",
    "--executable-sha256", "1".repeat(64), "--executable-version", "provider version one",
    "--argv-policy-id", "read-only-v1", "--model-requested", "claude-sonnet",
    ...(exitCode === "0" ? [] : ["--failure-code", "provider-failed"]),
  ];
}

function workBytes(cwd: string): string {
  return readFileSync(join(cwd, ".gdm", SLUG, "checks.json"), "utf8");
}

function receiptEvents(cwd: string): Record<string, any>[] {
  return readFileSync(join(cwd, ".gdm", SLUG, "journal.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>)
    .filter((event) => event.event === "protocol_receipt");
}

function allJournalEvents(cwd: string): Record<string, any>[] {
  return readFileSync(join(cwd, ".gdm", SLUG, "journal.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("protocol receipt lifecycle", () => {
  test("offer claim finish adopt is idempotent and never mutates Work authority", () => {
    const cwd = repository();
    const artifactBytes = Buffer.from("artifact π\n", "utf8");
    writeFileSync(join(cwd, "artifact.txt"), artifactBytes);
    writeFileSync(join(cwd, OUTPUT), "provider output\n");
    const before = workBytes(cwd);
    const handoff = offer(cwd, "production-offer", "artifact.txt");

    const claim = run(cwd, claimArgs(handoff.eventId));
    expect(claim).toMatchObject({ exitCode: 0, stderr: "" });
    const bundle = JSON.parse(claim.stdout) as Record<string, any>;
    expect(bundle).toMatchObject({
      schemaVersion: "gdm-dispatch-bundle/v1",
      claimId: "claim-one",
      handoff: { eventId: handoff.eventId },
      receiver: { role: "reviewer" },
      capabilityProfile: "gdm-read-only-specialist/v1",
      artifact: {
        path: "artifact.txt",
        text: artifactBytes.toString("utf8"),
        bytesBase64: artifactBytes.toString("base64"),
      },
    });
    expect(bundle.bundleSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(run(cwd, claimArgs(handoff.eventId))).toMatchObject({ exitCode: 0, stdout: claim.stdout, stderr: "" });
    const modelViewResult = run(cwd, [...claimArgs(handoff.eventId), "--model-view"]);
    expect(modelViewResult).toMatchObject({ exitCode: 0, stderr: "" });
    const modelView = JSON.parse(modelViewResult.stdout) as Record<string, any>;
    expect(modelView).toMatchObject({
      schemaVersion: "gdm-dispatch-model-view/v1",
      claimId: bundle.claimId,
      handoff: { eventId: handoff.eventId },
      artifact: { path: "artifact.txt", sha256: bundle.artifact.sha256, text: artifactBytes.toString("utf8") },
      bundleSha256: bundle.bundleSha256,
    });
    expect(Object.keys(modelView.artifact).sort()).toEqual(["path", "sha256", "text"]);
    expect(modelViewResult.stdout).not.toContain("bytesBase64");
    writeFileSync(join(cwd, OUTPUT), `provider output\n${receiverAck(bundle)}\n`);

    const finished = run(cwd, finishArgs("claim-one"));
    expect(finished).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(finished.stdout)).toMatchObject({
      schemaVersion: "gdm-protocol-receipt/v1",
      stage: "exited",
      claimId: "claim-one",
      bundleSha256: bundle.bundleSha256,
      runnerObserved: {
        status: "succeeded",
        exitCode: 0,
        providerTarget: "claude",
        modelRequested: "claude-sonnet",
        outputArtifact: { path: OUTPUT },
      },
    });
    expect(run(cwd, finishArgs("claim-one"))).toMatchObject({ exitCode: 0, stdout: finished.stdout, stderr: "" });

    writeFileSync(join(cwd, OUTPUT), "changed output\n");
    expect(run(cwd, ["protocol", "adopt", "--slug", SLUG, "--claim-id", "claim-one"]).stderr)
      .toContain("오류(output_changed)");
    expect(JSON.parse(run(cwd, ["protocol", "status", "--slug", SLUG]).stdout).lifecycles[0].staleReasons)
      .toContain("output_changed");
    unlinkSync(join(cwd, OUTPUT));
    expect(JSON.parse(run(cwd, ["protocol", "status", "--slug", SLUG]).stdout).lifecycles[0].staleReasons)
      .toContain("output_missing");
    writeFileSync(join(cwd, OUTPUT), `provider output\n${receiverAck(bundle)}\n`);
    truncateSync(join(cwd, OUTPUT), PROTOCOL_OUTPUT_MAX_BYTES + 1);
    const oversizedStatus = run(cwd, ["protocol", "status", "--slug", SLUG]);
    expect(oversizedStatus).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(oversizedStatus.stdout).lifecycles[0].staleReasons).toContain("output_changed");
    expect(run(cwd, ["protocol", "adopt", "--slug", SLUG, "--claim-id", "claim-one"]).stderr)
      .toContain("오류(output_changed)");
    writeFileSync(join(cwd, OUTPUT), `provider output\n${receiverAck(bundle)}\n`);

    const adopted = run(cwd, ["protocol", "adopt", "--slug", SLUG, "--claim-id", "claim-one"]);
    expect(adopted).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(adopted.stdout)).toMatchObject({ stage: "adopted", revision: 3 });
    expect(run(cwd, ["protocol", "adopt", "--slug", SLUG, "--claim-id", "claim-one"]))
      .toMatchObject({ exitCode: 0, stdout: adopted.stdout, stderr: "" });
    expect(workBytes(cwd)).toBe(before);

    const status = run(cwd, ["protocol", "status", "--slug", SLUG]);
    expect(status).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(status.stdout)).toMatchObject({
      schemaVersion: "gdm-protocol-status/v1",
      lifecycles: [{ claimId: "claim-one", stage: "adopted", stale: false }],
    });
  });

  test("receiver mismatch stale artifact forged observation and terminal transitions fail closed", () => {
    const cwd = repository();
    const artifact = `.gdm/${SLUG}/artifact.txt`;
    writeFileSync(join(cwd, artifact), "initial\n");
    writeFileSync(join(cwd, OUTPUT), "provider output\n");
    const handoff = offer(cwd, "guarded-offer", artifact);

    const wrongReceiver = run(cwd, claimArgs(handoff.eventId, "wrong-receiver", "writer", "claude"));
    expect(wrongReceiver.exitCode).toBe(4);
    expect(wrongReceiver.stderr).toContain("오류(receiver_mismatch)");
    const unsupported = claimArgs(handoff.eventId, "unsupported");
    unsupported[unsupported.indexOf("--capability-profile") + 1] = "write-capable-v1";
    expect(run(cwd, unsupported).stderr).toContain("오류(capability_unsupported)");

    const claimed = run(cwd, claimArgs(handoff.eventId));
    expect(claimed.exitCode).toBe(0);
    const bundle = JSON.parse(claimed.stdout) as Record<string, any>;
    expect(run(cwd, claimArgs(handoff.eventId, "second-claim")).stderr).toContain("오류(claim_conflict)");
    writeFileSync(join(cwd, OUTPUT), `${receiverAck(bundle)}\n`);

    writeFileSync(join(cwd, artifact), "changed\n");
    expect(run(cwd, finishArgs("claim-one")).stderr).toContain("오류(artifact_changed)");
    writeFileSync(join(cwd, artifact), "initial\n");

    const wrongProvider = finishArgs("claim-one");
    wrongProvider[wrongProvider.indexOf("--provider-target") + 1] = "codex";
    expect(run(cwd, wrongProvider).stderr).toContain("오류(receiver_mismatch)");
    const wrongModel = finishArgs("claim-one");
    wrongModel[wrongModel.indexOf("--model-requested") + 1] = "different-model";
    expect(run(cwd, wrongModel).stderr).toContain("오류(receiver_mismatch)");
    const punctuatedVersion = finishArgs("claim-one");
    punctuatedVersion[punctuatedVersion.indexOf("--executable-version") + 1] = "Claude Code/1.2.3+build.4";
    expect(run(cwd, punctuatedVersion)).toMatchObject({ exitCode: 0, stderr: "" });
    expect(run(cwd, claimArgs(handoff.eventId)).stderr).toContain("오류(receipt_transition)");
    expect(run(cwd, ["protocol", "recover", "--slug", SLUG, "--claim-id", "claim-one", "--reason", "late recovery"]).stderr)
      .toContain("오류(receipt_transition)");
  });

  test("runner version observation rejects multiline or credential-like text", () => {
    for (const [version, code] of [["version one\nversion two", "usage"], ["Bearer private-token", "privacy_rejected"]] as const) {
      const cwd = repository();
      const handoff = offer(cwd, `version-${code}`);
      const bundle = JSON.parse(run(cwd, claimArgs(handoff.eventId)).stdout) as Record<string, any>;
      writeFileSync(join(cwd, OUTPUT), `${receiverAck(bundle)}\n`);
      const args = finishArgs("claim-one");
      args[args.indexOf("--executable-version") + 1] = version;
      const result = run(cwd, args);
      expect(result.stderr).toContain(`오류(${code})`);
      expect(receiptEvents(cwd)).toHaveLength(1);
    }
  });

  test("automatic artifacts require bounded credential-free UTF-8 at offer and claim", () => {
    for (const [name, bytes, code, exitCode] of [
      ["encoding", Buffer.from([0xff, 0xfe]), "artifact_encoding_invalid", 3],
      ["credential", Buffer.from("sk-private-artifact-value\n"), "privacy_rejected", 5],
    ] as const) {
      const offeredCwd = repository();
      writeFileSync(join(offeredCwd, "artifact.txt"), bytes);
      const rejectedOffer = offerResult(offeredCwd, `offer-${name}`, "artifact.txt");
      expect(rejectedOffer.exitCode).toBe(exitCode);
      expect(rejectedOffer.stderr).toContain(`오류(${code})`);
      expect(allJournalEvents(offeredCwd).some((event) => event.event === "protocol_handoff")).toBe(false);

      const legacyCwd = repository();
      writeFileSync(join(legacyCwd, "artifact.txt"), bytes);
      const handoff = legacyHandoff(legacyCwd, `legacy-${name}`, "artifact.txt");
      const rejectedClaim = run(legacyCwd, claimArgs(handoff.eventId));
      expect(rejectedClaim.exitCode).toBe(exitCode);
      expect(rejectedClaim.stderr).toContain(`오류(${code})`);
      expect(receiptEvents(legacyCwd)).toHaveLength(0);
    }
  });

  test("automatic artifact and output byte caps fail before lifecycle authority changes", () => {
    const offeredCwd = repository();
    writeFileSync(join(offeredCwd, "large.txt"), Buffer.alloc(PROTOCOL_ARTIFACT_MAX_BYTES + 1, 0x61));
    const rejectedOffer = offerResult(offeredCwd, "large-offer", "large.txt");
    expect(rejectedOffer.exitCode).toBe(4);
    expect(rejectedOffer.stderr).toContain("오류(artifact_too_large)");
    expect(allJournalEvents(offeredCwd).some((event) => event.event === "protocol_handoff")).toBe(false);

    const legacyCwd = repository();
    writeFileSync(join(legacyCwd, "large.txt"), Buffer.alloc(PROTOCOL_ARTIFACT_MAX_BYTES + 1, 0x61));
    const legacy = legacyHandoff(legacyCwd, "large-legacy", "large.txt");
    const rejectedClaim = run(legacyCwd, claimArgs(legacy.eventId));
    expect(rejectedClaim.exitCode).toBe(4);
    expect(rejectedClaim.stderr).toContain("오류(artifact_too_large)");
    expect(receiptEvents(legacyCwd)).toHaveLength(0);

    const legacyRecordCwd = repository();
    writeFileSync(join(legacyRecordCwd, "large.txt"), "small\n");
    truncateSync(join(legacyRecordCwd, "large.txt"), PROTOCOL_LEGACY_ARTIFACT_MAX_BYTES + 1);
    const rejectedLegacyRecord = legacyHandoffResult(legacyRecordCwd, "bounded-legacy", "large.txt");
    expect(rejectedLegacyRecord.exitCode).toBe(4);
    expect(rejectedLegacyRecord.stderr).toContain("오류(artifact_too_large)");

    const legacyReadCwd = repository();
    writeFileSync(join(legacyReadCwd, "large.txt"), "small\n");
    const boundedLegacy = legacyHandoff(legacyReadCwd, "bounded-legacy-read", "large.txt");
    expect(run(legacyReadCwd, claimArgs(boundedLegacy.eventId))).toMatchObject({ exitCode: 0, stderr: "" });
    truncateSync(join(legacyReadCwd, "large.txt"), PROTOCOL_LEGACY_ARTIFACT_MAX_BYTES + 1);
    expect(run(legacyReadCwd, ["protocol", "export", "--slug", SLUG]).stderr)
      .toContain("오류(artifact_too_large)");
    expect(run(legacyReadCwd, ["protocol", "status", "--slug", SLUG]).stderr)
      .toContain("오류(artifact_too_large)");

    const outputCwd = repository();
    const handoff = offer(outputCwd, "large-output");
    expect(run(outputCwd, claimArgs(handoff.eventId))).toMatchObject({ exitCode: 0, stderr: "" });
    writeFileSync(join(outputCwd, OUTPUT), Buffer.alloc(PROTOCOL_OUTPUT_MAX_BYTES + 1, 0x61));
    const rejectedFinish = run(outputCwd, finishArgs("claim-one", "70"));
    expect(rejectedFinish.exitCode).toBe(4);
    expect(rejectedFinish.stderr).toContain("오류(output_too_large)");
    expect(receiptEvents(outputCwd)).toHaveLength(1);
  });

  test("provider executable change is a failed observed exit and exact replay is idempotent", () => {
    const cwd = repository();
    writeFileSync(join(cwd, OUTPUT), "provider output before integrity failure\n");
    const handoff = offer(cwd, "executable-change");
    expect(run(cwd, claimArgs(handoff.eventId))).toMatchObject({ exitCode: 0, stderr: "" });
    const args = finishArgs("claim-one", "70");
    args[args.indexOf("--failure-code") + 1] = "provider_executable_changed";

    const failed = run(cwd, args);
    expect(failed.exitCode).toBe(4);
    expect(failed.stderr).toContain("오류(provider_executable_changed)");
    expect(receiptEvents(cwd).at(-1)).toMatchObject({
      stage: "exited",
      runnerObserved: { status: "failed", exitCode: 70, failureCode: "provider_executable_changed" },
    });
    const length = receiptEvents(cwd).length;
    expect(run(cwd, args).stderr).toContain("오류(provider_executable_changed)");
    expect(receiptEvents(cwd)).toHaveLength(length);

    const invalidCwd = repository();
    writeFileSync(join(invalidCwd, OUTPUT), "provider output\n");
    const invalidHandoff = offer(invalidCwd, "invalid-executable-change");
    const bundle = JSON.parse(run(invalidCwd, claimArgs(invalidHandoff.eventId)).stdout) as Record<string, any>;
    writeFileSync(join(invalidCwd, OUTPUT), `${receiverAck(bundle)}\n`);
    const invalidArgs = finishArgs("claim-one");
    invalidArgs.push("--failure-code", "provider_executable_changed");
    const invalid = run(invalidCwd, invalidArgs);
    expect(invalid.exitCode).toBe(3);
    expect(invalid.stderr).toContain("오류(runner_observation_invalid)");
    expect(receiptEvents(invalidCwd)).toHaveLength(1);
  });

  test("receiver ACK is mandatory and blocked is persisted without becoming a successful runner result", () => {
    for (const invalid of ["empty", "forged-claim", "forged-hash"] as const) {
      const cwd = repository();
      writeFileSync(join(cwd, OUTPUT), "");
      const handoff = offer(cwd, `ack-${invalid}`);
      const claimed = run(cwd, claimArgs(handoff.eventId));
      const bundle = JSON.parse(claimed.stdout) as Record<string, any>;
      if (invalid !== "empty") {
        const forged = {
          ...bundle,
          ...(invalid === "forged-claim" ? { claimId: "another-claim" } : { bundleSha256: "0".repeat(64) }),
        };
        writeFileSync(join(cwd, OUTPUT), `${receiverAck(forged)}\n`);
      }
      const before = receiptEvents(cwd).length;
      const rejected = run(cwd, finishArgs("claim-one"));
      expect(rejected.exitCode).toBe(3);
      expect(rejected.stderr).toContain("오류(receiver_ack_invalid)");
      expect(receiptEvents(cwd).slice(before)).toEqual([
        expect.objectContaining({
          stage: "exited",
          runnerObserved: expect.objectContaining({
            status: "failed",
            exitCode: 0,
            failureCode: "receiver_ack_invalid",
          }),
        }),
      ]);
      const replayLength = receiptEvents(cwd).length;
      expect(run(cwd, finishArgs("claim-one")).stderr).toContain("오류(receiver_ack_invalid)");
      expect(receiptEvents(cwd)).toHaveLength(replayLength);
    }

    const cwd = repository();
    writeFileSync(join(cwd, OUTPUT), "");
    const handoff = offer(cwd, "blocked-ack");
    const bundle = JSON.parse(run(cwd, claimArgs(handoff.eventId)).stdout) as Record<string, any>;
    writeFileSync(join(cwd, OUTPUT), `${receiverAck(bundle, "blocked")}\n`);
    const blocked = run(cwd, finishArgs("claim-one"));
    expect(blocked.exitCode).toBe(4);
    expect(blocked.stderr).toContain("오류(receiver_blocked)");
    expect(receiptEvents(cwd).at(-1)).toMatchObject({
      stage: "exited",
      runnerObserved: { status: "blocked", exitCode: 0 },
    });
    expect(run(cwd, ["protocol", "adopt", "--slug", SLUG, "--claim-id", "claim-one"]).stderr)
      .toContain("오류(receipt_transition)");
  });

  test("recover abandons only claimed work and permits a new claim", () => {
    const cwd = repository();
    const handoff = offer(cwd, "recoverable-offer");
    const longClaimId = "c".repeat(64);
    expect(run(cwd, claimArgs(handoff.eventId, longClaimId))).toMatchObject({ exitCode: 0, stderr: "" });
    expect(receiptEvents(cwd).at(-1)?.receiptId.length).toBeLessThanOrEqual(64);
    const recovered = run(cwd, [
      "protocol", "recover", "--slug", SLUG, "--claim-id", longClaimId, "--reason", "receiver unavailable",
    ]);
    expect(recovered).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toMatchObject({ stage: "abandoned", reason: "receiver unavailable" });
    expect(run(cwd, [
      "protocol", "recover", "--slug", SLUG, "--claim-id", longClaimId, "--reason", "receiver unavailable",
    ])).toMatchObject({ exitCode: 0, stdout: recovered.stdout, stderr: "" });
    expect(run(cwd, claimArgs(handoff.eventId, "replacement-claim"))).toMatchObject({ exitCode: 0, stderr: "" });
  });

  test("recover can abandon a stale orphaned claim", () => {
    const cwd = repository();
    const handoff = offer(cwd, "stale-recovery");
    expect(run(cwd, claimArgs(handoff.eventId))).toMatchObject({ exitCode: 0, stderr: "" });
    writeFileSync(join(cwd, "source.txt"), "changed after claim\n");

    const recovered = run(cwd, [
      "protocol", "recover", "--slug", SLUG, "--claim-id", "claim-one", "--reason", "stale claim cleanup",
    ]);
    expect(recovered).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toMatchObject({ stage: "abandoned" });
  });

  test("persisted receipts must bind an existing same-work handoff receiver and time", () => {
    const corruptions: readonly ((receipt: Record<string, any>, work: Record<string, any>) => void)[] = [
      (receipt) => {
        receipt.handoffEventId = `h-${"0".repeat(16)}`;
      },
      (receipt) => {
        receipt.receiver.role = "different-role";
      },
      (receipt, work) => {
        receipt.ts = new Date(Date.parse(work.createdAt) - 1).toISOString();
      },
      (receipt) => {
        receipt.event = "protocol_receipt_damaged";
      },
    ];
    for (const corrupt of corruptions) {
      const cwd = repository();
      const handoff = offer(cwd, "receipt-binding");
      expect(run(cwd, claimArgs(handoff.eventId))).toMatchObject({ exitCode: 0, stderr: "" });
      const work = JSON.parse(readFileSync(join(cwd, ".gdm", SLUG, "checks.json"), "utf8")) as Record<string, any>;
      const events = allJournalEvents(cwd);
      const receipt = events.find((event) => event.event === "protocol_receipt")!;
      corrupt(receipt, work);
      writeFileSync(
        join(cwd, ".gdm", SLUG, "journal.jsonl"),
        events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );

      const result = run(cwd, ["protocol", "status", "--slug", SLUG]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("오류(state_corrupt)");
    }
  });
});
