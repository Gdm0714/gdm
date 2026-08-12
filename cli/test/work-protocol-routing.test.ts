import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const BEGIN = "<!-- GDM_WORK_PROTOCOL_V1_BEGIN -->";
const END = "<!-- GDM_WORK_PROTOCOL_V1_END -->";
const V2_BEGIN = "<!-- GDM_WORK_PROTOCOL_V2_BEGIN -->";
const V2_END = "<!-- GDM_WORK_PROTOCOL_V2_END -->";
const ROUTED = ["plan", "go", "full"] as const;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function block(text: string): string {
  expect(text.match(/GDM_WORK_PROTOCOL_V1_BEGIN/gu)).toHaveLength(1);
  expect(text.match(/GDM_WORK_PROTOCOL_V1_END/gu)).toHaveLength(1);
  const start = text.indexOf(BEGIN);
  const finish = text.indexOf(END, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(finish).toBeGreaterThan(start);
  return text.slice(start, finish + END.length);
}

function lifecycleBlock(text: string): string {
  expect(text.match(/GDM_WORK_PROTOCOL_V2_BEGIN/gu)).toHaveLength(1);
  expect(text.match(/GDM_WORK_PROTOCOL_V2_END/gu)).toHaveLength(1);
  const start = text.indexOf(V2_BEGIN);
  const finish = text.indexOf(V2_END, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(finish).toBeGreaterThan(start);
  return text.slice(start, finish + V2_END.length);
}

describe("vendor-neutral work protocol routing", () => {
  test("keeps one canonical byte-identical block in plan, go, and full", () => {
    const canonical = block(read("skills/_shared/work-protocol.md"));
    const lifecycle = lifecycleBlock(read("skills/_shared/work-protocol.md"));

    for (const skill of ROUTED) {
      expect(block(read(`skills/${skill}/SKILL.md`))).toBe(canonical);
      expect(lifecycleBlock(read(`skills/${skill}/SKILL.md`))).toBe(lifecycle);
    }
  });

  test("routes v2 specialists through one capability-bound runner without granting authority", () => {
    const lifecycle = lifecycleBlock(read("skills/_shared/work-protocol.md"));
    const readme = read("README.md");
    const design = read("DESIGN.md");
    const evaluation = read("bench/work-protocol-v2-evaluation-2026-08-12.md");
    for (const value of [
      "gdm protocol offer",
      "gdm protocol adopt",
      "gdm protocol recover",
      "gdm protocol status",
      "gdm-read-only-specialist/v1",
      "gdm-dispatch-bundle/v1",
      "gdm-dispatch-model-view/v1",
      "gdm-protocol-receipt/v1",
      "GDM_RECEIVER_ACK_V1=",
      "gdm-receiver-ack/v1",
      "gdm-preflight-bundle/v1",
      "gdm-agents/run-role.sh --mode work",
      "gdm-agents/run-role.sh --mode preflight",
      "{path,sha256,text,bytesBase64}",
    ]) {
      expect(lifecycle).toContain(value);
    }
    expect(lifecycle).toMatch(/finish도 Work\/check\/audit\/delivery를 바꾸지 않는다/u);
    expect(lifecycle).toMatch(/실제 원격 provider\/model identity나 reasoning 품질을 증명하지 않는다/u);
    expect(lifecycle).not.toMatch(/\b(?:claude\s+-p|codex\s+exec)\b/iu);
    expect(lifecycle).toContain("Work mode는 `--prompt`를 받지 않는다");
    expect(lifecycle).toContain("provider tool은 0개");
    expect(lifecycle).toContain("bounded code excerpt");
    expect(lifecycle).toContain("evidence exact content·hash·command output");
    expect(lifecycle).toContain("모델 검토 입력은 `text`다");
    expect(lifecycle).toContain("`text`와 decoded `bytesBase64`는 같은 exact bytes");
    expect(lifecycle).toContain("`gdm-dispatch-model-view/v1` projection");
    expect(lifecycle).toMatch(/artifact\s+`\{path,sha256,text\}`/u);
    expect(lifecycle).toContain("`bytesBase64`를 포함하지 않는다");
    expect(lifecycle).toContain("full canonical bundle의 digest");
    expect(lifecycle).toContain("`GDM_DISPATCH_BUNDLE_V1_BEGIN/END` 이름은 호환 framing");
    expect(lifecycle).toContain("`bytesBase64`는 canonical identity/transport에만 쓰고 provider model-view에는 주입하지 않아");
    expect(lifecycle).toContain("CLI가 모델 backend에 연결하는 transport 자체를 차단하거나 증명한다는 뜻은 아니다");
    expect(lifecycle).toContain("credential-free valid UTF-8, 최대 1 MiB");
    expect(lifecycle).toContain("finish output은 최대 2 MiB");
    expect(lifecycle).toContain("canonical dispatch bundle은 최대 4 MiB");
    expect(lifecycle).toContain("artifact_encoding_invalid|privacy_rejected|artifact_too_large|output_too_large|bundle_too_large");
    expect(lifecycle).toContain("`finish`에는 호출자가 정하는 `--status`가 없다");
    expect(readme).toContain(
      "runner가 관찰한 metadata일 뿐 원격 identity나 reasoning 품질이 같다는 증명이 아니다",
    );
    expect(readme).toMatch(
      /provider CLI가[\s\S]*모델 backend에 연결하는 transport까지 차단한다는 뜻은 아니다/u,
    );
    expect(readme).toMatch(
      /canonical artifact[\s\S]*\{path,sha256,text,bytesBase64\}[\s\S]*gdm-dispatch-model-view\/v1[\s\S]*\{path,sha256,text\}[\s\S]*`bytesBase64`는 없다/u,
    );
    expect(readme).toMatch(
      /GDM_RECEIVER_TRUST_BOOTSTRAP_V1:[\s\S]*ACK 선택지만[\s\S]*artifact text[\s\S]*신뢰하지 않는 분석 데이터/u,
    );
    expect(readme).toContain("원격 model identity나 artifact provenance attestation이 아니다");
    expect(design).toMatch(
      /실제 원격\s+provider\/model identity 또는 reasoning 품질 attestation이 아니다/u,
    );
    expect(design).toMatch(
      /모델 backend에 연결하는 transport 자체를 차단하거나 attest하는 경계는 아니다/u,
    );
    expect(design).toMatch(
      /canonical `gdm-dispatch-bundle\/v1`[\s\S]*gdm-dispatch-model-view\/v1[\s\S]*model-view에는 `bytesBase64`가 없/u,
    );
    expect(design).toMatch(
      /gdm-provider-adapter-v2[\s\S]*--append-system-prompt[\s\S]*artifact text[\s\S]*untrusted data/u,
    );
    for (const claim of ["audit-claude-4", "audit-claude-5", "audit-claude-6"]) {
      expect(evaluation).toContain(claim);
    }
    expect(evaluation).toContain("bounded runner timeout으로 exit 124");
    expect(evaluation).toContain("0 bytes");
    expect(evaluation).toContain("pre-fix harness의 입력 확대 경로");
    expect(evaluation).toMatch(/세 timeout은[\s\S]*모델 품질[\s\S]*평가가 아니다/u);
  });

  test("documents the exact snapshot, handoff, and stale-detection surface", () => {
    const canonical = block(read("skills/_shared/work-protocol.md"));

    expect(canonical).toContain("`gdm protocol export --slug <s>`");
    expect(canonical).toContain("`gdm-work-snapshot/v1`");
    expect(canonical).toContain(
      "`gdm protocol handoff --slug <s> --handoff-id <handoff-id> --from-role <from-role> --to-role <to-role> --intent <intent>`",
    );
    expect(canonical).toContain("`gdm-handoff/v1`");
    for (const flag of [
      "--from-provider",
      "--to-provider",
      "--artifact",
      "--expected-plan-fingerprint",
      "--expected-state-fingerprint",
      "--expected-source-fingerprint",
    ]) {
      expect(canonical).toContain(`\`${flag}`);
    }
    expect(canonical).toContain("`ready-to-validate`");
    expect(canonical).toContain("`gdm done --slug <s>`");
    expect(canonical).toMatch(/gdm-plan[\s\S]*Work[\s\S]*gdm plan init[\s\S]*뒤에만 export/u);
  });

  test("denies workflow authority and keeps same-session chatter lightweight", () => {
    const canonical = block(read("skills/_shared/work-protocol.md"));

    expect(canonical).toMatch(/snapshot과 handoff는 컨텍스트 전달과 stale 감지 수단일 뿐/u);
    for (const authority of [
      "evidence",
      "`gdm pass`",
      "audit 판정",
      "`gdm done`",
      "commit 승인",
      "delivery 승인",
    ]) {
      expect(canonical).toContain(authority);
    }
    expect(canonical).toMatch(/provider ID[\s\S]*메타데이터일 뿐[\s\S]*권한/u);
    expect(canonical).toMatch(/같은 네이티브 세션[\s\S]*모두 journal에 기록할 필요는 없다/u);
    expect(canonical).toMatch(/역할·공급자 경계를 넘는[\s\S]*handoff/u);
  });

  test("contains only intentional metavariables and no renderer or orchestrator claim", () => {
    const canonical = block(read("skills/_shared/work-protocol.md"));
    const metavariables = [...canonical.matchAll(/<(?!!--)[^>\n]+>/gu)].map(([value]) => value);

    expect(new Set(metavariables)).toEqual(
      new Set([
        "<s>",
        "<handoff-id>",
        "<from-role>",
        "<to-role>",
        "<intent>",
        "<provider-id>",
        "<path>",
        "<sha256>",
      ]),
    );
    expect(canonical).not.toMatch(/TODO|TBD|FIXME|\{\{|\}\}|PLACEHOLDER/u);
    expect(canonical).not.toMatch(
      /PROTOCOL_RENDERER|PROTOCOL_ORCHESTRATOR|protocol renderer|protocol orchestrator|모델을 자동으로 호출|공급자를 자동으로 선택/u,
    );
  });
});
