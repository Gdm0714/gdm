import { afterEach, describe, expect, test } from "bun:test";
import {
  CONTRACT_CHECK_CASES,
  CONTRACT_CHECK_ENTRY_TYPE,
  CONTRACT_CHECK_MAX_TOKENS,
  CONTRACT_CHECK_SUITE_VERSION,
  CONTRACT_CHECK_TIMEOUT_MS,
  GDM_HARNESS_VERSION,
  GDM_PROCESS_MAX_BYTES,
  GDM_PROCESS_TIMEOUT_MS,
  formatGdmSummary,
  installGdmCommands,
  parseFeedbackArgs,
  runBoundedGdm,
  scoreContractCheck,
  selectGdmWork,
} from "../../agents/pi/ax.mjs";

type Notification = { readonly message: string; readonly level: string };
type CommandHandler = (args: string, ctx: any) => Promise<void>;

function fakePi(entries: any[] = []) {
  const commands = new Map<string, CommandHandler>();
  const appended: { customType: string; data: any }[] = [];
  return {
    pi: {
      registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options.handler),
      appendEntry: (customType: string, data: any) => appended.push({ customType, data }),
    },
    commands,
    appended,
    entries,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  const notifications: Notification[] = [];
  return {
    notifications,
    value: {
      hasUI: true,
      cwd: "/tmp/repository",
      ui: { notify: (message: string, level = "info") => notifications.push({ message, level }) },
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinkingLevel: "xhigh",
      sessionManager: { getEntries: () => [] },
      modelRegistry: { complete: async () => ({ content: [] }) },
      ...overrides,
    },
  };
}

const processResult = (stdout: string, overrides: Partial<{
  ok: boolean;
  exitCode: number | null;
  stderr: string;
  error: string;
}> = {}) => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: "",
  error: "",
  ...overrides,
});

afterEach(() => {
  delete process.env.GDM_EXECUTABLE;
});

describe("GDM Pi commands", () => {
  test("keeps explicit process, model, and suite bounds small", () => {
    expect(GDM_PROCESS_TIMEOUT_MS).toBe(3_000);
    expect(GDM_PROCESS_MAX_BYTES).toBe(256 * 1024);
    expect(CONTRACT_CHECK_TIMEOUT_MS).toBe(45_000);
    expect(CONTRACT_CHECK_MAX_TOKENS).toBe(384);
    expect(CONTRACT_CHECK_CASES).toHaveLength(4);
    expect(new Set(CONTRACT_CHECK_CASES.map((item) => item.id)).size).toBe(4);
    expect(CONTRACT_CHECK_CASES.find((item) => item.id === "model-upgrade")?.choices.B)
      .toContain("representative harness regressions or offline evals");
    expect(CONTRACT_CHECK_SUITE_VERSION).toBe("gdm-contract-check/v1");
    expect(GDM_HARNESS_VERSION).toBe("gdm-pi/v1");
    expect(CONTRACT_CHECK_ENTRY_TYPE).toBe("gdm-contract-check");
  });

  test("runs only an absolute executable and enforces timeout and byte bounds", async () => {
    expect((await runBoundedGdm("gdm", "/tmp", [])).error).toContain("invalid");
    expect(await runBoundedGdm("/usr/bin/printf", "/tmp", ["ok"], { timeoutMs: 500, maxBytes: 10 }))
      .toMatchObject({ ok: true, exitCode: 0, stdout: "ok", error: "" });
    expect((await runBoundedGdm("/usr/bin/printf", "/tmp", ["oversize"], { timeoutMs: 500, maxBytes: 3 })).error)
      .toContain("output limit");
    expect((await runBoundedGdm("/bin/sleep", "/tmp", ["1"], { timeoutMs: 10, maxBytes: 10 })).error)
      .toContain("timed out");
  });

  test("selects the newest active Work and labels outcome as declared and unmeasured", () => {
    const works = [
      { slug: "done", done: true, proven: 1, total: 1, lastAt: "2026-08-19T00:03:00.000Z" },
      { slug: "old", done: false, proven: 0, total: 1, lastAt: "2026-08-19T00:01:00.000Z" },
      {
        slug: "focus",
        done: false,
        proven: 1,
        total: 2,
        lastAt: "2026-08-19T00:02:00.000Z",
        contract: {
          outcome: {
            bottleneck: "리뷰 대기열",
            desiredOutcome: "릴리스 전 누락 감소",
            baseline: "주 3건",
            target: "주 1건",
            unit: "주당 누락 건수",
            interveneIf: "2주 연속 2건 초과",
          },
        },
        blockers: [{ code: "unproven", message: "미통과 항목 1개" }],
        checks: [{ id: "c2", status: "open", manual: true }],
      },
    ];
    expect(selectGdmWork(works)?.slug).toBe("focus");
    const summary = formatGdmSummary(works, {
      feedback: { good: 2, bad: 1, total: 3 },
      evalCandidates: [{ work: "focus" }],
    });
    expect(summary).toContain("GDM · focus · 1/2");
    expect(summary).toContain("선언한 outcome (GDM 미측정)");
    for (const value of [
      "리뷰 대기열", "릴리스 전 누락 감소", "주 3건", "주 1건", "주당 누락 건수", "2주 연속 2건 초과",
    ]) expect(summary).toContain(value);
    expect(summary).toContain("전체 피드백: good 2 · bad 1 · 저장소 전체 회귀 검토 후보 1");
    expect(summary).toContain(
      "다음: 사람 확인 c2 · gdm pass c2 --manual --observed <확인파일> --slug focus",
    );
    expect(summary).not.toContain("AX ·");
    expect(summary).not.toContain("달성률");
    expect(formatGdmSummary([], {})).toBe("GDM · Work 없음\n다음: gdm plan init");
    expect(formatGdmSummary([{
      slug: "expert",
      done: false,
      proven: 0,
      total: 1,
      checks: [{ id: "c1", status: "open", manual: true, expert: true }],
      blockers: [{ code: "unproven", message: "미통과 항목 1개" }],
    }], {})).toContain(
      "gdm pass c1 --manual --observed <확인파일> --reviewer <검토자> --note <판단근거> --slug expert",
    );
    expect(formatGdmSummary([{
      slug: "empty",
      done: false,
      proven: 0,
      total: 0,
      checks: [],
      blockers: [{ code: "no_checks", message: "검증 항목 없음" }],
    }], {})).toContain("gdm plan add --desc <검증항목> --cmd <명령> --expect <기대> --slug empty");
  });

  test("parses only compact good or bad feedback", () => {
    expect(parseFeedbackArgs("good")).toEqual({ value: "good" });
    expect(parseFeedbackArgs(" bad  다음 행동이 모호함 ")).toEqual({ value: "bad", reason: "다음 행동이 모호함" });
    expect(parseFeedbackArgs("bad --not-a-flag")).toEqual({ value: "bad", reason: "--not-a-flag" });
    expect(() => parseFeedbackArgs("bad")).toThrow(/reason/iu);
    expect(() => parseFeedbackArgs("maybe")).toThrow("Usage");
    expect(() => parseFeedbackArgs("bad\nsource")).toThrow("Usage");
    expect(() => parseFeedbackArgs(`bad ${"x".repeat(241)}`)).toThrow("240");
  });

  test("registers live GDM commands plus notice-only AX migrations and leaves non-UI modes side-effect free", async () => {
    const fake = fakePi();
    let runs = 0;
    expect(installGdmCommands(fake.pi, { runGdm: async () => { runs++; return processResult("[]"); } })).toBe(true);
    expect(installGdmCommands(fake.pi)).toBe(false);
    expect([...fake.commands.keys()].sort()).toEqual(["ax", "ax-eval", "feedback", "gdm", "gdm-contract-check"]);
    let completions = 0;
    const noUi = context({
      hasUI: false,
      modelRegistry: { complete: async () => { completions++; return { stopReason: "stop", content: [] }; } },
    }).value;
    for (const name of ["gdm", "feedback", "gdm-contract-check", "ax", "ax-eval"]) {
      await fake.commands.get(name)?.(name === "feedback" ? "good" : "", noUi);
    }
    expect(runs).toBe(0);
    expect(completions).toBe(0);
    expect(fake.appended).toEqual([]);
  });

  test("shows declared outcome through /gdm and records reasoned bad feedback through exact argv", async () => {
    const fake = fakePi();
    const calls: string[][] = [];
    const works = [{
      slug: "focus",
      done: false,
      proven: 0,
      total: 1,
      lastAt: "2026-08-19T00:00:00.000Z",
      contract: {
        outcome: {
          bottleneck: "수동 릴리스 확인",
          desiredOutcome: "누락 감소",
          baseline: "주 3건",
          target: "주 1건",
          unit: "주당 건수",
          interveneIf: "2주 연속 목표 초과",
        },
      },
      blockers: [{ code: "unproven", message: "미통과 항목 1개" }],
      checks: [{ id: "c1", status: "open", manual: false }],
    }];
    installGdmCommands(fake.pi, {
      runGdm: async (_cwd, argv) => {
        calls.push([...argv]);
        if (argv[0] === "status") return processResult(JSON.stringify(works));
        if (argv[0] === "retro") return processResult(JSON.stringify({
          feedback: { good: 1, bad: 0, total: 1 }, evalCandidates: [],
        }));
        return processResult(JSON.stringify({ slug: "focus", value: "bad", source: "pi" }));
      },
    });
    const ctx = context();
    expect(fake.commands.get("gdm")).toBeDefined();
    await fake.commands.get("gdm")?.("", ctx.value);
    await fake.commands.get("feedback")?.("bad --not-a-flag", ctx.value);

    expect(calls).toEqual([
      ["status", "--json", "--checks"],
      ["retro", "--all", "--json"],
      ["status", "--json"],
      [
        "feedback", "--value", "bad", "--source", "pi", "--slug", "focus", "--json",
        "--reason=--not-a-flag",
      ],
    ]);
    expect(ctx.notifications[0]?.message).toContain("GDM · focus · 0/1");
    expect(ctx.notifications[0]?.message).toContain("선언한 outcome (GDM 미측정)");
    expect(ctx.notifications[0]?.message).toContain("저장소 전체 회귀 검토 후보");
    expect(ctx.notifications[1]).toEqual({ message: "피드백 기록 · focus · bad", level: "info" });
    expect(fake.appended).toEqual([]);
  });

  test("rejects reasonless bad feedback before any subprocess but records reasonless good feedback", async () => {
    const fake = fakePi();
    const calls: string[][] = [];
    const works = [{
      slug: "focus",
      done: false,
      proven: 0,
      total: 1,
      lastAt: "2026-08-19T00:00:00.000Z",
    }];
    installGdmCommands(fake.pi, {
      runGdm: async (_cwd, argv) => {
        calls.push([...argv]);
        if (argv[0] === "status") return processResult(JSON.stringify(works));
        return processResult(JSON.stringify({ slug: "focus", value: "good", source: "pi" }));
      },
    });
    const ctx = context();
    await fake.commands.get("feedback")?.("bad", ctx.value);
    expect(calls).toEqual([]);
    expect(fake.appended).toEqual([]);
    expect(ctx.notifications.at(-1)?.level).toBe("error");
    expect(ctx.notifications.at(-1)?.message).toMatch(/reason/iu);

    await fake.commands.get("feedback")?.("good", ctx.value);
    expect(calls).toEqual([
      ["status", "--json"],
      ["feedback", "--value", "good", "--source", "pi", "--slug", "focus", "--json"],
    ]);
    expect(ctx.notifications.at(-1)).toEqual({ message: "피드백 기록 · focus · good", level: "info" });
  });

  test("keeps /ax and /ax-eval as notice-only migrations with zero subprocess or model calls", async () => {
    const fake = fakePi();
    let runs = 0;
    let completions = 0;
    installGdmCommands(fake.pi, {
      runGdm: async () => { runs++; return processResult("[]"); },
    });
    const ctx = context({
      modelRegistry: {
        complete: async () => {
          completions++;
          return { stopReason: "stop", content: [] };
        },
      },
    });
    await fake.commands.get("ax")?.("", ctx.value);
    await fake.commands.get("ax-eval")?.("", ctx.value);
    expect(runs).toBe(0);
    expect(completions).toBe(0);
    expect(fake.appended).toEqual([]);
    expect(ctx.notifications).toHaveLength(2);
    expect(ctx.notifications[0]?.message).toContain("/gdm");
    expect(ctx.notifications[1]?.message).toContain("/gdm-contract-check");
  });

  test("fails closed on malformed or timed-out GDM state", async () => {
    for (const result of [
      processResult("not-json"),
      processResult(JSON.stringify([{
        slug: "focus",
        done: false,
        proven: -2,
        total: -1,
        checks: [{}],
        blockers: [],
      }])),
      processResult("", { ok: false, exitCode: null, error: "GDM command timed out" }),
    ]) {
      const fake = fakePi();
      installGdmCommands(fake.pi, { runGdm: async () => result });
      const ctx = context();
      expect(fake.commands.get("gdm")).toBeDefined();
      await fake.commands.get("gdm")?.("", ctx.value);
      expect(ctx.notifications.at(-1)?.level).toBe("error");
      expect(ctx.notifications.at(-1)?.message).not.toContain("undefined");
    }
  });

  test("runs one bounded tool-free eval only through /gdm-contract-check", async () => {
    const previous = {
      type: "custom",
      customType: CONTRACT_CHECK_ENTRY_TYPE,
      data: { suiteVersion: CONTRACT_CHECK_SUITE_VERSION, passed: 3 },
    };
    const fake = fakePi([previous]);
    const completions: any[] = [];
    installGdmCommands(fake.pi, {
      now: () => "2026-08-19T00:00:00.000Z",
      newSessionId: () => "gdm-contract-check-session",
    });
    const ctx = context({
      sessionManager: { getEntries: () => fake.entries },
      modelRegistry: {
        complete: async (...args: any[]) => {
          completions.push(args);
          return {
            stopReason: "stop",
            content: [{
              type: "text",
              text: JSON.stringify({
                answers: Object.fromEntries(CONTRACT_CHECK_CASES.map((item) => [item.id, item.answer])),
              }),
            }],
          };
        },
      },
    });
    expect(fake.commands.get("gdm-contract-check")).toBeDefined();
    await fake.commands.get("gdm-contract-check")?.("", ctx.value);

    expect(completions).toHaveLength(1);
    expect(completions[0]?.[2]).toMatchObject({
      maxTokens: CONTRACT_CHECK_MAX_TOKENS,
      cacheRetention: "none",
      sessionId: "gdm-contract-check-session",
      reasoningEffort: "xhigh",
    });
    expect(completions[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(fake.appended).toHaveLength(1);
    expect(fake.appended[0]).toEqual({
      customType: CONTRACT_CHECK_ENTRY_TYPE,
      data: {
        suiteVersion: CONTRACT_CHECK_SUITE_VERSION,
        harnessVersion: GDM_HARNESS_VERSION,
        modelId: "openai-codex/gpt-5.6-sol",
        thinkingLevel: "xhigh",
        at: "2026-08-19T00:00:00.000Z",
        passed: 4,
        total: 4,
        caseResults: Object.fromEntries(CONTRACT_CHECK_CASES.map((item) => [item.id, true])),
      },
    });
    const persisted = JSON.stringify(fake.appended[0]);
    expect(persisted).not.toContain("question");
    expect(persisted).not.toContain("prompt");
    expect(persisted).not.toContain("response");
    expect(persisted).not.toContain("ax");
    expect(ctx.notifications.at(-1)?.message).toContain("이전 대비 +1");
    expect(ctx.notifications.at(-1)?.message).toContain("전체 하네스 인증이 아닙니다");
    expect(ctx.notifications.at(-1)?.message).not.toContain("AX");
  });

  test("does not replace the contract-check baseline with malformed, incomplete, or timed-out output", async () => {
    const validAnswers = JSON.stringify({
      answers: Object.fromEntries(CONTRACT_CHECK_CASES.map((item) => [item.id, item.answer])),
    });
    for (const complete of [
      async () => ({ stopReason: "stop", content: [{ type: "text", text: "not-json" }] }),
      async () => ({ stopReason: "error", content: [{ type: "text", text: validAnswers }] }),
      async () => ({ stopReason: "length", content: [{ type: "text", text: validAnswers }] }),
      async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) =>
        await new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ stopReason: "aborted" }))),
    ]) {
      const fake = fakePi();
      installGdmCommands(fake.pi, { contractCheckTimeoutMs: 5 });
      const ctx = context({ modelRegistry: { complete } });
      expect(fake.commands.get("gdm-contract-check")).toBeDefined();
      await fake.commands.get("gdm-contract-check")?.("", ctx.value);
      expect(fake.appended).toEqual([]);
      expect(ctx.notifications.at(-1)?.level).toBe("error");
    }
  });

  test("uses exact choices for deterministic scoring", () => {
    const answers = Object.fromEntries(CONTRACT_CHECK_CASES.map((item) => [item.id, item.answer]));
    expect(scoreContractCheck(JSON.stringify({ answers }))).toMatchObject({ passed: 4, total: 4 });
    answers[CONTRACT_CHECK_CASES[0]!.id] = "A";
    expect(scoreContractCheck(`prefix ${JSON.stringify({ answers })} suffix`)).toMatchObject({ passed: 3, total: 4 });
    expect(() => scoreContractCheck('{"answers":{}}')).toThrow("invalid");
  });
});
