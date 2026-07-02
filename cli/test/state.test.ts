import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCheck,
  checksHash,
  closeWork,
  editCheck,
  GdmError,
  initWork,
  passCheck,
  provenCount,
  recordAudit,
  refreshEvidence,
  revertChecks,
  validateWork,
} from "../src/state.ts";
import {
  listWorks,
  loadPresets,
  loadWork,
  resolveWork,
  resolveWorkForRead,
  savePresets,
  saveWork,
} from "../src/store.ts";
import type { Work } from "../src/types.ts";

const NOW = "2026-07-02T00:00:00.000Z";
const EV = { observed: "out/c1.txt", sha256: "abc123", manual: false };

function sampleWork(): Work {
  let work = initWork("sample", "샘플 작업", NOW);
  ({ work } = addCheck(work, { desc: "빌드 통과", cmd: "bun run build", expect: "exit 0" }));
  ({ work } = addCheck(work, { desc: "테스트 통과", cmd: "bun test", expect: "전체 pass" }));
  return work;
}

describe("initWork", () => {
  test("정상 생성", () => {
    const work = initWork("fix-login", "로그인 수정", NOW);
    expect(work.slug).toBe("fix-login");
    expect(work.done).toBe(false);
    expect(work.checks).toHaveLength(0);
  });

  test("잘못된 슬러그 거부", () => {
    expect(() => initWork("한글슬러그", "x", NOW)).toThrow(GdmError);
    expect(() => initWork("UPPER", "x", NOW)).toThrow(GdmError);
    expect(() => initWork("a", "x", NOW)).toThrow(GdmError);
    expect(() => initWork("../escape", "x", NOW)).toThrow(GdmError);
  });

  test("빈 brief 거부", () => {
    expect(() => initWork("ok-slug", "   ", NOW)).toThrow(GdmError);
  });
});

describe("addCheck", () => {
  test("id가 c1, c2로 증가", () => {
    const work = sampleWork();
    expect(work.checks.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("자동 항목에 cmd 없으면 거부", () => {
    const work = initWork("sample", "x", NOW);
    expect(() => addCheck(work, { desc: "항목", expect: "기대" })).toThrow(/재현 명령/);
  });

  test("manual 항목은 cmd 없이 허용", () => {
    const work = initWork("sample", "x", NOW);
    const { check } = addCheck(work, { desc: "UI 확인", expect: "모달 정상 표시", manual: true });
    expect(check.manual).toBe(true);
    expect(check.cmd).toBeNull();
  });

  test("expect 없으면 거부", () => {
    const work = initWork("sample", "x", NOW);
    expect(() => addCheck(work, { desc: "항목", cmd: "echo" })).toThrow(/기대 관찰/);
  });
});

describe("passCheck", () => {
  test("open → proven (sha256 포함)", () => {
    const work = passCheck(sampleWork(), "c1", EV, NOW);
    expect(work.checks[0]!.status).toBe("proven");
    expect(work.checks[0]!.evidence?.sha256).toBe("abc123");
    expect(provenCount(work)).toEqual({ proven: 1, total: 2 });
  });

  test("sha256 없으면 거부", () => {
    expect(() =>
      passCheck(sampleWork(), "c1", { observed: "out.txt", sha256: "", manual: false }, NOW),
    ).toThrow(/해시/);
  });

  test("이미 proven이면 거부", () => {
    const work = passCheck(sampleWork(), "c1", EV, NOW);
    expect(() => passCheck(work, "c1", EV, NOW)).toThrow(/이미 통과/);
  });

  test("자동 항목에 수동 증거 거부", () => {
    expect(() => passCheck(sampleWork(), "c1", { ...EV, manual: true }, NOW)).toThrow(/수동 증거/);
  });

  test("manual 항목에 자동 증거 거부", () => {
    let work = initWork("sample", "x", NOW);
    ({ work } = addCheck(work, { desc: "UI", expect: "정상", manual: true }));
    expect(() => passCheck(work, "c1", EV, NOW)).toThrow(/수동 확인 항목/);
  });

  test("없는 항목 거부", () => {
    expect(() => passCheck(sampleWork(), "c9", EV, NOW)).toThrow(/c9가 없습니다/);
  });
});

describe("editCheck", () => {
  test("reason 없으면 거부", () => {
    expect(() => editCheck(sampleWork(), "c1", { desc: "변경" }, "")).toThrow(/사유.*필수/);
  });

  test("proven 항목 수정 시 open으로 회귀 + 증거 삭제", () => {
    const proven = passCheck(sampleWork(), "c1", EV, NOW);
    const { work, reverted } = editCheck(proven, "c1", { expect: "exit 0 그리고 경고 없음" }, "기준 강화");
    expect(reverted).toBe(true);
    expect(work.checks[0]!.status).toBe("open");
    expect(work.checks[0]!.evidence).toBeUndefined();
  });

  test("변경 없으면 거부", () => {
    expect(() => editCheck(sampleWork(), "c1", { desc: "빌드 통과" }, "사유")).toThrow(/바뀐 내용/);
  });

  test("자동 항목의 cmd를 비우면 거부", () => {
    expect(() => editCheck(sampleWork(), "c1", { cmd: "  " }, "사유")).toThrow(/비울 수 없습니다/);
  });

  test("desc를 비우면 거부", () => {
    expect(() => editCheck(sampleWork(), "c1", { desc: "  " }, "사유")).toThrow(/비울 수 없습니다/);
  });
});

describe("closeWork", () => {
  test("미통과 항목 있으면 목록과 함께 거부", () => {
    try {
      closeWork(sampleWork(), NOW);
      throw new Error("도달하면 안 됨");
    } catch (error) {
      expect(error).toBeInstanceOf(GdmError);
      expect((error as GdmError).code).toBe("unproven");
      expect((error as GdmError).message).toContain("c1");
      expect((error as GdmError).message).toContain("c2");
    }
  });

  test("check 없이 done 거부", () => {
    const work = initWork("sample", "x", NOW);
    expect(() => closeWork(work, NOW)).toThrow(/항목이 하나도/);
  });

  test("전부 proven이면 done, 이후 add/close 거부", () => {
    let work = sampleWork();
    work = passCheck(work, "c1", EV, NOW);
    work = passCheck(work, "c2", { ...EV, observed: "out/c2.txt" }, NOW);
    const closed = closeWork(work, NOW);
    expect(closed.done).toBe(true);
    expect(() => addCheck(closed, { desc: "추가", cmd: "x", expect: "y" })).toThrow(/완료된 작업/);
    expect(() => closeWork(closed, NOW)).toThrow(/이미 완료/);
  });
});

describe("audit 게이트", () => {
  function allProven(auditRequired = true): Work {
    let work = initWork("sample", "샘플", NOW, auditRequired);
    ({ work } = addCheck(work, { desc: "빌드", cmd: "b", expect: "ok" }));
    work = passCheck(work, "c1", EV, NOW);
    return work;
  }

  test("미통과 상태에서 verdict 거부", () => {
    const work = initWork("sample", "x", NOW, true);
    expect(() => recordAudit(work, "pass", "report.md", NOW)).toThrow(/모든 항목 통과 후/);
  });

  test("검수 필수 작업은 검수 없이 done 거부", () => {
    expect(() => closeWork(allProven(), NOW)).toThrow(/검수가 필요한 작업/);
  });

  test("검수 반려 상태에서 done 거부", () => {
    const audited = recordAudit(allProven(), "fail", "report.md", NOW);
    expect(() => closeWork(audited, NOW)).toThrow(/반려/);
  });

  test("검수 통과 후 done 성공", () => {
    const audited = recordAudit(allProven(), "pass", "report.md", NOW);
    expect(closeWork(audited, NOW).done).toBe(true);
  });

  test("검수 후 상태가 바뀌면 done 거부 (stateHash 불일치)", () => {
    let audited = recordAudit(allProven(), "pass", "report.md", NOW);
    ({ work: audited } = addCheck(audited, { desc: "추가", cmd: "x", expect: "y" }));
    audited = passCheck(audited, "c2", { ...EV, observed: "out/c2.txt" }, NOW);
    expect(() => closeWork(audited, NOW)).toThrow(/재검수/);
  });

  test("검수 불필요 작업은 audit 없이 done 가능", () => {
    expect(closeWork(allProven(false), NOW).done).toBe(true);
  });

  test("checksHash는 checks 변경에만 반응", () => {
    const work = allProven();
    const before = checksHash(work);
    expect(checksHash({ ...work, brief: "다른 brief" })).toBe(before);
    const { work: added } = addCheck(work, { desc: "추가", cmd: "x", expect: "y" });
    expect(checksHash(added)).not.toBe(before);
  });
});

describe("revertChecks / refreshEvidence", () => {
  test("revertChecks: proven → open + 증거 제거", () => {
    const proven = passCheck(sampleWork(), "c1", EV, NOW);
    const reverted = revertChecks(proven, ["c1"]);
    expect(reverted.checks[0]!.status).toBe("open");
    expect(reverted.checks[0]!.evidence).toBeUndefined();
    expect(reverted.checks[1]!.status).toBe("open");
  });

  test("refreshEvidence: proven 자동 항목의 증거 갱신", () => {
    const proven = passCheck(sampleWork(), "c1", EV, NOW);
    const refreshed = refreshEvidence(proven, "c1", { ...EV, sha256: "newhash" }, NOW);
    expect(refreshed.checks[0]!.status).toBe("proven");
    expect(refreshed.checks[0]!.evidence?.sha256).toBe("newhash");
  });

  test("refreshEvidence: open 항목 거부", () => {
    expect(() => refreshEvidence(sampleWork(), "c1", EV, NOW)).toThrow(/통과 상태가 아닙니다/);
  });

  test("refreshEvidence: 수동 항목 거부", () => {
    let work = initWork("sample", "x", NOW);
    ({ work } = addCheck(work, { desc: "UI", expect: "정상", manual: true }));
    work = passCheck(work, "c1", { observed: "shot.png", sha256: "h", manual: true }, NOW);
    expect(() => refreshEvidence(work, "c1", EV, NOW)).toThrow(/수동 항목/);
  });
});

describe("validateWork", () => {
  test("checks가 배열이 아니면 거부", () => {
    expect(() => validateWork({ slug: "x", brief: "y", done: false, checks: {} }, "t")).toThrow(
      /배열이 아님/,
    );
  });

  test("잘못된 status 값 거부", () => {
    const work = sampleWork() as unknown as { checks: { status: string }[] };
    work.checks[0]!.status = "hacked";
    expect(() => validateWork(work, "t")).toThrow(/status 값 오류/);
  });

  test("증거 없이 proven이면 거부 (손편집 우회 차단)", () => {
    const work = sampleWork() as unknown as { checks: { status: string }[] };
    work.checks[0]!.status = "proven";
    expect(() => validateWork(work, "t")).toThrow(/증거 없이 proven/);
  });
});

describe("store", () => {
  test("저장/로드 라운드트립 + work.md 생성", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    const work = sampleWork();
    saveWork(cwd, work);
    expect(loadWork(cwd, "sample")).toEqual(work);
    expect(listWorks(cwd)).toHaveLength(1);
  });

  test("손상된 checks.json은 GdmError로 보고", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    mkdirSync(join(cwd, ".gdm", "broken"), { recursive: true });
    writeFileSync(join(cwd, ".gdm", "broken", "checks.json"), "{truncated");
    try {
      loadWork(cwd, "broken");
      throw new Error("도달하면 안 됨");
    } catch (error) {
      expect(error).toBeInstanceOf(GdmError);
      expect((error as GdmError).code).toBe("state_corrupt");
    }
  });

  test("디렉토리명과 slug 불일치는 손상으로 처리", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    saveWork(cwd, sampleWork());
    const forged = { ...sampleWork(), slug: "sample" };
    mkdirSync(join(cwd, ".gdm", "renamed"), { recursive: true });
    writeFileSync(join(cwd, ".gdm", "renamed", "checks.json"), JSON.stringify(forged));
    expect(() => loadWork(cwd, "renamed")).toThrow(/불일치/);
  });

  test("손상된 작업이 있어도 listWorks는 나머지를 반환", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    saveWork(cwd, sampleWork());
    mkdirSync(join(cwd, ".gdm", "broken"), { recursive: true });
    writeFileSync(join(cwd, ".gdm", "broken", "checks.json"), "not json");
    const works = listWorks(cwd);
    expect(works).toHaveLength(1);
    expect(works[0]!.slug).toBe("sample");
  });

  test("resolveWork: 진행 중 1개면 자동 선택, Work 반환", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    saveWork(cwd, sampleWork());
    expect(resolveWork(cwd).slug).toBe("sample");
  });

  test("resolveWork: 0개/2개면 에러", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    expect(() => resolveWork(cwd)).toThrow(/진행 중인 작업이 없습니다/);
    saveWork(cwd, sampleWork());
    saveWork(cwd, { ...sampleWork(), slug: "another" });
    expect(() => resolveWork(cwd)).toThrow(/여러 개/);
  });

  test("resolveWork: 경로 순회 슬러그 거부", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    expect(() => resolveWork(cwd, "../../etc")).toThrow(GdmError);
    expect(() => resolveWork(cwd, "a/b")).toThrow(GdmError);
  });

  test("resolveWork: 없는 슬러그 에러", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    expect(() => resolveWork(cwd, "ghost")).toThrow(/없습니다/);
  });

  test("resolveWorkForRead: 진행 중 없으면 가장 최근 작업(완료 포함) 선택", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    let work = sampleWork();
    work = passCheck(work, "c1", EV, NOW);
    work = passCheck(work, "c2", { ...EV, observed: "out/c2.txt" }, NOW);
    saveWork(cwd, closeWork(work, NOW));
    expect(() => resolveWork(cwd)).toThrow(/진행 중인 작업이 없습니다/);
    expect(resolveWorkForRead(cwd).slug).toBe("sample");
  });

  test("프리셋 저장/로드 라운드트립", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    expect(loadPresets(cwd)).toEqual({});
    savePresets(cwd, { test: "./gradlew test", build: "bun run build" });
    expect(loadPresets(cwd)).toEqual({ test: "./gradlew test", build: "bun run build" });
  });

  test("손상된 프리셋 파일은 GdmError", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-test-"));
    mkdirSync(join(cwd, ".gdm"), { recursive: true });
    writeFileSync(join(cwd, ".gdm", "presets.json"), "{broken");
    expect(() => loadPresets(cwd)).toThrow(GdmError);
  });
});
