import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ContextError, runContextQuery } from "../src/context-nav/index.ts";
import { buildContextPack } from "../src/context-nav/query.ts";
import type { ContextQuery } from "../src/context-nav/schema.ts";

const decoder = new TextDecoder();
const SECRET = ["sk", "test", "0123456789abcdefghijklmnop"].join("-");
const JWT = ["abcdefgh1234", "ijklmnop5678", "qrstuvwx9012"].join(".");
const AUTHORIZATION_FIELD = ["Author", "ization"].join("");
const AUTHORIZATION = `${["Bear", "er"].join("")} abc123`;
const GENERIC_AUTHORIZATION = `${AUTHORIZATION_FIELD}: Basic tiny`;
const QUOTED_JSON_AUTHORIZATION = `"${AUTHORIZATION_FIELD}": "x"`;
const ESCAPED_JSON_AUTHORIZATION = QUOTED_JSON_AUTHORIZATION.replaceAll("\"", `${String.fromCharCode(92)}\"`);
const UNICODE_ESCAPED_AUTHORIZATION = `"Author${String.fromCharCode(92)}u0069zation": "x"`;
const URL_ESCAPED_AUTHORIZATION = "Author%69zation: x";
const HTML_ESCAPED_AUTHORIZATION = "Author&#x69;zation: x";
const INVISIBLE_AUTHORIZATION = `Author${String.fromCodePoint(0x200b)}ization: x`;
const COMPATIBILITY_AUTHORIZATION = `${String.fromCodePoint(0xff21)}uthorization: x`;
const QUOTED_YAML_AUTHORIZATION = `'${AUTHORIZATION_FIELD}': x`;
const QUOTED_MARKDOWN_AUTHORIZATION = `\`${AUTHORIZATION_FIELD}\` = x`;
const PASSWORD = "password = correct-horse-battery-staple";
const QUOTED_PASSWORD = `"password": "x"`;
const QUOTED_CREDENTIALS = `'credentials': x`;
const SEPARATOR_PASSWORD = `"pass-word": "x"`;
const UNDERSCORE_PASSWORD = `"pass_word": "x"`;
const BENIGN_ASSIGNMENT_HEADING = "API: Overview";
const ESCAPED_PASSWORD = QUOTED_PASSWORD.replaceAll("\"", `${String.fromCharCode(92)}\"`);
const UNICODE_ESCAPED_PASSWORD = `"passw${String.fromCharCode(92)}u006frd": "x"`;
const UNDERSCORE_ASSIGNMENT = "client_secret = tiny-pass";
const CONNECTION = `${["post", "gres"].join("")}://admin:database-pass@localhost/app`;

function git(cwd: string, args: readonly string[]): void {
  const outcome = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(outcome.exitCode, decoder.decode(outcome.stderr)).toBe(0);
}

function directory(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function repository(prefix: string): string {
  const root = directory(prefix);
  git(root, ["init", "-q"]);
  return root;
}

function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function request(root: string, overrides: Partial<ContextQuery> = {}): ContextQuery {
  return {
    schemaVersion: "gdm-context-query/v1",
    root,
    op: "pack",
    terms: ["boundary"],
    seeds: [],
    edgeTypes: ["imports", "mentions", "contains", "owns", "touches", "verifies", "evidenced_by", "tests"],
    maxDepth: 2,
    budget: { maxBytes: 4096, maxNodes: 24, maxEdges: 48, maxSnippets: 5 },
    ...overrides,
  };
}

describe("context navigation adversarial boundaries", () => {
  test("rejects malformed schemas and unsafe query values", () => {
    const root = repository("gdm-context-invalid-");
    write(root, "src/entry.ts", "export const boundary = true;\n");
    const env = { GDM_CONTEXT_TRUSTED_ROOT: root };
    const invalid: unknown[] = [
      { ...request(root), unknown: true },
      { ...request(root), schemaVersion: "gdm-context-query/v2" },
      { ...request(root), terms: [] },
      { ...request(root), terms: [SECRET] },
      { ...request(root), terms: [GENERIC_AUTHORIZATION] },
      { ...request(root), terms: [QUOTED_JSON_AUTHORIZATION] },
      { ...request(root), terms: [ESCAPED_JSON_AUTHORIZATION] },
      { ...request(root), terms: [UNICODE_ESCAPED_AUTHORIZATION] },
      { ...request(root), terms: [QUOTED_PASSWORD] },
      { ...request(root), terms: [SEPARATOR_PASSWORD] },
      { ...request(root), terms: [BENIGN_ASSIGNMENT_HEADING] },
      { ...request(root), seeds: ["../outside.ts"] },
      { ...request(root), maxDepth: 5 },
      { ...request(root), budget: { maxBytes: 4096, maxNodes: 24, maxEdges: 48, maxSnippets: 5, page: 2 } },
    ];

    for (const raw of invalid) {
      expect(() => runContextQuery(raw, env), JSON.stringify(raw)).toThrow(ContextError);
    }
  });

  test("returns an empty untrusted pack before repository inspection", () => {
    const nonRepository = directory("gdm-context-untrusted-");
    write(nonRepository, "sentinel.txt", SECRET);
    const pack = runContextQuery(request(nonRepository), {
      GDM_CONTEXT_TRUSTED_ROOT: directory("gdm-context-other-root-"),
    });

    expect(pack.st).toBe("untrusted");
    expect(pack.fr).toBe("stale");
    expect(pack.n).toEqual([]);
    expect(pack.e).toEqual([]);
    expect(pack.sn).toEqual([]);
    expect(JSON.stringify(pack)).not.toContain(SECRET);
  });

  test("does not follow a trusted-root symlink", () => {
    const root = repository("gdm-context-real-root-");
    write(root, "src/entry.ts", "export const boundary = true;\n");
    const parent = directory("gdm-context-root-link-");
    const link = join(parent, "repo");
    symlinkSync(root, link);

    const pack = runContextQuery(request(link, { root: link }), { GDM_CONTEXT_TRUSTED_ROOT: link });
    expect(pack.st).toBe("untrusted");
    expect(pack.n).toEqual([]);
  });

  test("fails closed when any GDM Work metadata is malformed", () => {
    const root = repository("gdm-context-corrupt-work-");
    write(root, "src/entry.ts", "export const boundary = true;\n");
    write(root, ".gdm/broken/checks.json", "{not-json\n");

    const pack = runContextQuery(request(root), { GDM_CONTEXT_TRUSTED_ROOT: root });
    expect(pack.st).toBe("error");
    expect(pack.fr).toBe("stale");
    expect(pack.n).toEqual([]);
    expect(pack.e).toEqual([]);
    expect(pack.sn).toEqual([]);
    expect(pack.u.why).toEqual(["gdm-metadata-invalid"]);
  });

  test("fails closed when a candidate Work directory is incomplete", () => {
    const root = repository("gdm-context-incomplete-work-");
    write(root, "src/entry.ts", "export const boundary = true;\n");
    write(root, ".gdm/incomplete-work/marker.txt", "missing state\n");

    const pack = runContextQuery(request(root), { GDM_CONTEXT_TRUSTED_ROOT: root });
    expect(pack.st).toBe("error");
    expect(pack.fr).toBe("stale");
    expect(pack.n).toEqual([]);
    expect(pack.u.why).toEqual(["gdm-metadata-invalid"]);
  });

  test("marks a changing source graph stale instead of returning snippets as fresh", () => {
    const root = repository("gdm-context-changing-");
    const volatile = join(root, "src", "volatile.ts");
    write(root, "src/volatile.ts", "export const boundary = 0;\n");
    const pack = buildContextPack(request(root, {
      terms: ["boundary"],
      seeds: ["src/volatile.ts"],
    }), root, {
      beforeFreshness: () => writeFileSync(volatile, "export const boundary = 1;\n"),
    });

    expect(pack.st).toBe("stale");
    expect(pack.fr).toBe("stale");
    expect(pack.sn).toEqual([]);
    expect(pack.u.why).toContain("source-or-work-changed-during-query");
  });

  test("uses the full file digest when truncated provenance prefixes collide", () => {
    const root = repository("gdm-context-prefix-collision-");
    const volatile = join(root, "src", "volatile.ts");
    write(root, "src/volatile.ts", "export const boundary = 0;\n");
    const pack = buildContextPack(request(root, {
      terms: ["boundary"],
      seeds: ["src/volatile.ts"],
    }), root, {
      beforeFreshness: () => writeFileSync(volatile, "export const boundary = 1;\n"),
      fileDigestForTest: (bytes) => decoder.decode(bytes).includes("= 0")
        ? `deadbeef${"0".repeat(56)}`
        : `deadbeef${"1".repeat(56)}`,
    });

    expect(pack.st).toBe("stale");
    expect(pack.fr).toBe("stale");
    expect(pack.sn).toEqual([]);
    expect(pack.u.why).toContain("source-or-work-changed-during-query");
  });

  test("hard-caps output and excludes secret-shaped and ignored corpus", () => {
    const root = repository("gdm-context-budget-");
    write(root, "src/entry.ts", "export const boundary = true;\n");
    write(root, ".env.local", `TOKEN=${SECRET}\n`);
    write(root, ".envrc", `export TOKEN=${SECRET}\n`);
    write(root, "docs/secrets.md", [
      `# Security ${SECRET}`,
      `# Security ${JWT}`,
      `# Security ${AUTHORIZATION}`,
      `# Security ${GENERIC_AUTHORIZATION}`,
      `# Security ${QUOTED_JSON_AUTHORIZATION}`,
      `# Security ${ESCAPED_JSON_AUTHORIZATION}`,
      `# Security ${UNICODE_ESCAPED_AUTHORIZATION}`,
      `# Security ${URL_ESCAPED_AUTHORIZATION}`,
      `# Security ${HTML_ESCAPED_AUTHORIZATION}`,
      `# Security ${INVISIBLE_AUTHORIZATION}`,
      `# Security ${COMPATIBILITY_AUTHORIZATION}`,
      `# Security ${QUOTED_YAML_AUTHORIZATION}`,
      `# Security ${QUOTED_MARKDOWN_AUTHORIZATION}`,
      `# Security ${PASSWORD}`,
      `# Security ${QUOTED_PASSWORD}`,
      `# Security ${QUOTED_CREDENTIALS}`,
      `# Security ${SEPARATOR_PASSWORD}`,
      `# Security ${UNDERSCORE_PASSWORD}`,
      `# ${BENIGN_ASSIGNMENT_HEADING}`,
      `# Security ${ESCAPED_PASSWORD}`,
      `# Security ${UNICODE_ESCAPED_PASSWORD}`,
      `# Security ${UNDERSCORE_ASSIGNMENT}`,
      `# Security ${CONNECTION}`,
      "",
    ].join("\n"));
    write(root, ".gitignore", ".env*\n");
    for (let index = 0; index < 120; index++) {
      write(root, `docs/boundary-${String(index).padStart(3, "0")}.md`, `# Boundary ${index}\n\nSafe documentation ${index}.\n`);
    }

    const first = runContextQuery(request(root, {
      terms: ["boundary"],
      budget: { maxBytes: 512, maxNodes: 64, maxEdges: 128, maxSnippets: 12 },
    }), { GDM_CONTEXT_TRUSTED_ROOT: root });
    const second = runContextQuery(request(root, {
      terms: ["boundary"],
      budget: { maxBytes: 512, maxNodes: 64, maxEdges: 128, maxSnippets: 12 },
    }), { GDM_CONTEXT_TRUSTED_ROOT: root });
    const serialized = JSON.stringify(first);

    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(512);
    expect(first.tr).not.toBeNull();
    expect(second).toEqual(first);
    for (const secret of [
      SECRET,
      JWT,
      AUTHORIZATION,
      GENERIC_AUTHORIZATION,
      QUOTED_JSON_AUTHORIZATION,
      ESCAPED_JSON_AUTHORIZATION,
      UNICODE_ESCAPED_AUTHORIZATION,
      URL_ESCAPED_AUTHORIZATION,
      HTML_ESCAPED_AUTHORIZATION,
      INVISIBLE_AUTHORIZATION,
      COMPATIBILITY_AUTHORIZATION,
      QUOTED_YAML_AUTHORIZATION,
      QUOTED_MARKDOWN_AUTHORIZATION,
      PASSWORD,
      QUOTED_PASSWORD,
      QUOTED_CREDENTIALS,
      SEPARATOR_PASSWORD,
      UNDERSCORE_PASSWORD,
      BENIGN_ASSIGNMENT_HEADING,
      ESCAPED_PASSWORD,
      UNICODE_ESCAPED_PASSWORD,
      UNDERSCORE_ASSIGNMENT,
      CONNECTION,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(".env.local");
    expect(serialized).not.toContain(".envrc");
  });
});
