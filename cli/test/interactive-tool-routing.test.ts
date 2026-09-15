import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("interactive companion tool routing", () => {
  test("routes web UI verification through terminal-browser", () => {
    const routing = read("skills/_shared/routing.md");
    const go = read("skills/go/SKILL.md");
    const ui = read("skills/ui/SKILL.md");

    expect(routing).toContain("`WEB_RUNTIME_PROVIDER: terminal-browser`");
    expect(routing).toContain("`terminal-browser-background-tab.sh open <url>`");
    expect(routing).toContain(
      "terminal-browser action --browser <key> --tab <id> -- snapshot|click|fill|eval",
    );
    expect(go).toContain("terminal-browser action --browser <key> --tab <id> -- snapshot");
    expect(go).toContain("기계 판정 가능한 action과 assertion은 check의 `cmd`에 넣어");
    expect(ui).toContain("`terminal-browser-background-tab.sh open <url>`");
    expect(ui).toContain("정상·경계 상태의");
  });

  test("routes interactive reviews through tuicr", () => {
    const routing = read("skills/_shared/routing.md");
    const review = read("skills/review/SKILL.md");

    expect(routing).toContain("`HUMAN_REVIEW_PROVIDER: tuicr`");
    expect(review).toContain("사용자 주도 리뷰");
    expect(review).toContain("에이전트 주도 리뷰");
    expect(review).toContain("`tuicr-wrapper.sh`");
    expect(review).toContain("`tuicr review comments`");
    expect(review).toContain('`tuicr review add --username "<실제 검토자>"`');
    expect(review).toContain("읽기 전용 runtime·edge·반증 pass가 판정 정본");
  });

  test("keeps automated browser tabs out of the visible terminal", () => {
    const routing = read("skills/_shared/routing.md");
    const go = read("skills/go/SKILL.md");
    const ui = read("skills/ui/SKILL.md");

    for (const text of [routing, go, ui]) {
      expect(text).not.toContain("terminal-browser open <url> --split right");
      expect(text).not.toContain('tmux select-pane -t "$TMUX_PANE"');
      expect(text).toContain("terminal-browser-background-tab.sh open <url>");
      expect(text).toContain("`--follow`");
    }
    expect(go).toContain("--browser <key> --tab <id>");
    expect(go).toContain("terminal-browser-background-tab.sh close <key> <id>");
    expect(go).toContain("`active: false`");
  });

  test("documents explicit interactive viewing and invisible fallback", () => {
    const routing = read("skills/_shared/routing.md");
    const go = read("skills/go/SKILL.md");
    const ui = read("skills/ui/SKILL.md");

    expect(routing).toContain("사용자가 화면 공유를 명시적으로 원할 때만");
    expect(routing).toContain("headless 테스트로 폴백");
    expect(go).toContain("사용자가 화면 표시를 명시적으로 요청한 경우만");
    expect(go).toContain("기존 headless 테스트로 폴백");
    expect(ui).toContain("사용자가 화면 표시를 명시적으로 요청한 경우만");
    expect(ui).toContain("headless 흐름으로 폴백");
  });

  test("keeps companion tools optional with safe fallbacks", () => {
    const routing = read("skills/_shared/routing.md");
    const go = read("skills/go/SKILL.md");
    const review = read("skills/review/SKILL.md");
    const readme = read("README.md");

    for (const text of [routing, go, review, readme]) {
      expect(text).toMatch(/optional|선택형/);
      expect(text).toContain("폴백");
    }
    expect(routing).toContain("단위·통합 테스트");
    expect(routing).toContain("gdm 설치기는 두 companion tool을 자동 설치하지 않는다");
    expect(review).toContain("tuicr는 gdm-full의 독립 auditor를 대신하지 않는다");
    expect(readme).toContain("gdm 설치기가 자동으로");
  });
});
