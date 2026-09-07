#!/usr/bin/env bun
import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createPilotFixture } from "../context-pack-pilot/fixture.ts";
import { INSTALL_SCHEMA, contextRequest, isRecord, sha256 } from "./protocol.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SOURCE = join(ROOT, "cli/dist/gdm");
const TARGET = resolve(process.env.HOME ?? "", ".local/bin/gdm");
const LAUNCHER = resolve(process.env.HOME ?? "", ".local/bin/gdm-pi");
const RECEIPT = join(import.meta.dir, "results/install.json");
const HEX64 = /^[0-9a-f]{64}$/u;

function regular(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe installed artifact ${basename(path)}`);
  return realpathSync(path);
}

function run(path: string, args: readonly string[], stdin = "", env: Readonly<Record<string, string>> = {}) {
  const outcome = Bun.spawnSync([path, ...args], {
    stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  if (outcome.exitCode !== 0) throw new Error(`installed smoke failed ${args.join(" ")}`);
  return new TextDecoder().decode(outcome.stdout);
}

const receipt = JSON.parse(readFileSync(RECEIPT, "utf8")) as unknown;
if (!isRecord(receipt) || receipt.schemaVersion !== INSTALL_SCHEMA || receipt.target !== "user-local-gdm" ||
    typeof receipt.sourceSha256 !== "string" || !HEX64.test(receipt.sourceSha256) ||
    typeof receipt.installedSha256 !== "string" || !HEX64.test(receipt.installedSha256) ||
    typeof receipt.launcherSha256 !== "string" || !HEX64.test(receipt.launcherSha256) ||
    typeof receipt.backupName !== "string" || receipt.backupName.includes("/") ||
    typeof receipt.backupSha256 !== "string" || !HEX64.test(receipt.backupSha256)) throw new Error("invalid install receipt");
const source = regular(SOURCE);
const target = regular(TARGET);
const launcher = regular(LAUNCHER);
const backup = regular(join(dirname(target), receipt.backupName));
const sourceSha256 = sha256(readFileSync(source));
const installedSha256 = sha256(readFileSync(target));
if (sourceSha256 !== receipt.sourceSha256 || installedSha256 !== sourceSha256 || installedSha256 !== receipt.installedSha256 ||
    sha256(readFileSync(launcher)) !== receipt.launcherSha256 || sha256(readFileSync(backup)) !== receipt.backupSha256) {
  throw new Error("installed hash parity failed");
}
const sourceStatus = JSON.parse(run(source, ["context", "status"])) as unknown;
const targetStatus = JSON.parse(run(target, ["context", "status"])) as unknown;
if (!isRecord(sourceStatus) || !isRecord(targetStatus) || JSON.stringify(sourceStatus) !== JSON.stringify(targetStatus) ||
    sourceStatus.schemaVersion !== "gdm-context-status/v1" || sourceStatus.mode !== "one-shot") throw new Error("installed status parity failed");
const fixture = createPilotFixture();
try {
  const request = `${JSON.stringify(contextRequest(fixture.root, "ownership"))}\n`;
  const env = { GDM_CONTEXT_TRUSTED_ROOT: fixture.root };
  const sourcePack = run(source, ["context", "query"], request, env);
  const targetPack = run(target, ["context", "query"], request, env);
  const pack = JSON.parse(targetPack) as unknown;
  if (sourcePack !== targetPack || sha256(targetPack) !== receipt.querySha256 || Buffer.byteLength(targetPack) !== receipt.queryBytes ||
      Buffer.byteLength(targetPack) > 4097 || !isRecord(pack) || pack.s !== "gdm-context-pack/v1" || pack.st !== "ok" || pack.fr !== "fresh") {
    throw new Error("installed query parity failed");
  }
} finally {
  rmSync(fixture.root, { recursive: true, force: true });
}
console.log(JSON.stringify({ verified: true, sourceSha256, installedSha256, launcherPreserved: true, contextLive: true }));
