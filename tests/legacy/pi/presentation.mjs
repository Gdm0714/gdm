export const LONG_RUN_NOTIFICATION_MS = 15_000;

const INSTALLATIONS = Symbol.for("gdm-pi:presentation:v1");

export const JOKER_WORKING_INDICATOR = Object.freeze({
  frames: Object.freeze(["♠"]),
  intervalMs: 1_000,
});

export const COMPLETION_NOTIFICATION =
  "\u001b]777;notify;Pi;Joker 작업 완료 — 입력을 기다립니다\u0007";

export function completionNotificationDue(startedAt, endedAt, hasUI, isTTY) {
  return Number.isFinite(startedAt) && Number.isFinite(endedAt) &&
    endedAt - startedAt >= LONG_RUN_NOTIFICATION_MS && hasUI === true && isTTY === true;
}

function installationRegistry() {
  const globals = globalThis;
  if (!(globals[INSTALLATIONS] instanceof WeakSet)) globals[INSTALLATIONS] = new WeakSet();
  return globals[INSTALLATIONS];
}

function showWorkingIndicator(ctx) {
  if (!ctx?.hasUI || typeof ctx.ui?.setWorkingIndicator !== "function") return;
  try {
    ctx.ui.setWorkingIndicator(JOKER_WORKING_INDICATOR);
  } catch {
    // Presentation is best-effort and must never block the GDM execution contract.
  }
}

export function installGdmPresentation(pi, dependencies = {}) {
  const registry = installationRegistry();
  if (registry.has(pi)) return false;
  registry.add(pi);

  const now = dependencies.now ?? (() => performance.now());
  const isTTY = dependencies.isTTY ?? (() => process.stdout.isTTY === true);
  const write = dependencies.write ?? ((value) => process.stdout.write(value));
  let startedAt = null;

  pi.on("session_start", async (_event, ctx) => {
    showWorkingIndicator(ctx);
  });
  pi.on("agent_start", async (_event, ctx) => {
    startedAt = now();
    showWorkingIndicator(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const finishedAt = now();
    const beganAt = startedAt;
    startedAt = null;
    if (!completionNotificationDue(beganAt, finishedAt, ctx?.hasUI, isTTY())) return;
    try {
      write(COMPLETION_NOTIFICATION);
    } catch {
      // A terminal notification failure must not fail or mutate the completed agent run.
    }
  });
  pi.on("session_shutdown", async () => {
    startedAt = null;
  });
  return true;
}
