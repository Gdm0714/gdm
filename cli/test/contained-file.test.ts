import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContainedFile } from "../src/contained-file.ts";

describe("contained file boundary", () => {
  test("reads and hashes a regular file inside the repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-contained-"));
    mkdirSync(join(cwd, "evidence"));
    writeFileSync(join(cwd, "evidence", "result.txt"), "verified\n");
    const result = readContainedFile(cwd, "evidence/result.txt", "observed");
    expect(result.path).toBe("evidence/result.txt");
    expect(result.content).toBe("verified\n");
    expect(Buffer.from(result.bytes).toString("utf8")).toBe("verified\n");
    expect(result.bytesBase64).toBe(Buffer.from("verified\n").toString("base64"));
    expect(result.sha256).toHaveLength(64);
  });

  test("rejects absolute, traversal, symlink, missing, and directory inputs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-contained-reject-"));
    writeFileSync(join(cwd, "target.txt"), "target\n");
    symlinkSync(join(cwd, "target.txt"), join(cwd, "link.txt"));
    mkdirSync(join(cwd, "directory"));
    for (const value of ["/etc/hosts", "../escape", "link.txt", "missing.txt", "directory"]) {
      expect(() => readContainedFile(cwd, value, "observed")).toThrow();
    }
  });

  test("enforces an optional byte cap before returning file content", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gdm-contained-cap-"));
    writeFileSync(join(cwd, "large.txt"), "123456");
    expect(() => readContainedFile(cwd, "large.txt", "artifact", {
      maxBytes: 5,
      tooLargeCode: "artifact_too_large",
    })).toThrow(expect.objectContaining({ code: "artifact_too_large" }));
    expect(readContainedFile(cwd, "large.txt", "artifact", { maxBytes: 6 }).content).toBe("123456");
  });
});
