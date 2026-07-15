import {
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  assertIdentity,
  closeDescriptor,
  createDirectory,
  hasCode,
  identity,
  inspect,
  ledgerFiles,
  readLedgerFile,
  rejected,
  rethrowIo,
  sameIdentity,
  syncDirectory,
} from "./habit-ledger-nodes.ts";
import type { Identity, LedgerFiles, NodeSpec } from "./habit-ledger-nodes.ts";
import { GdmError } from "./state.ts";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 5;
// 원장 쓰기는 밀리초 단위다. 이보다 오래된 잠금은 크래시로 남은 것으로 보고 회수한다.
const LOCK_STALE_MS = 60_000;
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

type LockLease = {
  readonly files: LedgerFiles;
  readonly root: Identity;
  readonly directory: Identity;
  readonly lock: Identity;
  readonly descriptor: number;
};

export type HabitLedgerFileUpdate<T> =
  | { readonly kind: "unchanged"; readonly value: T }
  | { readonly kind: "replace"; readonly bytes: string; readonly value: T };

function tryAcquire(files: LedgerFiles, root: Identity, directory: Identity): LockLease | null {
  assertIdentity(files.root, root);
  assertIdentity(files.directory, directory);
  let descriptor: number;
  try {
    descriptor = openSync(
      files.lock.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (hasCode(error, "EEXIST") || hasCode(error, "ELOOP")) {
      const existing = inspect(files.lock);
      if (existing !== undefined && Date.now() - existing.mtimeMs > LOCK_STALE_MS) {
        const current = inspect(files.lock);
        if (current !== undefined && sameIdentity(current, identity(existing))) {
          try {
            unlinkSync(files.lock.path);
          } catch (unlinkError) {
            if (!hasCode(unlinkError, "ENOENT")) return rethrowIo(unlinkError, "lock-reclaim");
          }
        }
      }
      return null;
    }
    return rethrowIo(error, "lock");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw rejected("lock", "kind");
    return { files, root, directory, lock: identity(stat), descriptor };
  } catch (error) {
    closeDescriptor(descriptor);
    return rethrowIo(error, "lock");
  }
}

function acquire(files: LedgerFiles): LockLease {
  inspect(files.repository);
  const root = createDirectory(files.root);
  assertIdentity(files.root, root);
  const directory = createDirectory(files.directory);
  inspect(files.ledger);
  inspect(files.temp);
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const lease = tryAcquire(files, root, directory);
    if (lease !== null) return lease;
    Atomics.wait(WAIT_CELL, 0, 0, LOCK_POLL_MS);
  }
  throw new GdmError("원장이 다른 프로세스에 의해 잠겨 있습니다. 잠시 후 다시 시도하세요", "habit_ledger_busy");
}

function assertLease(lease: LockLease): void {
  assertIdentity(lease.files.root, lease.root);
  assertIdentity(lease.files.directory, lease.directory);
  assertIdentity(lease.files.lock, lease.lock);
}

function removeOwned(node: NodeSpec, owned: Identity): void {
  const current = inspect(node);
  if (current === undefined) return;
  if (!sameIdentity(current, owned)) throw rejected(node.name, "changed");
  try {
    unlinkSync(node.path);
  } catch (error) {
    rethrowIo(error, "cleanup");
  }
}

function removeStaleTemp(lease: LockLease): void {
  assertLease(lease);
  const stale = inspect(lease.files.temp);
  if (stale === undefined) return;
  removeOwned(lease.files.temp, identity(stale));
  syncDirectory(lease.files.directory, lease.directory);
}

function replaceFile(lease: LockLease, bytes: string): void {
  assertLease(lease);
  inspect(lease.files.ledger);
  if (inspect(lease.files.temp) !== undefined) throw rejected("temp", "occupied");
  let descriptor: number;
  try {
    descriptor = openSync(
      lease.files.temp.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    return rethrowIo(error, "temp-open");
  }
  let owned: Identity;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw rejected("temp", "kind");
    owned = identity(stat);
  } catch (error) {
    closeDescriptor(descriptor);
    return rethrowIo(error, "temp-open");
  }
  try {
    try {
      writeFileSync(descriptor, bytes, "utf8");
      fsyncSync(descriptor);
    } catch (error) {
      rethrowIo(error, "write");
    } finally {
      closeDescriptor(descriptor);
    }
    assertLease(lease);
    inspect(lease.files.ledger);
    assertIdentity(lease.files.temp, owned);
    try {
      renameSync(lease.files.temp.path, lease.files.ledger.path);
    } catch (error) {
      rethrowIo(error, "rename");
    }
    syncDirectory(lease.files.directory, lease.directory);
  } finally {
    removeOwned(lease.files.temp, owned);
  }
}

function release(lease: LockLease): void {
  try {
    assertLease(lease);
    removeOwned(lease.files.lock, lease.lock);
    syncDirectory(lease.files.directory, lease.directory);
  } finally {
    closeDescriptor(lease.descriptor);
  }
}

function assertNever(value: never): never {
  throw new GdmError("habit_ledger_decision_invalid", "habit_ledger_corrupt");
}

export function habitLedgerFilePath(cwd: string): string {
  return ledgerFiles(cwd).ledger.path;
}

export function readHabitLedgerFile(cwd: string): string | null {
  return readLedgerFile(ledgerFiles(cwd));
}

export function updateHabitLedgerFile<T>(
  cwd: string,
  decide: (current: string | null) => HabitLedgerFileUpdate<T>,
): T {
  const lease = acquire(ledgerFiles(cwd));
  try {
    removeStaleTemp(lease);
    const decision = decide(readLedgerFile(lease.files));
    switch (decision.kind) {
      case "unchanged":
        return decision.value;
      case "replace":
        replaceFile(lease, decision.bytes);
        return decision.value;
      default:
        return assertNever(decision);
    }
  } finally {
    release(lease);
  }
}
