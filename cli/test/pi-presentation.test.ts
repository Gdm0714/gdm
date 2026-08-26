import { describe, expect, test } from "bun:test";
import {
  COMPLETION_NOTIFICATION,
  JOKER_WORKING_INDICATOR,
  LONG_RUN_NOTIFICATION_MS,
  completionNotificationDue,
  installGdmPresentation,
} from "../../agents/pi/presentation.mjs";

type Handler = (event: unknown, context: FakeContext) => Promise<void>;
type FakeContext = {
  readonly hasUI: boolean;
  readonly ui: { readonly setWorkingIndicator?: (value: unknown) => void };
};

function fakePi(): {
  readonly pi: { readonly on: (event: string, handler: Handler) => void };
  readonly handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return {
    pi: { on: (event, handler) => handlers.set(event, handler) },
    handlers,
  };
}

describe("GDM Pi presentation", () => {
  test("uses one uncolored stable working icon and a static OSC 777 completion message", () => {
    expect(JOKER_WORKING_INDICATOR.intervalMs).toBe(1_000);
    expect(JOKER_WORKING_INDICATOR.frames).toEqual(["♠"]);
    expect(JOKER_WORKING_INDICATOR.frames[0]).not.toContain("\u001b[");
    expect(COMPLETION_NOTIFICATION).toBe(
      "\u001b]777;notify;Pi;Joker 작업 완료 — 입력을 기다립니다\u0007",
    );
  });

  test("notifies only for interactive TTY runs lasting at least fifteen seconds", () => {
    expect(completionNotificationDue(1_000, 1_000 + LONG_RUN_NOTIFICATION_MS - 1, true, true))
      .toBe(false);
    expect(completionNotificationDue(1_000, 1_000 + LONG_RUN_NOTIFICATION_MS, true, true))
      .toBe(true);
    expect(completionNotificationDue(1_000, 1_000 + LONG_RUN_NOTIFICATION_MS, false, true))
      .toBe(false);
    expect(completionNotificationDue(1_000, 1_000 + LONG_RUN_NOTIFICATION_MS, true, false))
      .toBe(false);
    expect(completionNotificationDue(Number.NaN, 20_000, true, true)).toBe(false);
  });

  test("installs once, shows stable status, and suppresses short-run notifications", async () => {
    const { pi, handlers } = fakePi();
    let now = 1_000;
    const writes: string[] = [];
    const indicators: unknown[] = [];
    const context: FakeContext = {
      hasUI: true,
      ui: { setWorkingIndicator: (value) => indicators.push(value) },
    };

    expect(installGdmPresentation(pi, {
      now: () => now,
      isTTY: () => true,
      write: (value: string) => writes.push(value),
    })).toBe(true);
    expect(installGdmPresentation(pi)).toBe(false);

    await handlers.get("session_start")?.({}, context);
    await handlers.get("agent_start")?.({}, context);
    expect(indicators).toEqual([JOKER_WORKING_INDICATOR, JOKER_WORKING_INDICATOR]);

    now += LONG_RUN_NOTIFICATION_MS - 1;
    await handlers.get("agent_settled")?.({}, context);
    expect(writes).toEqual([]);

    now += 1;
    await handlers.get("agent_start")?.({}, context);
    now += LONG_RUN_NOTIFICATION_MS;
    await handlers.get("agent_settled")?.({}, context);
    expect(writes).toEqual([COMPLETION_NOTIFICATION]);
  });

  test("degrades without UI methods and resets timing on shutdown", async () => {
    const { pi, handlers } = fakePi();
    let now = 5_000;
    const writes: string[] = [];
    const context: FakeContext = { hasUI: false, ui: {} };
    installGdmPresentation(pi, {
      now: () => now,
      isTTY: () => true,
      write: (value: string) => writes.push(value),
    });

    await handlers.get("session_start")?.({}, context);
    await handlers.get("agent_start")?.({}, context);
    await handlers.get("session_shutdown")?.({}, context);
    now += LONG_RUN_NOTIFICATION_MS;
    await handlers.get("agent_settled")?.({}, context);
    expect(writes).toEqual([]);
  });
});
