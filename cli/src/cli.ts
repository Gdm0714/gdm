#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  addCheck,
  assertPassable,
  closeWork,
  editCheck,
  GdmError,
  initWork,
  passCheck,
  provenCount,
} from "./state.ts";
import {
  appendJournal,
  journalTail,
  listWorks,
  resolveWork,
  saveWork,
  workDir,
  workExists,
} from "./store.ts";
import type { Evidence, Work } from "./types.ts";

const VERSION = "0.2.0";
const CMD_TIMEOUT_MS = 300_000;

const USAGE = `gdm ${VERSION} — 검증 항목 기반 작업 하네스

사용법:
  gdm plan init --slug <슬러그> (--brief <설명> | --brief-file <파일>)
  gdm plan add  --desc <항목> --cmd <재현 명령> --expect <기대> [--manual] [--slug <슬러그>]
  gdm plan list [--json] [--slug <슬러그>]
  gdm plan edit --check <id> [--desc ..] [--cmd ..] [--expect ..] --reason <사유> [--slug <슬러그>]
  gdm pass <id> [--note <메모>] [--slug <슬러그>]           # 자동 항목: cmd를 직접 실행해 판정
  gdm pass <id> --manual --observed <확인 기록 파일> [...]   # 수동 항목: 스크린샷 등 제출
  gdm done [--slug <슬러그>]
  gdm resume [--json] [--slug <슬러그>]
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

function journalDenied(cwd: string, slug: string, action: string, error: GdmError, ts: string): void {
  appendJournal(cwd, slug, { ts, event: "denied", action, code: error.code, message: error.message });
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
  const work = initWork(slug, brief, ts);
  appendJournal(cwd, slug, { ts, event: "plan.init", brief: work.brief });
  saveWork(cwd, work);
  console.log(`작업 시작: ${slug}`);
  console.log(`다음: gdm plan add --desc <항목> --cmd <재현 명령> --expect <기대>`);
}

function cmdPlanAdd(cwd: string, args: string[]): void {
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
    throw new GdmError(`재현 명령 실행 실패: ${result.error.message}`, "cmd_failed");
  }
  if (result.status !== 0) {
    throw new GdmError(
      `재현 명령이 실패했습니다 (exit ${result.status}). 출력: ${observed}\n${tailLines(output, 15)}`,
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
          `${id}는 자동 검증 항목입니다. gdm pass가 재현 명령을 직접 실행하므로 --manual/--observed는 쓸 수 없습니다`,
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
    if (error instanceof GdmError) journalDenied(cwd, work.slug, "pass", error, ts);
    throw error;
  }
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

function cmdDone(cwd: string, args: string[]): void {
  const ts = now();
  const work = resolveWork(cwd, readFlag(args, "slug"));
  try {
    const stale = verifyEvidence(cwd, work);
    if (stale.length > 0) {
      const ids = stale.map((s) => s.id);
      const reverted: Work = {
        ...work,
        checks: work.checks.map((c) =>
          ids.includes(c.id) ? { ...c, status: "open" as const, evidence: undefined } : c,
        ),
      };
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

function cmdResume(cwd: string, args: string[]): void {
  const work = resolveWork(cwd, readFlag(args, "slug"));
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify({ work, journal: journalTail(cwd, work.slug) }, null, 2));
    return;
  }
  const { proven, total } = provenCount(work);
  console.log(`# ${work.slug} — ${work.done ? "완료" : "진행 중"} (${proven}/${total})`);
  console.log(`목표: ${work.brief}`);
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

function cmdDoctor(cwd: string): void {
  console.log(`gdm ${VERSION}`);
  for (const [label, path] of [
    ["claude 스킬", join(homedir(), ".claude", "skills", "gdm-go")],
    ["codex 스킬 ", join(homedir(), ".codex", "skills", "gdm-go")],
  ] as const) {
    console.log(`  ${label}: ${path} ${existsSync(path) ? "[OK]" : "[없음 — install/install.sh 실행]"}`);
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
      case "done":
        cmdDone(cwd, rest);
        break;
      case "resume":
        cmdResume(cwd, rest);
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
