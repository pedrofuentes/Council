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

  // ── Roadmap 6.4: confinement-aware detection (TOCTOU-safe) ────────────
  describe("confinement (Roadmap 6.4)", () => {
    it("accepts files inside the confinement root", async () => {
      await fs.writeFile(path.join(dir, "a.md"), "ok");
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
      });
      expect(result.newFiles).toHaveLength(1);
      expect(result.rejectedFiles ?? []).toHaveLength(0);
    });

    it("rejects symlinks whose target is outside the confinement root", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "council-outside-"));
      try {
        const secret = path.join(outside, "secret.md");
        await fs.writeFile(secret, "SECRET");
        try {
          await fs.symlink(secret, path.join(dir, "trap.md"));
        } catch {
          // Symlinks not permitted on this OS/account — skip.
          return;
        }
        const result = await detectDocumentChanges(dir, new Map(), [".md"], {
          confinementRoot: dir,
        });
        expect(result.newFiles.some((f) => f.filename === "trap.md")).toBe(false);
        expect((result.rejectedFiles ?? []).some((p) => p.endsWith("trap.md"))).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("does NOT read file bytes via the unconfined path (uses fd-based reads)", async () => {
      // Sanity: a regular file inside confinement still produces a checksum.
      await fs.writeFile(path.join(dir, "a.md"), "hello fd");
      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        confinementRoot: dir,
      });
      expect(result.newFiles).toHaveLength(1);
      expect(result.newFiles[0]?.checksum).toBe(sha256("hello fd"));
    });

    it("surfaces non-ENOENT readdir errors instead of silently returning empty", async () => {
      // Force a non-missing-directory error by passing a file path (ENOTDIR).
      const filePath = path.join(dir, "file.md");
      await fs.writeFile(filePath, "x");
      await expect(
        detectDocumentChanges(filePath, new Map(), [".md"], { confinementRoot: dir }),
      ).rejects.toThrow();
    });

    // ── Sentinel pr373 cycle 4: root-swap TOCTOU ─────────────────────
    it("does NOT re-resolve the confinement root when _rootIsCanonical is set", async () => {
      // Prove the frozen-root contract: when the caller asserts the
      // confinement root is already canonical, the detector must not
      // call realpath() on it again. We assert this by injecting an
      // override that THROWS for the root path — the call must still
      // succeed (because realpath is only invoked for the FILE, not
      // the root).
      await fs.writeFile(path.join(dir, "a.md"), "hi");
      const canonical = await fs.realpath(dir);
      const rootArg = dir; // may equal canonical on this OS

      const calls: string[] = [];
      const override = async (p: string): Promise<string> => {
        calls.push(p);
        // Throw if the detector re-resolves the root — this proves
        // the bug we are guarding against.
        if (p === rootArg || p === canonical) {
          throw new Error(`detector re-resolved the root: ${p}`);
        }
        return fs.realpath(p);
      };

      const result = await detectDocumentChanges(canonical, new Map(), [".md"], {
        confinementRoot: canonical,
        _rootIsCanonical: true,
        _realpathOverride: override,
      });
      expect(result.newFiles).toHaveLength(1);
      // The override should have been called for the file but never for the root.
      expect(calls.every((p) => p !== rootArg && p !== canonical)).toBe(true);
    });
  });

  // ── Sentinel #341 / #342: error surfacing & per-file resilience ─────
  describe("error surfacing (#341, #342)", () => {
    it("wraps readdir failures with a descriptive message naming the docsPath (#341)", async () => {
      // ENOTDIR (passing a regular file) is a typical misconfiguration:
      // a stray empty message is unhelpful — callers need to see WHICH
      // path failed and WHY, with a stable prefix they can recognize.
      const filePath = path.join(dir, "regular-file.md");
      await fs.writeFile(filePath, "x");
      await expect(
        detectDocumentChanges(filePath, new Map(), [".md"]),
      ).rejects.toThrow(/document scan failed/i);
      await expect(
        detectDocumentChanges(filePath, new Map(), [".md"]),
      ).rejects.toThrow(new RegExp(filePath.replace(/\\/g, "\\\\")));
    });

    it("invokes onWarning and continues when a single file's lstat fails (#342)", async () => {
      // Two normal files plus one that disappears between readdir and
      // lstat. Simulate the race by deleting after readdir entries are
      // captured but before per-file lstat runs — readdir gives us the
      // name list, then we delete the file via `unlink` BEFORE calling
      // detectDocumentChanges using a `_lstatOverride` test seam.
      await fs.writeFile(path.join(dir, "a.md"), "alpha");
      await fs.writeFile(path.join(dir, "b.md"), "bravo");
      await fs.writeFile(path.join(dir, "ghost.md"), "ghost");

      const ghostAbs = path.resolve(dir, "ghost.md");
      const realLstat = fs.lstat;
      const warnings: string[] = [];

      const result = await detectDocumentChanges(dir, new Map(), [".md"], {
        onWarning: (msg) => warnings.push(msg),
        _lstatOverride: async (p: string) => {
          if (path.resolve(p) === ghostAbs) {
            const err: NodeJS.ErrnoException = new Error(
              "ENOENT: no such file",
            );
            err.code = "ENOENT";
            throw err;
          }
          return realLstat(p);
        },
      });

      // The two healthy files were processed.
      const names = result.newFiles.map((f) => f.filename).sort();
      expect(names).toEqual(["a.md", "b.md"]);
      // Ghost file did not bring the scan down — it was skipped, and a
      // warning naming the file + error was emitted.
      expect(warnings.length).toBe(1);
      const warning = warnings[0] ?? "";
      expect(warning).toContain("ghost.md");
      expect(warning).toMatch(/lstat|stat|ENOENT/i);
    });
  });
});
