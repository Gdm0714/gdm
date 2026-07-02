#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  addCheck,
  assertPassable,
  checksHash,
  closeWork,
  editCheck,
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
  journalTail,
  listWorks,
  readJournal,
  resolveWork,
  saveWork,
  workDir,
  workExists,
} from "./store.ts";
import type { Evidence, Work } from "./types.ts";

const VERSION = "0.4.0";
const CMD_TIMEOUT_MS = 300_000;

const USAGE = `gdm ${VERSION} — 검증 항목 기반 작업 하네스

사용법:
  gdm plan init --slug <슬러그> (--brief <설명> | --brief-file <파일>) [--audit]
  gdm plan add  --desc <항목> --cmd <검증 명령> --expect <기대> [--manual] [--slug <슬러그>]
  gdm plan list [--json] [--slug <슬러그>]
  gdm plan edit --check <id> [--desc ..] [--cmd ..] [--expect ..] --reason <사유> [--slug <슬러그>]
  gdm pass <id> [--note <메모>] [--slug <슬러그>]           # 자동 항목: cmd를 직접 실행해 판정
  gdm pass <id> --manual --observed <확인 기록 파일> [...]   # 수동 항목: 스크린샷 등 제출
  gdm recheck [--check <id>] [--slug <슬러그>]              # 통과한 자동 항목 재실행 (회귀 검출)
  gdm audit brief [--json] [--slug <슬러그>]                # 검수자에게 줄 브리핑 패키지 출력
  gdm audit verdict (--pass | --fail) --report <검수보고 파일> [--slug <슬러그>]
  gdm done [--slug <슬러그>]
  gdm status [--json]                                       # 현재 디렉토리 전체 작업 현황
  gdm resume [--json] [--slug <슬러그>]
  gdm retro [--json] [--slug <슬러그>]                      # journal 회고 (거부·수정 이력)
  gdm doctor

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
    if (value === undefined) throw new GdmError(`--${name} 값이 필요합니다`, "usage");
    return value;
  }
  const prefix = `--${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
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
    const mark = c.status === "proven" ? "✅" : "⬜";
    const how = c.manual ? "(수동 확인)" : `${c.cmd}`;
    const detail = c.status === "proven" ? `증거: ${c.evidence?.observed}` : `재현: ${how} → 기대: ${c.expect}`;
    return `  ${mark} ${c.id} ${c.desc} — ${detail}`;
  });
}

function cmdPlanInit(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug", "brief", "brief-file"], ["audit"]);
  const ts = now();
  const slug = readFlag(args, "slug");
  if (!slug) throw new GdmError("--slug가 필요합니다", "usage");
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
  const work = initWork(slug, brief, ts, auditRequired);
  appendJournal(cwd, slug, { ts, event: "plan.init", brief: work.brief, auditRequired });
  saveWork(cwd, work);
  console.log(`작업 시작: ${slug}${auditRequired ? " (검수 필수)" : ""}`);
  console.log(`다음: gdm plan add --desc <항목> --cmd <검증 명령> --expect <기대>`);
}

function cmdPlanAdd(cwd: string, args: string[]): void {
  ensureFlags(args, ["desc", "cmd", "expect", "slug"], ["manual"]);
  const ts = now();
  const work = resolveWork(cwd, readFlag(args, "slug"));
  const { work: next, check } = addCheck(work, {
    desc: readFlag(args, "desc") ?? "",
    cmd: readFlag(args, "cmd"),
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
  const work = resolveWork(cwd, readFlag(args, "slug"));
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify(work, null, 2));
    return;
  }
  const { proven, total } = provenCount(work);
  console.log(`# ${work.slug} — ${work.done ? "완료" : "진행 중"} (${proven}/${total})`);
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
    cmd: readFlag(args, "cmd"),
    expect: readFlag(args, "expect"),
  };
  const { work: next, reverted } = editCheck(work, id, patch, reason);
  appendJournal(cwd, work.slug, { ts, event: "plan.edit", check: id, patch, reason, reverted });
  saveWork(cwd, next);
  console.log(`${id} 수정됨${reverted ? " (통과 상태가 해제되어 재검증 필요)" : ""}`);
}

function buildManualEvidence(cwd: string, args: string[], note?: string): Omit<Evidence, "at"> {
  const observed = readFlag(args, "observed");
  if (!observed) {
    throw new GdmError("수동 항목은 --observed <확인 기록 파일(스크린샷 등)>이 필요합니다", "usage");
  }
  const path = resolve(cwd, observed);
  if (!existsSync(path)) throw new GdmError(`증거 파일이 없습니다: ${observed}`, "observed_missing");
  if (statSync(path).size === 0) throw new GdmError(`증거 파일이 비어 있습니다: ${observed}`, "observed_empty");
  return { observed, sha256: sha256(readFileSync(path)), manual: true, note };
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

function cmdRecheck(cwd: string, args: string[]): void {
  ensureFlags(args, ["check", "slug"]);
  const ts = now();
  let work = resolveWork(cwd, readFlag(args, "slug"));
  const only = readFlag(args, "check");
  const targets = work.checks.filter(
    (c) => c.status === "proven" && !c.manual && (!only || c.id === only),
  );
  if (only && targets.length === 0) {
    throw new GdmError(`${only}는 재검증 대상이 아닙니다 (통과한 자동 항목만 가능)`, "not_recheckable");
  }
  if (targets.length === 0) {
    console.log("재검증할 자동 통과 항목이 없습니다");
    return;
  }
  const failed: string[] = [];
  for (const check of targets) {
    try {
      const evidence = buildAutoEvidence(cwd, work.slug, check.id, check.cmd!);
      work = refreshEvidence(work, check.id, evidence, ts);
      appendJournal(cwd, work.slug, { ts, event: "recheck", check: check.id, ok: true, sha256: evidence.sha256 });
      console.log(`${check.id} 재검증 통과`);
    } catch (error) {
      if (!(error instanceof GdmError) || error.code !== "cmd_failed") throw error;
      work = revertChecks(work, [check.id]);
      failed.push(check.id);
      appendJournal(cwd, work.slug, { ts, event: "recheck", check: check.id, ok: false, message: error.message });
      console.log(`${check.id} 재검증 실패 — open으로 회귀`);
    }
  }
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
  const work = resolveWork(cwd, readFlag(args, "slug"));
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
    const stale = verifyEvidence(cwd, work);
    if (stale.length > 0) {
      const ids = stale.map((s) => s.id);
      const reverted = revertChecks(work, ids);
      appendJournal(cwd, work.slug, { ts, event: "evidence_stale", checks: ids });
      saveWork(cwd, reverted);
      throw new GdmError(
        `증거 재검증 실패 — 해당 항목을 open으로 되돌렸습니다. 다시 pass 하세요:\n  ${stale
          .map((s) => s.why)
          .join("\n  ")}`,
        "evidence_stale",
      );
    }
    const next = closeWork(work, ts);
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
  ensureFlags(args, [], ["json"]);
  const works = listWorks(cwd);
  if (hasFlag(args, "json")) {
    const summary = works.map((w) => {
      const { proven, total } = provenCount(w);
      const last = journalTail(cwd, w.slug, 1)[0];
      return { slug: w.slug, done: w.done, proven, total, lastEvent: last?.event, lastAt: last?.ts };
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
  }
}

function cmdResume(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug"], ["json"]);
  const work = resolveWork(cwd, readFlag(args, "slug"));
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify({ work, journal: journalTail(cwd, work.slug) }, null, 2));
    return;
  }
  const { proven, total } = provenCount(work);
  console.log(`# ${work.slug} — ${work.done ? "완료" : "진행 중"} (${proven}/${total})`);
  console.log(`목표: ${work.brief}`);
  const audit = auditState(work);
  if (audit) console.log(audit);
  console.log("항목:");
  for (const line of checkLine(work)) console.log(line);
  const tail = journalTail(cwd, work.slug, 5);
  if (tail.length > 0) {
    console.log("최근 기록:");
    for (const ev of tail) console.log(`  - ${ev.ts} ${ev.event}${ev.check ? ` ${ev.check}` : ""}`);
  }
  if (!work.done) {
    console.log("다음: 미통과 항목을 구현한 뒤 gdm pass <id>");
  }
}

function cmdRetro(cwd: string, args: string[]): void {
  ensureFlags(args, ["slug"], ["json"]);
  const work = resolveWork(cwd, readFlag(args, "slug"));
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

const SKILL_NAMES = ["go", "full", "plan", "review", "analyze", "research"] as const;

function cmdDoctor(cwd: string): void {
  console.log(`gdm ${VERSION}`);
  for (const name of SKILL_NAMES) {
    const claude = existsSync(join(homedir(), ".claude", "skills", `gdm-${name}`));
    const codex = existsSync(join(homedir(), ".codex", "skills", `gdm-${name}`));
    const mark = (ok: boolean) => (ok ? "OK" : "없음");
    console.log(`  gdm-${name}: claude[${mark(claude)}] codex[${mark(codex)}]`);
  }
  if (SKILL_NAMES.some((n) => !existsSync(join(homedir(), ".claude", "skills", `gdm-${n}`)))) {
    console.log(`  → 누락 스킬은 install/install.sh 실행으로 설치`);
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
        else {
          console.error(USAGE);
          process.exit(2);
        }
        break;
      }
      case "pass":
        cmdPass(cwd, rest);
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
      process.exit(error.code === "usage" ? 2 : 1);
    }
    console.error(`오류(internal): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
