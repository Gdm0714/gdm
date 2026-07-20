import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { GdmError, provenCount, validateSlug, validateWork } from "./state.ts";
import type { Check, JournalEvent, Work } from "./types.ts";

const ROOT = ".gdm";

function atomicWriteFile(path: string, body: string | Uint8Array): void {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmp, body, { flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function workDir(cwd: string, slug: string): string {
  validateSlug(slug);
  return join(cwd, ROOT, slug);
}

export function workExists(cwd: string, slug: string): boolean {
  return existsSync(join(workDir(cwd, slug), "checks.json"));
}

export function loadWork(cwd: string, slug: string): Work {
  const path = join(workDir(cwd, slug), "checks.json");
  if (!existsSync(path)) throw new GdmError(`작업 "${slug}"가 없습니다`, "work_not_found");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new GdmError(`상태 파일이 손상됐습니다 (${path}): JSON 파싱 실패`, "state_corrupt");
  }
  const work = validateWork(raw, path);
  if (work.slug !== slug) {
    throw new GdmError(
      `상태 파일이 손상됐습니다 (${path}): 디렉토리(${slug})와 slug(${work.slug}) 불일치`,
      "state_corrupt",
    );
  }
  return work;
}

export function saveWork(cwd: string, work: Work): void {
  const dir = workDir(cwd, work.slug);
  mkdirSync(join(dir, "out"), { recursive: true });
  const path = join(dir, "checks.json");
  atomicWriteFile(path, JSON.stringify(work, null, 2) + "\n");
  atomicWriteFile(join(dir, "work.md"), renderWorkMd(work));
}

export function repairTrailingNulWork(
  cwd: string,
  slug: string,
): { work: Work; removedBytes: number } {
  const path = join(workDir(cwd, slug), "checks.json");
  if (!existsSync(path)) throw new GdmError(`작업 "${slug}"가 없습니다`, "work_not_found");

  const contents = readFileSync(path);
  let end = contents.length;
  while (end > 0 && contents[end - 1] === 0) end--;
  const removedBytes = contents.length - end;
  if (removedBytes === 0) {
    throw new GdmError(
      `복구를 거부했습니다 (${path}): 파일 끝에 NUL 바이트가 없습니다`,
      "repair_not_applicable",
    );
  }

  let raw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents.subarray(0, end));
    raw = JSON.parse(text);
  } catch {
    throw new GdmError(
      `복구를 거부했습니다 (${path}): trailing NUL 제거 후에도 JSON 파싱 실패`,
      "state_corrupt",
    );
  }
  const work = validateWork(raw, path);
  if (work.slug !== slug) {
    throw new GdmError(
      `복구를 거부했습니다 (${path}): 디렉토리(${slug})와 slug(${work.slug}) 불일치`,
      "state_corrupt",
    );
  }

  atomicWriteFile(path, contents.subarray(0, end));
  return { work, removedBytes };
}

export function appendJournal(cwd: string, slug: string, event: JournalEvent): void {
  const dir = workDir(cwd, slug);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "journal.jsonl"), JSON.stringify(event) + "\n");
}

export function readJournal(cwd: string, slug: string): JournalEvent[] {
  const path = join(workDir(cwd, slug), "journal.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as JournalEvent);
}

export function journalTail(cwd: string, slug: string, n = 8): JournalEvent[] {
  return readJournal(cwd, slug).slice(-n);
}

export function listWorks(cwd: string): Work[] {
  const root = join(cwd, ROOT);
  if (!existsSync(root)) return [];
  const works: Work[] = [];
  for (const name of readdirSync(root)) {
    if (!existsSync(join(root, name, "checks.json"))) continue;
    try {
      works.push(loadWork(cwd, name));
    } catch (error) {
      if (!(error instanceof GdmError)) throw error;
      console.error(`경고: 작업 "${name}" 건너뜀 — ${error.message}`);
    }
  }
  return works;
}

export function resolveWork(cwd: string, given?: string): Work {
  if (given) return loadWork(cwd, given);
  const active = listWorks(cwd).filter((w) => !w.done);
  if (active.length === 1) return active[0]!;
  if (active.length === 0) {
    throw new GdmError("진행 중인 작업이 없습니다. gdm plan init으로 시작하세요", "no_active");
  }
  const slugs = active.map((w) => w.slug).join(", ");
  throw new GdmError(`진행 중인 작업이 여러 개입니다. --slug로 지정하세요: ${slugs}`, "ambiguous_slug");
}

export function resolveWorkForRead(cwd: string, given?: string): Work {
  if (given) return loadWork(cwd, given);
  const works = listWorks(cwd);
  const active = works.filter((w) => !w.done);
  if (active.length === 1) return active[0]!;
  if (active.length > 1) {
    const slugs = active.map((w) => w.slug).join(", ");
    throw new GdmError(`진행 중인 작업이 여러 개입니다. --slug로 지정하세요: ${slugs}`, "ambiguous_slug");
  }
  if (works.length === 0) {
    throw new GdmError("작업이 없습니다. gdm plan init으로 시작하세요", "no_active");
  }
  const latest = works
    .map((w) => ({ w, ts: journalTail(cwd, w.slug, 1)[0]?.ts ?? w.createdAt }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))[0]!;
  return latest.w;
}

export function loadPresets(cwd: string): Record<string, string> {
  const path = join(cwd, ROOT, "presets.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    throw new GdmError(`프리셋 파일이 손상됐습니다: ${path}`, "state_corrupt");
  }
}

export function savePresets(cwd: string, presets: Record<string, string>): void {
  mkdirSync(join(cwd, ROOT), { recursive: true });
  const path = join(cwd, ROOT, "presets.json");
  atomicWriteFile(path, JSON.stringify(presets, null, 2) + "\n");
}

export function checkMark(check: Check): string {
  return check.status === "proven" ? "✅" : "⬜";
}

export function checkHow(check: Check): string {
  return check.manual ? "(수동 확인)" : `${check.cmd}`;
}

export function renderWorkMd(work: Work): string {
  const { proven, total } = provenCount(work);
  const status = work.done
    ? `완료 (${proven}/${total}) · ${work.doneAt}`
    : `진행 중 (${proven}/${total}) · 시작 ${work.createdAt}`;
  const rows = work.checks.map((c) => {
    const cmd = c.manual ? checkHow(c) : `\`${c.cmd}\``;
    const evidence = c.evidence ? c.evidence.observed : "—";
    return `| ${c.id} | ${checkMark(c)} | ${c.desc} | ${cmd} | ${c.expect} | ${evidence} |`;
  });
  const required =
    work.contract.required.length > 0 ? work.contract.required.map((value) => `  - ${value}`) : ["  - 없음"];
  const forbidden =
    work.contract.forbidden.length > 0 ? work.contract.forbidden.map((value) => `  - ${value}`) : ["  - 없음"];
  return [
    `# ${work.slug}`,
    "",
    `> ${status}`,
    "",
    "## 목표",
    "",
    work.brief,
    "",
    "## 작업 계약",
    "",
    `- 커밋: ${work.contract.commit}`,
    "- 필수:",
    ...required,
    "- 금지:",
    ...forbidden,
    "",
    "## 확인 항목",
    "",
    "| ID | 상태 | 항목 | 재현 명령 | 기대 | 증거 |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
