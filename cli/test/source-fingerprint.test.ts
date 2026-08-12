import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceFingerprint } from "../src/source-fingerprint.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const GIT = "/usr/bin/git";
const decoder = new TextDecoder();

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync([GIT, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(decoder.decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gdm-source-fingerprint-"));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "gdm test"]);
  git(cwd, ["config", "user.email", "gdm@example.invalid"]);
  git(cwd, ["config", "core.filemode", "true"]);
  writeFileSync(join(cwd, "tracked.txt"), "base\n");
  mkdirSync(join(cwd, ".gdm"));
  writeFileSync(join(cwd, ".gdm", "tracked-state.json"), "initial\n");
  git(cwd, ["add", "tracked.txt", ".gdm/tracked-state.json"]);
  git(cwd, ["commit", "-qm", "baseline"]);
  return cwd;
}

function runCli(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

describe("source fingerprint", () => {
  test("CLI returns only the bounded v1 JSON and never executes PATH git", () => {
    const cwd = repository();
    const fakeBin = mkdtempSync(join(tmpdir(), "gdm-fake-git-"));
    const marker = join(fakeBin, "path-git-ran");
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, "#!/bin/sh\n: > \"$FAKE_GIT_MARKER\"\nexit 99\n");
    chmodSync(fakeGit, 0o755);

    const result = runCli(cwd, ["workspace", "fingerprint", "--json"], {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_GIT_MARKER: marker,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["schemaVersion", "sha256", "fileCount"]);
    expect(parsed).toEqual({
      schemaVersion: 1,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      fileCount: 1,
    });
    expect(existsSync(marker)).toBe(false);

    const outside = mkdtempSync(join(tmpdir(), "gdm-source-outside-"));
    expect(runCli(outside, ["workspace", "fingerprint", "--json"]).exitCode).not.toBe(0);
  });

  test("staged-only content and index-only mode changes alter the digest", () => {
    const cwd = repository();
    const clean = captureSourceFingerprint(cwd);

    writeFileSync(join(cwd, "tracked.txt"), "staged one\n");
    git(cwd, ["add", "tracked.txt"]);
    git(cwd, ["restore", "--source=HEAD", "--worktree", "tracked.txt"]);
    const firstStaged = captureSourceFingerprint(cwd);
    expect(firstStaged.sha256).not.toBe(clean.sha256);

    writeFileSync(join(cwd, "tracked.txt"), "staged two\n");
    git(cwd, ["add", "tracked.txt"]);
    git(cwd, ["restore", "--source=HEAD", "--worktree", "tracked.txt"]);
    const secondStaged = captureSourceFingerprint(cwd);
    expect(secondStaged.sha256).not.toBe(firstStaged.sha256);

    git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "tracked.txt"]);
    expect(captureSourceFingerprint(cwd)).toEqual(clean);
    git(cwd, ["update-index", "--chmod=+x", "tracked.txt"]);
    const indexMode = captureSourceFingerprint(cwd);
    expect(indexMode.sha256).not.toBe(clean.sha256);
  });

  test("working mode, delete, rename, symlink, and untracked paths alter the digest", () => {
    const cwd = repository();
    const clean = captureSourceFingerprint(cwd);

    chmodSync(join(cwd, "tracked.txt"), 0o755);
    expect(captureSourceFingerprint(cwd).sha256).not.toBe(clean.sha256);
    chmodSync(join(cwd, "tracked.txt"), 0o644);
    expect(captureSourceFingerprint(cwd)).toEqual(clean);
    chmodSync(join(cwd, "tracked.txt"), 0o600);
    expect(captureSourceFingerprint(cwd).sha256).not.toBe(clean.sha256);
    chmodSync(join(cwd, "tracked.txt"), 0o644);

    rmSync(join(cwd, "tracked.txt"));
    expect(captureSourceFingerprint(cwd).sha256).not.toBe(clean.sha256);
    git(cwd, ["restore", "tracked.txt"]);

    renameSync(join(cwd, "tracked.txt"), join(cwd, "renamed\nfile.txt"));
    expect(captureSourceFingerprint(cwd).sha256).not.toBe(clean.sha256);
    renameSync(join(cwd, "renamed\nfile.txt"), join(cwd, "tracked.txt"));

    symlinkSync("target-one", join(cwd, "link.txt"));
    const firstLink = captureSourceFingerprint(cwd);
    expect(firstLink.sha256).not.toBe(clean.sha256);
    rmSync(join(cwd, "link.txt"));
    symlinkSync("target-two", join(cwd, "link.txt"));
    expect(captureSourceFingerprint(cwd).sha256).not.toBe(firstLink.sha256);
    rmSync(join(cwd, "link.txt"));

    writeFileSync(join(cwd, "untracked.txt"), "new\n");
    const untracked = captureSourceFingerprint(cwd);
    expect(untracked.sha256).not.toBe(clean.sha256);
    expect(untracked.fileCount).toBe(clean.fileCount + 1);
  });

  test("tracked, staged, and untracked .gdm changes are completely excluded", () => {
    const cwd = repository();
    const clean = captureSourceFingerprint(cwd);

    writeFileSync(join(cwd, ".gdm", "tracked-state.json"), "changed\n");
    writeFileSync(join(cwd, ".gdm", "new-state.json"), "new\n");
    git(cwd, ["add", ".gdm/tracked-state.json", ".gdm/new-state.json"]);

    expect(captureSourceFingerprint(cwd)).toEqual(clean);
  });
});
