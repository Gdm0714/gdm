import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { GdmError } from "./state.ts";

export const SOURCE_FINGERPRINT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_GIT_EXECUTABLE = "/usr/bin/git";

export interface SourceFingerprint {
  readonly schemaVersion: typeof SOURCE_FINGERPRINT_SCHEMA_VERSION;
  readonly sha256: string;
  readonly fileCount: number;
}

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const EXCLUDED_PATHS = [
  ":(exclude).gdm",
  ":(exclude).gdm/**",
  ":(exclude).gdm.lock",
] as const;
const GDM_DIRECTORY = Buffer.from(".gdm");
const GDM_LOCK = Buffer.from(".gdm.lock");
const PATH_SEPARATOR = 0x2f;
const DOT = 0x2e;

function outputBuffer(value: Uint8Array | string | null | undefined): Buffer {
  if (typeof value === "string") return Buffer.from(value);
  return value === null || value === undefined ? Buffer.alloc(0) : Buffer.from(value);
}

function gitOutput(cwd: string, gitExecutable: string, args: readonly string[]): Buffer {
  if (!isAbsolute(gitExecutable)) {
    throw new GdmError("workspace fingerprint의 git 실행 파일은 절대 경로여야 합니다", "usage");
  }
  const result = spawnSync(gitExecutable, args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) {
    throw new GdmError(`workspace fingerprint git 실행 실패: ${result.error.message}`, "source_fingerprint_failed");
  }
  if (result.status !== 0) {
    const stderr = outputBuffer(result.stderr).toString("utf8").trim();
    throw new GdmError(
      `workspace fingerprint git 명령 실패${stderr ? `: ${stderr}` : ""}`,
      "source_fingerprint_failed",
    );
  }
  return outputBuffer(result.stdout);
}

function nulRecords(output: Buffer): Buffer[] {
  if (output.byteLength === 0) return [];
  if (output[output.byteLength - 1] !== 0) {
    throw new GdmError("workspace fingerprint git 출력이 NUL 형식이 아닙니다", "source_fingerprint_failed");
  }
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index++) {
    if (output[index] !== 0) continue;
    records.push(Buffer.from(output.subarray(start, index)));
    start = index + 1;
  }
  return records;
}

function excluded(path: Buffer): boolean {
  return path.equals(GDM_DIRECTORY) || path.equals(GDM_LOCK) ||
    (
      path.byteLength > GDM_DIRECTORY.byteLength &&
      path.subarray(0, GDM_DIRECTORY.byteLength).equals(GDM_DIRECTORY) &&
      path[GDM_DIRECTORY.byteLength] === PATH_SEPARATOR
    );
}

function absolutePath(root: string, path: Buffer): Buffer {
  let componentStart = 0;
  let unsafe = path.byteLength === 0 || path[0] === PATH_SEPARATOR;
  for (let index = 0; !unsafe && index <= path.byteLength; index++) {
    if (index < path.byteLength && path[index] !== PATH_SEPARATOR) continue;
    const length = index - componentStart;
    unsafe = length === 0 ||
      (length === 1 && path[componentStart] === DOT) ||
      (length === 2 && path[componentStart] === DOT && path[componentStart + 1] === DOT);
    componentStart = index + 1;
  }
  if (unsafe) {
    throw new GdmError("workspace fingerprint에 안전하지 않은 git 경로가 있습니다", "source_fingerprint_failed");
  }
  return Buffer.concat([Buffer.from(root), Buffer.from(sep), path]);
}

/**
 * Return a compact digest of repository source and Git state. This is separate
 * from captureWorkspaceFingerprint because audit records depend on that
 * function's existing byte-for-byte semantics.
 */
export function captureSourceFingerprint(
  cwd: string,
  gitExecutable = DEFAULT_GIT_EXECUTABLE,
): SourceFingerprint {
  const rootOutput = gitOutput(cwd, gitExecutable, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const root = rootOutput.toString("utf8").replace(/\r?\n$/u, "");
  if (!root || !isAbsolute(root)) {
    throw new GdmError("workspace fingerprint 저장소 루트를 확인할 수 없습니다", "source_fingerprint_failed");
  }

  const pathArgs = ["--", ".", ...EXCLUDED_PATHS];
  const listed = gitOutput(
    root,
    gitExecutable,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", ...pathArgs],
  );
  const index = gitOutput(root, gitExecutable, ["ls-files", "--stage", "-z", ...pathArgs]);
  const status = gitOutput(
    root,
    gitExecutable,
    ["status", "--porcelain=v2", "-z", "--untracked-files=all", ...pathArgs],
  );
  const paths = nulRecords(listed)
    .filter((path) => !excluded(path))
    .sort(Buffer.compare)
    .filter((path, index, sorted) => index === 0 || !path.equals(sorted[index - 1]!));

  const hash = createHash("sha256");
  const appendCount = (count: number): void => {
    const encoded = Buffer.allocUnsafe(8);
    encoded.writeBigUInt64BE(BigInt(count));
    hash.update(encoded);
  };
  const appendBytes = (value: Uint8Array): void => {
    appendCount(value.byteLength);
    hash.update(value);
  };
  const appendString = (value: string): void => appendBytes(Buffer.from(value, "utf8"));
  appendString("gidem-source-fingerprint-v1");
  appendBytes(index);
  appendBytes(status);
  appendCount(paths.length);
  for (const path of paths) {
    appendBytes(path);
    const filePath = absolutePath(root, path);
    try {
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        appendString("symlink");
        appendCount(stat.mode & 0o7777);
        appendBytes(readlinkSync(filePath, { encoding: "buffer" }));
      } else if (stat.isFile()) {
        appendString("file");
        appendCount(stat.mode & 0o7777);
        appendBytes(readFileSync(filePath));
      } else if (stat.isDirectory()) {
        appendString("directory");
        appendCount(stat.mode & 0o7777);
      } else {
        appendString("other");
        appendCount(stat.mode & 0o7777);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      appendString("deleted");
    }
  }

  return {
    schemaVersion: SOURCE_FINGERPRINT_SCHEMA_VERSION,
    sha256: hash.digest("hex"),
    fileCount: paths.length,
  };
}
