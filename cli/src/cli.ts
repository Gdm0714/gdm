#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { cmdDevice } from "./device-cli.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  prepareFailure,
  prepareRetry,
  recordFailure,
  recordRetry,
} from "./attempt.ts";
import { latestAttemptStates, readAttemptEvents } from "./attempt-journal.ts";
import { parseBriefChecks } from "./brief-checks.ts";
import { readContainedFile } from "./contained-file.ts";
import { auditIntegrityProblems, captureWorkspaceFingerprint } from "./audit-integrity.ts";
import { ensureFlags, hasFlag, readFlag, readFlags } from "./cli-args.ts";
import {
  addConstraints,
  amendScope,
  assertCommitAllowed,
  createContract,
  parseRiskLevel,
  parseCommitState,
  parseConstraints,
  parseVerificationMode,
  opaqueId,
  safeText,
  transitionCommit,
} from "./contract.ts";
import { activateHabit, cmdHabit } from "./habit-cli.ts";
import { scanHabitArgs } from "./habit-cli-args.ts";
import { habitOverview } from "./habit-summary.ts";
import {
  addCheck,
  assertPassable,
  checkKind,
  checksHash,
  closeWork,
  completionBlockers,
  editCheck,
  findCheck,
  GdmError,
  initWork,
  parseCheckKind,
  passCheck,
  provenCount,
  recordAudit,
  recordRedEvidence,
  recordVerificationPlanSourceFingerprint,
  refreshEvidence,
  revertChecks,
  verificationPlanFingerprint,
} from "./state.ts";
import {
  appendJournal,
  checkHow,
  checkMark,
  journalTail,
  listWorks,
  loadPresets,
  readJournal,
  repairTrailingNulWork,
  resolveWork,
  resolveWorkForRead,
  savePresets,
  saveWork,
  workDir,
  workExists,
  writeWorkOutput,
} from "./store.ts";
import type { Check, Evidence, Work } from "./types.ts";
import { describeScopeProblems, workspaceScopeProblems } from "./workflow-gates.ts";
import { VERSION } from "./version.ts";
import { acquireRepositoryLock } from "./repository-lock.ts";
import { captureSourceFingerprint } from "./source-fingerprint.ts";
import { saveVerificationPlanSourceFingerprint } from "./work-source-fingerprint.ts";
import { cmdDelivery } from "./delivery-cli.ts";
import { cmdProtocol } from "./protocol-cli.ts";
import { cmdContext } from "./context-nav-command.ts";
import { codexAgentLimitDoctorLines } from "./codex-agent-limit.ts";
import { AgentCliError, cmdAgent } from "./agent-cli.ts";
import {
  AgentHooksConfigError,
  codexAgentHookDoctorLines,
  resolveCodexHome,
} from "./codex-agent-hooks-config.ts";

const MIN_CMD_TIMEOUT_MS = 100;
const MAX_CMD_TIMEOUT_MS = 3_600_000;

function commandTimeoutMs(): number | undefined {
  const raw = process.env.GDM_COMMAND_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  if (!/^\d+$/u.test(raw)) {
    throw new GdmError("GDM_COMMAND_TIMEOUT_MS는 밀리초 단위 정수여야 합니다", "usage");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_CMD_TIMEOUT_MS || parsed > MAX_CMD_TIMEOUT_MS) {
    throw new GdmError(
      `GDM_COMMAND_TIMEOUT_MS는 ${MIN_CMD_TIMEOUT_MS}~${MAX_CMD_TIMEOUT_MS} 범위여야 합니다`,
      "usage",
    );
  }
  return parsed;
}

const USAGE = `gdm ${VERSION} — 작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우

흐름: 약속 → 증명 → 관찰 → 습관 → 비교

  gdm device <list|doctor|build|install|test|capture> [--config <JSON>] [--case <장면>] [--json]

사용법:
  gdm plan init --slug <슬러그> (--brief <설명> | --brief-file <파일>) [--audit] [--risk <low|medium|high>] [--verification <deterministic|inspectable|opaque>] [--simplify] (--require <약속> | --forbid <금지>)...
                [--assume <가정>]... [--uncertain <불확실성>]... [--allow-path <경로>]... [--forbid-path <경로>]... [--stop-if <중단 조건>]...
                [--bottleneck <병목> --desired-outcome <원하는 결과> --baseline <기준값> --target <목표값> --unit <단위> --intervene-if <사람 개입 조건>]  # 선언한 outcome (GDM 미측정), 여섯 값은 전부 함께 사용
  gdm plan contract [--slug <슬러그>] (--require <약속> | --forbid <금지>)...
  gdm plan contract [--slug <슬러그>] (--allow-path <경로> | --forbid-path <경로> | --remove-allow-path <경로> | --remove-forbid-path <경로>)... --reason <사유>
  gdm plan contract [--slug <슬러그>] --commit <forbidden|explicitly-approved> --reason <사유>
  gdm plan contract [--slug <슬러그>] --check-commit
  gdm plan contract --slug <슬러그> --activate-habit <habit-id>@<version>
  gdm attempt fail --slug <슬러그> --attempt-id <id> (--command <id> | --capability <id>) --target <id> --error-code <id> --hypothesis <가설>
  gdm attempt retry --slug <슬러그> --attempt-id <id> --fingerprint <id> [--changed <종류> --evidence <파일>]
  gdm habit observe --pattern <id> --taxonomy <유형> --source-token <id> --source-group <id> --source-kind <incident|principle>
  gdm habit import --file <observation-jsonl>
  gdm habit propose --pattern <id> --statement <규칙> --source-event <event-id> --source-event <event-id> [--habit <habit-id>]
  gdm habit adopt <habit-id>@<version> --rule-ref <상대 파일> --reason <사유>
  gdm habit retire <habit-id>@<version> --reason <사유>
  gdm habit evaluate <habit-id>@<version> --work <슬러그> --outcome <ineligible|skipped|clean|recurred> [--correct <event-id> --reason <사유>]
  gdm habit status [--json]
  gdm habit harvest [--json]
  gdm plan add  --desc <항목> --cmd <검증 명령> --expect <기대> [--kind <regression|behavior|edge|static>] [--slug <슬러그>]
  gdm plan add  --desc <항목> --expect <기대> --manual [--expert] [--slug <슬러그>]
  gdm plan add  --from-brief [--dry-run] [--slug <슬러그>]   # brief의 "## 검증 항목" 초안 일괄 등록
  gdm plan list [--json] [--slug <슬러그>]
  gdm plan edit --check <id> [--desc ..] [--cmd ..] [--expect ..] [--kind ..] --reason <사유> [--slug <슬러그>]
  gdm plan source --fingerprint <sha256> [--slug <슬러그>]
  gdm pass <id> --red [--note <메모>] [--slug <슬러그>] [--expected-plan-fingerprint <sha256>]     # regression 항목의 수정 전 실패 증거
  gdm pass <id> [--note <메모>] [--slug <슬러그>] [--expected-plan-fingerprint <sha256>]           # 자동 항목: cmd를 직접 실행해 판정
  gdm pass <id> --manual --observed <확인 기록 파일> [--reviewer <검토자>] [...]   # 수동 항목
  gdm recheck [--check <id>] [--slug <슬러그>] [--expected-plan-fingerprint <sha256>]              # 통과한 자동 항목 재실행 (회귀 검출)
  gdm audit brief [--json] [--slug <슬러그>]                # 검수자에게 줄 브리핑 패키지 출력
  gdm audit verdict (--pass | --fail) --report <검수보고 파일> --implementation-model <모델> --audit-model <모델> [--slug <슬러그>]
  gdm done [--slug <슬러그>] [--expected-plan-fingerprint <sha256>]
  gdm protocol export [--slug <슬러그>] [--expected-plan-fingerprint <sha256>] [--expected-state-fingerprint <sha256>] [--expected-source-fingerprint <sha256>]
  gdm protocol handoff --slug <슬러그> --handoff-id <id> --from-role <id> --to-role <id> --intent <설명> [--from-provider <id>] [--to-provider <id>] [--artifact <저장소 상대 파일>] [--expected-plan-fingerprint <sha256>] [--expected-state-fingerprint <sha256>] [--expected-source-fingerprint <sha256>]
  gdm protocol offer --slug <슬러그> --handoff-id <id> --from-role <id> --to-role <id> --intent <설명> --expected-plan-fingerprint <sha256> --expected-state-fingerprint <sha256> --expected-source-fingerprint <sha256> [--from-provider <id>] [--to-provider <id>] [--artifact <저장소 상대 파일>]
  gdm protocol claim --slug <슬러그> --handoff-event-id <id> --claim-id <id> --receiver-role <id> [--receiver-provider <id>] --capability-profile gdm-read-only-specialist/v1 [--model-requested <id>] [--model-view]
  gdm protocol finish --slug <슬러그> --claim-id <id> --exit-code <0..255> --output-artifact <저장소 상대 파일> --provider-target <id> --adapter-version <id> --executable <절대경로> --executable-sha256 <sha256> --executable-version <설명> --argv-policy-id <id> [--model-requested <id>] [--failure-code <id>]
  gdm protocol adopt --slug <슬러그> --claim-id <id>
  gdm protocol recover --slug <슬러그> --claim-id <id> --reason <사유>
  gdm protocol status [--slug <슬러그>]
  gdm workspace fingerprint --json
  gdm context query                                      # trusted Git root의 bounded Context Pack JSON을 stdin request로 조회
  gdm context status                                     # one-shot provider capability 조회
  gdm status [--json] [--checks]                            # 현재 디렉토리 전체 작업 현황 (--checks: 항목 상세)
  gdm resume [--json] [--slug <슬러그>]
  gdm retro [--all] [--json] [--slug <슬러그>]              # 회고 (--all: 전체 작업 횡단 + 개선 제안)
  gdm feedback --value good [--reason <사유>] [--source <id>] [--slug <슬러그>] [--json]
  gdm feedback --value bad --reason <사유> [--source <id>] [--slug <슬러그>] [--json]
  gdm miss --desc <내용> [--type <유형>] [--check <id>] [--slug <슬러그>]  # 게이트 통과 후 발견된 결함 기록
  gdm repair state --slug <슬러그> --trailing-nul               # 끝의 NUL 손상만 명시적으로 복구
  gdm delivery prepare --slug <슬러그> --issue <id> --branch <브랜치> --head <sha>
  gdm delivery pr --slug <슬러그> --number <id> --head <sha>
  gdm delivery ci --slug <슬러그> --status <passed|failed> --head <sha> --run <id>
  gdm delivery approve-merge --slug <슬러그> --head <sha> --reason <승인 근거>
  gdm delivery check-merge --slug <슬러그> --head <sha>
  gdm delivery merged --slug <슬러그> --head <sha> --merge-sha <sha>
  gdm agent hook-install --binary <절대경로> [--dry-run] [--json] # 기존 hooks.json을 보존해 런타임 게이트 설치
  gdm agent hook-status [--json]                            # 설치·원장 상태 조회
  gdm agent hook [--handler-id gdm-agent-gate-v1]           # Codex lifecycle hook 내부 진입점
  gdm preset set <이름> <명령> | list | rm <이름>            # 프로젝트 표준 명령 등록
  gdm doctor

프리셋: plan add/edit의 --cmd에 "@이름"을 쓰면 등록된 명령으로 치환됩니다
  (예: gdm preset set test "./gradlew test" → gdm plan add --cmd @test ...)

규칙:
  - 자동 항목의 증거는 gdm이 직접 만듭니다: pass가 cmd를 실행해 출력을 저장·해시하고,
    exit 0일 때만 통과시킵니다 (cmd는 기대가 충족될 때만 성공하도록 작성하세요)
  - done은 모든 항목 통과 + 증거 파일 현존·해시 일치를 재검증한 뒤에만 성공합니다
  - 상태 파일(.gdm/)은 gdm 명령으로만 수정하세요
`;

function now(): string {
  return new Date().toISOString();
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertExpectedPlanFingerprint(work: Work, expected: string | undefined): void {
  if (expected === undefined) return;
  if (!/^[0-9a-f]{64}$/u.test(expected)) {
    throw new GdmError("--expected-plan-fingerprint는 소문자 64자리 SHA-256이어야 합니다", "usage");
  }
  const actual = verificationPlanFingerprint(work);
  if (actual !== expected) {
    throw new GdmError(
      `검증 계획 지문이 일치하지 않습니다 (expected ${expected}, actual ${actual})`,
      "plan_fingerprint_mismatch",
    );
  }
}

function tailLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

function journalDenied(
  cwd: string,
  slug: string,
  action: string,
  error: GdmError,
  ts: string,
  extra: Record<string, unknown> = {},
): void {
  appendJournal(cwd, slug, { ts, event: "denied", action, code: error.code, message: error.message, ...extra });
}

function checkLine(work: Work): string[] {
  return work.checks.map((c) => {
    const detail =
      c.status === "proven" ? `증거: ${c.evidence?.observed}` : `재현: ${checkHow(c)} → 기대: ${c.expect}`;
    return `  ${checkMark(c)} ${c.id} ${c.desc} [${checkKind(c)}] — ${detail}`;
  });
}

function workHeader(work: Work): string {
  const { proven, total } = provenCount(work);
  return `# ${work.slug} — ${work.done ? "완료" : "진행 중"} (${proven}/${total})`;
}

function contractLine(work: Work): string {
  return `계약: 필수 ${work.contract.required.length} · 금지 ${work.contract.forbidden.length} · 위험 ${work.contract.risk ?? "low"} · 검증 ${work.contract.verification ?? "deterministic"} · 커밋 ${work.contract.commit}`;
}

function declaredOutcomeLines(work: Work): string[] {
  const outcome = work.contract.outcome;
  if (outcome === undefined) return [];
  return [
    `병목: ${outcome.bottleneck}`,
    `원하는 결과: ${outcome.desiredOutcome}`,
    `baseline: ${outcome.baseline}`,
    `target: ${outcome.target}`,
    `unit: ${outcome.unit}`,
    `사람 개입 조건: ${outcome.interveneIf}`,
  ];
}

function cmdPlanInit(cwd: string, args: string[]): void {
  ensureFlags(
    args,
    [
      "slug", "brief", "brief-file", "require", "forbid", "assume", "uncertain", "allow-path",
      "forbid-path", "stop-if", "risk", "verification", "bottleneck", "desired-outcome", "baseline",
      "target", "unit", "intervene-if",
    ],
    ["audit", "simplify"],
  );
  const ts = now();
  const slug = readFlag(args, "slug");
  if (!slug) throw new GdmError("--slug가 필요합니다", "usage");
  const outcomeValues = {
    bottleneck: readFlag(args, "bottleneck"),
    desiredOutcome: readFlag(args, "desired-outcome"),
    baseline: readFlag(args, "baseline"),
    target: readFlag(args, "target"),
    unit: readFlag(args, "unit"),
    interveneIf: readFlag(args, "intervene-if"),
  };
  const outcomeCount = Object.values(outcomeValues).filter((value) => value !== undefined).length;
  if (outcomeCount !== 0 && outcomeCount !== 6) {
    throw new GdmError(
      "outcome 여섯 플래그(--bottleneck, --desired-outcome, --baseline, --target, --unit, --intervene-if)는 전부 함께 사용해야 합니다",
      "usage",
    );
  }
  const outcome = outcomeCount === 0
    ? undefined
    : {
        bottleneck: outcomeValues.bottleneck!,
        desiredOutcome: outcomeValues.desiredOutcome!,
        baseline: outcomeValues.baseline!,
        target: outcomeValues.target!,
        unit: outcomeValues.unit!,
        interveneIf: outcomeValues.interveneIf!,
      };
  const constraints = parseConstraints(readFlags(args, "require"), readFlags(args, "forbid"));
  const risk = parseRiskLevel(readFlag(args, "risk"));
  const verification = parseVerificationMode(readFlag(args, "verification"));
  const allowedPaths = readFlags(args, "allow-path");
  const contract = createContract(constraints, {
    assumptions: readFlags(args, "assume"),
    uncertainties: readFlags(args, "uncertain"),
    allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined,
    forbiddenPaths: readFlags(args, "forbid-path"),
    stopConditions: readFlags(args, "stop-if"),
    risk,
    verification,
    simplificationRequired: hasFlag(args, "simplify"),
    outcome,
  });
  const briefFile = readFlag(args, "brief-file");
  let brief: string | undefined;
  if (briefFile) {
    const path = resolve(cwd, briefFile);
    if (!existsSync(path)) throw new GdmError(`brief 파일이 없습니다: ${briefFile}`, "usage");
    brief = readFileSync(path, "utf8");
  } else {
    brief = readFlag(args, "brief");
  }
  if (!brief) throw new GdmError("--brief 또는 --brief-file이 필요합니다", "usage");
  if (workExists(cwd, slug)) {
    throw new GdmError(`작업 "${slug}"가 이미 있습니다. 이어서 하려면 gdm resume --slug ${slug}`, "work_exists");
  }
  const auditRequired = hasFlag(args, "audit") || risk === "high";
  const baseline = captureWorkspaceFingerprint(cwd);
  const work = initWork(slug, brief, ts, auditRequired, contract, baseline);
  appendJournal(cwd, slug, { ts, event: "plan.init", brief: work.brief, auditRequired, contract, baseline });
  saveWork(cwd, work);
  console.log(`작업 시작: ${slug}${auditRequired ? " (검수 필수)" : ""}`);
  if (risk === "high" && !hasFlag(args, "audit")) console.log("high risk 정책으로 독립 검수를 자동 요구합니다");
  console.log(`다음: gdm plan add --desc <항목> --cmd <검증 명령> --expect <기대>`);
}

function cmdPlanContract(cwd: string, args: string[]): void {
  scanHabitArgs(args);
  ensureFlags(
    args,
    [
      "slug", "require", "forbid", "commit", "reason", "activate-habit", "allow-path", "forbid-path",
      "remove-allow-path", "remove-forbid-path",
    ],
    ["check-commit"],
  );
  const requiredValues = readFlags(args, "require");
  const forbiddenValues = readFlags(args, "forbid");
  const hasConstraints = requiredValues.length > 0 || forbiddenValues.length > 0;
  const checkCommit = hasFlag(args, "check-commit");
  const commitValue = readFlag(args, "commit");
  const activationValues = readFlags(args, "activate-habit");
  const activationValue = activationValues[0];
  const reasonValue = readFlag(args, "reason");
  const scopeInput = {
    addAllowed: readFlags(args, "allow-path"),
    addForbidden: readFlags(args, "forbid-path"),
    removeAllowed: readFlags(args, "remove-allow-path"),
    removeForbidden: readFlags(args, "remove-forbid-path"),
  };
  const hasScope = Object.values(scopeInput).some((values) => values.length > 0);
  const modes = Number(hasConstraints) + Number(hasScope) + Number(checkCommit) + Number(commitValue !== undefined) + Number(activationValue !== undefined);
  if (
    modes !== 1 ||
    activationValues.length > 1 ||
    (checkCommit && reasonValue !== undefined) ||
    (hasConstraints && reasonValue !== undefined) ||
    (activationValue !== undefined && reasonValue !== undefined)
  ) {
    throw new GdmError("plan contract 동작을 정확히 하나만 지정하세요", "usage");
  }
  const slug = readFlag(args, "slug");
  if (activationValue !== undefined) {
    if (slug === undefined) throw new GdmError("habit 활성화에는 --slug가 필요합니다", "usage");
    activateHabit(cwd, slug, activationValue, now());
    return;
  }
  if (checkCommit) {
    const work = resolveWorkForRead(cwd, slug);
    assertCommitAllowed(work);
    console.log(`커밋 상태: ${work.contract.commit}`);
    return;
  }
  if (hasConstraints) {
    const constraints = parseConstraints(requiredValues, forbiddenValues);
    const work = resolveWork(cwd, slug);
    const result = addConstraints(work, constraints);
    if (!result.changed) {
      console.log(`계약 변경 없음: ${work.slug}`);
      return;
    }
    const ts = now();
    appendJournal(cwd, work.slug, {
      ts,
      event: "contract.constraints",
      required: result.addedRequired,
      forbidden: result.addedForbidden,
    });
    saveWork(cwd, result.work);
    console.log(`계약 갱신: ${work.slug}`);
    return;
  }
  if (hasScope) {
    if (reasonValue === undefined) throw new GdmError("범위 변경에는 --reason이 필요합니다", "reason_required");
    const work = resolveWork(cwd, slug);
    const ts = now();
    const result = amendScope(work, scopeInput, reasonValue, ts);
    appendJournal(cwd, work.slug, { ts, event: "contract.scope", ...result.amendment });
    saveWork(cwd, result.work);
    console.log(`범위 계약 갱신: ${work.slug} — ${result.amendment.reason}`);
    return;
  }
  if (commitValue === undefined || reasonValue === undefined) {
    throw new GdmError("커밋 상태 전환에는 --commit과 --reason이 필요합니다", "usage");
  }
  const target = parseCommitState(commitValue);
  const reason = safeText(reasonValue, "reason");
  const work = resolveWorkForRead(cwd, slug);
  const result = transitionCommit(work, target, reason, now());
  if (!result.changed || result.transition === undefined) {
    console.log(`커밋 상태 변경 없음: ${work.contract.commit}`);
    return;
  }
  appendJournal(cwd, work.slug, { event: "contract.commit", ts: result.transition.at, ...result.transition });
  saveWork(cwd, result.work);
  console.log(`커밋 상태: ${result.transition.from} → ${result.transition.to}`);
}

function cmdPlanSource(cwd: string, args: string[]): void {
  ensureFlags(args, ["fingerprint", "slug"]);
  const work = resolveWork(cwd, readFlag(args, "slug"));
  const fingerprint = readFlag(args, "fingerprint");
  if (fingerprint === undefined) throw new GdmError("--fingerprint가 필요합니다", "usage");
  const next = recordVerificationPlanSourceFingerprint(work, fingerprint);
  saveVerificationPlanSourceFingerprint(cwd, next.slug, fingerprint);
  console.log(`source fingerprint 기록됨: ${fingerprint}`);
}

function cmdAttemptFail(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug", "attempt-id", "command", "capability", "target", "error-code", "hypothesis"]);
  const command = readFlag(args, "command");
  const capability = readFlag(args, "capability");
  if ((command === undefined) === (capability === undefined)) {
    throw new GdmError("--command 또는 --capability 중 정확히 하나가 필요합니다", "usage");
  }
  const attemptId = readFlag(args, "attempt-id");
  const target = readFlag(args, "target");
  const errorCode = readFlag(args, "error-code");
  const hypothesis = readFlag(args, "hypothesis");
  if (attemptId === undefined || target === undefined || errorCode === undefined || hypothesis === undefined) {
    throw new GdmError("attempt fail 필수 필드가 누락됐습니다", "usage");
  }
  const sourceKind = command === undefined ? "capability" : "command";
  const input = prepareFailure({
    attemptId,
    sourceKind,
    sourceId: command ?? capability ?? "",
    target,
    errorCode,
    hypothesis,
  });
  const work = resolveWork(cwd, readFlag(args, "slug"));
  if (work.done) throw new GdmError("완료된 작업에는 실패 시도를 추가할 수 없습니다", "attempt_transition");
  const events = readAttemptEvents(readJournal(cwd, work.slug));
  const result = recordFailure(events, input, now());
  if (result.changed) appendJournal(cwd, work.slug, result.event);
  console.log(`${result.event.fingerprint} · epoch ${result.event.epoch} · ${result.event.decision}`);
}

function cmdAttemptRetry(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug", "attempt-id", "fingerprint", "changed", "evidence"]);
  const attemptId = readFlag(args, "attempt-id");
  const fingerprint = readFlag(args, "fingerprint");
  if (attemptId === undefined || fingerprint === undefined) {
    throw new GdmError("attempt retry 필수 필드가 누락됐습니다", "usage");
  }
  const input = prepareRetry({
    attemptId,
    fingerprint,
    changed: readFlag(args, "changed"),
    evidence: readFlag(args, "evidence"),
  });
  const work = resolveWork(cwd, readFlag(args, "slug"));
  if (work.done) throw new GdmError("완료된 작업에는 재시도를 추가할 수 없습니다", "attempt_transition");
  const events = readAttemptEvents(readJournal(cwd, work.slug));
  const result = recordRetry(cwd, events, input, now());
  if (result.changed) appendJournal(cwd, work.slug, result.event);
  console.log(`${result.event.fingerprint} · epoch ${result.event.epoch} · ${result.event.decision}`);
}

function cmdAttempt(cwd: string, args: string[]): void {
  const [sub, ...attemptArgs] = args;
  if (sub === "fail") cmdAttemptFail(cwd, attemptArgs);
  else if (sub === "retry") cmdAttemptRetry(cwd, attemptArgs);
  else throw new GdmError("attempt는 fail 또는 retry를 사용하세요", "usage");
}

function resolveCmd(cwd: string, cmd: string | undefined): string | undefined {
  if (!cmd?.startsWith("@")) return cmd;
  const name = cmd.slice(1);
  const presets = loadPresets(cwd);
  const resolved = presets[name];
  if (!resolved) {
    const known = Object.keys(presets).join(", ") || "없음";
    throw new GdmError(`프리셋 "@${name}"이 없습니다 (등록된 프리셋: ${known})`, "preset_not_found");
  }
  return resolved;
}

function cmdPlanAddFromBrief(cwd: string, args: string[]): void {
  if (
    readFlag(args, "desc") || readFlag(args, "cmd") || readFlag(args, "expect") || readFlag(args, "kind") ||
    hasFlag(args, "manual") || hasFlag(args, "expert")
  ) {
    throw new GdmError("--from-brief는 개별 항목 플래그와 함께 쓸 수 없습니다", "usage");
  }
  const ts = now();
  let work = resolveWork(cwd, readFlag(args, "slug"));
  const inputs = parseBriefChecks(work.brief);
  const added: Check[] = [];
  for (const input of inputs) {
    const result = addCheck(work, input);
    work = result.work;
    added.push(result.check);
  }
  const dryRun = hasFlag(args, "dry-run");
  for (const check of added) {
    console.log(`  ${dryRun ? "·" : "+"} ${check.id} ${check.desc}${check.manual ? " (manual)" : ""}`);
  }
  if (dryRun) {
    console.log(`dry-run: ${added.length}개 파싱됨 — 등록하려면 --dry-run 없이 다시 실행하세요`);
    return;
  }
  for (const check of added) {
    appendJournal(cwd, work.slug, {
      ts,
      event: "plan.add",
      check: check.id,
      desc: check.desc,
      cmd: check.cmd,
      expect: check.expect,
      manual: check.manual,
      kind: check.kind,
      expert: check.expert,
      source: "brief",
    });
  }
  saveWork(cwd, work);
  console.log(`brief에서 ${added.length}개 항목 등록 (총 ${work.checks.length}개)`);
}

function cmdPlanAdd(cwd: string, args: string[]): void {
  ensureFlags(args, ["desc", "cmd", "expect", "kind", "slug"], ["manual", "expert", "from-brief", "dry-run"]);
  if (hasFlag(args, "from-brief")) {
    cmdPlanAddFromBrief(cwd, args);
    return;
  }
  if (hasFlag(args, "dry-run")) {
    throw new GdmError("--dry-run은 --from-brief와 함께만 사용합니다", "usage");
  }
  const ts = now();
  const work = resolveWork(cwd, readFlag(args, "slug"));
  const { work: next, check } = addCheck(work, {
    desc: readFlag(args, "desc") ?? "",
    cmd: resolveCmd(cwd, readFlag(args, "cmd")),
    expect: readFlag(args, "expect"),
    manual: hasFlag(args, "manual"),
    kind: parseCheckKind(readFlag(args, "kind")),
    expert: hasFlag(args, "expert"),
  });
  appendJournal(cwd, work.slug, {
    ts,
    event: "plan.add",
    check: check.id,
    desc: check.desc,
    cmd: check.cmd,
    expect: check.expect,
    manual: check.manual,
    kind: check.kind,
    expert: check.expert,
  });
  saveWork(cwd, next);
  console.log(`${check.id} 추가됨 (총 ${next.checks.length}개)`);
}

function cmdPlanList(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug"], ["json"]);
  const work = resolveWorkForRead(cwd, readFlag(args, "slug"));
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify(work, null, 2));
    return;
  }
  console.log(workHeader(work));
  for (const line of checkLine(work)) console.log(line);
}

function cmdPlanEdit(cwd: string, args: string[]): void {
  ensureFlags(args, ["check", "desc", "cmd", "expect", "kind", "reason", "slug"]);
  const ts = now();
  const id = readFlag(args, "check");
  if (!id) throw new GdmError("--check <id>가 필요합니다", "usage");
  const reason = readFlag(args, "reason") ?? "";
  const work = resolveWork(cwd, readFlag(args, "slug"));
  const patch = {
    desc: readFlag(args, "desc"),
    cmd: resolveCmd(cwd, readFlag(args, "cmd")),
    expect: readFlag(args, "expect"),
    kind: parseCheckKind(readFlag(args, "kind")),
  };
  try {
    const { work: next, reverted } = editCheck(work, id, patch, reason);
    appendJournal(cwd, work.slug, { ts, event: "plan.edit", check: id, patch, reason, reverted });
    saveWork(cwd, next);
    console.log(`${id} 수정됨${reverted ? " (통과 상태가 해제되어 재검증 필요)" : ""}`);
  } catch (error) {
    if (error instanceof GdmError) journalDenied(cwd, work.slug, "plan.edit", error, ts, { check: id });
    throw error;
  }
}

function buildManualEvidence(
  cwd: string,
  args: string[],
  note?: string,
  reviewer?: string,
): Omit<Evidence, "at"> {
  const observed = readFlag(args, "observed");
  if (!observed) {
    throw new GdmError("수동 항목은 --observed <확인 기록 파일(스크린샷 등)>이 필요합니다", "usage");
  }
  const contained = readContainedFile(cwd, observed, "observed");
  if (contained.content.length === 0) throw new GdmError(`증거 파일이 비어 있습니다: ${observed}`, "observed_empty");
  return { observed, sha256: contained.sha256, manual: true, note, reviewer };
}

function buildAutoEvidence(
  cwd: string,
  slug: string,
  id: string,
  cmd: string,
  note?: string,
): Omit<Evidence, "at"> {
  console.log(`실행: ${cmd}`);
  const result = spawnSync("bash", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    timeout: commandTimeoutMs(),
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
  const body = `$ ${cmd}\n(exit ${result.status})\n\n${output}`;
  const observed = writeWorkOutput(cwd, slug, `${id}.txt`, body);
  if (result.error) {
    throw new GdmError(`검증 명령 실행 실패: ${result.error.message}`, "cmd_failed");
  }
  if (result.status !== 0) {
    throw new GdmError(
      `검증 명령이 실패했습니다 (exit ${result.status}). 출력: ${observed}\n${tailLines(output, 15)}`,
      "cmd_failed",
    );
  }
  console.log(tailLines(output, 10));
  return { observed, sha256: sha256(body), exitCode: result.status, manual: false, note };
}

function buildRedEvidence(
  cwd: string,
  slug: string,
  id: string,
  cmd: string,
  note?: string,
): Omit<Evidence, "at"> {
  console.log(`red 재현: ${cmd}`);
  const result = spawnSync("bash", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    timeout: commandTimeoutMs(),
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
  const body = `$ ${cmd}\n(exit ${result.status})\n\n${output}`;
  const observed = writeWorkOutput(cwd, slug, `${id}-red.txt`, body);
  if (result.error || result.status === null) {
    throw new GdmError(`red 재현 명령 실행 실패: ${result.error?.message ?? "종료 상태 없음"}`, "cmd_failed");
  }
  if (result.status === 0) {
    throw new GdmError(
      `red 재현이 성공(exit 0)했습니다. 결함을 드러내는 동일 명령인지 확인한 뒤 다시 실행하세요. 출력: ${observed}`,
      "red_expected_failure",
    );
  }
  console.log(tailLines(output, 10));
  return { observed, sha256: sha256(body), exitCode: result.status, manual: false, note };
}

function validateAutoCommand(cwd: string, cmd: string): string {
  console.log(`실행: ${cmd}`);
  const result = spawnSync("bash", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    timeout: commandTimeoutMs(),
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
  const body = `$ ${cmd}\n(exit ${result.status})\n\n${output}`;
  if (result.error) {
    throw new GdmError(`검증 명령 실행 실패: ${result.error.message}`, "cmd_failed");
  }
  if (result.status !== 0) {
    throw new GdmError(
      `검증 명령이 실패했습니다 (exit ${result.status}). 완료 전 검증은 승인된 증거 파일을 덮어쓰지 않습니다\n${tailLines(output, 15)}`,
      "cmd_failed",
    );
  }
  console.log(tailLines(output, 10));
  return sha256(body);
}

function cmdPass(cwd: string, args: string[]): void {
  const ts = now();
  const id = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  if (!id) throw new GdmError("통과시킬 항목 id가 필요합니다: gdm pass <id>", "usage");
  const rest = args.slice(1);
  ensureFlags(
    rest,
    ["observed", "note", "reviewer", "slug", "expected-plan-fingerprint"],
    ["manual", "red"],
  );
  const work = resolveWork(cwd, readFlag(rest, "slug"));
  assertExpectedPlanFingerprint(work, readFlag(rest, "expected-plan-fingerprint"));
  try {
    const check = assertPassable(work, id);
    const noteValue = readFlag(rest, "note");
    const note = check.expert && noteValue !== undefined ? safeText(noteValue, "note") : noteValue;
    if (hasFlag(rest, "red")) {
      if (hasFlag(rest, "manual") || readFlag(rest, "observed") || readFlag(rest, "reviewer")) {
        throw new GdmError("--red는 자동 regression 명령과 note만 받습니다", "red_not_allowed");
      }
      if (checkKind(check) !== "regression" || check.manual || !check.cmd) {
        throw new GdmError(`${id}는 regression 자동 항목이 아닙니다. --red를 제거하세요`, "red_not_allowed");
      }
      const evidence = buildRedEvidence(cwd, work.slug, id, check.cmd, note);
      const next = recordRedEvidence(work, id, evidence, ts);
      appendJournal(cwd, work.slug, { ts, event: "pass.red", check: id, ...evidence });
      saveWork(cwd, next);
      console.log(`${id} red 증거 기록됨 — 결함을 수정한 뒤 gdm pass ${id}`);
      return;
    }
    if (checkKind(check) === "regression" && !check.redEvidence) {
      throw new GdmError(
        `${id}는 regression 항목입니다. 먼저 gdm pass ${id} --red로 실패를 재현하세요`,
        "red_evidence_required",
      );
    }
    let evidence: Omit<Evidence, "at">;
    if (check.manual) {
      if (!hasFlag(rest, "manual")) {
        throw new GdmError(
          `${id}는 수동 확인 항목입니다. --manual과 함께 확인 기록(스크린샷 등) 경로를 제출하세요`,
          "manual_required",
        );
      }
      const reviewerValue = readFlag(rest, "reviewer");
      const reviewer = reviewerValue === undefined ? undefined : safeText(reviewerValue, "reviewer");
      evidence = buildManualEvidence(cwd, rest, note, reviewer);
    } else {
      if (hasFlag(rest, "manual") || readFlag(rest, "observed") || readFlag(rest, "reviewer")) {
        throw new GdmError(
          `${id}는 자동 검증 항목입니다. --manual/--observed/--reviewer는 쓸 수 없습니다`,
          "manual_not_allowed",
        );
      }
      evidence = buildAutoEvidence(cwd, work.slug, id, check.cmd!, note);
    }
    const next = passCheck(work, id, evidence, ts);
    appendJournal(cwd, work.slug, { ts, event: "pass", check: id, ...evidence });
    saveWork(cwd, next);
    const { proven, total } = provenCount(next);
    console.log(`${id} 통과 (${proven}/${total})`);
    if (proven === total) console.log(`모든 항목 통과 — gdm done으로 완료하세요`);
  } catch (error) {
    if (error instanceof GdmError) journalDenied(cwd, work.slug, "pass", error, ts, { check: id });
    throw error;
  }
}

function runRecheck(
  cwd: string,
  work: Work,
  ts: string,
  targets: Work["checks"],
  mode: "refresh" | "validate" = "refresh",
): { work: Work; failed: string[] } {
  let next = work;
  const failed: string[] = [];
  for (const check of targets) {
    try {
      const evidenceSha256 =
        mode === "refresh"
          ? (() => {
              const evidence = buildAutoEvidence(cwd, next.slug, check.id, check.cmd!);
              next = refreshEvidence(next, check.id, evidence, ts);
              return evidence.sha256;
            })()
          : validateAutoCommand(cwd, check.cmd!);
      appendJournal(cwd, next.slug, {
        ts,
        event: "recheck",
        check: check.id,
        ok: true,
        mode,
        sha256: evidenceSha256,
      });
      console.log(`${check.id} 재검증 통과`);
    } catch (error) {
      if (!(error instanceof GdmError) || error.code !== "cmd_failed") throw error;
      next = revertChecks(next, [check.id]);
      failed.push(check.id);
      appendJournal(cwd, next.slug, { ts, event: "recheck", check: check.id, ok: false, message: error.message });
      console.log(`${check.id} 재검증 실패 — open으로 회귀`);
    }
  }
  return { work: next, failed };
}

function cmdRecheck(cwd: string, args: string[]): void {
  ensureFlags(args, ["check", "slug", "expected-plan-fingerprint"]);
  const ts = now();
  const initial = resolveWork(cwd, readFlag(args, "slug"));
  assertExpectedPlanFingerprint(initial, readFlag(args, "expected-plan-fingerprint"));
  const only = readFlag(args, "check");
  const targets = initial.checks.filter(
    (c) => c.status === "proven" && !c.manual && (!only || c.id === only),
  );
  if (only && targets.length === 0) {
    throw new GdmError(`${only}는 재검증 대상이 아닙니다 (통과한 자동 항목만 가능)`, "not_recheckable");
  }
  if (targets.length === 0) {
    console.log("재검증할 자동 통과 항목이 없습니다");
    return;
  }
  const { work, failed } = runRecheck(cwd, initial, ts, targets);
  saveWork(cwd, work);
  const { proven, total } = provenCount(work);
  if (failed.length > 0) {
    throw new GdmError(
      `재검증 결과: ${targets.length}개 중 ${failed.length}개 실패 (${failed.join(", ")}) — 현재 ${proven}/${total}`,
      "recheck_failed",
    );
  }
  console.log(`재검증 결과: ${targets.length}개 전부 통과 (${proven}/${total})`);
}

function verifyEvidence(cwd: string, work: Work): { id: string; why: string; red?: boolean }[] {
  const problems: { id: string; why: string; red?: boolean }[] = [];
  for (const check of work.checks) {
    const evidenceItems = [
      ...(check.redEvidence ? [{ evidence: check.redEvidence, red: true }] : []),
      ...(check.status === "proven" && check.evidence ? [{ evidence: check.evidence, red: false }] : []),
    ];
    for (const item of evidenceItems) {
      const label = item.red ? "red 증거" : "증거";
      let actualHash: string;
      try {
        actualHash = readContainedFile(cwd, item.evidence.observed, `${check.id}-${label}`).sha256;
      } catch (error) {
        if (!(error instanceof GdmError)) throw error;
        problems.push({
          id: check.id,
          why: `${check.id}: ${label} 파일을 안전하게 읽을 수 없음 (${item.evidence.observed}; ${error.code})`,
          red: item.red,
        });
        continue;
      }
      if (actualHash !== item.evidence.sha256) {
        problems.push({
          id: check.id,
          why: `${check.id}: ${label} 파일이 pass 이후 변경됨 (${item.evidence.observed})`,
          red: item.red,
        });
      }
    }
  }
  return problems;
}

function auditState(cwd: string, work: Work): string {
  if (!work.auditRequired && work.contract.risk !== "high") return "";
  if (!work.audit) return "검수: 필요 (미실시)";
  if (work.audit.result === "fail") return "검수: 반려";
  if (work.audit.stateHash !== checksHash(work)) return "검수: 무효 (상태 변경됨, 재검수 필요)";
  return auditIntegrityProblems(cwd, work.audit).length === 0
    ? "검수: 통과"
    : "검수: 무효 (보고서 또는 워크트리 변경됨, 재검수 필요)";
}

function cmdAuditBrief(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug"], ["json"]);
  const work = resolveWorkForRead(cwd, readFlag(args, "slug"));
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify({ work, journal: readJournal(cwd, work.slug) }, null, 2));
    return;
  }
  const { proven, total } = provenCount(work);
  console.log(`# 검수 브리핑: ${work.slug} (${proven}/${total} 통과)`);
  console.log("");
  console.log("## 원 요청");
  console.log(work.brief);
  console.log("");
  console.log("## 작업 계약");
  console.log(contractLine(work));
  for (const value of work.contract.required) console.log(`- 필수: ${value}`);
  for (const value of work.contract.forbidden) console.log(`- 금지: ${value}`);
  for (const value of work.contract.assumptions ?? []) console.log(`- 가정: ${value}`);
  for (const value of work.contract.uncertainties ?? []) console.log(`- 불확실성: ${value}`);
  console.log(`- 허용 경로: ${(work.contract.allowedPaths ?? ["."]).join(", ") || "없음"}`);
  console.log(`- 금지 경로: ${(work.contract.forbiddenPaths ?? []).join(", ") || "없음"}`);
  for (const value of work.contract.stopConditions ?? []) console.log(`- 중단 조건: ${value}`);
  console.log(`- 간소화 증거: ${work.contract.simplificationRequired ? "필수" : "선택"}`);
  const outcomeLines = declaredOutcomeLines(work);
  if (outcomeLines.length > 0) {
    console.log("");
    console.log("## 선언한 outcome (GDM 미측정)");
    for (const line of outcomeLines) console.log(`- ${line}`);
  }
  console.log("");
  console.log("## 확인 항목과 증거");
  for (const c of work.checks) {
    const how = c.manual ? "(수동 확인)" : c.cmd;
    console.log(`- ${c.id} [${c.status}/${checkKind(c)}] ${c.desc}${c.expert ? " (expert)" : ""}`);
    console.log(`  검증: ${how} → 기대: ${c.expect}`);
    if (c.redEvidence) console.log(`  red 증거: ${c.redEvidence.observed} (sha256 ${c.redEvidence.sha256.slice(0, 12)}…)`);
    if (c.evidence) console.log(`  증거: ${c.evidence.observed} (sha256 ${c.evidence.sha256.slice(0, 12)}…)`);
    if (c.evidence?.reviewer) console.log(`  reviewer: ${c.evidence.reviewer} · 근거: ${c.evidence.note ?? "—"}`);
  }
  const denied = readJournal(cwd, work.slug).filter((e) => e.event === "denied" || e.event === "plan.edit");
  if (denied.length > 0) {
    console.log("");
    console.log("## 과정 이력 (거부·기준 수정)");
    for (const e of denied) {
      console.log(`- ${e.ts} ${e.event}${e.check ? ` ${e.check}` : ""}: ${e.reason ?? e.message ?? ""}`);
    }
  }
  console.log("");
  console.log(`검수보고 저장 위치: ${join(workDir(cwd, work.slug), "audit-report.md")}`);
  console.log(`판정 기록: gdm audit verdict (--pass | --fail) --report <검수보고 경로> --implementation-model <모델> --audit-model <모델>`);
  if (proven < total) console.log(`주의: 미통과 항목이 있어 verdict는 아직 기록할 수 없습니다`);
}

function cmdAuditVerdict(cwd: string, args: string[]): void {
  ensureFlags(args, ["report", "slug", "implementation-model", "audit-model"], ["pass", "fail"]);
  const ts = now();
  const pass = hasFlag(args, "pass");
  const fail = hasFlag(args, "fail");
  if (pass === fail) throw new GdmError("--pass 또는 --fail 중 정확히 하나가 필요합니다", "usage");
  const report = readFlag(args, "report");
  if (!report) throw new GdmError("--report <검수보고 파일>이 필요합니다", "usage");
  const implementationModel = safeText(readFlag(args, "implementation-model") ?? "", "implementation-model");
  const auditModel = safeText(readFlag(args, "audit-model") ?? "", "audit-model");
  const contained = readContainedFile(cwd, report, "report");
  if (contained.content.length === 0) throw new GdmError(`검수보고 파일이 비어 있습니다: ${report}`, "report_empty");
  const verdictLines = contained.content
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("**판정:"));
  if (
    verdictLines.length !== 1 ||
    (verdictLines[0] !== "**판정: 통과**" && verdictLines[0] !== "**판정: 반려**")
  ) {
    throw new GdmError("검수보고에는 정확한 판정 marker가 하나 있어야 합니다", "audit_verdict_invalid");
  }
  const reportPassed = verdictLines[0] === "**판정: 통과**";
  if (reportPassed !== pass) {
    throw new GdmError("검수보고의 판정과 --pass/--fail 인자가 일치하지 않습니다", "audit_verdict_mismatch");
  }
  if (!contained.content.includes(`implementationModel: ${implementationModel}`) || !contained.content.includes(`auditModel: ${auditModel}`)) {
    throw new GdmError("검수보고의 implementationModel 또는 auditModel이 명령 인자와 일치하지 않습니다", "audit_model_mismatch");
  }
  const work = resolveWork(cwd, readFlag(args, "slug"));
  try {
    const workspace = captureWorkspaceFingerprint(cwd);
    const next = recordAudit(
      work,
      pass ? "pass" : "fail",
      contained.path,
      contained.sha256,
      implementationModel,
      auditModel,
      workspace,
      ts,
    );
    appendJournal(cwd, work.slug, {
      ts,
      event: "audit",
      result: next.audit!.result,
      report,
      reportSha256: contained.sha256,
      implementationModel,
      auditModel,
      workspace,
      stateHash: next.audit!.stateHash,
    });
    saveWork(cwd, next);
    if (pass) {
      console.log(`검수 통과 기록됨 — gdm done으로 완료하세요`);
    } else {
      console.log(`검수 반려 기록됨 — 반려 사유를 check로 반영(plan add/edit)하고 해결 후 재검수하세요`);
    }
  } catch (error) {
    if (error instanceof GdmError) journalDenied(cwd, work.slug, "audit", error, ts);
    throw error;
  }
}

function cmdDone(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug", "expected-plan-fingerprint"]);
  const ts = now();
  const work = resolveWork(cwd, readFlag(args, "slug"));
  assertExpectedPlanFingerprint(work, readFlag(args, "expected-plan-fingerprint"));
  try {
    // Preserve closeWork's canonical work_done error, but reject before any
    // scope scan, audit validation, command replay, or evidence mutation.
    if (work.done) closeWork(work, ts);
    const scopeProblems = workspaceScopeProblems(work, captureWorkspaceFingerprint(cwd));
    if (scopeProblems.length > 0) {
      throw new GdmError(describeScopeProblems(scopeProblems), "scope_violation");
    }
    const requiresAudit = work.auditRequired || work.contract.risk === "high";
    if (requiresAudit && work.audit?.result === "pass") {
      const problems = auditIntegrityProblems(cwd, work.audit);
      if (problems.length > 0) {
        throw new GdmError(`검수 무결성 실패 — 재검수가 필요합니다: ${problems.join(", ")}`, "audit_stale");
      }
    }
    const auditBindsGitWorkspace = requiresAudit && work.audit?.result === "pass" && work.audit.workspace !== null;
    const autoTargets = auditBindsGitWorkspace
      ? []
      : work.checks.filter((c) => c.status === "proven" && !c.manual);
    const { work: rechecked, failed } = runRecheck(cwd, work, ts, autoTargets, "validate");
    if (failed.length > 0) {
      saveWork(cwd, rechecked);
      throw new GdmError(
        `완료 전 재검증 실패 — ${failed.join(", ")}가 open으로 회귀했습니다. 코드를 고치고 다시 pass 하세요`,
        "unproven",
      );
    }
    const postCheckScopeProblems = workspaceScopeProblems(rechecked, captureWorkspaceFingerprint(cwd));
    if (postCheckScopeProblems.length > 0) {
      throw new GdmError(describeScopeProblems(postCheckScopeProblems), "scope_violation");
    }
    const stale = verifyEvidence(cwd, rechecked);
    if (stale.length > 0) {
      const ids = [...new Set(stale.map((s) => s.id))];
      const redIds = [...new Set(stale.filter((s) => s.red).map((s) => s.id))];
      const reverted = revertChecks(rechecked, ids, redIds);
      appendJournal(cwd, work.slug, { ts, event: "evidence_stale", checks: ids });
      saveWork(cwd, reverted);
      throw new GdmError(
        `증거 재검증 실패 — 해당 항목을 open으로 되돌렸습니다. 다시 pass 하세요:\n  ${stale
          .map((s) => s.why)
          .join("\n  ")}`,
        "evidence_stale",
      );
    }
    const next = closeWork(rechecked, ts);
    appendJournal(cwd, work.slug, { ts, event: "done", checks: next.checks.length });
    saveWork(cwd, next);
    console.log(`작업 완료: ${work.slug} (${next.checks.length}/${next.checks.length})`);
    console.log(`요약 문서: ${join(workDir(cwd, work.slug), "work.md")}`);
  } catch (error) {
    if (error instanceof GdmError) journalDenied(cwd, work.slug, "done", error, ts);
    throw error;
  }
}

function cmdStatus(cwd: string, args: string[]): void {
  ensureFlags(args, [], ["json", "checks"]);
  const withChecks = hasFlag(args, "checks");
  const works = listWorks(cwd);
  if (hasFlag(args, "json")) {
    const summary = works.map((w) => {
      const { proven, total } = provenCount(w);
      const last = journalTail(cwd, w.slug, 1)[0];
      return {
        slug: w.slug,
        done: w.done,
        proven,
        total,
        blockers: completionBlockers(w),
        audit: auditState(cwd, w),
        contract: w.contract,
        delivery: w.delivery ?? null,
        lastEvent: last?.event,
        lastAt: last?.ts,
        ...(withChecks ? { checks: w.checks } : {}),
      };
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (works.length === 0) {
    console.log("작업이 없습니다. gdm plan init으로 시작하세요");
    return;
  }
  for (const w of works) {
    const { proven, total } = provenCount(w);
    const last = journalTail(cwd, w.slug, 1)[0];
    const state = w.done ? "완료  " : "진행 중";
    const lastInfo = last ? ` — 마지막: ${last.ts} ${last.event}` : "";
    console.log(`[${state}] ${w.slug} (${proven}/${total})${lastInfo}`);
    if (w.delivery) {
      console.log(
        `  전달: ${w.delivery.branch} · PR ${w.delivery.pr?.number ?? "—"} · CI ${w.delivery.ci?.status ?? "—"} · ${w.delivery.merged ? "머지됨" : "미머지"}`,
      );
    }
    if (withChecks) {
      for (const line of checkLine(w)) console.log(line);
    }
  }
}

function cmdResume(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug"], ["json"]);
  const work = resolveWorkForRead(cwd, readFlag(args, "slug"));
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify({ work, journal: journalTail(cwd, work.slug) }, null, 2));
    return;
  }
  console.log(workHeader(work));
  console.log(`목표: ${work.brief}`);
  console.log(contractLine(work));
  const outcomeLines = declaredOutcomeLines(work);
  if (outcomeLines.length > 0) {
    console.log("선언한 outcome (GDM 미측정):");
    for (const line of outcomeLines) console.log(`  - ${line}`);
  }
  const audit = auditState(cwd, work);
  if (audit) console.log(audit);
  if (work.delivery) {
    console.log(
      `전달: ${work.delivery.branch} · ${work.delivery.head} · PR ${work.delivery.pr?.number ?? "—"} · CI ${work.delivery.ci?.status ?? "—"} · 머지 ${work.delivery.merged?.sha ?? "—"}`,
    );
  }
  console.log("항목:");
  for (const line of checkLine(work)) console.log(line);
  const tail = journalTail(cwd, work.slug, 5);
  if (tail.length > 0) {
    console.log("최근 기록:");
    for (const ev of tail) console.log(`  - ${ev.ts} ${ev.event}${ev.check ? ` ${ev.check}` : ""}`);
  }
  const attempts = latestAttemptStates(readJournal(cwd, work.slug));
  if (attempts.length > 0) {
    console.log("재시도 상태:");
    for (const attempt of attempts) {
      console.log(
        `  - ${attempt.fingerprint} · epoch ${attempt.epoch} · ${attempt.decision} · 가설 ${attempt.hypothesis}`,
      );
    }
  }
  if (!work.done) {
    console.log("다음: 미통과 항목을 구현한 뒤 gdm pass <id>");
  }
}

function cmdMiss(cwd: string, args: string[]): void {
  ensureFlags(args, ["desc", "type", "check", "slug"]);
  const ts = now();
  const desc = readFlag(args, "desc");
  if (!desc) throw new GdmError("--desc <무엇이 어떻게 터졌는지>가 필요합니다", "usage");
  const work = resolveWorkForRead(cwd, readFlag(args, "slug"));
  const check = readFlag(args, "check");
  if (check) findCheck(work, check);
  const type = readFlag(args, "type");
  appendJournal(cwd, work.slug, {
    ts,
    event: "miss",
    desc,
    ...(type ? { type } : {}),
    ...(check ? { check } : {}),
  });
  console.log(`탈출 결함 기록: ${work.slug}${check ? ` ${check}` : ""} — ${desc}`);
  console.log(`집계: gdm retro --all (게이트 구멍 리포트)`);
}

function resolveFeedbackWork(cwd: string, given?: string): Work {
  if (given !== undefined) return resolveWorkForRead(cwd, given);
  const works = listWorks(cwd);
  if (works.length === 0) {
    throw new GdmError("작업이 없습니다. gdm plan init으로 시작하세요", "no_active");
  }
  const active = works.filter((work) => !work.done);
  const candidates = active.length > 0 ? active : works;
  return candidates
    .map((work) => ({
      work,
      ts: journalTail(cwd, work.slug, 1)[0]?.ts ?? work.createdAt,
    }))
    .sort((left, right) => {
      const time = right.ts.localeCompare(left.ts);
      return time !== 0 ? time : left.work.slug.localeCompare(right.work.slug);
    })[0]!.work;
}

function cmdFeedback(cwd: string, args: string[]): void {
  ensureFlags(args, ["value", "reason", "source", "slug"], ["json"]);
  const value = readFlag(args, "value");
  if (value !== "good" && value !== "bad") {
    throw new GdmError("--value는 good 또는 bad여야 합니다", "usage");
  }
  const reasonValue = readFlag(args, "reason");
  const reason = reasonValue === undefined ? undefined : safeText(reasonValue, "reason", 240);
  const source = opaqueId(readFlag(args, "source") ?? "manual", "source");
  if (value === "bad" && reason === undefined) {
    throw new GdmError("--value bad에는 --reason <사유>가 필요합니다", "usage");
  }
  const work = resolveFeedbackWork(cwd, readFlag(args, "slug"));
  appendJournal(cwd, work.slug, {
    ts: now(),
    event: "feedback",
    value,
    ...(reason === undefined ? {} : { reason }),
    source,
  });
  const result = {
    slug: work.slug,
    value,
    ...(reason === undefined ? {} : { reason }),
    source,
  };
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`피드백 기록: ${work.slug} — ${value} (${source})`);
}

function cmdRetroAll(cwd: string, json: boolean): void {
  const works = listWorks(cwd);
  if (works.length === 0 && !json) {
    console.log("작업이 없습니다");
    return;
  }
  const habits = habitOverview(cwd);
  const deniedByCode = new Map<string, number>();
  const editReasons: { work: string; check?: unknown; reason?: unknown }[] = [];
  const misses: { work: string; type?: unknown; check?: unknown; desc?: unknown }[] = [];
  const feedback = { good: 0, bad: 0, total: 0 };
  const evalCandidates: { work: string; reason: string; source: string }[] = [];
  let recheckFails = 0;
  let events = 0;
  for (const w of works) {
    for (const e of readJournal(cwd, w.slug)) {
      events++;
      if (e.event === "denied") {
        const code = String(e.code ?? "unknown");
        deniedByCode.set(code, (deniedByCode.get(code) ?? 0) + 1);
      } else if (e.event === "plan.edit") {
        editReasons.push({ work: w.slug, check: e.check, reason: e.reason });
      } else if (e.event === "miss") {
        misses.push({ work: w.slug, type: e.type, check: e.check, desc: e.desc });
      } else if (e.event === "feedback" && (e.value === "good" || e.value === "bad")) {
        feedback[e.value]++;
        feedback.total++;
        if (e.value === "bad" && typeof e.reason === "string" && e.reason.length > 0) {
          evalCandidates.push({
            work: w.slug,
            reason: e.reason,
            source: typeof e.source === "string" ? e.source : "unknown",
          });
        }
      } else if (e.event === "recheck" && e.ok === false) {
        recheckFails++;
      }
    }
  }
  const missByType = new Map<string, number>();
  for (const m of misses) {
    const type = String(m.type ?? "미분류");
    missByType.set(type, (missByType.get(type) ?? 0) + 1);
  }
  const suggestions: string[] = [];
  for (const [type, count] of [...missByType.entries()].sort((a, b) => b[1] - a[1])) {
    suggestions.push(
      `검수 체크리스트에 "${type}" 유형 반영 검토 — 게이트 통과 후 ${count}건 발견 (gdm-agents/auditor.md)`,
    );
  }
  if (editReasons.length >= 3) {
    suggestions.push(`check 기준 수정 ${editReasons.length}건 — plan 단계에서 기준을 더 구체화하면 재작업이 줄어듭니다`);
  }
  if (recheckFails > 0) {
    suggestions.push(`recheck가 회귀 ${recheckFails}건을 잡음 — 후속 변경의 영향 항목만 중간 재검증하고 done 직전 중복 실행은 생략`);
  }
  if (json) {
    console.log(
      JSON.stringify(
        {
          works: works.length,
          done: works.filter((w) => w.done).length,
          events,
          denied: Object.fromEntries(deniedByCode),
          misses,
          feedback,
          evalCandidates,
          editCount: editReasons.length,
          recheckFails,
          suggestions,
          habitCandidates: habits.candidates,
          habitAdopted: habits.adopted,
          habitNext: habits.next,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `# 전체 회고 — 작업 ${works.length}개(완료 ${works.filter((w) => w.done).length}), 이벤트 ${events}건, 탈출 결함 ${misses.length}건`,
  );
  console.log(`피드백: good ${feedback.good}건 · bad ${feedback.bad}건 · 전체 ${feedback.total}건`);
  console.log(`습관: 후보 ${habits.candidates}개 · 채택 ${habits.adopted}개 · 다음 ${habits.next}`);
  if (misses.length > 0) {
    console.log("탈출 결함 (게이트 구멍):");
    for (const m of misses) {
      console.log(`  - [${m.type ?? "미분류"}] ${m.work}${m.check ? ` ${m.check}` : ""}: ${m.desc}`);
    }
  }
  if (deniedByCode.size > 0) {
    console.log("거부 사유 누적:");
    for (const [code, count] of [...deniedByCode.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${code}: ${count}회`);
    }
  }
  if (suggestions.length > 0) {
    console.log("개선 제안:");
    for (const s of suggestions) console.log(`  → ${s}`);
  } else {
    console.log("개선 제안: 없음 — 탈출 결함·반복 마찰이 아직 없습니다");
  }
}

function cmdRetro(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug"], ["json", "all"]);
  if (hasFlag(args, "all")) {
    cmdRetroAll(cwd, hasFlag(args, "json"));
    return;
  }
  const work = resolveWorkForRead(cwd, readFlag(args, "slug"));
  const journal = readJournal(cwd, work.slug);
  const denied = journal.filter((e) => e.event === "denied");
  const edits = journal.filter((e) => e.event === "plan.edit");
  const rechecks = journal.filter((e) => e.event === "recheck");
  const deniedByCode = new Map<string, number>();
  for (const d of denied) {
    const code = String(d.code ?? "unknown");
    deniedByCode.set(code, (deniedByCode.get(code) ?? 0) + 1);
  }
  const frictionByCheck = new Map<string, number>();
  for (const d of denied) {
    if (typeof d.check === "string") {
      frictionByCheck.set(d.check, (frictionByCheck.get(d.check) ?? 0) + 1);
    }
  }
  if (hasFlag(args, "json")) {
    console.log(
      JSON.stringify(
        {
          slug: work.slug,
          done: work.done,
          events: journal.length,
          denied: Object.fromEntries(deniedByCode),
          frictionByCheck: Object.fromEntries(frictionByCheck),
          edits: edits.map((e) => ({ check: e.check, reason: e.reason, patch: e.patch })),
          rechecks: rechecks.map((e) => ({ check: e.check, ok: e.ok })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`# ${work.slug} 회고 — 이벤트 ${journal.length}건, 거부 ${denied.length}건, 기준 수정 ${edits.length}건`);
  if (journal.length > 0) {
    console.log(`기간: ${journal[0]!.ts} → ${journal[journal.length - 1]!.ts}`);
  }
  if (deniedByCode.size > 0) {
    console.log("거부 사유:");
    for (const [code, count] of [...deniedByCode.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${code}: ${count}회`);
    }
  }
  if (frictionByCheck.size > 0) {
    console.log("항목별 마찰(거부 횟수):");
    for (const [check, count] of [...frictionByCheck.entries()].sort((a, b) => b[1] - a[1])) {
      const desc = work.checks.find((c) => c.id === check)?.desc ?? "";
      console.log(`  - ${check} ${desc}: ${count}회`);
    }
  }
  if (edits.length > 0) {
    console.log("기준 수정 이력:");
    for (const e of edits) console.log(`  - ${e.check}: ${e.reason}`);
  }
  if (rechecks.length > 0) {
    const failedRechecks = rechecks.filter((r) => r.ok === false).length;
    console.log(`재검증: ${rechecks.length}회 (회귀 검출 ${failedRechecks}회)`);
  }
  if (denied.length === 0 && edits.length === 0) {
    console.log("게이트 마찰 없음 — 항목 설계가 처음부터 유효했습니다");
  }
}

function cmdPreset(cwd: string, args: string[]): void {
  const [sub, ...rest] = args;
  if (sub === "list") {
    const presets = loadPresets(cwd);
    const names = Object.keys(presets);
    if (names.length === 0) {
      console.log("등록된 프리셋 없음 — gdm preset set <이름> <명령>");
      return;
    }
    for (const name of names) console.log(`@${name} = ${presets[name]}`);
    return;
  }
  if (sub === "set") {
    const [name, command] = rest;
    if (!name || !command) throw new GdmError("사용법: gdm preset set <이름> <명령>", "usage");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new GdmError(`프리셋 이름은 소문자/숫자/하이픈만 가능합니다: "${name}"`, "usage");
    }
    const presets = loadPresets(cwd);
    presets[name] = command;
    savePresets(cwd, presets);
    console.log(`@${name} = ${command}`);
    return;
  }
  if (sub === "rm") {
    const [name] = rest;
    if (!name) throw new GdmError("사용법: gdm preset rm <이름>", "usage");
    const presets = loadPresets(cwd);
    if (!(name in presets)) throw new GdmError(`프리셋 "@${name}"이 없습니다`, "preset_not_found");
    delete presets[name];
    savePresets(cwd, presets);
    console.log(`@${name} 삭제됨`);
    return;
  }
  throw new GdmError("preset은 set, list 또는 rm을 사용하세요", "usage");
}

function cmdRepair(cwd: string, args: string[]): void {
  const [sub, ...rest] = args;
  if (sub !== "state") {
    throw new GdmError("사용법: gdm repair state --slug <슬러그> --trailing-nul", "usage");
  }
  ensureFlags(rest, ["slug"], ["trailing-nul"]);
  const slug = readFlag(rest, "slug");
  if (!slug || !hasFlag(rest, "trailing-nul")) {
    throw new GdmError("사용법: gdm repair state --slug <슬러그> --trailing-nul", "usage");
  }
  const { removedBytes } = repairTrailingNulWork(cwd, slug);
  const ts = now();
  appendJournal(cwd, slug, {
    ts,
    event: "state.repair",
    kind: "trailing-nul",
    removedBytes,
  });
  console.log(`${slug} 상태 복구 완료: trailing NUL ${removedBytes}바이트 제거`);
}

const SKILL_NAMES = [
  "go",
  "full",
  "plan",
  "review",
  "analyze",
  "research",
  "pr",
  "ui",
  "db",
  "design",
  "reflect",
  "email",
  "document",
] as const;

function repoVersionFromSkills(): { version: string; root: string } | undefined {
  try {
    const link = join(homedir(), ".claude", "skills", "gdm-go");
    const root = resolve(realpathSync(link), "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "cli", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? { version: pkg.version, root } : undefined;
  } catch {
    return undefined;
  }
}

const TARGET_MANIFEST_KEYS = [
  "schemaVersion", "target", "adapterVersion", "canonicalSourceSha256", "sourceSha256",
  "capabilityProfile", "hook", "runner", "skills",
] as const;
const TARGET_CAPABILITY_PROFILE = {
  id: "gdm-read-only-specialist/v1",
  filesystem: "read-only",
  delegation: "disabled",
  mcp: "disabled",
  shell: "unsupported",
  browser: "unsupported",
  network: "unsupported",
} as const;
const TARGET_RUNNER = {
  contract: "gdm-role-runner/v1",
  path: "gdm-agents/run-role.sh",
  adapters: {
    codex: "gdm-agents/providers/codex.sh",
    claude: "gdm-agents/providers/claude.sh",
    pi: "gdm-agents/providers/pi.sh",
  },
} as const;
const TARGET_HASH_RE = /^[0-9a-f]{64}$/u;

type TargetName = "codex" | "claude" | "pi";
type TargetManifestDoctor = {
  readonly target: TargetName;
  readonly status: "valid" | "drift" | "missing";
  readonly sourceHash?: string;
  readonly profile: "gdm-read-only-specialist/v1" | "invalid" | "unavailable";
  readonly hook: "supported" | "not-required" | "invalid" | "unavailable";
  readonly runner: "supported" | "invalid" | "unavailable";
  readonly problems: readonly string[];
};

function doctorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function doctorExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function doctorExactObject(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (!doctorRecord(value) || !doctorExactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function doctorContainedRegularFile(root: string, relativePath: string, executable = false): string | undefined {
  try {
    const canonicalRoot = realpathSync(root);
    const path = join(root, relativePath);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (executable && (stat.mode & 0o111) === 0)) return undefined;
    const canonical = realpathSync(path);
    const fromRoot = relative(canonicalRoot, canonical);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

function doctorInstalledHash(root: string, relativePath: string, expectedHash: unknown): boolean {
  if (typeof expectedHash !== "string" || !TARGET_HASH_RE.test(expectedHash)) return false;
  const path = doctorContainedRegularFile(root, relativePath, true);
  return path !== undefined && createHash("sha256").update(readFileSync(path)).digest("hex") === expectedHash;
}

function doctorRunnerValid(root: string, value: unknown): boolean {
  if (!doctorRecord(value) || !doctorExactKeys(value, ["contract", "path", "sha256", "adapters"])) return false;
  if (value.contract !== TARGET_RUNNER.contract || value.path !== TARGET_RUNNER.path ||
      !doctorInstalledHash(root, TARGET_RUNNER.path, value.sha256) || !doctorRecord(value.adapters) ||
      !doctorExactKeys(value.adapters, ["codex", "claude", "pi"])) return false;
  for (const provider of ["codex", "claude", "pi"] as const) {
    const adapter = value.adapters[provider];
    const expectedPath = TARGET_RUNNER.adapters[provider];
    if (!doctorRecord(adapter) || !doctorExactKeys(adapter, ["path", "sha256"]) ||
        adapter.path !== expectedPath || !doctorInstalledHash(root, expectedPath, adapter.sha256)) return false;
  }
  return true;
}

function inspectTargetManifest(target: TargetName, skillsRoot: string): TargetManifestDoctor {
  const manifestPath = join(skillsRoot, "gdm-target-manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      target,
      status: "missing",
      profile: "unavailable",
      hook: "unavailable",
      runner: "unavailable",
      problems: ["manifest missing"],
    };
  }
  const problems: string[] = [];
  let raw: unknown;
  const containedManifest = doctorContainedRegularFile(skillsRoot, "gdm-target-manifest.json");
  if (containedManifest === undefined) {
    problems.push("manifest is not a contained regular file");
  } else {
    try {
      raw = JSON.parse(readFileSync(containedManifest, "utf8"));
    } catch {
      problems.push("manifest JSON is malformed");
    }
  }
  if (!doctorRecord(raw)) {
    return {
      target,
      status: "drift",
      profile: "invalid",
      hook: "invalid",
      runner: "invalid",
      problems: problems.length > 0 ? problems : ["manifest root is invalid"],
    };
  }
  if (!doctorExactKeys(raw, TARGET_MANIFEST_KEYS)) problems.push("top-level schema keys differ");
  if (raw.schemaVersion !== "gdm-target-skill-manifest/v1") problems.push("schemaVersion differs");
  if (raw.target !== target) problems.push("target differs from install path");
  if (raw.adapterVersion !== "gdm-target-adapter/v1") problems.push("adapterVersion differs");
  const sourceHash = typeof raw.canonicalSourceSha256 === "string" && TARGET_HASH_RE.test(raw.canonicalSourceSha256)
    ? raw.canonicalSourceSha256
    : undefined;
  if (sourceHash === undefined) problems.push("canonical source hash is invalid");
  if (typeof raw.sourceSha256 !== "string" || !TARGET_HASH_RE.test(raw.sourceSha256)) {
    problems.push("source hash is invalid");
  }

  const profileValid = doctorExactObject(raw.capabilityProfile, TARGET_CAPABILITY_PROFILE);
  if (!profileValid) problems.push("capability profile differs");
  const expectedHook = target === "codex"
    ? { id: "gdm-agent-gate-v1", status: "supported", requiredForTarget: true }
    : { id: null, status: "not-required", requiredForTarget: false };
  const hookValid = doctorExactObject(raw.hook, expectedHook);
  if (!hookValid) problems.push("hook capability differs");
  const runnerValid = doctorRunnerValid(skillsRoot, raw.runner);
  if (!runnerValid) problems.push("runner or provider adapter contract/hash differs");

  const expectedSkills = [...SKILL_NAMES].map((name) => `gdm-${name}`).sort();
  if (!Array.isArray(raw.skills)) {
    problems.push("skills list is invalid");
  } else {
    const names: string[] = [];
    for (const [index, value] of raw.skills.entries()) {
      if (!doctorRecord(value) || !doctorExactKeys(value, [
        "name", "sourcePath", "sourceSha256", "renderedSha256",
      ])) {
        problems.push(`skill ${index + 1} schema differs`);
        continue;
      }
      const name = typeof value.name === "string" ? value.name : "";
      names.push(name);
      if (!/^gdm-[a-z][a-z0-9-]*$/u.test(name) || value.sourcePath !== `skills/${name.slice(4)}`) {
        problems.push(`skill ${index + 1} identity differs`);
      }
      if (typeof value.sourceSha256 !== "string" || !TARGET_HASH_RE.test(value.sourceSha256)) {
        problems.push(`skill ${name || index + 1} source hash is invalid`);
      }
      if (typeof value.renderedSha256 !== "string" || !TARGET_HASH_RE.test(value.renderedSha256)) {
        problems.push(`skill ${name || index + 1} rendered hash is invalid`);
        continue;
      }
      const skillPath = doctorContainedRegularFile(skillsRoot, `${name}/SKILL.md`);
      if (skillPath === undefined) {
        problems.push(`skill ${name || index + 1} is missing or unsafe`);
      } else {
        const installedHash = createHash("sha256").update(readFileSync(skillPath)).digest("hex");
        if (installedHash !== value.renderedSha256) problems.push(`skill ${name} rendered bytes drifted`);
      }
    }
    if (new Set(names).size !== names.length || names.some((name, index) => name !== [...names].sort()[index])) {
      problems.push("skill names are duplicate or unsorted");
    }
    if (names.length !== expectedSkills.length || names.some((name, index) => name !== expectedSkills[index])) {
      problems.push("installed skill set differs");
    }
  }
  return {
    target,
    status: problems.length === 0 ? "valid" : "drift",
    ...(sourceHash === undefined ? {} : { sourceHash }),
    profile: profileValid ? "gdm-read-only-specialist/v1" : "invalid",
    hook: hookValid ? (target === "codex" ? "supported" : "not-required") : "invalid",
    runner: runnerValid ? "supported" : "invalid",
    problems,
  };
}

function targetManifestDoctorLines(home: string, codexHomePath: string, piAgentPath: string): string[] {
  const targets = [
    inspectTargetManifest("codex", join(codexHomePath, "skills")),
    inspectTargetManifest("claude", join(home, ".claude", "skills")),
    inspectTargetManifest("pi", join(piAgentPath, "skills")),
  ] as const;
  const lines = targets.map((result) => {
    const prefix = result.status === "valid" ? "OK" : result.status === "missing" ? "WARN" : "ERROR";
    const source = result.sourceHash === undefined ? "unavailable" : `${result.sourceHash.slice(0, 12)}…`;
    const detail = result.problems.length === 0 ? "" : ` — ${result.problems.join(", ")}`;
    return `  protocol target ${result.target}: ${prefix} manifest[${result.status}] source[${source}] profile[${result.profile}] hook[${result.hook}] runner[${result.runner}]${detail}`;
  });
  const sourceHashes = targets.map((target) => target.sourceHash);
  if (sourceHashes.every((hash): hash is string => hash !== undefined)) {
    lines.push(sourceHashes.every((hash) => hash === sourceHashes[0])
      ? `  protocol target source parity: OK [${sourceHashes[0]!.slice(0, 12)}…]`
      : "  protocol target source parity: ERROR [mismatch]");
  } else {
    lines.push("  protocol target source parity: WARN [unavailable]");
  }
  return lines;
}

function cmdDoctor(cwd: string): void {
  console.log(`gdm ${VERSION}`);
  const home = homedir();
  const codexEnv = { ...process.env, HOME: process.env.HOME ?? home };
  const codexHomePath = resolveCodexHome(cwd, codexEnv);
  const configuredPiAgentPath = process.env.PI_CODING_AGENT_DIR;
  const piAgentPath = configuredPiAgentPath === undefined || configuredPiAgentPath.length === 0
    ? join(home, ".pi", "agent")
    : isAbsolute(configuredPiAgentPath) ? resolve(configuredPiAgentPath) : resolve(cwd, configuredPiAgentPath);
  const repo = repoVersionFromSkills();
  if (repo) {
    if (repo.version === VERSION) {
      console.log(`  저장소: ${repo.version} (바이너리와 일치)`);
    } else {
      console.log(
        `  저장소: ${repo.version} — 바이너리(${VERSION})와 다릅니다 → ${join(repo.root, "install", "install.sh")} 재실행`,
      );
    }
  }
  for (const line of codexAgentLimitDoctorLines(cwd, codexEnv)) console.log(line);
  for (const line of codexAgentHookDoctorLines(cwd, codexEnv, process.execPath)) {
    console.log(line);
  }
  for (const line of targetManifestDoctorLines(home, codexHomePath, piAgentPath)) console.log(line);
  for (const name of SKILL_NAMES) {
    const claude = existsSync(join(home, ".claude", "skills", `gdm-${name}`));
    const codex = existsSync(join(codexHomePath, "skills", `gdm-${name}`));
    const pi = existsSync(join(piAgentPath, "skills", `gdm-${name}`));
    const mark = (ok: boolean) => (ok ? "OK" : "없음");
    console.log(`  gdm-${name}: claude[${mark(claude)}] codex[${mark(codex)}] pi[${mark(pi)}]`);
  }
  if (SKILL_NAMES.some((name) =>
    !existsSync(join(home, ".claude", "skills", `gdm-${name}`)) ||
    !existsSync(join(codexHomePath, "skills", `gdm-${name}`)) ||
    !existsSync(join(piAgentPath, "skills", `gdm-${name}`))
  )) {
    console.log(`  → 누락 스킬은 재설치로 채웁니다: curl -fsSL https://raw.githubusercontent.com/Gdm0714/gdm/main/install.sh | bash (소스 설치는 install/install.sh)`);
  }
  const works = listWorks(cwd);
  const active = works.filter((w) => !w.done);
  console.log(`  현재 디렉토리 작업: ${works.length}개 (진행 중 ${active.length}개)`);
}

function cmdWorkspace(cwd: string, args: string[]): void {
  const [subcommand, ...rest] = args;
  if (subcommand !== "fingerprint") {
    throw new GdmError("workspace 하위 명령은 fingerprint만 지원합니다", "usage");
  }
  ensureFlags(rest, [], ["json"]);
  if (!hasFlag(rest, "json")) {
    throw new GdmError("gdm workspace fingerprint는 --json이 필요합니다", "usage");
  }
  console.log(JSON.stringify(captureSourceFingerprint(cwd)));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const [command, ...rest] = argv;
  const [sub] = rest;
  // Habit commands are serialized by habit-ledger-file.ts. Nesting the repository
  // work-state lock here turns concurrent observations into avoidable lock timeouts.
  const mutating =
    command === "pass" || command === "attempt" || command === "recheck" || command === "done" ||
    command === "feedback" || command === "miss" || command === "repair" ||
    (command === "plan" && sub !== "list" && !(sub === "contract" && rest.includes("--check-commit"))) ||
    (command === "audit" && sub === "verdict") ||
    command === "protocol" ||
    (command === "preset" && sub !== "list") ||
    command === "delivery";
  let releaseLock: (() => void) | undefined;
  try {
    if (mutating) releaseLock = acquireRepositoryLock(cwd);
    switch (command) {
      case "device":
        await cmdDevice(cwd, rest);
        break;
      case "plan": {
        const [sub, ...planArgs] = rest;
        if (sub === "init") cmdPlanInit(cwd, planArgs);
        else if (sub === "add") cmdPlanAdd(cwd, planArgs);
        else if (sub === "list") cmdPlanList(cwd, planArgs);
        else if (sub === "edit") cmdPlanEdit(cwd, planArgs);
        else if (sub === "contract") cmdPlanContract(cwd, planArgs);
        else if (sub === "source") cmdPlanSource(cwd, planArgs);
        else {
          console.error(USAGE);
          process.exitCode = 2;
        }
        break;
      }
      case "pass":
        cmdPass(cwd, rest);
        break;
      case "attempt":
        cmdAttempt(cwd, rest);
        break;
      case "habit":
        cmdHabit(cwd, rest, now());
        break;
      case "recheck":
        cmdRecheck(cwd, rest);
        break;
      case "audit": {
        const [sub, ...auditArgs] = rest;
        if (sub === "brief") cmdAuditBrief(cwd, auditArgs);
        else if (sub === "verdict") cmdAuditVerdict(cwd, auditArgs);
        else {
          console.error(USAGE);
          process.exitCode = 2;
        }
        break;
      }
      case "done":
        cmdDone(cwd, rest);
        break;
      case "status":
        cmdStatus(cwd, rest);
        break;
      case "resume":
        cmdResume(cwd, rest);
        break;
      case "retro":
        cmdRetro(cwd, rest);
        break;
      case "feedback":
        cmdFeedback(cwd, rest);
        break;
      case "preset":
        cmdPreset(cwd, rest);
        break;
      case "miss":
        cmdMiss(cwd, rest);
        break;
      case "repair":
        cmdRepair(cwd, rest);
        break;
      case "delivery":
        cmdDelivery(cwd, rest, now());
        break;
      case "protocol":
        cmdProtocol(cwd, rest, now());
        break;
      case "context":
        cmdContext(rest, rest[0] === "query" ? readFileSync(0, "utf8") : "", process.env);
        break;
      case "agent":
        cmdAgent(
          cwd,
          rest,
          rest[0] === "hook" ? readFileSync(0, "utf8") : "",
          process.env,
          process.execPath,
        );
        break;
      case "doctor":
        cmdDoctor(cwd);
        break;
      case "workspace":
        cmdWorkspace(cwd, rest);
        break;
      case "--version":
        console.log(VERSION);
        break;
      default:
        console.error(USAGE);
        process.exitCode = command === undefined || command === "--help" ? 0 : 2;
    }
  } catch (error) {
    if (error instanceof AgentCliError) {
      console.error(`오류(${error.code}): ${error.message}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof AgentHooksConfigError) {
      console.error(`오류(${error.code}): ${error.message}`);
      process.exitCode = 3;
      return;
    }
    if (error instanceof GdmError) {
      console.error(`오류(${error.code}): ${error.message}`);
      const usage = new Set(["usage", "constraint_required", "state_corrupt", "habit_ledger_corrupt", "brief_checks_invalid"]);
      const invalid = new Set([
        "work_not_found",
        "contract_conflict",
        "contract_locked",
        "commit_transition_conflict",
        "attempt_id_conflict",
        "attempt_not_found",
        "attempt_transition",
        "event_conflict",
        "habit_transition",
        "stale_correction",
        "evaluation_activation_mismatch",
        "habit_rule_changed",
        "habit_activation_locked",
        "habit_activation_conflict",
        "habit_event_invalid",
        "handoff_id_conflict",
        "handoff_time_invalid",
        "receipt_time_invalid",
        "handoff_not_found", "claim_not_found", "claim_id_conflict", "receipt_conflict", "receipt_transition",
        "runner_observation_invalid",
        "receiver_ack_invalid",
        "artifact_encoding_invalid",
        "audit_verdict_invalid",
        "audit_verdict_mismatch",
      ]);
      const policy = new Set([
        "commit_forbidden", "unchanged_retry", "stale_evidence", "delivery_gate", "scope_violation",
        "red_evidence_required", "red_expected_failure", "red_not_allowed", "simplification_required",
        "expert_evidence_required", "expert_review_required", "scope_locked", "plan_fingerprint_mismatch",
        "state_fingerprint_mismatch", "source_fingerprint_mismatch",
        "capability_unsupported", "receiver_mismatch", "claim_conflict", "bundle_mismatch",
        "artifact_missing", "artifact_changed",
        "artifact_too_large", "output_too_large", "bundle_too_large",
        "output_missing", "output_changed", "receiver_blocked", "provider_executable_changed",
      ]);
      const privacy = new Set(["privacy_rejected", "path_rejected"]);
      if (usage.has(error.code)) process.exitCode = 2;
      else if (invalid.has(error.code)) process.exitCode = 3;
      else if (policy.has(error.code)) process.exitCode = 4;
      else if (privacy.has(error.code)) process.exitCode = 5;
      else process.exitCode = 1;
      return;
    }
    console.error(`오류(internal): ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    releaseLock?.();
  }
}

await main();
