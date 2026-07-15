#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  prepareFailure,
  prepareRetry,
  recordFailure,
  recordRetry,
} from "./attempt.ts";
import { latestAttemptStates, readAttemptEvents } from "./attempt-journal.ts";
import { parseBriefChecks } from "./brief-checks.ts";
import { readContainedFile } from "./contained-file.ts";
import {
  addConstraints,
  assertCommitAllowed,
  createContract,
  parseCommitState,
  parseConstraints,
  safeText,
  transitionCommit,
} from "./contract.ts";
import { activateHabit, cmdHabit } from "./habit-cli.ts";
import { scanHabitArgs } from "./habit-cli-args.ts";
import { habitOverview } from "./habit-summary.ts";
import {
  addCheck,
  assertPassable,
  checksHash,
  closeWork,
  editCheck,
  findCheck,
  GdmError,
  initWork,
  passCheck,
  provenCount,
  recordAudit,
  refreshEvidence,
  revertChecks,
} from "./state.ts";
import {
  appendJournal,
  checkHow,
  checkMark,
  journalTail,
  listWorks,
  loadPresets,
  readJournal,
  resolveWork,
  resolveWorkForRead,
  savePresets,
  saveWork,
  workDir,
  workExists,
} from "./store.ts";
import type { Evidence, Work } from "./types.ts";

const VERSION = "0.8.0";
const CMD_TIMEOUT_MS = 300_000;

const USAGE = `gdm ${VERSION} — 작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우

흐름: 약속 → 증명 → 관찰 → 습관 → 비교

사용법:
  gdm plan init --slug <슬러그> (--brief <설명> | --brief-file <파일>) [--audit] (--require <약속> | --forbid <금지>)...
  gdm plan contract [--slug <슬러그>] (--require <약속> | --forbid <금지>)...
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
  gdm plan add  --desc <항목> --cmd <검증 명령> --expect <기대> [--manual] [--slug <슬러그>]
  gdm plan add  --from-brief [--dry-run] [--slug <슬러그>]   # brief의 "## 검증 항목" 초안 일괄 등록
  gdm plan list [--json] [--slug <슬러그>]
  gdm plan edit --check <id> [--desc ..] [--cmd ..] [--expect ..] --reason <사유> [--slug <슬러그>]
  gdm pass <id> [--note <메모>] [--slug <슬러그>]           # 자동 항목: cmd를 직접 실행해 판정
  gdm pass <id> --manual --observed <확인 기록 파일> [...]   # 수동 항목: 스크린샷 등 제출
  gdm recheck [--check <id>] [--slug <슬러그>]              # 통과한 자동 항목 재실행 (회귀 검출)
  gdm audit brief [--json] [--slug <슬러그>]                # 검수자에게 줄 브리핑 패키지 출력
  gdm audit verdict (--pass | --fail) --report <검수보고 파일> [--slug <슬러그>]
  gdm done [--slug <슬러그>]
  gdm status [--json] [--checks]                            # 현재 디렉토리 전체 작업 현황 (--checks: 항목 상세)
  gdm resume [--json] [--slug <슬러그>]
  gdm retro [--all] [--json] [--slug <슬러그>]              # 회고 (--all: 전체 작업 횡단 + 개선 제안)
  gdm miss --desc <내용> [--type <유형>] [--check <id>] [--slug <슬러그>]  # 게이트 통과 후 발견된 결함 기록
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

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new GdmError(`--${name} 값이 필요합니다`, "usage");
    }
    return value;
  }
  const prefix = `--${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function readFlags(args: string[], name: string): readonly string[] {
  const values: string[] = [];
  const token = `--${name}`;
  const prefix = `${token}=`;
  for (let index = 0; index < args.length; index++) {
    const current = args[index];
    if (current === token) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new GdmError(`${token} 값이 필요합니다`, "usage");
      }
      values.push(value);
      index++;
    } else if (current?.startsWith(prefix)) {
      values.push(current.slice(prefix.length));
    }
  }
  return values;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function ensureFlags(args: string[], value: string[], bool: string[] = []): void {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    if (value.includes(name)) {
      if (eq < 0) i++;
      continue;
    }
    if (bool.includes(name)) {
      if (eq >= 0) throw new GdmError(`--${name}는 값을 받지 않습니다`, "usage");
      continue;
    }
    const known = [...value, ...bool].map((f) => `--${f}`).join(", ") || "없음";
    throw new GdmError(`알 수 없는 플래그: --${name} (가능: ${known})`, "usage");
  }
}

function now(): string {
  return new Date().toISOString();
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
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
    return `  ${checkMark(c)} ${c.id} ${c.desc} — ${detail}`;
  });
}

function workHeader(work: Work): string {
  const { proven, total } = provenCount(work);
  return `# ${work.slug} — ${work.done ? "완료" : "진행 중"} (${proven}/${total})`;
}

function contractLine(work: Work): string {
  return `계약: 필수 ${work.contract.required.length} · 금지 ${work.contract.forbidden.length} · 커밋 ${work.contract.commit}`;
}

function cmdPlanInit(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug", "brief", "brief-file", "require", "forbid"], ["audit"]);
  const ts = now();
  const slug = readFlag(args, "slug");
  if (!slug) throw new GdmError("--slug가 필요합니다", "usage");
  const constraints = parseConstraints(readFlags(args, "require"), readFlags(args, "forbid"));
  const contract = createContract(constraints);
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
  const auditRequired = hasFlag(args, "audit");
  const work = initWork(slug, brief, ts, auditRequired, contract);
  appendJournal(cwd, slug, { ts, event: "plan.init", brief: work.brief, auditRequired, contract });
  saveWork(cwd, work);
  console.log(`작업 시작: ${slug}${auditRequired ? " (검수 필수)" : ""}`);
  console.log(`다음: gdm plan add --desc <항목> --cmd <검증 명령> --expect <기대>`);
}

function cmdPlanContract(cwd: string, args: string[]): void {
  scanHabitArgs(args);
  ensureFlags(args, ["slug", "require", "forbid", "commit", "reason", "activate-habit"], ["check-commit"]);
  const requiredValues = readFlags(args, "require");
  const forbiddenValues = readFlags(args, "forbid");
  const hasConstraints = requiredValues.length > 0 || forbiddenValues.length > 0;
  const checkCommit = hasFlag(args, "check-commit");
  const commitValue = readFlag(args, "commit");
  const activationValues = readFlags(args, "activate-habit");
  const activationValue = activationValues[0];
  const reasonValue = readFlag(args, "reason");
  const modes = Number(hasConstraints) + Number(checkCommit) + Number(commitValue !== undefined) + Number(activationValue !== undefined);
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
  if (readFlag(args, "desc") || readFlag(args, "cmd") || readFlag(args, "expect") || hasFlag(args, "manual")) {
    throw new GdmError("--from-brief는 --desc/--cmd/--expect/--manual과 함께 쓸 수 없습니다", "usage");
  }
  const ts = now();
  let work = resolveWork(cwd, readFlag(args, "slug"));
  const inputs = parseBriefChecks(work.brief);
  const added: { id: string; desc: string; cmd: string | null; expect: string; manual: boolean }[] = [];
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
      source: "brief",
    });
  }
  saveWork(cwd, work);
  console.log(`brief에서 ${added.length}개 항목 등록 (총 ${work.checks.length}개)`);
}

function cmdPlanAdd(cwd: string, args: string[]): void {
  ensureFlags(args, ["desc", "cmd", "expect", "slug"], ["manual", "from-brief", "dry-run"]);
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
  });
  appendJournal(cwd, work.slug, {
    ts,
    event: "plan.add",
    check: check.id,
    desc: check.desc,
    cmd: check.cmd,
    expect: check.expect,
    manual: check.manual,
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
  ensureFlags(args, ["check", "desc", "cmd", "expect", "reason", "slug"]);
  const ts = now();
  const id = readFlag(args, "check");
  if (!id) throw new GdmError("--check <id>가 필요합니다", "usage");
  const reason = readFlag(args, "reason") ?? "";
  const work = resolveWork(cwd, readFlag(args, "slug"));
  const patch = {
    desc: readFlag(args, "desc"),
    cmd: resolveCmd(cwd, readFlag(args, "cmd")),
    expect: readFlag(args, "expect"),
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

function buildManualEvidence(cwd: string, args: string[], note?: string): Omit<Evidence, "at"> {
  const observed = readFlag(args, "observed");
  if (!observed) {
    throw new GdmError("수동 항목은 --observed <확인 기록 파일(스크린샷 등)>이 필요합니다", "usage");
  }
  const contained = readContainedFile(cwd, observed, "observed");
  if (contained.content.length === 0) throw new GdmError(`증거 파일이 비어 있습니다: ${observed}`, "observed_empty");
  return { observed, sha256: contained.sha256, manual: true, note };
}

function buildAutoEvidence(
  cwd: string,
  slug: string,
  id: string,
  cmd: string,
  note?: string,
): Omit<Evidence, "at"> {
  const outDir = join(workDir(cwd, slug), "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${id}.txt`);
  console.log(`실행: ${cmd}`);
  const result = spawnSync("bash", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    timeout: CMD_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
  const body = `$ ${cmd}\n(exit ${result.status})\n\n${output}`;
  writeFileSync(outPath, body);
  const observed = relative(cwd, outPath);
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

function cmdPass(cwd: string, args: string[]): void {
  const ts = now();
  const id = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  if (!id) throw new GdmError("통과시킬 항목 id가 필요합니다: gdm pass <id>", "usage");
  const rest = args.slice(1);
  ensureFlags(rest, ["observed", "note", "slug"], ["manual"]);
  const work = resolveWork(cwd, readFlag(rest, "slug"));
  try {
    const check = assertPassable(work, id);
    const note = readFlag(rest, "note");
    let evidence: Omit<Evidence, "at">;
    if (check.manual) {
      if (!hasFlag(rest, "manual")) {
        throw new GdmError(
          `${id}는 수동 확인 항목입니다. --manual과 함께 확인 기록(스크린샷 등) 경로를 제출하세요`,
          "manual_required",
        );
      }
      evidence = buildManualEvidence(cwd, rest, note);
    } else {
      if (hasFlag(rest, "manual") || readFlag(rest, "observed")) {
        throw new GdmError(
          `${id}는 자동 검증 항목입니다. gdm pass가 검증 명령을 직접 실행하므로 --manual/--observed는 쓸 수 없습니다`,
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
): { work: Work; failed: string[] } {
  let next = work;
  const failed: string[] = [];
  for (const check of targets) {
    try {
      const evidence = buildAutoEvidence(cwd, next.slug, check.id, check.cmd!);
      next = refreshEvidence(next, check.id, evidence, ts);
      appendJournal(cwd, next.slug, { ts, event: "recheck", check: check.id, ok: true, sha256: evidence.sha256 });
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
  ensureFlags(args, ["check", "slug"]);
  const ts = now();
  const initial = resolveWork(cwd, readFlag(args, "slug"));
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
    console.error(`재검증 결과: ${targets.length}개 중 ${failed.length}개 실패 (${failed.join(", ")}) — 현재 ${proven}/${total}`);
    process.exit(1);
  }
  console.log(`재검증 결과: ${targets.length}개 전부 통과 (${proven}/${total})`);
}

function verifyEvidence(cwd: string, work: Work): { id: string; why: string }[] {
  const problems: { id: string; why: string }[] = [];
  for (const check of work.checks) {
    if (check.status !== "proven" || !check.evidence) continue;
    const path = resolve(cwd, check.evidence.observed);
    if (!existsSync(path)) {
      problems.push({ id: check.id, why: `${check.id}: 증거 파일 없음 (${check.evidence.observed})` });
      continue;
    }
    if (sha256(readFileSync(path)) !== check.evidence.sha256) {
      problems.push({
        id: check.id,
        why: `${check.id}: 증거 파일이 pass 이후 변경됨 (${check.evidence.observed})`,
      });
    }
  }
  return problems;
}

function auditState(work: Work): string {
  if (!work.auditRequired) return "";
  if (!work.audit) return "검수: 필요 (미실시)";
  if (work.audit.result === "fail") return "검수: 반려";
  return work.audit.stateHash === checksHash(work) ? "검수: 통과" : "검수: 무효 (상태 변경됨, 재검수 필요)";
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
  console.log("");
  console.log("## 확인 항목과 증거");
  for (const c of work.checks) {
    const how = c.manual ? "(수동 확인)" : c.cmd;
    console.log(`- ${c.id} [${c.status}] ${c.desc}`);
    console.log(`  검증: ${how} → 기대: ${c.expect}`);
    if (c.evidence) console.log(`  증거: ${c.evidence.observed} (sha256 ${c.evidence.sha256.slice(0, 12)}…)`);
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
  console.log(`판정 기록: gdm audit verdict (--pass | --fail) --report <검수보고 경로>`);
  if (proven < total) console.log(`주의: 미통과 항목이 있어 verdict는 아직 기록할 수 없습니다`);
}

function cmdAuditVerdict(cwd: string, args: string[]): void {
  ensureFlags(args, ["report", "slug"], ["pass", "fail"]);
  const ts = now();
  const pass = hasFlag(args, "pass");
  const fail = hasFlag(args, "fail");
  if (pass === fail) throw new GdmError("--pass 또는 --fail 중 정확히 하나가 필요합니다", "usage");
  const report = readFlag(args, "report");
  if (!report) throw new GdmError("--report <검수보고 파일>이 필요합니다", "usage");
  const reportPath = resolve(cwd, report);
  if (!existsSync(reportPath)) throw new GdmError(`검수보고 파일이 없습니다: ${report}`, "report_missing");
  if (statSync(reportPath).size === 0) throw new GdmError(`검수보고 파일이 비어 있습니다: ${report}`, "report_empty");
  const work = resolveWork(cwd, readFlag(args, "slug"));
  try {
    const next = recordAudit(work, pass ? "pass" : "fail", report, ts);
    appendJournal(cwd, work.slug, {
      ts,
      event: "audit",
      result: next.audit!.result,
      report,
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
  ensureFlags(args, ["slug"]);
  const ts = now();
  const work = resolveWork(cwd, readFlag(args, "slug"));
  try {
    const autoTargets = work.checks.filter((c) => c.status === "proven" && !c.manual);
    const { work: rechecked, failed } = runRecheck(cwd, work, ts, autoTargets);
    if (failed.length > 0) {
      saveWork(cwd, rechecked);
      throw new GdmError(
        `완료 전 재검증 실패 — ${failed.join(", ")}가 open으로 회귀했습니다. 코드를 고치고 다시 pass 하세요`,
        "unproven",
      );
    }
    const stale = verifyEvidence(cwd, rechecked);
    if (stale.length > 0) {
      const ids = stale.map((s) => s.id);
      const reverted = revertChecks(rechecked, ids);
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
        contract: w.contract,
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
  const audit = auditState(work);
  if (audit) console.log(audit);
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

function cmdRetroAll(cwd: string, json: boolean): void {
  const works = listWorks(cwd);
  if (works.length === 0) {
    console.log("작업이 없습니다");
    return;
  }
  const habits = habitOverview(cwd);
  const deniedByCode = new Map<string, number>();
  const editReasons: { work: string; check?: unknown; reason?: unknown }[] = [];
  const misses: { work: string; type?: unknown; check?: unknown; desc?: unknown }[] = [];
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
    suggestions.push(`recheck가 회귀 ${recheckFails}건을 잡음 — done 전 recheck를 기본 습관으로`);
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
  console.error(USAGE);
  process.exit(2);
}

const SKILL_NAMES = ["go", "full", "plan", "review", "analyze", "research", "pr", "ui", "db", "design", "reflect"] as const;

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

function cmdDoctor(cwd: string): void {
  console.log(`gdm ${VERSION}`);
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
  for (const name of SKILL_NAMES) {
    const claude = existsSync(join(homedir(), ".claude", "skills", `gdm-${name}`));
    const codex = existsSync(join(homedir(), ".codex", "skills", `gdm-${name}`));
    const mark = (ok: boolean) => (ok ? "OK" : "없음");
    console.log(`  gdm-${name}: claude[${mark(claude)}] codex[${mark(codex)}]`);
  }
  if (SKILL_NAMES.some((name) =>
    !existsSync(join(homedir(), ".claude", "skills", `gdm-${name}`)) ||
    !existsSync(join(homedir(), ".codex", "skills", `gdm-${name}`))
  )) {
    console.log(`  → 누락 스킬은 재설치로 채웁니다: curl -fsSL https://raw.githubusercontent.com/Gdm0714/gdm/main/install.sh | bash (소스 설치는 install/install.sh)`);
  }
  const works = listWorks(cwd);
  const active = works.filter((w) => !w.done);
  console.log(`  현재 디렉토리 작업: ${works.length}개 (진행 중 ${active.length}개)`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "plan": {
        const [sub, ...planArgs] = rest;
        if (sub === "init") cmdPlanInit(cwd, planArgs);
        else if (sub === "add") cmdPlanAdd(cwd, planArgs);
        else if (sub === "list") cmdPlanList(cwd, planArgs);
        else if (sub === "edit") cmdPlanEdit(cwd, planArgs);
        else if (sub === "contract") cmdPlanContract(cwd, planArgs);
        else {
          console.error(USAGE);
          process.exit(2);
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
          process.exit(2);
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
      case "preset":
        cmdPreset(cwd, rest);
        break;
      case "miss":
        cmdMiss(cwd, rest);
        break;
      case "doctor":
        cmdDoctor(cwd);
        break;
      case "--version":
        console.log(VERSION);
        break;
      default:
        console.error(USAGE);
        process.exit(command === undefined || command === "--help" ? 0 : 2);
    }
  } catch (error) {
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
      ]);
      const policy = new Set(["commit_forbidden", "unchanged_retry", "stale_evidence"]);
      const privacy = new Set(["privacy_rejected", "path_rejected"]);
      if (usage.has(error.code)) process.exit(2);
      if (invalid.has(error.code)) process.exit(3);
      if (policy.has(error.code)) process.exit(4);
      if (privacy.has(error.code)) process.exit(5);
      process.exit(1);
    }
    console.error(`오류(internal): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
