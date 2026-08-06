import { describe, expect, test } from "bun:test";
import { parseBriefChecks } from "../src/brief-checks.ts";
import { GdmError } from "../src/state.ts";

const VALID_BRIEF = `# 계획: 샘플

## 목표
설명.

## 검증 항목 초안
gdm plan add에 그대로 쓸 수 있는 형태:
- desc: 빌드 성공 / cmd: \`cargo build --workspace\` / expect: 컴파일 오류 없이 exit 0
- desc: 설정값 반영 / cmd: grep -q "LIMIT = 500" src/config.ts / expect: exit 0
- desc: 화면 확인 (manual) / expect: 스크린샷이 정본과 일치

## 작업 계약 초안
- require: 기존 동작 보존
`;

function errorOf(brief: string): GdmError {
  try {
    parseBriefChecks(brief);
  } catch (error) {
    if (error instanceof GdmError) return error;
    throw error;
  }
  throw new Error("expected GdmError");
}

describe("parseBriefChecks", () => {
  test("자동·수동 항목과 백틱 cmd를 파싱한다", () => {
    // Given: gdm-plan 템플릿 형식의 brief.
    // When: 검증 항목 초안을 파싱한다.
    const inputs = parseBriefChecks(VALID_BRIEF);

    // Then: 섹션 안의 항목만, 형식 그대로 구조화된다.
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toEqual({
      desc: "빌드 성공",
      cmd: "cargo build --workspace",
      expect: "컴파일 오류 없이 exit 0",
      manual: false,
    });
    expect(inputs[1]!.cmd).toBe('grep -q "LIMIT = 500" src/config.ts');
    expect(inputs[2]).toEqual({
      desc: "화면 확인",
      cmd: undefined,
      expect: "스크린샷이 정본과 일치",
      manual: true,
    });
  });

  test("다음 heading에서 섹션이 끝난다", () => {
    // Given: 섹션 뒤에 다른 목록이 있는 brief.
    const brief = `## 검증 항목 초안
- desc: 항목 / cmd: printf ok / expect: ok

## 구현 단계
- desc: 이것은 항목이 아니다 / expect: 파싱 금지
`;

    // When/Then: 다음 섹션의 유사 형식 줄은 무시된다.
    expect(parseBriefChecks(brief)).toHaveLength(1);
  });

  test("regression·static·expert 분류를 실행 가능한 입력으로 보존한다", () => {
    const brief = `## 검증 항목 초안
- desc: 기존 결함 재현 (regression) / cmd: bun test regression / expect: red 뒤 green
- desc: 최소 diff 확인 (static) / cmd: bun run lint / expect: 불필요한 복잡성 없음
- desc: 전문가 위험 검토 (expert) / expect: reviewer와 판단 근거 기록
`;

    expect(parseBriefChecks(brief)).toEqual([
      { desc: "기존 결함 재현", cmd: "bun test regression", expect: "red 뒤 green", manual: false, kind: "regression" },
      { desc: "최소 diff 확인", cmd: "bun run lint", expect: "불필요한 복잡성 없음", manual: false, kind: "static" },
      { desc: "전문가 위험 검토", cmd: undefined, expect: "reviewer와 판단 근거 기록", manual: true, kind: "manual", expert: true },
    ]);
  });

  test("섹션이 없으면 brief_checks_invalid", () => {
    const error = errorOf("# 계획\n\n## 목표\n설명뿐");
    expect(error.code).toBe("brief_checks_invalid");
    expect(error.message).toContain("검증 항목");
  });

  test("한 줄이라도 형식 오류면 전체 실패하고 행 번호를 알려준다", () => {
    // Given: 두 번째 항목에 expect가 없는 brief.
    const brief = `## 검증 항목 초안
- desc: 좋은 항목 / cmd: printf ok / expect: exit 0
- desc: 나쁜 항목 / cmd: printf bad
`;

    // When: 파싱한다.
    const error = errorOf(brief);

    // Then: 아무것도 반환하지 않고 실패 행이 보고된다.
    expect(error.code).toBe("brief_checks_invalid");
    expect(error.message).toContain("3행");
    expect(error.message).toContain("expect");
  });

  test("manual 항목에 cmd가 함께 있으면 실패한다", () => {
    const brief = `## 검증 항목 초안
- desc: 애매한 항목 (manual) / cmd: printf ok / expect: 둘 다 있음
`;
    const error = errorOf(brief);
    expect(error.code).toBe("brief_checks_invalid");
    expect(error.message).toContain("manual");
  });

  test("항목이 하나도 없으면 실패한다", () => {
    const error = errorOf("## 검증 항목 초안\n설명 문장만 있음\n");
    expect(error.code).toBe("brief_checks_invalid");
  });
});
