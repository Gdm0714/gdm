import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const HELPER = join(ROOT, "skills", "go", "terminal-browser-background-tab.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gdm-terminal-browser-"));
  temporaryDirectories.push(directory);
  const statePath = join(directory, "state.json");
  const logPath = join(directory, "calls.jsonl");
  const fakePath = join(directory, "terminal-browser-fake.ts");
  writeFileSync(
    statePath,
    JSON.stringify({
      self: { window: "main", tab: "@0", pane: "%0" },
      browsers: [
        {
          key: "visible",
          cdpPort: 4001,
          inCurrentTab: true,
          tabs: [{ id: 1, url: "https://visible.test", active: true, targetId: "target-1" }],
        },
        {
          key: "hidden",
          cdpPort: 4002,
          inCurrentTab: false,
          tabs: [{ id: 7, url: "https://user.test", active: true, targetId: "target-7" }],
        },
      ],
    }),
  );
  writeFileSync(
    fakePath,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.TB_FAKE_STATE!;
const logPath = process.env.TB_FAKE_LOG!;
const args = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeState = (state: unknown) => writeFileSync(statePath, JSON.stringify(state));

if (args[0] === "ls") {
  process.stdout.write(JSON.stringify(readState()));
  process.exit(0);
}

if (args[0] !== "action") process.exit(2);
const browserKey = args[args.indexOf("--browser") + 1];
const tabId = Number(args[args.indexOf("--tab") + 1]);
const delimiter = args.indexOf("--");
const command = args.slice(delimiter + 1);
const state = readState();
const browser = state.browsers.find((item: { key: string }) => item.key === browserKey);
if (!browser) process.exit(3);

if (command[0] === "eval") {
  const marker = command.slice(1).join(" ").match(/about:blank#gdm-ai-[0-9-]+/)?.[0];
  if (marker) state.pendingUrl = marker;
  writeState(state);
  process.stdout.write("true\\n");
  process.exit(0);
}

if (command[0] === "mouse" && command[1] === "up" && command[2] === "middle") {
  browser.tabs.push({
    id: 8,
    url: state.pendingUrl,
    active: false,
    targetId: "target-8",
  });
  delete state.pendingUrl;
  writeState(state);
  process.stdout.write("done\\n");
  process.exit(0);
}

if (command[0] === "goto") {
  const tab = browser.tabs.find((item: { id: number }) => item.id === tabId);
  if (!tab) process.exit(4);
  tab.url = command[1];
  if (process.env.TB_FAKE_ACTIVATE_ON_GOTO === "1") {
    for (const item of browser.tabs) item.active = false;
    tab.active = true;
  }
  writeState(state);
  process.stdout.write("navigated\\n");
  process.exit(0);
}

if (command[0] === "tab" && command[1] === "close") {
  const closing = browser.tabs.find((item: { id: number }) => item.id === tabId);
  browser.tabs = browser.tabs.filter((item: { id: number }) => item.id !== tabId);
  if (closing?.active && browser.tabs.length > 0) browser.tabs[0].active = true;
  writeState(state);
  process.stdout.write("closed\\n");
  process.exit(0);
}

process.stdout.write("done\\n");
`,
  );
  chmodSync(fakePath, 0o755);
  return { statePath, logPath, fakePath };
}

describe("terminal-browser background tab helper", () => {
  test("opens and targets an inactive tab without changing the user's active tab", () => {
    const { statePath, logPath, fakePath } = fixture();
    const targetUrl = "http://127.0.0.1:3012/test";
    const environment = {
      ...process.env,
      TERMINAL_BROWSER_BIN: fakePath,
      TB_FAKE_STATE: statePath,
      TB_FAKE_LOG: logPath,
    };

    const opened = Bun.spawnSync([HELPER, "open", targetUrl], { env: environment });
    expect(opened.exitCode).toBe(0);
    const result = JSON.parse(opened.stdout.toString());
    expect(result).toEqual({
      browser: "hidden",
      tab: 8,
      target: "target-8",
      url: targetUrl,
      active: false,
    });

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const hidden = state.browsers.find((browser: { key: string }) => browser.key === "hidden");
    expect(hidden.tabs.find((tab: { id: number }) => tab.id === 7).active).toBe(true);
    expect(hidden.tabs.find((tab: { id: number }) => tab.id === 8).active).toBe(false);

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((call) => call.includes("--split"))).toBe(false);
    expect(calls.some((call) => call.includes("--follow"))).toBe(false);
    expect(calls).toContainEqual([
      "action",
      "--browser",
      "hidden",
      "--tab",
      "8",
      "--",
      "goto",
      targetUrl,
    ]);

    const closed = Bun.spawnSync([HELPER, "close", "hidden", "8"], { env: environment });
    expect(closed.exitCode).toBe(0);
    const closedState = JSON.parse(readFileSync(statePath, "utf8"));
    const remaining = closedState.browsers.find(
      (browser: { key: string }) => browser.key === "hidden",
    ).tabs;
    expect(remaining.map((tab: { id: number }) => tab.id)).toEqual([7]);
  });

  test("removes the AI tab when navigation unexpectedly activates it", () => {
    const { statePath, logPath, fakePath } = fixture();
    const environment = {
      ...process.env,
      TERMINAL_BROWSER_BIN: fakePath,
      TB_FAKE_STATE: statePath,
      TB_FAKE_LOG: logPath,
      TB_FAKE_ACTIVATE_ON_GOTO: "1",
    };

    const opened = Bun.spawnSync([HELPER, "open", "https://unexpected.test"], {
      env: environment,
    });
    expect(opened.exitCode).not.toBe(0);
    expect(opened.stderr.toString()).toContain("background tab was activated");

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const hidden = state.browsers.find((browser: { key: string }) => browser.key === "hidden");
    expect(hidden.tabs.map((tab: { id: number }) => tab.id)).toEqual([7]);
    expect(hidden.tabs[0].active).toBe(true);
  });
});
