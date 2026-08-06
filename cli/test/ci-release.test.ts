import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("CI and release policy", () => {
  test("PR CI scans only the change range and runs one verify pipeline", () => {
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("github.event.pull_request.base.sha");
    expect(ci).toContain("github.event.pull_request.head.sha");
    expect(ci).not.toContain("AI 표기 금지 검사 (전체 히스토리)");
    expect(ci.match(/bun run verify/g)).toHaveLength(1);
    expect(ci).toContain("cancel-in-progress: true");
    expect(ci).toContain("runs-on: ubuntu-24.04");
    expect(ci).toContain("timeout-minutes: 45");
    expect(ci).toContain("persist-credentials: false");
    const actionRefs = [...ci.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]+([^#\s]+)(?:[ \t]+#.*)?[ \t]*$/gmu)].map(
      (match) => match[1],
    );
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }
  });

  test("tag release verifies source and package version before publishing", () => {
    const release = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(release.indexOf("bun run verify")).toBeGreaterThan(0);
    expect(release.indexOf("bun run verify")).toBeLessThan(release.indexOf("\n  build:"));
    expect(release).toContain("Match tag and package version");
    expect(release).toContain("bun install --frozen-lockfile");
    expect(release).toContain('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main');
    const nativeMatrix = [...release.matchAll(
      /^[ \t]*-[ \t]+runner:[ \t]+([^\s]+)\n[ \t]+os:[ \t]+([^\s]+)\n[ \t]+arch:[ \t]+([^\s]+)$/gmu,
    )].map((match) => match.slice(1));
    expect(nativeMatrix).toEqual([
      ["ubuntu-24.04", "linux", "x64"],
      ["ubuntu-24.04-arm", "linux", "arm64"],
      ["macos-15-intel", "darwin", "x64"],
      ["macos-15", "darwin", "arm64"],
    ]);
    expect(release).toContain("Confirm native runner architecture");
    expect(release).toContain("script/qa/gdm-release-qa.zsh");
    expect(release).toContain("--verify-tag");
    expect(release).toContain("bun-version: 1.3.14");
    const jobsStart = release.indexOf("\njobs:");
    const verifyStart = release.indexOf("\n  verify:");
    const verifySteps = release.indexOf("\n    steps:", verifyStart);
    const buildStart = release.indexOf("\n  build:");
    const buildSteps = release.indexOf("\n    steps:", buildStart);
    const publishStart = release.indexOf("\n  publish:");
    const publishSteps = release.indexOf("\n    steps:", publishStart);
    expect(release.slice(0, jobsStart)).toContain("permissions:\n  contents: read");
    expect(release.slice(0, jobsStart)).not.toContain("contents: write");
    expect(release.slice(verifyStart, verifySteps)).toContain("timeout-minutes: 45");
    expect(release.slice(buildStart, buildSteps)).toContain("needs: verify");
    expect(release.slice(buildStart, buildSteps)).toContain("timeout-minutes: 30");
    expect(release.slice(publishStart, publishSteps)).toContain("needs: build");
    expect(release.slice(publishStart, publishSteps)).toContain("timeout-minutes: 10");
    expect(release.slice(publishStart, publishSteps)).toContain("permissions:\n      contents: write");
    expect(release.slice(jobsStart, publishStart)).not.toContain("contents: write");
    expect(release.match(/contents: write/g)).toHaveLength(1);
    const writeScopes = [...release.matchAll(/^[ \t]+([a-z-]+):[ \t]+write[ \t]*$/gmu)].map(
      (match) => match[1],
    );
    expect(writeScopes).toEqual(["contents"]);
    expect(release).toContain("- name: Smoke native binary");
    expect(release).toContain("--version)");
    expect(release).toContain("persist-credentials: false");
    expect(release).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(release).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(release).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(release).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(release).toContain("sudo apt-get install --yes ripgrep zsh");
    expect(release).toContain("Restore artifact executable modes");
    expect(release).toContain(".github/workflows/ci.yml");
    const actionRefs = [...release.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]+([^#\s]+)(?:[ \t]+#.*)?[ \t]*$/gmu)].map(
      (match) => match[1],
    );
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const actionRef of actionRefs) {
      expect(actionRef).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }
  });

  test("remote installer verifies both artifacts before installing the binary", () => {
    const install = readFileSync(join(ROOT, "install.sh"), "utf8");
    expect(install).toContain("GDM_SKIP_VERIFY=1");
    expect(install).toContain('verify_asset "$asset" "$tmp/gdm"');
    expect(install).toContain('verify_asset "gdm-skills.tar.gz" "$tmp/skills.tar.gz"');
    expect(install.indexOf("verify_asset \"gdm-skills.tar.gz\"")).toBeLessThan(install.indexOf('mv "$INSTALL_TMP" "$BIN_DIR/gdm"'));
    expect(install).toContain("SHASUMS256.txt가 없어 설치를 중단합니다");
  });
});
