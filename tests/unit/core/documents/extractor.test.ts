/**
 * Tests for extractDocument — Roadmap 6.1.
 *
 * RED at this commit: src/core/documents/extractor.ts does not exist yet.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { extractDocument } from "../../../../src/core/documents/extractor.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("extractDocument", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-extract-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it(".txt content is returned as-is (trimmed)", async () => {
    const filePath = path.join(dir, "notes.txt");
    const raw = "  hello world\nthis is text  \n";
    await fs.writeFile(filePath, raw);
    const result = await extractDocument(filePath);
    expect(result.content).toBe("hello world\nthis is text");
    expect(result.filename).toBe("notes.txt");
    expect(result.path).toBe(filePath);
    expect(result.checksum).toBe(sha256(raw));
    expect(result.sizeBytes).toBe(Buffer.byteLength(raw, "utf-8"));
  });

  it("counts words by whitespace tokens", async () => {
    const filePath = path.join(dir, "notes.txt");
    await fs.writeFile(filePath, "one two three   four\nfive");
    const result = await extractDocument(filePath);
    expect(result.wordCount).toBe(5);
  });

  it("word count is zero for empty content", async () => {
    const filePath = path.join(dir, "empty.txt");
    await fs.writeFile(filePath, "   \n  ");
    const result = await extractDocument(filePath);
    expect(result.wordCount).toBe(0);
  });

  it(".md strips headers, bold, italic, links, images, and code fences", async () => {
    const filePath = path.join(dir, "doc.md");
    const md = [
      "# Heading One",
      "## Heading Two",
      "",
      "Some **bold** and *italic* text with a [link](https://example.com).",
      "",
      "![alt text](image.png)",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "Inline `code` here.",
    ].join("\n");
    await fs.writeFile(filePath, md);
    const result = await extractDocument(filePath);
    expect(result.content).not.toContain("#");
    expect(result.content).not.toContain("**");
    expect(result.content).not.toContain("```");
    expect(result.content).not.toContain("](");
    expect(result.content).not.toContain("![");
    expect(result.content).toContain("Heading One");
    expect(result.content).toContain("Heading Two");
    expect(result.content).toContain("bold");
    expect(result.content).toContain("italic");
    expect(result.content).toContain("link");
    expect(result.content).not.toContain("https://example.com");
    expect(result.content).not.toContain("image.png");
    expect(result.content).not.toContain("const x = 1;");
  });

  it(".html strips tags and decodes basic entities", async () => {
    const filePath = path.join(dir, "page.html");
    const html =
      "<html><body><h1>Title</h1><p>Hello &amp; goodbye, 5 &lt; 10 &gt; 3, &quot;quoted&quot;.</p></body></html>";
    await fs.writeFile(filePath, html);
    const result = await extractDocument(filePath);
    expect(result.content).not.toContain("<h1>");
    expect(result.content).not.toContain("</h1>");
    expect(result.content).not.toContain("<p>");
    expect(result.content).not.toContain("&amp;");
    expect(result.content).not.toContain("&lt;");
    expect(result.content).toContain("Title");
    expect(result.content).toContain("Hello & goodbye");
    expect(result.content).toContain("5 < 10 > 3");
    expect(result.content).toContain('"quoted"');
  });

  it("checksum matches SHA-256 of raw bytes", async () => {
    const filePath = path.join(dir, "x.md");
    const raw = "# Some heading\n\nbody text";
    await fs.writeFile(filePath, raw);
    const result = await extractDocument(filePath);
    expect(result.checksum).toBe(sha256(raw));
  });

  it("UTF-8 multi-byte characters are read correctly", async () => {
    const filePath = path.join(dir, "u.txt");
    await fs.writeFile(filePath, "café — naïve résumé");
    const result = await extractDocument(filePath);
    expect(result.content).toBe("café — naïve résumé");
    expect(result.wordCount).toBe(4);
  });

  // ──────────────────────────────────────────────────────────────────
  // fd-based confinement (Roadmap 6.4) — closes TOCTOU race where a
  // symlink could be swapped between a realpath check and the read.
  // The extractor must: open fd → verify realpath confined →
  // verify the fd's inode still matches the canonical path (no swap)
  // → read via the file handle.
  // ──────────────────────────────────────────────────────────────────

  describe("confinement (TOCTOU-safe)", () => {
    it("accepts a regular file inside confinementRoot", async () => {
      const filePath = path.join(dir, "ok.txt");
      await fs.writeFile(filePath, "inside");
      const result = await extractDocument(filePath, { confinementRoot: dir });
      expect(result.content).toBe("inside");
    });

    it("rejects a path outside confinementRoot (no symlinks involved)", async () => {
      const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-extract-other-"));
      try {
        const filePath = path.join(otherDir, "secret.txt");
        await fs.writeFile(filePath, "secret");
        await expect(
          extractDocument(filePath, { confinementRoot: dir }),
        ).rejects.toThrow(/outside|traversal|confine/i);
      } finally {
        await fs.rm(otherDir, { recursive: true, force: true });
      }
    });

    it("rejects a symlink whose target lives outside confinementRoot", async () => {
      const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-extract-other-"));
      try {
        const target = path.join(otherDir, "secret.txt");
        await fs.writeFile(target, "secret");
        const link = path.join(dir, "link.txt");
        try {
          await fs.symlink(target, link);
        } catch {
          // Symlink creation requires admin on Windows; skip the body
          // rather than fail the whole suite when unsupported.
          return;
        }
        await expect(
          extractDocument(link, { confinementRoot: dir }),
        ).rejects.toThrow(/outside|traversal|confine/i);
      } finally {
        await fs.rm(otherDir, { recursive: true, force: true });
      }
    });

    it("rejects when the canonical path's inode does not match the fd inode (post-resolve swap)", async () => {
      // Defense-in-depth: the extractor should compare fh.stat() inode/dev
      // with lstat(canonical) and reject on mismatch. We exercise it with
      // an injected `_realpathOverride` (test-only seam) so we can simulate
      // a post-realpath swap without racing the filesystem.
      const inside = path.join(dir, "real.txt");
      const decoy = path.join(dir, "decoy.txt");
      await fs.writeFile(inside, "real-content");
      await fs.writeFile(decoy, "decoy-content");

      // The override pretends realpath(inside) === decoy: open() will still
      // bind to inside's inode, but the integrity check (lstat on the
      // returned canonical) will see decoy's inode → mismatch → reject.
      await expect(
        extractDocument(inside, {
          confinementRoot: dir,
          _realpathOverride: async (p: string) => {
            if (path.resolve(p) === path.resolve(inside)) return decoy;
            return fs.realpath(p);
          },
        }),
      ).rejects.toThrow(/TOCTOU|mismatch|changed/i);
    });

    it("rejects a directory passed as filePath", async () => {
      const sub = path.join(dir, "subdir");
      await fs.mkdir(sub);
      await expect(
        extractDocument(sub, { confinementRoot: dir }),
      ).rejects.toThrow(/regular file|not a file/i);
    });

    it("works without confinementRoot (back-compat)", async () => {
      const filePath = path.join(dir, "compat.txt");
      await fs.writeFile(filePath, "still works");
      const result = await extractDocument(filePath);
      expect(result.content).toBe("still works");
    });

    // ── Sentinel pr373 cycle 4: root-swap TOCTOU ─────────────────────
    it("does NOT re-resolve the confinement root when _rootIsCanonical is set", async () => {
      const canonical = await fs.realpath(dir);
      const filePath = path.join(canonical, "frozen.md");
      await fs.writeFile(filePath, "frozen body");

      const calls: string[] = [];
      const override = async (p: string): Promise<string> => {
        calls.push(p);
        if (p === canonical) {
          throw new Error(`extractor re-resolved the root: ${p}`);
        }
        return fs.realpath(p);
      };

      const result = await extractDocument(filePath, {
        confinementRoot: canonical,
        _rootIsCanonical: true,
        _realpathOverride: override,
      });
      expect(result.content).toBe("frozen body");
      expect(calls.every((p) => p !== canonical)).toBe(true);
    });
  });

  // Issue #376: mtime must come from the bound file handle (already
  // obtained via fh.stat in the TOCTOU-safe sequence), not a separate
  // post-extraction fs.stat() call. A separate stat opens a TOCTOU
  // window where the mtime stored on the document record may not
  // correspond to the content that was actually extracted.
  describe("modifiedAt (issue #376)", () => {
    it("returns modifiedAt from the file handle so it is bound to the same inode that was read", async () => {
      const filePath = path.join(dir, "doc.txt");
      await fs.writeFile(filePath, "first body");
      const beforeStat = await fs.stat(filePath);
      const result = await extractDocument(filePath);
      expect(result.content).toBe("first body");
      // modifiedAt is an ISO-8601 string equal to the fd's mtime at the
      // moment of extraction (which is the file's mtime at that point —
      // tested via the host stat captured immediately before).
      expect(typeof result.modifiedAt).toBe("string");
      expect(result.modifiedAt).toBe(beforeStat.mtime.toISOString());
    });

    it("modifiedAt corresponds to the bytes actually read, not a later mutation", async () => {
      const filePath = path.join(dir, "doc.txt");
      await fs.writeFile(filePath, "first body");
      const fdStatBefore = await fs.stat(filePath);

      // Override realpath to mutate the file's mtime AFTER the extractor
      // has opened the fd but BEFORE any internal post-open stat would
      // run. With a fd-bound stat, modifiedAt must equal the pre-mutation
      // value because the handle's inode mtime is what we report.
      const realpath = fs.realpath;
      const override = async (p: string): Promise<string> => {
        const futureTime = new Date(fdStatBefore.mtime.getTime() + 60_000);
        await fs.utimes(filePath, futureTime, futureTime);
        return realpath(p);
      };

      // With post-read consistency checking, the extractor detects the
      // mid-extraction mutation and refuses to return torn content.
      await expect(
        extractDocument(filePath, { _realpathOverride: override }),
      ).rejects.toThrow(/modified during read/i);
    });

    it("rejects torn reads when file content changes during extraction", async () => {
      const filePath = path.join(dir, "doc.txt");
      await fs.writeFile(filePath, "v1 body");
      // Inject a mutation between the post-open stat and readFile by
      // hooking realpath (called after the initial stat). This bumps
      // mtime; the post-read stat will detect the mismatch and throw.
      const realpath = fs.realpath;
      const override = async (p: string): Promise<string> => {
        await fs.writeFile(filePath, "v2 body has more bytes");
        return realpath(p);
      };
      await expect(
        extractDocument(filePath, { _realpathOverride: override }),
      ).rejects.toThrow(/modified during read|inode changed/i);
    });
  });
});
