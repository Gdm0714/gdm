import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { GdmError } from "./state.ts";

export type NodeName = "repository" | "gdm" | "habits" | "ledger" | "lock" | "temp";
export type NodeKind = "directory" | "regular";
export type NodeSpec = { readonly name: NodeName; readonly kind: NodeKind; readonly path: string };
export type Identity = { readonly device: number; readonly inode: number };
export type LedgerFiles = {
  readonly repository: NodeSpec;
  readonly root: NodeSpec;
  readonly directory: NodeSpec;
  readonly ledger: NodeSpec;
  readonly lock: NodeSpec;
  readonly temp: NodeSpec;
};

export function ledgerFiles(cwd: string): LedgerFiles {
  const root = join(cwd, ".gdm");
  const directory = join(root, "habits");
  return {
    repository: { name: "repository", kind: "directory", path: cwd },
    root: { name: "gdm", kind: "directory", path: root },
    directory: { name: "habits", kind: "directory", path: directory },
    ledger: { name: "ledger", kind: "regular", path: join(directory, "ledger.jsonl") },
    lock: { name: "lock", kind: "regular", path: join(directory, ".ledger.lock") },
    temp: { name: "temp", kind: "regular", path: join(directory, ".ledger.tmp") },
  };
}

export function rejected(node: NodeName, category: string): GdmError {
  return new GdmError(
    `habit_ledger_rejected node=${node} category=${category}`,
    "habit_ledger_corrupt",
  );
}

function ioFailure(operation: string): GdmError {
  return new GdmError(`habit_ledger_io operation=${operation}`, "habit_ledger_corrupt");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && isRecord(error) && error.code === code;
}

export function rethrowIo(error: unknown, operation: string): never {
  if (error instanceof GdmError) throw error;
  if (error instanceof Error) throw ioFailure(operation);
  throw error;
}

export function inspect(node: NodeSpec): Stats | undefined {
  let stat: Stats;
  try {
    stat = lstatSync(node.path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    return rethrowIo(error, "inspect");
  }
  if (stat.isSymbolicLink()) throw rejected(node.name, "symlink");
  if (node.kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw rejected(node.name, "kind");
  }
  return stat;
}

export function required(node: NodeSpec): Stats {
  const stat = inspect(node);
  if (stat === undefined) throw rejected(node.name, "missing");
  return stat;
}

export function identity(stat: Stats): Identity {
  return { device: stat.dev, inode: stat.ino };
}

export function sameIdentity(stat: Stats, expected: Identity): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

export function assertIdentity(node: NodeSpec, expected: Identity): void {
  if (!sameIdentity(required(node), expected)) throw rejected(node.name, "changed");
}

export function closeDescriptor(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch (error) {
    rethrowIo(error, "close");
  }
}

function readRegular(node: NodeSpec): string {
  let descriptor: number;
  try {
    descriptor = openSync(node.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return rethrowIo(error, "read-open");
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw rejected(node.name, "kind");
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    return rethrowIo(error, "read");
  } finally {
    closeDescriptor(descriptor);
  }
}

export function readLedgerFile(files: LedgerFiles): string | null {
  required(files.repository);
  if (inspect(files.root) === undefined) return null;
  if (inspect(files.directory) === undefined) return null;
  inspect(files.lock);
  inspect(files.temp);
  const ledger = inspect(files.ledger);
  return ledger === undefined ? null : readRegular(files.ledger);
}

export function createDirectory(node: NodeSpec): Identity {
  const existing = inspect(node);
  if (existing !== undefined) return identity(existing);
  try {
    mkdirSync(node.path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) return rethrowIo(error, "mkdir");
  }
  return identity(required(node));
}

export function syncDirectory(node: NodeSpec, expected: Identity): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      node.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    return rethrowIo(error, "directory-open");
  }
  try {
    if (!sameIdentity(fstatSync(descriptor), expected)) throw rejected(node.name, "changed");
    fsyncSync(descriptor);
  } catch (error) {
    rethrowIo(error, "directory-sync");
  } finally {
    closeDescriptor(descriptor);
  }
}
