import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertNoSensitiveRaw } from "./contract.ts";
import { GdmError } from "./state.ts";

export type ContainedFile = {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
};

function rejected(field: string, category: string): GdmError {
  return new GdmError(`field=${field} category=${category}`, "path_rejected");
}

export function readContainedFile(cwd: string, value: string, field: string): ContainedFile {
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
    if (!fstatSync(descriptor).isFile()) throw rejected(field, "containment");
    const bytes = readFileSync(descriptor);
    return {
      path: value,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes.toString("utf8"),
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
