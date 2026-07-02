import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GdmError, provenCount, validateSlug, validateWork } from "./state.ts";
import type { JournalEvent, Work } from "./types.ts";

const ROOT = ".gdm";

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
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(work, null, 2) + "\n");
  renameSync(tmp, path);
  writeFileSync(join(dir, "work.md"), renderWorkMd(work));
}

export function appendJournal(cwd: string, slug: string, event: JournalEvent): void {
  const dir = workDir(cwd, slug);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "journal.jsonl"), JSON.stringify(event) + "\n");
}

export function journalTail(cwd: string, slug: string, n = 8): JournalEvent[] {
  const path = join(workDir(cwd, slug), "journal.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-n).map((line) => JSON.parse(line) as JournalEvent);
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

export function renderWorkMd(work: Work): string {
  const { proven, total } = provenCount(work);
  const status = work.done
    ? `완료 (${proven}/${total}) · ${work.doneAt}`
    : `진행 중 (${proven}/${total}) · 시작 ${work.createdAt}`;
  const rows = work.checks.map((c) => {
    const mark = c.status === "proven" ? "✅" : "⬜";
    const cmd = c.manual ? "(수동 확인)" : `\`${c.cmd}\``;
    const evidence = c.evidence ? c.evidence.observed : "—";
    return `| ${c.id} | ${mark} | ${c.desc} | ${cmd} | ${c.expect} | ${evidence} |`;
  });
  return [
    `# ${work.slug}`,
    "",
    `> ${status}`,
    "",
    "## 목표",
    "",
    work.brief,
    "",
    "## 확인 항목",
    "",
    "| ID | 상태 | 항목 | 재현 명령 | 기대 | 증거 |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
