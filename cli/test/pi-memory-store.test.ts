import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRememberEvent,
  type RememberEvent,
} from "../../agents/pi/gdm-memory/core.ts";
import {
  MemoryStoreError,
  appendMemoryEvent,
  readMemoryStore,
} from "../../agents/pi/gdm-memory/store.ts";

const roots: string[] = [];
const STORE_MODULE = pathToFileURL(join(import.meta.dir, "..", "..", "agents", "pi", "gdm-memory", "store.ts")).href;
const CORE_MODULE = pathToFileURL(join(import.meta.dir, "..", "..", "agents", "pi", "gdm-memory", "core.ts")).href;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gdm-memory-store-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(text: string, second = 0): RememberEvent {
  return createRememberEvent({
    scope: "global",
    text,
    reason: "test",
    source: "slash-command",
    now: new Date(`2026-08-31T00:00:${String(second).padStart(2, "0")}Z`),
  });
}

describe("gdm-pi memory event store", () => {
  test("preserves all unique events from eight concurrent processes", async () => {
    const path = join(tempRoot(), "global.jsonl");
    const children = Array.from({ length: 8 }, (_, index) => {
      const code = `
        import { appendMemoryEvent } from ${JSON.stringify(STORE_MODULE)};
        import { createRememberEvent } from ${JSON.stringify(CORE_MODULE)};
        const event = createRememberEvent({ scope: "global", text: "concurrent memory ${index}", reason: "test", source: "slash-command", now: new Date("2026-08-31T00:00:${String(index).padStart(2, "0")}Z") });
        await appendMemoryEvent({ path: ${JSON.stringify(path)}, scope: "global", event });
      `;
      return Bun.spawn(["bun", "--eval", code], { stdout: "pipe", stderr: "pipe" });
    });
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual(Array(8).fill(0));
    const snapshot = await readMemoryStore({ path, scope: "global" });
    expect(snapshot.entries).toHaveLength(8);
    expect(new Set(snapshot.entries.map((item) => item.id)).size).toBe(8);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("folds concurrent duplicate events to one active memory", async () => {
    const path = join(tempRoot(), "global.jsonl");
    const same = event("same durable preference");
    await Promise.all(Array.from({ length: 4 }, () => appendMemoryEvent({ path, scope: "global", event: same })));
    const snapshot = await readMemoryStore({ path, scope: "global" });
    expect(snapshot.entries).toHaveLength(1);
  });

  test("leaves malformed, unknown-version, and project-mismatch stores byte-identical", async () => {
    const cases = [
      { content: "{not-json}\n", scope: "global" as const },
      { content: '{"schemaVersion":"gdm-pi-memory-event/2","event":"clear","scope":"global","createdAt":"2026-08-31T00:00:00.000Z"}\n', scope: "global" as const },
      {
        content: `${JSON.stringify({
          ...createRememberEvent({
            scope: "project",
            text: "project decision",
            reason: "test",
            source: "slash-command",
            now: new Date("2026-08-31T00:00:00Z"),
            projectRealpath: "/other",
          }),
        })}\n`,
        scope: "project" as const,
        projectRealpath: "/expected",
      },
    ];
    for (const sample of cases) {
      const path = join(tempRoot(), "store.jsonl");
      writeFileSync(path, sample.content, { mode: 0o600 });
      const before = readFileSync(path);
      const candidate = sample.scope === "project"
        ? createRememberEvent({
          scope: "project",
          text: "new project decision",
          reason: "test",
          source: "slash-command",
          now: new Date("2026-09-01T00:00:00Z"),
          projectRealpath: sample.projectRealpath,
        })
        : event("new global preference");
      await expect(appendMemoryEvent({
        path,
        scope: sample.scope,
        projectRealpath: sample.projectRealpath,
        event: candidate,
      })).rejects.toBeInstanceOf(MemoryStoreError);
      expect(readFileSync(path)).toEqual(before);
    }
  });

  test("rejects symlinked memory directories without touching their target", async () => {
    const root = tempRoot();
    const outside = join(root, "outside");
    mkdirSync(outside);
    const memory = join(root, "memory");
    symlinkSync(outside, memory);
    const path = join(memory, "global.jsonl");
    await expect(appendMemoryEvent({ path, scope: "global", event: event("safe preference") }))
      .rejects.toThrow("contains a symlink");
    expect(existsSync(join(outside, "global.jsonl"))).toBe(false);
  });

  test("enforces entry and secret boundaries before append", async () => {
    expect(() => createRememberEvent({
      scope: "global",
      text: "x".repeat(501),
      source: "slash-command",
      now: new Date(),
    })).toThrow("exceeds 500");
    expect(() => createRememberEvent({
      scope: "global",
      text: "token=abcdefghijklmnopqrstuvwxyz1234567890",
      source: "slash-command",
      now: new Date(),
    })).toThrow("secret-shaped");

    const path = join(tempRoot(), "global.jsonl");
    const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify(event(`entry ${index}`, index % 60))).join("\n") + "\n";
    writeFileSync(path, lines, { mode: 0o600 });
    const before = readFileSync(path);
    await expect(appendMemoryEvent({ path, scope: "global", event: event("entry 201") }))
      .rejects.toThrow("200 active entries");
    expect(readFileSync(path)).toEqual(before);
  });
});
