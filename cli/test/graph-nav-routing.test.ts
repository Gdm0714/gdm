import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const ROUTED_SKILLS = ["analyze", "plan", "review"];
const PROVIDER_MARKER = "`GRAPH_NAV_PROVIDER: env:GDM_GRAPH_PROVIDER`";

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function skill(name: string): string {
  return read(`skills/${name}/SKILL.md`);
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function installedSkillNames(): string[] {
  return readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(ROOT, "skills", name, "SKILL.md")))
    .sort();
}

function readableFilesUnder(path: string): string[] {
  const absolute = join(ROOT, path);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const relative = `${path}/${entry.name}`;
    if (entry.isDirectory()) return readableFilesUnder(relative);
    return entry.isFile() ? [relative] : [];
  });
}

describe("optional code graph navigation routing", () => {
  test("routes the provider to exactly plan, analyze, and review", () => {
    const routed = installedSkillNames().filter((name) => skill(name).includes("GDM_GRAPH_PROVIDER"));

    expect(routed).toEqual([...ROUTED_SKILLS].sort());
    for (const name of routed) expect(skill(name)).toContain(PROVIDER_MARKER);
    expect(read("skills/_shared/routing.md")).toContain(PROVIDER_MARKER);
  });

  test("requires a quoted direct executable invocation with the v1 JSON request", () => {
    const policies = [read("skills/_shared/routing.md"), ...ROUTED_SKILLS.map(skill)];

    for (const policy of policies) {
      const compact = normalized(policy);
      expect(policy).toContain('`"$GDM_GRAPH_PROVIDER" query`');
      expect(compact).toContain("command string으로 다시 파싱하지 않고 실행 파일 경로 한 개");
      expect(compact).toContain("변수를 한 토큰으로 quote한다");
      expect(compact).toContain("`sh -c`, `zsh -lc`, `eval`, command string parsing");
      expect(compact).toContain('"schemaVersion":"gdm-graph-query/v1"');
      expect(compact).toContain('"root":"/absolute/git/root"');
      expect(compact).toContain('"entry":"repo/relative/file.ts"');
      expect(compact).toContain('"direction":"dependencies"');
      expect(compact).toContain('"maxDepth":1');
    }
  });

  test("discards invalid or stale v2 results and complements partial results", () => {
    const policies = [read("skills/_shared/routing.md"), ...ROUTED_SKILLS.map(skill)];

    for (const policy of policies) {
      const compact = normalized(policy);
      expect(compact).toContain("10초");
      expect(compact).toContain("terminal tool의 timeout");
      expect(compact).toContain("shell `timeout` wrapper");
      expect(compact).toMatch(/미설정[\s\S]*missing[\s\S]*실행 불가/u);
      expect(compact).toMatch(/non-zero[\s\S]*crash[\s\S]*timeout/u);
      expect(compact).toMatch(/malformed JSON[\s\S]*schema mismatch/u);
      expect(compact).toContain("partial");
      expect(compact).toContain("stale");
      expect(compact).toContain("unsupported");
      expect(compact).toContain('"schemaVersion":"gdm-graph-result/v2"');
      for (const field of [
        "provider",
        "entry",
        "direction",
        "nodes",
        "path",
        "depth",
        "edges",
        "candidateTests",
        "unresolved",
        "limitations",
        "coverage",
        "scope",
        "requestedMaxDepth",
        "completeWithinRequestedDepth",
        "frontier",
        "incompleteReasons",
        "freshness",
        "truncated",
      ]) {
        expect(compact).toContain(field);
      }
      expect(compact).toContain("freshness.consistent=false");
      expect(compact).toContain("Read/Glob/Grep로 폴백");
      expect(compact).toContain("capability 설명만 있다는 이유로 정상 결과를 실패로 바꾸지는 않는다");
      expect(compact).toContain("coverage.completeWithinRequestedDepth=false");
      expect(compact).toContain("기존 Read/Glob/Grep 탐색도 반드시 수행");
      expect(compact).toContain("빈 edge나 알려진 edge만으로 영향 범위를 결론내리지 않는다");
    }
  });

  test("uses complete bounded coverage without treating its frontier as partial", () => {
    const policies = [read("skills/_shared/routing.md"), ...ROUTED_SKILLS.map(skill)];

    for (const policy of policies) {
      const compact = normalized(policy);
      expect(compact).toContain("coverage.scope");
      expect(compact).toContain("bounded coverage");
      expect(compact).toContain("coverage.completeWithinRequestedDepth=true");
      expect(compact).toContain("truncated=false");
      expect(compact).toContain("repository-wide Read/Glob/Grep 폴백을 수행하지 않는다");
      expect(compact).toContain("nodes`·`edges`·`candidateTests`의 후보 소스는 직접 열어 확인");
      expect(compact).toContain("frontier가 있다는 사실만으로 partial인 것은 아니며");
      expect(compact).toContain("저장소 전체의 complete를 뜻하지도 않는다");
      expect(compact).toContain("maxDepth`를 늘려 다시 조회하거나 Read/Glob/Grep로 폴백");
    }
  });

  test("keeps graph output outside evidence, scope, and completion gates", () => {
    const policies = [read("skills/_shared/routing.md"), ...ROUTED_SKILLS.map(skill)];

    for (const policy of policies) {
      const compact = normalized(policy);
      expect(compact).toContain("navigation hint");
      expect(compact).toContain("실제 소스를 직접 열어 확인");
      expect(compact).toContain("증거가 아니다");
      expect(compact).toContain("범위 확장");
      expect(compact).toContain("`gdm pass`");
      expect(compact).toContain("`gdm done`");
    }
  });

  test("keeps core, go, full, Native, and installation paths unconnected", () => {
    const forbidden = [
      "skills/go/SKILL.md",
      "skills/full/SKILL.md",
      "install/install.sh",
      ...readdirSync(join(ROOT, "cli", "src"), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name !== "graph-nav-provider.ts")
        .map((entry) => `cli/src/${entry.name}`),
      ...readableFilesUnder("native"),
    ];

    for (const path of forbidden) {
      const content = read(path);
      expect(content).not.toContain("GDM_GRAPH_PROVIDER");
      expect(content).not.toContain("gdm-graph-query/v1");
    }
  });

  test("exposes the provider only in the gdm-graph benchmark arm", () => {
    const run = read("bench/run.sh");
    const gdmPrompt = run.slice(run.indexOf("    gdm)"), run.indexOf("    gdm-graph)"));
    const graphPrompt = run.slice(run.indexOf("    gdm-graph)"), run.indexOf("    omx)"));

    expect(run.match(/export GDM_GRAPH_PROVIDER/gu)).toHaveLength(1);
    expect(run).toMatch(/if \[ "\$ARM" = gdm-graph \]; then[\s\S]*export GDM_GRAPH_PROVIDER/);
    expect(gdmPrompt).not.toContain("GDM_GRAPH_PROVIDER");
    expect(graphPrompt).toContain("GDM_GRAPH_PROVIDER");
    expect(read("bench/judge.sh")).toContain("bare|gdm|gdm-graph|omx|lazycodex|workbook");
    expect(read("bench/quality-judge.sh")).not.toContain("gdm-graph");
    expect(read("bench/graph-quality-judge.sh")).toContain("ARMS=(gdm gdm-graph)");
  });
});
