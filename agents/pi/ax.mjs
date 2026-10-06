/** Pi presentation/model callbacks only; all harness command policy lives in Rust. */
import { randomUUID } from "node:crypto";
import { nativeRpc } from "./native.ts";
const installed = new WeakSet();
function notify(ctx, text, level = "info") { if (ctx?.hasUI) ctx.ui.notify(text, level); }
export function installGdmCommands(pi) {
  if (installed.has(pi)) return false;
  installed.add(pi);
  pi.registerCommand("gdm", {
    description: "Show GDM Work, exceptions and next action",
    handler: async (args, ctx) => {
      if (args.trim()) return notify(ctx, "Usage: /gdm", "error");
      try { const value = await nativeRpc("pi-commands", { action: "summary" }, ctx.cwd); notify(ctx, value.summary); }
      catch (error) { notify(ctx, `GDM 상태 조회 실패: ${error.message}`, "error"); }
    },
  });
  pi.registerCommand("feedback", {
    description: "Record good or bad feedback for the current GDM Work",
    handler: async (args, ctx) => {
      try { const value = await nativeRpc("pi-commands", { action: "feedback", args }, ctx.cwd); notify(ctx, value.message); }
      catch (error) { notify(ctx, error.message, "error"); }
    },
  });
  pi.registerCommand("gdm-contract-check", {
    description: "Run one bounded tool-free GDM contract check",
    handler: async (args, ctx) => {
      if (args.trim()) return notify(ctx, "Usage: /gdm-contract-check", "error");
      if (!ctx.model || typeof ctx.modelRegistry?.complete !== "function") return notify(ctx, "GDM contract check를 실행할 모델이 없습니다", "error");
      const controller = new AbortController(); let timer;
      try {
        const definition = await nativeRpc("pi-commands", { action: "contract-definition" }, ctx.cwd);
        notify(ctx, `GDM contract check 실행 · ${definition.cases.length}개 · 최대 ${definition.timeoutMs / 1000}초`);
        timer = setTimeout(() => controller.abort(), definition.timeoutMs);
        const response = await ctx.modelRegistry.complete(ctx.model, {
          systemPrompt: definition.systemPrompt,
          messages: [{ role: "user", content: [{ type: "text", text: definition.prompt }], timestamp: Date.now() }],
        }, {
          maxTokens: definition.maxTokens, cacheRetention: "none", signal: controller.signal,
          sessionId: randomUUID(), ...(typeof ctx.thinkingLevel === "string" ? { reasoningEffort: ctx.thinkingLevel } : {}),
        });
        if (controller.signal.aborted) throw new Error("GDM contract check timed out");
        const value = await nativeRpc("pi-commands", { action: "contract-record", response,
          modelId: `${ctx.model.provider}/${ctx.model.id}`, thinkingLevel: ctx.thinkingLevel ?? "off",
          entries: (ctx.sessionManager?.getEntries?.() ?? []).filter(e => e.type === "custom" && e.customType === definition.entryType),
        }, ctx.cwd);
        pi.appendEntry(value.entryType, value.record); notify(ctx, value.message, value.level);
      } catch (error) { notify(ctx, `GDM contract check 실패: ${error.message}`, "error"); }
      finally { if (timer) clearTimeout(timer); }
    },
  });
  pi.registerCommand("ax", { description: "Use /gdm", handler: async (_args, ctx) => notify(ctx, "/ax는 /gdm으로 변경되었습니다. /gdm을 사용하세요.", "warning") });
  return true;
}
