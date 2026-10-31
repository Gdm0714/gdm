#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  constants,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createPilotFixture } from "../context-pack-pilot/fixture.ts";
import { INSTALL_SCHEMA, contextRequest, isRecord, sha256 } from "./protocol.ts";

export interface BinaryProbe {
  readonly version: string;
  readonly contextSupported: boolean;
  readonly querySha256: string | null;
  readonly queryBytes: number | null;
}

export interface InstallOptions {
  readonly source: string;
  readonly target: string;
  readonly launcher: string;
  readonly probe: (path: string) => BinaryProbe;
  readonly now?: () => Date;
}

export interface InstallResult {
  readonly sourceSha256: string;
  readonly oldSha256: string;
  readonly installedSha256: string;
  readonly launcherSha256: string;
  readonly backupPath: string;
  readonly oldProbe: BinaryProbe;
  readonly sourceProbe: BinaryProbe;
  readonly installedProbe: BinaryProbe;
}

function regularFile(path: string, label: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return realpathSync(path);
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function atomicCopy(source: string, target: string, mode: number): void {
  const directory = dirname(target);
  const temporary = join(directory, `.gdm-install-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, mode);
    syncFile(temporary);
    renameSync(temporary, target);
    syncDirectory(directory);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function installBinary(options: InstallOptions): InstallResult {
  const source = regularFile(options.source, "source");
  const target = regularFile(options.target, "target");
  const launcher = regularFile(options.launcher, "launcher");
  const sourceBytes = readFileSync(source);
  const oldBytes = readFileSync(target);
  const launcherSha256 = sha256(readFileSync(launcher));
  const sourceSha256 = sha256(sourceBytes);
  const oldSha256 = sha256(oldBytes);
  const sourceProbe = options.probe(source);
  const oldProbe = options.probe(target);
  if (!sourceProbe.contextSupported || sourceProbe.querySha256 === null || sourceProbe.queryBytes === null || sourceProbe.queryBytes > 4097) {
    throw new Error("source context probe failed");
  }
  const timestamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/gu, "-");
  const backupPath = `${target}.bak.${timestamp}.${randomBytes(4).toString("hex")}`;
  copyFileSync(target, backupPath, constants.COPYFILE_EXCL);
  chmodSync(backupPath, lstatSync(target).mode & 0o777);
  syncFile(backupPath);
  if (sha256(readFileSync(backupPath)) !== oldSha256) throw new Error("backup hash mismatch");
  try {
    atomicCopy(source, target, 0o755);
    const installedSha256 = sha256(readFileSync(target));
    const installedProbe = options.probe(target);
    if (installedSha256 !== sourceSha256 || installedProbe.version !== sourceProbe.version ||
        installedProbe.contextSupported !== true || installedProbe.querySha256 !== sourceProbe.querySha256 ||
        installedProbe.queryBytes !== sourceProbe.queryBytes || sha256(readFileSync(launcher)) !== launcherSha256) {
      throw new Error("installed binary validation failed");
    }
    return {
      sourceSha256,
      oldSha256,
      installedSha256,
      launcherSha256,
      backupPath,
      oldProbe,
      sourceProbe,
      installedProbe,
    };
  } catch (error) {
    try {
      atomicCopy(backupPath, target, lstatSync(backupPath).mode & 0o777);
      const restoredProbe = options.probe(target);
      if (sha256(readFileSync(target)) !== oldSha256 || restoredProbe.version !== oldProbe.version ||
          restoredProbe.contextSupported !== oldProbe.contextSupported || sha256(readFileSync(launcher)) !== launcherSha256) {
        throw new Error("rollback validation failed");
      }
    } catch (rollbackError) {
      throw new Error(`install failed and rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
}

function command(path: string, args: readonly string[], stdin = "", env: Readonly<Record<string, string>> = {}) {
  const outcome = Bun.spawnSync([path, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return { exitCode: outcome.exitCode, stdout: new TextDecoder().decode(outcome.stdout) };
}

function probeWithFixture(root: string): (path: string) => BinaryProbe {
  return (path) => {
    const version = command(path, ["--version"]);
    if (version.exitCode !== 0) throw new Error("binary version probe failed");
    const status = command(path, ["context", "status"]);
    let contextSupported = false;
    if (status.exitCode === 0) {
      try {
        const value = JSON.parse(status.stdout) as unknown;
        contextSupported = isRecord(value) && value.schemaVersion === "gdm-context-status/v1" && value.mode === "one-shot";
      } catch {}
    }
    if (!contextSupported) return { version: version.stdout.trim(), contextSupported: false, querySha256: null, queryBytes: null };
    const request = `${JSON.stringify(contextRequest(root, "ownership"))}\n`;
    const query = command(path, ["context", "query"], request, { GDM_CONTEXT_TRUSTED_ROOT: root });
    if (query.exitCode !== 0) throw new Error("binary context query probe failed");
    const pack = JSON.parse(query.stdout) as unknown;
    if (!isRecord(pack) || pack.s !== "gdm-context-pack/v1" || pack.st !== "ok" || pack.fr !== "fresh" ||
        Buffer.byteLength(query.stdout) > 4097) throw new Error("binary context pack probe failed");
    return {
      version: version.stdout.trim(),
      contextSupported: true,
      querySha256: sha256(query.stdout),
      queryBytes: Buffer.byteLength(query.stdout),
    };
  };
}

async function main(): Promise<void> {
  throw new Error("Retired benchmark installer: Pi integration was removed. Use install/install.sh for the native GDM/gid targets.");
}

if (import.meta.main) await main();
