import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { GdmError } from "./state.ts";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;
const MALFORMED_LOCK_STALE_MS = 60_000;
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

type Identity = { readonly dev: number; readonly ino: number };

function identity(stat: Stats): Identity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function reclaimDeadOwner(path: string): boolean {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new GdmError("작업 잠금 경로가 일반 파일이 아닙니다", "state_lock_rejected");
  }
  let pid = 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid === "number") pid = parsed.pid;
  } catch {
    if (Date.now() - before.mtimeMs < MALFORMED_LOCK_STALE_MS) return false;
  }
  if (processIsAlive(pid)) return false;
  let current: Stats;
  try {
    current = lstatSync(path);
  } catch (error) {
    // The owner (or another waiter reclaiming the same dead owner) may have
    // removed the lock after our first lstat. That is successful progress, so
    // retry acquisition instead of surfacing a generic exit-1 filesystem race.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (!sameIdentity(identity(before), identity(current))) return false;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

export function acquireRepositoryLock(cwd: string): () => void {
  const path = join(cwd, ".gdm.lock");
  const deadline = performance.now() + LOCK_TIMEOUT_MS;

  while (performance.now() < deadline) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const owned = identity(fstatSync(descriptor));
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n");
      closeSync(descriptor);
      descriptor = undefined;
      return () => {
        try {
          const current = lstatSync(path);
          if (sameIdentity(owned, identity(current))) unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ELOOP") throw error;
      if (code === "ELOOP") throw new GdmError("작업 잠금 심볼릭 링크를 거부했습니다", "state_lock_rejected");
      if (reclaimDeadOwner(path)) continue;
      Atomics.wait(WAIT_CELL, 0, 0, LOCK_POLL_MS);
    }
  }
  throw new GdmError("다른 gdm 프로세스가 작업 상태를 갱신 중입니다", "state_busy");
}
