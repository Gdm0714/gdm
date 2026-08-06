import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { readContainedFile } from "./contained-file.ts";
import type { Audit, WorkspaceFingerprint } from "./types.ts";

function git(cwd: string, args: readonly string[]): { readonly status: number | null; readonly stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

function excluded(path: string): boolean {
  return path === ".gdm.lock" || path === ".gdm" || path.startsWith(".gdm/");
}

export function currentGitPosition(cwd: string): { readonly head: string; readonly branch: string } | null {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const branch = git(cwd, ["branch", "--show-current"]);
  if (head.status !== 0 || branch.status !== 0 || !head.stdout.trim() || !branch.stdout.trim()) return null;
  return { head: head.stdout.trim().toLowerCase(), branch: branch.stdout.trim() };
}

export function captureWorkspaceFingerprint(cwd: string): WorkspaceFingerprint | null {
  const rootResult = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) return null;
  const root = rootResult.stdout.trim();
  const headResult = git(root, ["rev-parse", "HEAD"]);
  const head = headResult.status === 0 && headResult.stdout.trim()
    ? headResult.stdout.trim().toLowerCase()
    : "unborn";
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (files.status !== 0) return null;

  const hash = createHash("sha256");
  const fingerprints: { path: string; sha256: string }[] = [];
  for (const file of files.stdout.split("\0").filter(Boolean).sort()) {
    const path = resolve(root, file);
    const fromRoot = relative(root, path).split(sep).join("/");
    if (fromRoot.startsWith("../") || fromRoot === ".." || excluded(fromRoot)) continue;
    const fileHash = createHash("sha256");
    const update = (value: string | Uint8Array): void => {
      hash.update(value);
      fileHash.update(value);
    };
    update(`path\0${fromRoot}\0`);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) update(`symlink\0${readlinkSync(path)}\0`);
      else if (stat.isFile()) {
        update(`file\0${stat.mode & 0o111 ? "executable" : "regular"}\0`);
        update(readFileSync(path));
      }
    } catch {
      update("deleted\0");
    }
    fingerprints.push({ path: fromRoot, sha256: fileHash.digest("hex") });
  }
  return { kind: "git", head, sha256: hash.digest("hex"), files: fingerprints };
}

export function auditIntegrityProblems(cwd: string, audit: Audit): string[] {
  const problems: string[] = [];
  if (!audit.reportSha256) {
    problems.push("검수보고 해시가 없습니다");
  } else {
    try {
      const report = readContainedFile(cwd, audit.report, "report");
      if (report.sha256 !== audit.reportSha256) problems.push("검수보고가 판정 후 변경됐습니다");
    } catch {
      problems.push("검수보고를 안전하게 읽을 수 없습니다");
    }
  }
  if (!audit.implementationModel || !audit.auditModel) {
    problems.push("구현 모델 또는 검수 모델 기록이 없습니다");
  } else if (audit.implementationModel.toLowerCase() === audit.auditModel.toLowerCase()) {
    problems.push("구현 모델과 검수 모델이 같습니다");
  }
  if (audit.workspace === undefined) {
    problems.push("검수 시점 워크트리 지문이 없습니다");
  } else if (audit.workspace !== null) {
    const current = captureWorkspaceFingerprint(cwd);
    if (current === null || current.sha256 !== audit.workspace.sha256) {
      problems.push("검수 후 워크트리 내용이 변경됐습니다");
    }
  }
  return problems;
}
