import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("release packaging policy", () => {
  test("remote installer verifies both artifacts before installing the binary", () => {
    const install = readFileSync(join(ROOT, "install.sh"), "utf8");
    const packager = readFileSync(join(ROOT, "script", "release", "gdm-package.zsh"), "utf8");
    const qa = readFileSync(join(ROOT, "script", "qa", "gdm-release-qa.zsh"), "utf8");
    expect(install).toContain("GDM_SKIP_VERIFY=1");
    expect(install).toContain('verify_asset "$asset" "$tmp/gdm"');
    expect(install).toContain('verify_asset "gdm-skills.tar.gz" "$tmp/skills.tar.gz"');
    expect(install.indexOf("verify_asset \"gdm-skills.tar.gz\"")).toBeLessThan(install.indexOf('mv "$INSTALL_TMP" "$BIN_DIR/gdm"'));
    expect(install).toContain("SHASUMS256.txt가 없어 설치를 중단합니다");
    expect(install).toContain('$tmp/pkg/targets/codex');
    expect(install).toContain('$tmp/pkg/targets/claude');
    expect(install).toContain('$tmp/pkg/targets/gid');
    expect(install).toContain("validate_staged_target");
    expect(install).toContain("canonicalSourceSha256");
    expect(install).toContain("manifest_runner_hash");
    expect(packager).toContain("render-skills");
    expect(packager).toContain('for target in codex claude gid');
    expect(packager).toContain("verify-manifests");
    expect(qa).toContain("deterministic target renders");
    expect(qa).toContain("for target in codex claude gid");
  });
});
