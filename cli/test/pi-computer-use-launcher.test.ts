import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gdm-pi computer use launcher", () => {
  test("explicitly loads only the isolated Computer Use extension while preserving existing boundaries", () => {
    const launcher = readFileSync(join(ROOT, "agents", "pi", "gdm-pi"), "utf8");
    expect(launcher).toContain('computer_use_extension="$asset_root/gdm-computer-use/index.ts"');
    expect(launcher).toContain('required_assets=("$extension" "$memory_extension" "$computer_use_extension"');
    expect(launcher).toContain('--extension "$memory_extension"');
    expect(launcher).toContain('--extension "$computer_use_extension"');
    expect(launcher).toContain("--no-extensions");
    expect(launcher).toContain("read,bash,edit,write,grep,find,ls,gdm_delegate,gdm_memory,gdm_computer_use");
  });

  test("renders the Computer Use tree byte-identically into the Pi target", () => {
    const output = mkdtempSync(join(tmpdir(), "gdm-cu-render-"));
    roots.push(output);
    const rendered = Bun.spawnSync([
      "bun", join(ROOT, "install", "render-skills.ts"),
      "--source-root", join(ROOT, "skills"),
      "--agents-root", join(ROOT, "agents"),
      "--target", "pi",
      "--output", output,
    ], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(rendered.exitCode, rendered.stderr.toString()).toBe(0);
    for (const file of ["index.ts", "vm.ts", "rfb.ts", "auth.ts", "png.ts", "keys.ts", "setup.sh"]) {
      expect(readFileSync(join(output, "gdm-agents", "pi", "gdm-computer-use", file))).toEqual(
        readFileSync(join(ROOT, "agents", "pi", "gdm-computer-use", file)),
      );
    }
  });
});
