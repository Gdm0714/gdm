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
  });

  test("tag release verifies source and package version before publishing", () => {
    const release = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(release.indexOf("bun run verify")).toBeGreaterThan(0);
    expect(release.indexOf("bun run verify")).toBeLessThan(release.indexOf("크로스 컴파일"));
    expect(release).toContain("태그·패키지 버전 일치");
    expect(release).toContain("bun install --frozen-lockfile");
  });

  test("remote installer verifies both artifacts before installing the binary", () => {
    const install = readFileSync(join(ROOT, "install.sh"), "utf8");
    expect(install).toContain("GDM_SKIP_VERIFY=1");
    expect(install).toContain('verify_asset "$asset" "$tmp/gdm"');
    expect(install).toContain('verify_asset "gdm-skills.tar.gz" "$tmp/skills.tar.gz"');
    expect(install.indexOf("verify_asset \"gdm-skills.tar.gz\"")).toBeLessThan(install.indexOf('mv "$install_tmp" "$BIN_DIR/gdm"'));
    expect(install).toContain("SHASUMS256.txt가 없어 설치를 중단합니다");
  });
});
