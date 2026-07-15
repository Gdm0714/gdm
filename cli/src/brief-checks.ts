import type { CheckInput } from "./state.ts";
import { GdmError } from "./state.ts";

const SECTION_HEADING_RE = /^##\s*검증 항목/u;
const HEADING_RE = /^##\s/u;
const ITEM_RE = /^-\s*desc:\s*/u;
const EXPECT_SPLIT_RE = /\s+\/\s+expect:\s*/u;
const CMD_SPLIT_RE = /\s+\/\s+cmd:\s*/u;
const MANUAL_MARK_RE = /\(manual\)$/u;

interface BriefCheckIssue {
  readonly line: number;
  readonly why: string;
}

function stripBackticks(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^`(.*)`$/su);
  return match ? match[1]!.trim() : trimmed;
}

export function parseBriefChecks(brief: string): CheckInput[] {
  const lines = brief.split("\n");
  const start = lines.findIndex((line) => SECTION_HEADING_RE.test(line.trim()));
  if (start < 0) {
    throw new GdmError(
      'brief에 "## 검증 항목" 섹션이 없습니다 — gdm-plan 템플릿의 검증 항목 초안 형식이 필요합니다',
      "brief_checks_invalid",
    );
  }
  const inputs: CheckInput[] = [];
  const issues: BriefCheckIssue[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (HEADING_RE.test(line)) break;
    if (!ITEM_RE.test(line)) continue;
    const lineNo = i + 1;
    const body = line.replace(ITEM_RE, "");
    const expectParts = body.split(EXPECT_SPLIT_RE);
    if (expectParts.length !== 2) {
      issues.push({ line: lineNo, why: '" / expect: " 구분자가 정확히 한 번 필요합니다' });
      continue;
    }
    const [head, expectRaw] = expectParts;
    const cmdParts = head!.split(CMD_SPLIT_RE);
    if (cmdParts.length > 2) {
      issues.push({ line: lineNo, why: '" / cmd: " 구분자가 두 번 이상입니다' });
      continue;
    }
    let desc = cmdParts[0]!.trim();
    const manual = MANUAL_MARK_RE.test(desc);
    if (manual) desc = desc.replace(MANUAL_MARK_RE, "").trim();
    const cmd = cmdParts.length === 2 ? stripBackticks(cmdParts[1]!) : undefined;
    if (manual && cmd) {
      issues.push({ line: lineNo, why: "manual 항목에 cmd가 함께 있습니다 — 하나만 선택하세요" });
      continue;
    }
    if (!manual && !cmd) {
      issues.push({
        line: lineNo,
        why: '자동 항목에는 " / cmd: "가 필요합니다 (수동 확인이면 desc 끝에 "(manual)")',
      });
      continue;
    }
    const expect = expectRaw!.trim();
    if (!desc || !expect) {
      issues.push({ line: lineNo, why: "desc 또는 expect가 비어 있습니다" });
      continue;
    }
    inputs.push({ desc, cmd, expect, manual });
  }
  if (issues.length > 0) {
    const detail = issues.map((issue) => `  ${issue.line}행: ${issue.why}`).join("\n");
    throw new GdmError(`검증 항목 초안 파싱 실패 — 아무것도 등록하지 않았습니다:\n${detail}`, "brief_checks_invalid");
  }
  if (inputs.length === 0) {
    throw new GdmError('검증 항목 초안에서 항목을 찾지 못했습니다 ("- desc: ..." 형식)', "brief_checks_invalid");
  }
  return inputs;
}
