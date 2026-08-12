import { defaultContract } from "../cli/src/contract.ts";
import {
  buildWorkSnapshot,
  recordProtocolHandoff,
} from "../cli/src/protocol.ts";
import { addCheck, initWork } from "../cli/src/state.ts";
import type { SourceFingerprint } from "../cli/src/source-fingerprint.ts";

const CREATED_AT = "2026-08-12T00:00:00.000Z";
const BEFORE_CREATION = "2026-08-11T23:59:59.000Z";
const SOURCE: SourceFingerprint = {
  schemaVersion: 1,
  sha256: "a".repeat(64),
  fileCount: 1,
};

let work = initWork(
  "integrity-probe",
  "Work Protocol integrity probe",
  CREATED_AT,
  false,
  defaultContract(),
);
({ work } = addCheck(work, {
  desc: "probe check",
  cmd: "true",
  expect: "exit 0",
  kind: "edge",
}));

const request = {
  handoffId: "integrity-probe-v1",
  fromRole: "producer",
  toRole: "receiver",
  intent: "integrity boundary probe",
} as const;
const recorded = recordProtocolHandoff(process.cwd(), work, [], SOURCE, request, CREATED_AT).event;

let preCreationFirstEventAccepted = false;
try {
  buildWorkSnapshot(work, SOURCE, [{ ...recorded, ts: BEFORE_CREATION }]);
  preCreationFirstEventAccepted = true;
} catch {
  preCreationFirstEventAccepted = false;
}

const changedSource: SourceFingerprint = {
  ...SOURCE,
  sha256: "b".repeat(64),
};
const sourceOnly = buildWorkSnapshot(work, changedSource, [recorded]).latestHandoff;
if (sourceOnly === null || JSON.stringify(sourceOnly.staleReasons) !== JSON.stringify(["source_changed"])) {
  throw new Error("source-only stale classification was not isolated");
}

console.log(JSON.stringify({
  schemaVersion: "gdm-work-protocol-integrity-probe/v1",
  preCreationFirstEventAccepted,
  sourceOnlyStaleReasons: sourceOnly.staleReasons,
}, null, 2));
