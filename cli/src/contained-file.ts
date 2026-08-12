import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertNoSensitiveRaw } from "./contract.ts";
import { GdmError } from "./state.ts";

export type ContainedFile = {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
  /** A detached, read-only-by-contract copy of the exact bytes hashed above. */
  readonly bytes: Uint8Array;
  /** Canonical immutable transport form of the same fd bytes. */
  readonly bytesBase64: string;
};

export type ContainedFileReadOptions = {
  /** Refuse before reading when the regular file is larger than this byte count. */
  readonly maxBytes?: number;
  /** Domain-specific error code used when maxBytes is exceeded. */
  readonly tooLargeCode?: string;
};

function rejected(field: string, category: string): GdmError {
  return new GdmError(`field=${field} category=${category}`, "path_rejected");
}

function boundedRead(descriptor: number, maxBytes: number, field: string, code: string): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const count = readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total);
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  throw new GdmError(`field=${field} maxBytes=${maxBytes}`, code);
}

export function readContainedFile(
  cwd: string,
  value: string,
  field: string,
  options: ContainedFileReadOptions = {},
): ContainedFile {
  assertNoSensitiveRaw(value, field);
  if (value.includes("\\") || isAbsolute(value) || value.length === 0) {
    throw rejected(field, "containment");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw rejected(field, "containment");
  }
  for (const part of parts) assertNoSensitiveRaw(part, `${field}-component`);
  let current = cwd;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw rejected(field, "symlink");
      }
    } catch (error) {
      if (error instanceof GdmError) throw error;
      throw rejected(field, "missing");
    }
  }
  let root: string;
  let path: string;
  try {
    root = realpathSync(cwd);
    path = realpathSync(resolve(cwd, value));
  } catch {
    throw rejected(field, "missing");
  }
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw rejected(field, "containment");
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw rejected(field, "read");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw rejected(field, "containment");
    const maxBytes = options.maxBytes;
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new GdmError(`field=${field} maxBytes가 유효하지 않습니다`, "usage");
    }
    const tooLargeCode = options.tooLargeCode ?? "file_too_large";
    if (maxBytes !== undefined && stat.size > maxBytes) {
      throw new GdmError(`field=${field} size=${stat.size} maxBytes=${maxBytes}`, tooLargeCode);
    }
    const bytes = maxBytes === undefined
      ? readFileSync(descriptor)
      : boundedRead(descriptor, maxBytes, field, tooLargeCode);
    return {
      path: value,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes.toString("utf8"),
      bytes: Uint8Array.from(bytes),
      bytesBase64: bytes.toString("base64"),
    };
  } catch (error) {
    if (error instanceof GdmError) throw error;
    throw rejected(field, "read");
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      throw rejected(field, "read");
    }
  }
}
