import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { GdmError, validateSlug } from "./state.ts";
import type { JournalEvent } from "./types.ts";

export const JOURNAL_ANCHOR_SCHEMA_VERSION = "gdm-journal-anchor/v1" as const;
export const JOURNAL_FORMAT_BYTES = `${JOURNAL_ANCHOR_SCHEMA_VERSION}\n` as const;
export const JOURNAL_FAILPOINT_ENV = "GDM_TEST_JOURNAL_FAILPOINT" as const;
export const JOURNAL_FAILPOINT_EXIT_CODE = 86 as const;

export type JournalAnchor = {
  readonly schemaVersion: typeof JOURNAL_ANCHOR_SCHEMA_VERSION;
  readonly byteLength: number;
  readonly lineCount: number;
  readonly sha256: string;
};

type OpenedJournal = {
  readonly descriptor: number;
  readonly bytes: Buffer;
  readonly events: readonly JournalEvent[];
  readonly anchor: JournalAnchor | null;
};

const SHA256_RE = /^[0-9a-f]{64}$/u;
const ANCHOR_KEYS = ["schemaVersion", "byteLength", "lineCount", "sha256"] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_ANCHOR_BYTES = 4 * 1024;
const MAX_FORMAT_BYTES = 128;
const MAX_COMMITTED_JOURNAL_BYTES = 64 * 1024 * 1024;

function corrupt(message: string): GdmError {
  return new GdmError(`journal 상태가 손상됐습니다: ${message}`, "state_corrupt");
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function closeQuietly(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the primary integrity error. A close failure cannot make an
    // uncommitted append visible because the anchor is the commit point.
  }
}

function workDirectory(cwd: string, slug: string): string {
  validateSlug(slug);
  return join(cwd, ".gdm", slug);
}

function inspectDirectory(path: string, label: string): "missing" | "directory" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw corrupt(`${label} 경로가 안전한 디렉토리가 아닙니다`);
    return "directory";
  } catch (error) {
    if (error instanceof GdmError) throw error;
    if (hasCode(error, "ENOENT")) return "missing";
    throw corrupt(`${label} 경로를 검사할 수 없습니다`);
  }
}

/**
 * Ensure only the gdm-owned directory components below cwd. Recursive mkdir is
 * deliberately avoided because it would traverse a pre-existing symlink.
 */
export function ensureWorkDirectory(cwd: string, slug: string, create: boolean): string {
  const root = join(cwd, ".gdm");
  const directory = workDirectory(cwd, slug);
  const rootState = inspectDirectory(root, ".gdm");
  if (rootState === "missing") {
    if (!create) return directory;
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw corrupt(".gdm 디렉토리를 만들 수 없습니다");
    }
    inspectDirectory(root, ".gdm");
    syncDirectory(cwd);
  }
  const workState = inspectDirectory(directory, "작업");
  if (workState === "missing" && create) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw corrupt("작업 디렉토리를 만들 수 없습니다");
    }
    inspectDirectory(directory, "작업");
    syncDirectory(root);
  }
  return directory;
}

function inspectRegular(path: string, label: string): "missing" | "regular" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw corrupt(`${label} 경로가 일반 파일이 아닙니다`);
    return "regular";
  } catch (error) {
    if (error instanceof GdmError) throw error;
    if (hasCode(error, "ENOENT")) return "missing";
    throw corrupt(`${label} 경로를 검사할 수 없습니다`);
  }
}

function readAll(descriptor: number, byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    let count: number;
    try {
      count = readSync(descriptor, bytes, offset, byteLength - offset, offset);
    } catch {
      throw corrupt("journal prefix를 읽을 수 없습니다");
    }
    if (count === 0) throw corrupt("anchor보다 journal이 짧습니다");
    offset += count;
  }
  return bytes;
}

function parseJournal(bytes: Buffer, expectedLines?: number): JournalEvent[] {
  if (bytes.byteLength === 0) {
    if (expectedLines !== undefined && expectedLines !== 0) throw corrupt("anchor lineCount가 일치하지 않습니다");
    return [];
  }
  if (bytes[bytes.byteLength - 1] !== 0x0a) throw corrupt("journal 마지막 행이 완전하지 않습니다");
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw corrupt("journal UTF-8 형식이 잘못됐습니다");
  }
  const lines = text.slice(0, -1).split("\n");
  if (expectedLines !== undefined && lines.length !== expectedLines) {
    throw corrupt("anchor lineCount가 일치하지 않습니다");
  }
  const events: JournalEvent[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.endsWith("\r")) throw corrupt("journal에 빈 행 또는 비정규 줄바꿈이 있습니다");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw corrupt("journal JSON 파싱에 실패했습니다");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw corrupt("journal 행이 JSON object가 아닙니다");
    }
    events.push(value as JournalEvent);
  }
  return events;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseAnchor(bytes: Buffer): JournalAnchor {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw corrupt("journal.anchor JSON 파싱에 실패했습니다");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corrupt("journal.anchor가 JSON object가 아닙니다");
  }
  const anchor = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(anchor);
  if (
    keys.length !== ANCHOR_KEYS.length ||
    ANCHOR_KEYS.some((key) => !Object.hasOwn(anchor, key)) ||
    keys.some((key) => !ANCHOR_KEYS.includes(key as typeof ANCHOR_KEYS[number])) ||
    anchor.schemaVersion !== JOURNAL_ANCHOR_SCHEMA_VERSION ||
    !Number.isSafeInteger(anchor.byteLength) || (anchor.byteLength as number) < 0 ||
    !Number.isSafeInteger(anchor.lineCount) || (anchor.lineCount as number) < 0 ||
    typeof anchor.sha256 !== "string" || !SHA256_RE.test(anchor.sha256)
  ) {
    throw corrupt("journal.anchor schema가 잘못됐습니다");
  }
  if ((anchor.byteLength === 0) !== (anchor.lineCount === 0)) {
    throw corrupt("journal.anchor의 길이와 행 수가 모순됩니다");
  }
  return anchor as JournalAnchor;
}

function readAnchor(directory: string): JournalAnchor | null {
  const path = join(directory, "journal.anchor");
  if (inspectRegular(path, "journal.anchor") === "missing") return null;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw corrupt("journal.anchor가 일반 파일이 아닙니다");
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_ANCHOR_BYTES) {
      throw corrupt(`journal.anchor 크기 상한(${MAX_ANCHOR_BYTES} bytes) 초과`);
    }
    return parseAnchor(readAll(descriptor, stat.size));
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt("journal.anchor를 읽을 수 없습니다");
  } finally {
    closeQuietly(descriptor);
  }
}

function readFormatMarker(directory: string): boolean {
  const path = join(directory, "journal.format");
  if (inspectRegular(path, "journal.format") === "missing") return false;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw corrupt("journal.format가 일반 파일이 아닙니다");
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_FORMAT_BYTES) {
      throw corrupt(`journal.format 크기 상한(${MAX_FORMAT_BYTES} bytes) 초과`);
    }
    const bytes = readAll(descriptor, stat.size);
    if (!bytes.equals(Buffer.from(JOURNAL_FORMAT_BYTES, "utf8"))) {
      throw corrupt("journal.format marker가 잘못됐습니다");
    }
    return true;
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt("journal.format을 읽을 수 없습니다");
  } finally {
    closeQuietly(descriptor);
  }
}

function openJournal(directory: string, create: boolean): number | null {
  const path = join(directory, "journal.jsonl");
  const state = inspectRegular(path, "journal.jsonl");
  if (state === "missing" && !create) return null;
  try {
    const flags = create
      ? constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    const descriptor = openSync(path, flags, 0o600);
    if (!fstatSync(descriptor).isFile()) {
      closeQuietly(descriptor);
      throw corrupt("journal.jsonl이 일반 파일이 아닙니다");
    }
    return descriptor;
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt("journal.jsonl을 열 수 없습니다");
  }
}

function validatedOpenedJournal(directory: string, create: boolean): OpenedJournal | null {
  const formatMarker = readFormatMarker(directory);
  const anchor = readAnchor(directory);
  if (formatMarker && anchor === null) {
    throw corrupt("v2 format marker가 있지만 journal.anchor가 없습니다");
  }
  const descriptor = openJournal(directory, create);
  if (descriptor === null) {
    if (anchor !== null) throw corrupt("anchor가 가리키는 journal이 없습니다");
    return null;
  }
  try {
    const size = fstatSync(descriptor).size;
    const committedLength = anchor?.byteLength ?? size;
    if (!Number.isSafeInteger(size) || size < committedLength) throw corrupt("anchor보다 journal이 짧습니다");
    if (committedLength > MAX_COMMITTED_JOURNAL_BYTES) {
      throw corrupt(`journal committed prefix 크기 상한(${MAX_COMMITTED_JOURNAL_BYTES} bytes) 초과`);
    }
    const bytes = readAll(descriptor, committedLength);
    if (anchor !== null && hash(bytes) !== anchor.sha256) throw corrupt("journal committed prefix hash가 다릅니다");
    const events = parseJournal(bytes, anchor?.lineCount);
    return { descriptor, bytes, events, anchor };
  } catch (error) {
    closeQuietly(descriptor);
    throw error;
  }
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    let count: number;
    try {
      count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    } catch {
      throw corrupt("journal 또는 anchor 쓰기에 실패했습니다");
    }
    if (count <= 0) throw corrupt("journal 또는 anchor 쓰기가 진행되지 않았습니다");
    offset += count;
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isDirectory()) throw corrupt("작업 디렉토리가 바뀌었습니다");
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt("작업 디렉토리를 동기화할 수 없습니다");
  } finally {
    closeQuietly(descriptor);
  }
}

function maybeFail(point: "after-data-fsync" | "after-anchor-rename"): void {
  if (process.env[JOURNAL_FAILPOINT_ENV] === point) process.exit(JOURNAL_FAILPOINT_EXIT_CODE);
}

function publishAnchor(directory: string, anchor: JournalAnchor, failpoint: boolean): void {
  const target = join(directory, "journal.anchor");
  inspectRegular(target, "journal.anchor");
  const temporary = join(directory, `.journal.anchor.tmp.${process.pid}.${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    if (!fstatSync(descriptor).isFile()) throw corrupt("journal.anchor 임시 경로가 일반 파일이 아닙니다");
    writeAll(descriptor, Buffer.from(`${JSON.stringify(anchor)}\n`, "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    inspectRegular(target, "journal.anchor");
    renameSync(temporary, target);
    if (failpoint) maybeFail("after-anchor-rename");
    syncDirectory(directory);
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt("journal.anchor를 원자적으로 게시할 수 없습니다");
  } finally {
    closeQuietly(descriptor);
    rmSync(temporary, { force: true });
  }
}

function publishFormatMarker(directory: string): void {
  const target = join(directory, "journal.format");
  if (readFormatMarker(directory)) return;
  const temporary = join(directory, `.journal.format.tmp.${process.pid}.${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    if (!fstatSync(descriptor).isFile()) throw corrupt("journal.format 임시 경로가 일반 파일이 아닙니다");
    writeAll(descriptor, Buffer.from(JOURNAL_FORMAT_BYTES, "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    inspectRegular(target, "journal.format");
    renameSync(temporary, target);
    syncDirectory(directory);
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw corrupt("journal.format을 원자적으로 게시할 수 없습니다");
  } finally {
    closeQuietly(descriptor);
    rmSync(temporary, { force: true });
  }
}

function canonicalEventLines(events: readonly JournalEvent[]): Buffer {
  if (events.length === 0) return Buffer.alloc(0);
  const lines: string[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      throw corrupt("append할 journal event가 object가 아닙니다");
    }
    const line = JSON.stringify(event);
    if (line === undefined) throw corrupt("append할 journal event를 직렬화할 수 없습니다");
    lines.push(line);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/** Read exactly the prefix committed by journal.anchor, or a strict legacy file. */
export function readCommittedJournal(cwd: string, slug: string): JournalEvent[] {
  const directory = ensureWorkDirectory(cwd, slug, false);
  if (inspectDirectory(directory, "작업") === "missing") return [];
  const opened = validatedOpenedJournal(directory, false);
  if (opened === null) return [];
  try {
    return [...opened.events];
  } finally {
    closeQuietly(opened.descriptor);
  }
}

/**
 * Append one fsynced batch and publish its committed prefix. The caller owns the
 * repository mutation lock; the anchor rename is the journal commit point.
 */
export function appendCommittedJournal(
  cwd: string,
  slug: string,
  events: readonly JournalEvent[],
): void {
  if (events.length === 0) return;
  const directory = ensureWorkDirectory(cwd, slug, true);
  const opened = validatedOpenedJournal(directory, true);
  if (opened === null) throw corrupt("journal을 만들 수 없습니다");
  try {
    let committedAnchor = opened.anchor;
    if (committedAnchor === null) {
      committedAnchor = {
        schemaVersion: JOURNAL_ANCHOR_SCHEMA_VERSION,
        byteLength: opened.bytes.byteLength,
        lineCount: opened.events.length,
        sha256: hash(opened.bytes),
      };
      // Adopt the complete strict legacy journal before appending. A crash from
      // this point onward can therefore expose only this prefix or the new one.
      publishAnchor(directory, committedAnchor, false);
    }

    const current = fstatSync(opened.descriptor);
    if (current.size < committedAnchor.byteLength) throw corrupt("anchor보다 journal이 짧습니다");
    if (current.size > committedAnchor.byteLength) {
      ftruncateSync(opened.descriptor, committedAnchor.byteLength);
      fsyncSync(opened.descriptor);
    }

    const batch = canonicalEventLines(events);
    const nextByteLength = opened.bytes.byteLength + batch.byteLength;
    const nextLineCount = committedAnchor.lineCount + events.length;
    if (!Number.isSafeInteger(nextByteLength) || nextByteLength > MAX_COMMITTED_JOURNAL_BYTES) {
      throw corrupt(`journal committed prefix 크기 상한(${MAX_COMMITTED_JOURNAL_BYTES} bytes) 초과`);
    }
    if (!Number.isSafeInteger(nextLineCount)) throw corrupt("journal lineCount 상한 초과");
    writeAll(opened.descriptor, batch);
    fsyncSync(opened.descriptor);
    maybeFail("after-data-fsync");

    const committedBytes = Buffer.concat([opened.bytes, batch]);
    publishAnchor(directory, {
      schemaVersion: JOURNAL_ANCHOR_SCHEMA_VERSION,
      byteLength: nextByteLength,
      lineCount: nextLineCount,
      sha256: hash(committedBytes),
    }, true);
    // The marker prevents deleting only the anchor from silently downgrading a
    // migrated journal to legacy parsing. Anchor is deliberately committed
    // first: a crash in between remains readable and the next writer repairs
    // the missing marker. Deleting both files is outside the accidental
    // single-file corruption model (and cannot be distinguished from legacy).
    publishFormatMarker(directory);
  } finally {
    closeQuietly(opened.descriptor);
  }
}

export function journalAnchorPath(cwd: string, slug: string): string {
  return join(workDirectory(cwd, slug), "journal.anchor");
}

export function journalFilePath(cwd: string, slug: string): string {
  return join(workDirectory(cwd, slug), "journal.jsonl");
}

export function journalFormatPath(cwd: string, slug: string): string {
  return join(workDirectory(cwd, slug), "journal.format");
}

export function journalAnchorExists(cwd: string, slug: string): boolean {
  const directory = ensureWorkDirectory(cwd, slug, false);
  if (inspectDirectory(directory, "작업") === "missing") return false;
  return inspectRegular(join(directory, "journal.anchor"), "journal.anchor") === "regular";
}
