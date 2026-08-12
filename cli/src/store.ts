import {
  closeSync,
  constants,
  fdatasyncSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  appendCommittedJournal,
  ensureWorkDirectory,
  readCommittedJournal,
} from "./journal-file.ts";
import { GdmError, provenCount, validateSlug, validateWork } from "./state.ts";
import type { Check, JournalEvent, Work } from "./types.ts";

const ROOT = ".gdm";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;

type ReadRegularFile = {
  readonly bytes: Buffer;
  readonly mode: number;
};

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function corrupt(path: string, why: string): GdmError {
  return new GdmError(`상태 파일이 손상됐습니다 (${path}): ${why}`, "state_corrupt");
}

function closeQuietly(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // The descriptor no longer participates in a commit after close is tried.
  }
}

function inspectDirectory(path: string, label: string): "missing" | "directory" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw corrupt(path, `${label} 경로가 안전한 디렉토리가 아님`);
    return "directory";
  } catch (error) {
    if (error instanceof GdmError) throw error;
    if (hasCode(error, "ENOENT")) return "missing";
    throw corrupt(path, `${label} 경로 검사 실패`);
  }
}

function inspectRegular(path: string, label: string): "missing" | "regular" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw corrupt(path, `${label} 경로가 일반 파일이 아님`);
    return "regular";
  } catch (error) {
    if (error instanceof GdmError) throw error;
    if (hasCode(error, "ENOENT")) return "missing";
    throw corrupt(path, `${label} 경로 검사 실패`);
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isDirectory()) throw corrupt(directory, "동기화 대상이 디렉토리가 아님");
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt(directory, "디렉토리 동기화 실패");
  } finally {
    closeQuietly(descriptor);
  }
}

function ensureRootDirectory(cwd: string, create: boolean): string {
  const root = join(cwd, ROOT);
  const state = inspectDirectory(root, ROOT);
  if (state === "missing" && create) {
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw corrupt(root, "디렉토리 생성 실패");
    }
    inspectDirectory(root, ROOT);
    syncDirectory(cwd);
  }
  return root;
}

function ensureChildDirectory(parent: string, name: string): string {
  const path = join(parent, name);
  if (inspectDirectory(path, name) === "missing") {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw corrupt(path, "디렉토리 생성 실패");
    }
    inspectDirectory(path, name);
    syncDirectory(parent);
  }
  return path;
}

function readExact(descriptor: number, byteLength: number, path: string): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    let count: number;
    try {
      count = readSync(descriptor, bytes, offset, byteLength - offset, offset);
    } catch {
      throw corrupt(path, "읽기 실패");
    }
    if (count === 0) throw corrupt(path, "읽는 동안 파일 길이가 바뀜");
    offset += count;
  }
  return bytes;
}

function readRegularFileWithMetadata(path: string, label: string): ReadRegularFile | null {
  if (inspectRegular(path, label) === "missing") return null;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw corrupt(path, `${label}가 일반 파일이 아님`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_STATE_FILE_BYTES) {
      throw corrupt(path, `${label} 크기 상한(${MAX_STATE_FILE_BYTES} bytes) 초과`);
    }
    return { bytes: readExact(descriptor, stat.size, path), mode: stat.mode & 0o7777 };
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt(path, `${label} 읽기 실패`);
  } finally {
    closeQuietly(descriptor);
  }
}

function readRegularFile(path: string, label: string): Buffer | null {
  return readRegularFileWithMetadata(path, label)?.bytes ?? null;
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw corrupt(path, "UTF-8 형식 오류");
  }
}

function writeAll(descriptor: number, bytes: Uint8Array, path: string): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    let count: number;
    try {
      count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    } catch {
      throw corrupt(path, "쓰기 실패");
    }
    if (count <= 0) throw corrupt(path, "쓰기가 진행되지 않음");
    offset += count;
  }
}

function syncFileData(descriptor: number): void {
  try {
    fdatasyncSync(descriptor);
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOSYS")) throw error;
    fsyncSync(descriptor);
  }
}

function durableAtomicWrite(
  directory: string,
  name: string,
  body: string | Uint8Array,
  mode = 0o600,
): void {
  const target = join(directory, name);
  inspectRegular(target, name);
  const temporary = join(directory, `.${name}.tmp.${process.pid}.${randomUUID()}`);
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (bytes.byteLength > MAX_STATE_FILE_BYTES) {
    throw corrupt(target, `${name} 크기 상한(${MAX_STATE_FILE_BYTES} bytes) 초과`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    if (!fstatSync(descriptor).isFile()) throw corrupt(temporary, "임시 경로가 일반 파일이 아님");
    fchmodSync(descriptor, mode);
    writeAll(descriptor, bytes, temporary);
    syncFileData(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    inspectRegular(target, name);
    renameSync(temporary, target);
    syncDirectory(directory);
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt(target, "원자적 저장 실패");
  } finally {
    closeQuietly(descriptor);
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the storage error; the uniquely named temp is never authoritative.
    }
  }
}

export function workDir(cwd: string, slug: string): string {
  validateSlug(slug);
  return join(cwd, ROOT, slug);
}

export function workExists(cwd: string, slug: string): boolean {
  const directory = ensureWorkDirectory(cwd, slug, false);
  return inspectRegular(join(directory, "checks.json"), "checks.json") === "regular";
}

export function loadWork(cwd: string, slug: string): Work {
  const directory = ensureWorkDirectory(cwd, slug, false);
  const path = join(directory, "checks.json");
  const bytes = readRegularFile(path, "checks.json");
  if (bytes === null) throw new GdmError(`작업 "${slug}"가 없습니다`, "work_not_found");
  let raw: unknown;
  try {
    raw = JSON.parse(decodeUtf8(bytes, path));
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt(path, "JSON 파싱 실패");
  }
  const work = validateWork(raw, path);
  if (work.slug !== slug) throw corrupt(path, `디렉토리(${slug})와 slug(${work.slug}) 불일치`);
  return work;
}

/**
 * Patch only the raw persisted source-approval field. The caller owns the
 * repository mutation lock. Validation uses the normalized Work projection,
 * while serialization deliberately uses the raw object so legacy omitted
 * defaults and the audit's checksHash meaning are not rewritten.
 */
export function patchVerificationPlanSourceFingerprint(
  cwd: string,
  slug: string,
  fingerprint: string,
): void {
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new GdmError("--fingerprint는 소문자 64자리 SHA-256이어야 합니다", "usage");
  }
  const directory = ensureWorkDirectory(cwd, slug, false);
  const path = join(directory, "checks.json");
  const current = readRegularFileWithMetadata(path, "checks.json");
  if (current === null) throw new GdmError(`작업 "${slug}"가 없습니다`, "work_not_found");

  let raw: unknown;
  try {
    raw = JSON.parse(decodeUtf8(current.bytes, path));
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt(path, "JSON 파싱 실패");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw corrupt(path, "객체가 아님");
  }
  const next = { ...(raw as Readonly<Record<string, unknown>>), verificationPlanSourceFingerprint: fingerprint };
  const validated = validateWork(next, path);
  if (validated.slug !== slug) throw corrupt(path, `디렉토리(${slug})와 slug(${validated.slug}) 불일치`);
  if (validated.done) {
    throw new GdmError("완료된 작업의 source fingerprint는 바꿀 수 없습니다", "work_done");
  }
  durableAtomicWrite(directory, "checks.json", `${JSON.stringify(next, null, 2)}\n`, current.mode);
}

export function saveWork(cwd: string, work: Work): void {
  const directory = ensureWorkDirectory(cwd, work.slug, true);
  ensureChildDirectory(directory, "out");
  const path = join(directory, "checks.json");
  const validated = validateWork(work, path);
  durableAtomicWrite(directory, "checks.json", `${JSON.stringify(validated, null, 2)}\n`);
  durableAtomicWrite(directory, "work.md", renderWorkMd(validated));
}

export function repairTrailingNulWork(
  cwd: string,
  slug: string,
): { work: Work; removedBytes: number } {
  const directory = ensureWorkDirectory(cwd, slug, false);
  const path = join(directory, "checks.json");
  const contents = readRegularFile(path, "checks.json");
  if (contents === null) throw new GdmError(`작업 "${slug}"가 없습니다`, "work_not_found");

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

  durableAtomicWrite(directory, "checks.json", contents.subarray(0, end));
  return { work, removedBytes };
}

export function appendJournal(cwd: string, slug: string, event: JournalEvent): void {
  appendCommittedJournal(cwd, slug, [event]);
}

export function readJournal(cwd: string, slug: string): JournalEvent[] {
  return readCommittedJournal(cwd, slug);
}

export function journalTail(cwd: string, slug: string, n = 8): JournalEvent[] {
  return readJournal(cwd, slug).slice(-n);
}

export function listWorks(cwd: string): Work[] {
  const root = ensureRootDirectory(cwd, false);
  if (inspectDirectory(root, ROOT) === "missing") return [];
  const works: Work[] = [];
  for (const name of readdirSync(root)) {
    try {
      const candidate = join(root, name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (inspectRegular(join(candidate, "checks.json"), "checks.json") === "missing") continue;
      validateSlug(name);
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
  const root = ensureRootDirectory(cwd, false);
  const path = join(root, "presets.json");
  const bytes = readRegularFile(path, "presets.json");
  if (bytes === null) return {};
  try {
    return JSON.parse(decodeUtf8(bytes, path)) as Record<string, string>;
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt(path, "프리셋 JSON 파싱 실패");
  }
}

export function savePresets(cwd: string, presets: Record<string, string>): void {
  const root = ensureRootDirectory(cwd, true);
  durableAtomicWrite(root, "presets.json", `${JSON.stringify(presets, null, 2)}\n`);
}

export function checkMark(check: Check): string {
  return check.status === "proven" ? "✅" : "⬜";
}

export function checkHow(check: Check): string {
  return check.manual ? `(수동 확인${check.expert ? " · expert" : ""})` : `${check.cmd}`;
}

export function renderWorkMd(work: Work): string {
  const { proven, total } = provenCount(work);
  const status = work.done
    ? `완료 (${proven}/${total}) · ${work.doneAt}`
    : `진행 중 (${proven}/${total}) · 시작 ${work.createdAt}`;
  const rows = work.checks.map((c) => {
    const cmd = c.manual ? checkHow(c) : `\`${c.cmd}\``;
    const evidence = c.evidence ? c.evidence.observed : "—";
    const red = c.redEvidence ? c.redEvidence.observed : "—";
    return `| ${c.id} | ${checkMark(c)} | ${c.kind ?? (c.manual ? "manual" : "behavior")} | ${c.desc} | ${cmd} | ${c.expect} | ${red} | ${evidence} |`;
  });
  const required =
    work.contract.required.length > 0 ? work.contract.required.map((value) => `  - ${value}`) : ["  - 없음"];
  const forbidden =
    work.contract.forbidden.length > 0 ? work.contract.forbidden.map((value) => `  - ${value}`) : ["  - 없음"];
  const list = (values: readonly string[] | undefined, fallback = "없음"): string =>
    values && values.length > 0 ? values.join(", ") : fallback;
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
    `- 위험도: ${work.contract.risk ?? "low"}`,
    `- 검증 가능성: ${work.contract.verification ?? "deterministic"}`,
    `- 허용 경로: ${list(work.contract.allowedPaths, ".")}`,
    `- 금지 경로: ${list(work.contract.forbiddenPaths)}`,
    `- 가정: ${list(work.contract.assumptions)}`,
    `- 불확실성: ${list(work.contract.uncertainties)}`,
    `- 중단 조건: ${list(work.contract.stopConditions)}`,
    `- 간소화 증거: ${work.contract.simplificationRequired ? "필수" : "선택"}`,
    "- 필수:",
    ...required,
    "- 금지:",
    ...forbidden,
    "",
    "## 확인 항목",
    "",
    "| ID | 상태 | 종류 | 항목 | 재현 명령 | 기대 | red 증거 | green 증거 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    ...(work.delivery
      ? [
          "",
          "## 전달",
          "",
          `- 이슈: ${work.delivery.issue}`,
          `- 브랜치: ${work.delivery.branch}`,
          `- HEAD: ${work.delivery.head}`,
          `- PR: ${work.delivery.pr?.number ?? "—"}`,
          `- CI: ${work.delivery.ci?.status ?? "—"}`,
          `- 머지 승인: ${work.delivery.mergeApproval ? "승인" : "—"}`,
          `- 머지 SHA: ${work.delivery.merged?.sha ?? "—"}`,
        ]
      : []),
    "",
  ].join("\n");
}
