import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  MAX_ACTIVE_ENTRIES,
  MAX_EVENT_BYTES,
  MAX_LOG_BYTES,
  type MemoryEntry,
  type MemoryEvent,
  type MemoryScope,
  parseMemoryLog,
  projectStoreKey,
} from "./core.ts";

export type MemoryStoreSnapshot = {
  readonly path: string;
  readonly scope: MemoryScope;
  readonly projectRealpath?: string;
  readonly exists: boolean;
  readonly bytes: number;
  readonly entries: readonly MemoryEntry[];
  readonly events: number;
};

export class MemoryStoreError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "MemoryStoreError";
    this.path = path;
  }
}

export function memoryRoot(agentDir: string): string {
  if (!isAbsolute(agentDir)) throw new Error("GDM_PI_AGENT_DIR must be absolute");
  return join(resolve(agentDir), "memory");
}

export function globalStorePath(agentDir: string): string {
  return join(memoryRoot(agentDir), "global.jsonl");
}

export function projectStorePath(agentDir: string, projectRealpath: string): string {
  if (!isAbsolute(projectRealpath)) throw new Error("projectRealpath must be absolute");
  return join(memoryRoot(agentDir), "projects", `${projectStoreKey(projectRealpath)}.jsonl`);
}

async function pathState(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertSafeStorePath(path: string, scope: MemoryScope): Promise<void> {
  const parent = dirname(path);
  const root = scope === "project" ? dirname(parent) : parent;
  for (const candidate of scope === "project" ? [root, parent, path] : [root, path]) {
    const info = await pathState(candidate);
    if (info?.isSymbolicLink()) throw new MemoryStoreError(path, `Memory path contains a symlink: ${candidate}`);
    if (candidate === path && info && !info.isFile()) {
      throw new MemoryStoreError(path, "Memory store is not a regular file");
    }
    if (candidate !== path && info && !info.isDirectory()) {
      throw new MemoryStoreError(path, `Memory directory is not a directory: ${candidate}`);
    }
  }
}

async function fileState(path: string, scope: MemoryScope): Promise<{ readonly exists: boolean; readonly bytes: number }> {
  await assertSafeStorePath(path, scope);
  const info = await pathState(path);
  return info ? { exists: true, bytes: info.size } : { exists: false, bytes: 0 };
}

export async function readMemoryStore(input: {
  readonly path: string;
  readonly scope: MemoryScope;
  readonly projectRealpath?: string;
}): Promise<MemoryStoreSnapshot> {
  const state = await fileState(input.path, input.scope);
  if (!state.exists) {
    return { ...input, exists: false, bytes: 0, entries: [], events: 0 };
  }
  if (state.bytes > MAX_LOG_BYTES) {
    throw new MemoryStoreError(input.path, `Memory store exceeds ${MAX_LOG_BYTES} bytes`);
  }
  let content: string;
  try {
    content = await readFile(input.path, "utf8");
  } catch (error) {
    throw new MemoryStoreError(input.path, `Memory store cannot be read: ${(error as Error).message}`);
  }
  const parsed = parseMemoryLog(content, input.scope, input.projectRealpath);
  if (!parsed.ok) {
    const suffix = parsed.line === undefined ? "" : ` at line ${parsed.line}`;
    throw new MemoryStoreError(input.path, `Memory store is invalid${suffix}: ${parsed.error}`);
  }
  return {
    ...input,
    exists: true,
    bytes: Buffer.byteLength(content),
    entries: parsed.entries,
    events: parsed.events,
  };
}

export async function appendMemoryEvent(input: {
  readonly path: string;
  readonly scope: MemoryScope;
  readonly projectRealpath?: string;
  readonly event: MemoryEvent;
}): Promise<{ readonly appended: boolean; readonly snapshot: MemoryStoreSnapshot }> {
  const snapshot = await readMemoryStore(input);
  const event = input.event;
  if (event.event === "remember" && snapshot.entries.some((entry) => entry.id === event.id)) {
    return { appended: false, snapshot };
  }
  if (event.event === "remember" && snapshot.entries.length >= MAX_ACTIVE_ENTRIES) {
    throw new MemoryStoreError(input.path, `Memory store already has ${MAX_ACTIVE_ENTRIES} active entries`);
  }
  const line = `${JSON.stringify(event)}\n`;
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length > MAX_EVENT_BYTES) {
    throw new MemoryStoreError(input.path, `Memory event exceeds ${MAX_EVENT_BYTES} bytes`);
  }
  if (snapshot.bytes + bytes.length > MAX_LOG_BYTES) {
    throw new MemoryStoreError(input.path, `Memory store would exceed ${MAX_LOG_BYTES} bytes`);
  }

  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
  await assertSafeStorePath(input.path, input.scope);
  const handle = await open(
    input.path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const result = await handle.write(bytes, 0, bytes.length, null);
    if (result.bytesWritten !== bytes.length) {
      throw new MemoryStoreError(input.path, `Memory append was partial: ${result.bytesWritten}/${bytes.length}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  const next = await readMemoryStore(input);
  return { appended: true, snapshot: next };
}

export async function inspectMemoryStore(input: {
  readonly path: string;
  readonly scope: MemoryScope;
  readonly projectRealpath?: string;
}): Promise<string> {
  try {
    const snapshot = await readMemoryStore(input);
    return `${input.scope}: ok, ${snapshot.entries.length} active, ${snapshot.events} events, ${snapshot.bytes} bytes, ${input.path}`;
  } catch (error) {
    return `${input.scope}: invalid, ${(error as Error).message}, ${input.path}`;
  }
}
