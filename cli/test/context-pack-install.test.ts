import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBinary, type BinaryProbe } from "../../bench/context-pack-e2e/install-gdm.ts";
import { sha256 } from "../../bench/context-pack-e2e/protocol.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gdm-narrow-install-"));
  temporary.push(root);
  const source = join(root, "source-gdm");
  const target = join(root, "gdm");
  const launcher = join(root, "unrelated-launcher");
  writeFileSync(source, "new-context-binary\n");
  writeFileSync(target, "old-binary\n");
  writeFileSync(launcher, "preserved-launcher\n");
  chmodSync(source, 0o755);
  chmodSync(target, 0o755);
  chmodSync(launcher, 0o755);
  return { root, source, target, launcher };
}

function probe(path: string): BinaryProbe {
  const text = readFileSync(path, "utf8");
  return text.startsWith("new-context")
    ? { version: "0.9.1", contextSupported: true, querySha256: sha256("pack"), queryBytes: 4 }
    : { version: "0.9.1", contextSupported: false, querySha256: null, queryBytes: null };
}

describe("narrow gdm binary installation", () => {
  test("atomically installs source bytes and preserves the launcher", () => {
    const paths = setup();
    const launcherBefore = sha256(readFileSync(paths.launcher));
    const result = installBinary({ ...paths, probe, now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(readFileSync(paths.target, "utf8")).toBe("new-context-binary\n");
    expect(result.installedSha256).toBe(sha256(readFileSync(paths.source)));
    expect(sha256(readFileSync(paths.launcher))).toBe(launcherBefore);
    expect(readFileSync(result.backupPath, "utf8")).toBe("old-binary\n");
    expect(lstatSync(paths.target).mode & 0o111).not.toBe(0);
  });

  test("restores the old bytes when post-install validation fails", () => {
    const paths = setup();
    let newProbeCount = 0;
    const failingProbe = (path: string): BinaryProbe => {
      const text = readFileSync(path, "utf8");
      if (text.startsWith("new-context") && ++newProbeCount === 2) throw new Error("injected post-install failure");
      return probe(path);
    };
    expect(() => installBinary({ ...paths, probe: failingProbe })).toThrow("injected post-install failure");
    expect(readFileSync(paths.target, "utf8")).toBe("old-binary\n");
    expect(readFileSync(paths.launcher, "utf8")).toBe("preserved-launcher\n");
  });

  test("rejects symlink and non-regular targets before creating a backup", () => {
    const paths = setup();
    rmSync(paths.target);
    symlinkSync(paths.source, paths.target);
    expect(() => installBinary({ ...paths, probe })).toThrow("regular non-symlink");

    rmSync(paths.target);
    mkdirSync(paths.target);
    expect(() => installBinary({ ...paths, probe })).toThrow("regular non-symlink");
  });
});
