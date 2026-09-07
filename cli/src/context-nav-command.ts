import { contextStatus, ContextError, runContextQuery } from "./context-nav/index.ts";
import { GdmError } from "./state.ts";

export function cmdContext(
  args: readonly string[],
  stdin: string,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const [subcommand, ...rest] = args;
  if (subcommand === "query") {
    if (rest.length !== 0) throw new GdmError("사용법: gdm context query", "usage");
    let raw: unknown;
    try {
      raw = JSON.parse(stdin);
    } catch {
      throw new GdmError("stdin에는 JSON request 하나가 필요합니다", "usage");
    }
    try {
      console.log(JSON.stringify(runContextQuery(raw, env)));
    } catch (error) {
      if (error instanceof ContextError) throw new GdmError(error.message, "usage");
      throw error;
    }
    return;
  }
  if (subcommand === "status") {
    if (rest.length !== 0) throw new GdmError("사용법: gdm context status", "usage");
    console.log(JSON.stringify(contextStatus()));
    return;
  }
  throw new GdmError("context 하위 명령은 query 또는 status만 지원합니다", "usage");
}
