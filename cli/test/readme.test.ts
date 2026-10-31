import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

function proseParagraphs(markdown: string): readonly string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(" "));
    current = [];
  };
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*(?:#|[-*] |\||<|>)/u.test(line) || line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line.trim());
  }
  flush();
  return paragraphs;
}

describe("public README", () => {
  test("opens with the harness, then gives a bounded reader journey", () => {
    const headings = [...README.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    for (const heading of ["무엇을 해결하나", "하네스 구성", "빠른 시작", "로컬 도구", "검증 모델", "문서"]) {
      expect(headings).toContain(heading);
    }
    expect(README.startsWith("# gdm\n")).toBe(true);
    for (const path of ["src", "skills", "agents/providers", "src/computer_use"]) {
      expect(existsSync(join(ROOT, path)), path).toBe(true);
    }
    for (const path of ["native", "website", "assets", "design-system.md"]) {
      expect(existsSync(join(ROOT, path)), path).toBe(false);
    }
    expect(README).toContain("작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우");
    expect(Math.max(...proseParagraphs(README).map((paragraph) => paragraph.length))).toBeLessThanOrEqual(420);
    expect(Math.max(...README.split("\n").map((line) => line.length))).toBeLessThanOrEqual(140);
    expect(README.match(/<details>/gu)).toHaveLength(1);
    expect(README.match(/<\/details>/gu)).toHaveLength(1);
    expect(README).toContain("### 2. Claude Code에서 실행");
    expect(README).toContain("/gdm-go 로그인 오류를 수정하고 검증까지 완료해줘");
  });

  test("describes current features and honest release boundaries", () => {
    for (const value of [
      "### 영구 메모리",
      "gdm memory rpc",
      "### 격리 Computer Use",
      "gdm computer-use setup",
      "### bounded Context Pack",
      "gdm context status",
      "18회",
      "13회만 measurement-valid",
      "자동 주입이나 기본 활성화에 연결되지 않은 실험 기능",
    ]) {
      expect(README).toContain(value);
    }
    expect(README).toContain("./install/install.sh");
    expect(README).not.toContain("releases/latest/download");
    for (const implementationDetail of [
      "gdm-dispatch-bundle/v1",
      "bytesBase64",
      "GDM_RECEIVER_TRUST_BOOTSTRAP_V1:",
    ]) {
      expect(README).not.toContain(implementationDetail);
    }
  });

  test("keeps every repository link resolvable", () => {
    const markdownLinks = [...README.matchAll(/\[[^\]]+\]\((\.\/[^)]+)\)/gu)]
      .map((match) => match[1]!.split("#", 1)[0]!);
    const htmlAssets = [...README.matchAll(/(?:src|srcset)="([^"]+)"/gu)].map((match) => match[1]!);
    const paths = [...new Set([...markdownLinks, ...htmlAssets])];
    expect(paths.length).toBeGreaterThanOrEqual(5);
    for (const path of paths) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
    }
  });
});
