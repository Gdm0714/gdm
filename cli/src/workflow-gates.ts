import { pathMatchesPrefix } from "./contract.ts";
import type { Work, WorkspaceFingerprint } from "./types.ts";

export interface ScopeProblem {
  readonly path: string;
  readonly reason: "outside-allowed" | "forbidden" | "unverifiable";
}

export function changedWorkspacePaths(
  baseline: WorkspaceFingerprint,
  current: WorkspaceFingerprint,
): readonly string[] | null {
  if (!baseline.files || !current.files) {
    return baseline.sha256 === current.sha256 ? [] : null;
  }
  const before = new Map(baseline.files.map((file) => [file.path, file.sha256]));
  const after = new Map(current.files.map((file) => [file.path, file.sha256]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

export function workspaceScopeProblems(
  work: Work,
  current: WorkspaceFingerprint | null,
): readonly ScopeProblem[] {
  if (work.baseline === undefined) return [];
  const allowed = work.contract.allowedPaths ?? ["."];
  const forbidden = work.contract.forbiddenPaths ?? [];
  const unrestricted = allowed.includes(".") && forbidden.length === 0;
  if (work.baseline === null || current === null) {
    return unrestricted ? [] : [{ path: "(workspace)", reason: "unverifiable" }];
  }
  const changed = changedWorkspacePaths(work.baseline, current);
  if (changed === null) return [{ path: "(workspace)", reason: "unverifiable" }];
  const problems: ScopeProblem[] = [];
  for (const path of changed) {
    if (forbidden.some((prefix) => pathMatchesPrefix(path, prefix))) {
      problems.push({ path, reason: "forbidden" });
    } else if (!allowed.some((prefix) => pathMatchesPrefix(path, prefix))) {
      problems.push({ path, reason: "outside-allowed" });
    }
  }
  return problems;
}

export function describeScopeProblems(problems: readonly ScopeProblem[]): string {
  const detail = problems.map((problem) => `${problem.path}(${problem.reason})`).join(", ");
  const recovery: string[] = [];
  if (problems.some((problem) => problem.reason === "outside-allowed")) {
    recovery.push("범위 확장: gdm plan contract --allow-path <경로> --reason <사유>");
  }
  if (problems.some((problem) => problem.reason === "forbidden")) {
    recovery.push("금지 해제: gdm plan contract --remove-forbid-path <경로> --reason <사유>");
  }
  if (problems.some((problem) => problem.reason === "unverifiable")) {
    recovery.push("Git 저장소에서 다시 plan init하거나 경로 제한을 명시적으로 해제");
  }
  return `변경 범위 계약 위반: ${detail}. ${recovery.join(" · ")}`;
}
