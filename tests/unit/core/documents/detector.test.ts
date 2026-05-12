/**
 * Tests for detectDocumentChanges — Roadmap 6.1.
 *
 * RED at this commit: src/core/documents/detector.ts does not exist yet.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { detectDocumentChanges } from "../../../../src/core/documents/detector.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("detectDocumentChanges", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-detect-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("classifies all files as new when knownChecksums is empty", async () => {
    await fs.writeFile(path.join(dir, "a.md"), "# A");
    await fs.writeFile(path.join(dir, "b.txt"), "hello");
    const result = await detectDocumentChanges(dir, new Map(), [".md", ".txt", ".html"]);
    expect(result.newFiles).toHaveLength(2);
    expect(result.modifiedFiles).toHaveLength(0);
    expect(result.unchangedFiles).toHaveLength(0);
    expect(result.unsupportedFiles).toHaveLength(0);
    const filenames = result.newFiles.map((f) => f.filename).sort();
    expect(filenames).toEqual(["a.md", "b.txt"]);
  });

  it("classifies file as unchanged when checksum matches", async () => {
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "# Hello world");
    const known = new Map<string, string>([[filePath, sha256("# Hello world")]]);
    const result = await detectDocumentChanges(dir, known, [".md"]);
    expect(result.unchangedFiles).toHaveLength(1);
    expect(result.newFiles).toHaveLength(0);
    expect(result.modifiedFiles).toHaveLength(0);
    expect(result.unchangedFiles[0]?.checksum).toBe(sha256("# Hello world"));
  });

  it("classifies file as modified when checksum differs", async () => {
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "new content");
    const known = new Map<string, string>([[filePath, sha256("old content")]]);
    const result = await detectDocumentChanges(dir, known, [".md"]);
    expect(result.modifiedFiles).toHaveLength(1);
    expect(result.newFiles).toHaveLength(0);
    expect(result.unchangedFiles).toHaveLength(0);
    expect(result.modifiedFiles[0]?.checksum).toBe(sha256("new content"));
  });

  it("filters out unsupported formats and reports them separately", async () => {
    await fs.writeFile(path.join(dir, "a.md"), "x");
    await fs.writeFile(path.join(dir, "b.pdf"), "x");
    await fs.writeFile(path.join(dir, "c.docx"), "x");
    const result = await detectDocumentChanges(dir, new Map(), [".md", ".txt", ".html"]);
    expect(result.newFiles.map((f) => f.filename)).toEqual(["a.md"]);
    expect(result.unsupportedFiles).toHaveLength(2);
    expect(result.unsupportedFiles.some((p) => p.endsWith("b.pdf"))).toBe(true);
    expect(result.unsupportedFiles.some((p) => p.endsWith("c.docx"))).toBe(true);
  });

  it("matches extensions case-insensitively", async () => {
    await fs.writeFile(path.join(dir, "A.MD"), "x");
    await fs.writeFile(path.join(dir, "B.HtMl"), "x");
    const result = await detectDocumentChanges(dir, new Map(), [".md", ".html"]);
    expect(result.newFiles).toHaveLength(2);
    expect(result.unsupportedFiles).toHaveLength(0);
  });

  it("recurses into subdirectories", async () => {
    await fs.mkdir(path.join(dir, "nested", "deep"), { recursive: true });
    await fs.writeFile(path.join(dir, "top.md"), "t");
    await fs.writeFile(path.join(dir, "nested", "mid.md"), "m");
    await fs.writeFile(path.join(dir, "nested", "deep", "bottom.md"), "b");
    const result = await detectDocumentChanges(dir, new Map(), [".md"]);
    expect(result.newFiles).toHaveLength(3);
    const filenames = result.newFiles.map((f) => f.filename).sort();
    expect(filenames).toEqual(["bottom.md", "mid.md", "top.md"]);
  });

  it("returns absolute paths and ISO modifiedAt timestamps", async () => {
    const filePath = path.join(dir, "a.md");
    await fs.writeFile(filePath, "hello");
    const result = await detectDocumentChanges(dir, new Map(), [".md"]);
    const f = result.newFiles[0];
    if (!f) throw new Error("expected at least one new file");
    expect(path.isAbsolute(f.path)).toBe(true);
    expect(f.sizeBytes).toBe(5);
    expect(f.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns empty result for non-existent directory", async () => {
    const missing = path.join(dir, "does-not-exist");
    const result = await detectDocumentChanges(missing, new Map(), [".md"]);
    expect(result.newFiles).toHaveLength(0);
    expect(result.modifiedFiles).toHaveLength(0);
    expect(result.unchangedFiles).toHaveLength(0);
    expect(result.unsupportedFiles).toHaveLength(0);
  });
});
