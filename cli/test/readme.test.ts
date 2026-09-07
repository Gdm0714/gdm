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
  test("opens with the product, then gives a bounded reader journey", () => {
    const headings = [...README.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    expect(headings).toEqual([
      "무엇을 해결하나",
      "제품 구성",
      "빠른 시작",
      "Gidem Native",
      "최근 추가된 Pi 기능",
      "검증 모델",
      "선택형 도구와 디자인",
      "요구사항",
      "저장소 구조",
      "개발과 검증",
      "문서",
      "라이선스",
    ]);
    expect(README).toContain("**Gidem 앱**");
    expect(README).toContain("**gdm 하네스**");
    expect(README).toContain("작업 증거가 다음 습관을 바꾸는 개인 AI 워크플로우");
    expect(Math.max(...proseParagraphs(README).map((paragraph) => paragraph.length))).toBeLessThanOrEqual(420);
    expect(Math.max(...README.split("\n").map((line) => line.length))).toBeLessThanOrEqual(140);
    expect(README.match(/<details>/gu)).toHaveLength(1);
    expect(README.match(/<\/details>/gu)).toHaveLength(1);
    expect(README.match(/^```/gmu)?.length ?? 0).toBe(18);
  });

  test("describes current features and honest release boundaries", () => {
    for (const value of [
      "### 영구 메모리",
      "/memory doctor",
      "### 격리 Computer Use",
      "gdm-computer-use/setup.sh",
      "### bounded Context Pack",
      "gdm context status",
      "18회",
      "13회만 measurement-valid",
      "Pi 자동 주입이나 기본 활성화에 연결되지 않은 실험 기능",
      "원격 release asset은 아직 게시되지 않았다",
      "Developer ID 서명과",
      "notarization을 포함한 공개 배포는 아직 준비 중",
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
    expect(paths.length).toBeGreaterThanOrEqual(10);
    for (const path of paths) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
    }
  });
});
