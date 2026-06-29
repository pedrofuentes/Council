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
import type {
  AiFallbackContent,
  AiFallbackLogger,
} from "../../../../src/core/documents/extractors/ai-fallback.js";

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

  it(".html strips <script> and <style> blocks including their inner content (issue #344)", async () => {
    // Issue #344: the extractor must not leak the bodies of <script> and
    // <style> tags into the indexed text — those are program code, not
    // prose, and would pollute the persona profile / FTS index with
    // tokens like `function`, `var`, hex color codes, etc.
    const filePath = path.join(dir, "page-with-script.html");
    const html = [
      "<html><head>",
      "<style>.hidden-css-token{color:#ff00aa;font-family:Inter}</style>",
      "</head><body>",
      "<h1>Visible Heading</h1>",
      "<script>var SECRET_SCRIPT_TOKEN = 'do-not-index'; function leak(){return SECRET_SCRIPT_TOKEN;}</script>",
      "<p>Visible body paragraph.</p>",
      "<script type=\"application/json\">{\"another\":\"SECRET_JSON_TOKEN\"}</script>",
      "</body></html>",
    ].join("\n");
    await fs.writeFile(filePath, html);
    const result = await extractDocument(filePath);

    // Visible prose survives.
    expect(result.content).toContain("Visible Heading");
    expect(result.content).toContain("Visible body paragraph");

    // Script + style bodies are gone (both opening tags AND inner content).
    expect(result.content).not.toMatch(/<script/i);
    expect(result.content).not.toMatch(/<\/script>/i);
    expect(result.content).not.toMatch(/<style/i);
    expect(result.content).not.toMatch(/<\/style>/i);
    expect(result.content).not.toContain("SECRET_SCRIPT_TOKEN");
    expect(result.content).not.toContain("SECRET_JSON_TOKEN");
    expect(result.content).not.toContain("hidden-css-token");
    expect(result.content).not.toContain("#ff00aa");
    expect(result.content).not.toContain("font-family");
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

    // Issue #522: regression test for the fourth torn-read condition
    // (buf.byteLength !== fdStat.size) — kernel returns fewer bytes than
    // the pre-read stat reported (short read), even though the pre/post
    // stat agree. This catches races with truncations/extensions during
    // the read itself, distinct from mtime/ctime changes.
    it("rejects short reads where buf.byteLength < fdStat.size (issue #522)", async () => {
      const filePath = path.join(dir, "doc.txt");
      await fs.writeFile(filePath, "full content here");
      // Simulate kernel returning fewer bytes than stat says file has.
      await expect(
        extractDocument(filePath, {
          _readFileOverride: async (_fh: fs.FileHandle) => {
            // Stat says 17 bytes ("full content here"), but we return only 4.
            const truncated = Buffer.from("full", "utf-8");
            return truncated;
          },
        }),
      ).rejects.toThrow(/modified during read|torn content/i);
    });

    // Issue #444: a (size, mtime)-only token can be evaded by a same-size
    // rewrite whose mtime is restored via utimes() after the write. ctime
    // updates on every inode metadata change (including utimes), so the
    // post-read stat must compare ctime as well to close that window.
    //
    // Timing note: the test needs a gap between the initial utimes (which
    // sets ctime to T1) and the extractor's fdStat capture, AND between
    // fdStat and the override's writeFile+utimes (which bumps ctime to
    // T2). Without these gaps, on fast systems or under parallel execution,
    // T1 and T2 can land in the same filesystem timestamp tick, making
    // postStat.ctimeMs === fdStat.ctimeMs and the guard ineffective.
    it("rejects same-size rewrites whose mtime is restored after the write (issue #444)", async () => {
      const filePath = path.join(dir, "doc.txt");
      await fs.writeFile(filePath, "AAAAAAA"); // 7 bytes
      // Pin atime/mtime to a fixed second-precision instant so the
      // attacker's restoring utimes() can reproduce the exact same
      // mtimeMs value (no sub-millisecond drift to mask the attack).
      const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
      await fs.utimes(filePath, pinned, pinned);

      // Ensure at least one filesystem timestamp tick elapses between
      // the setup utimes (which sets ctime) and the extractor's fdStat.
      // On Windows NTFS under parallel I/O or in git worktrees, the OS
      // may batch-flush metadata updates, so a generous gap (50ms)
      // guarantees the next ctime-bumping operation produces a distinct
      // value from fdStat.ctimeMs.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Inject mid-extraction mutation: overwrite with same-size payload,
      // then restore the original (pinned) mtime/atime via utimes — which
      // bumps ctime, the only field a (size, mtime) token misses.
      const realpath = fs.realpath;
      const override = async (p: string): Promise<string> => {
        // Ensure ctime advances past the tick captured by fdStat.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await fs.writeFile(filePath, "BBBBBBB"); // same length, different bytes
        await fs.utimes(filePath, pinned, pinned);
        return realpath(p);
      };

      await expect(
        extractDocument(filePath, { _realpathOverride: override }),
      ).rejects.toThrow(/modified during read|inode changed/i);
    });
  });

  // T3: extractDocument now delegates content normalization to the
  // extractor registry. The TOCTOU-safe read sequence stays in
  // extractor.ts; format dispatch lives in extractors/*.
  describe("registry dispatch (T3)", () => {
    it("rejects files larger than maxFileSizeBytes with oversize-file", async () => {
      const filePath = path.join(dir, "big.txt");
      await fs.writeFile(filePath, "a".repeat(200));
      const errors = await import(
        "../../../../src/core/documents/extractors/errors.js"
      );
      let caught: unknown;
      try {
        await extractDocument(filePath, { maxFileSizeBytes: 100 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(errors.ExtractionError);
      const e = caught as InstanceType<typeof errors.ExtractionError>;
      expect(e.kind).toBe("oversize-file");
    });

    it("accepts files at or below maxFileSizeBytes", async () => {
      const filePath = path.join(dir, "small.txt");
      await fs.writeFile(filePath, "hello");
      const result = await extractDocument(filePath, {
        maxFileSizeBytes: 1024,
      });
      expect(result.content).toBe("hello");
    });

    it("throws unsupported-format for unknown extensions", async () => {
      const filePath = path.join(dir, "weird.xyz");
      await fs.writeFile(filePath, "some content");
      const errors = await import(
        "../../../../src/core/documents/extractors/errors.js"
      );
      let caught: unknown;
      try {
        await extractDocument(filePath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(errors.ExtractionError);
      const e = caught as InstanceType<typeof errors.ExtractionError>;
      expect(e.kind).toBe("unsupported-format");
    });

    it("falls back to magic-byte detection when extension is unknown but bytes match a known signature", async () => {
      // T6 registers a PDF extractor. A %PDF buffer with an unknown
      // extension (.bin) should be detected via magic bytes and
      // dispatched to the PDF extractor — which rejects the fake body
      // as corrupt (not unsupported-format, because the format IS
      // supported now).
      const filePath = path.join(dir, "mystery.bin");
      await fs.writeFile(filePath, "%PDF-1.7\nfake pdf body");
      const errors = await import(
        "../../../../src/core/documents/extractors/errors.js"
      );
      let caught: unknown;
      try {
        await extractDocument(filePath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(errors.ExtractionError);
      const e = caught as InstanceType<typeof errors.ExtractionError>;
      expect(e.kind).toBe("corrupt-document");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // T-AIWIRE: the AI fallback is reachable ONLY at the unsupported-format
  // boundary — after every TOCTOU / confinement / torn-read guard above
  // has passed and ONLY when resolveExtractor finds no native extractor.
  // ──────────────────────────────────────────────────────────────────
  describe("AI fallback wiring (T-AIWIRE)", () => {
    // Write a file with an unsupported extension and innocuous text body so
    // neither extension lookup nor magic-byte detection resolves an
    // extractor — i.e. resolveExtractor fails and the AI-fallback decision
    // point is reached.
    async function writeUnsupported(name: string, body: string): Promise<string> {
      const filePath = path.join(dir, name);
      await fs.writeFile(filePath, body);
      return filePath;
    }

    it("throws unsupported-format when aiFallback mode is 'off' (unchanged)", async () => {
      const filePath = await writeUnsupported("off.xyz", "plain content");
      const errors = await import("../../../../src/core/documents/extractors/errors.js");
      let caught: unknown;
      try {
        await extractDocument(filePath, {
          aiFallback: { mode: "off", allowedExtensions: [] },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(errors.ExtractionError);
      const e = caught as InstanceType<typeof errors.ExtractionError>;
      expect(e.kind).toBe("unsupported-format");
    });

    it("throws unsupported-format when aiFallback is absent (default unchanged)", async () => {
      const filePath = await writeUnsupported("absent.xyz", "plain content");
      await expect(extractDocument(filePath)).rejects.toMatchObject({
        kind: "unsupported-format",
      });
    });

    it("auto mode returns AI-fallback content for an unsupported extension", async () => {
      const body = "totally proprietary format body";
      const filePath = await writeUnsupported("report.xyz", body);
      const result = await extractDocument(filePath, {
        aiFallback: { mode: "auto", allowedExtensions: [] },
      });
      // Marked distinctly as an AI-fallback result, not a native extraction.
      expect(result.metadata?.aiFallback).toBe(true);
      expect(result.metadata?.askUser).toBeUndefined();
      expect(typeof result.metadata?.detectedFormat).toBe("string");
      expect(result.content).toContain("report.xyz");
      expect(result.wordCount).toBeGreaterThan(0);
      // checksum / size / modifiedAt stay bound to the actually-read bytes.
      expect(result.checksum).toBe(sha256(body));
      expect(result.sizeBytes).toBe(Buffer.byteLength(body, "utf-8"));
      expect(result.filename).toBe("report.xyz");
      expect(typeof result.modifiedAt).toBe("string");
    });

    it("auto mode STILL throws unsupported-format for a blocklisted extension (.exe)", async () => {
      // The blocklist inside attemptAiFallback ALWAYS wins, even when the
      // extension is explicitly allow-listed.
      const filePath = await writeUnsupported("malware.exe", "not really an exe");
      const errors = await import("../../../../src/core/documents/extractors/errors.js");
      let caught: unknown;
      try {
        await extractDocument(filePath, {
          aiFallback: { mode: "auto", allowedExtensions: [".exe"] },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(errors.ExtractionError);
      const e = caught as InstanceType<typeof errors.ExtractionError>;
      expect(e.kind).toBe("unsupported-format");
    });

    it("auto mode throws unsupported-format when a non-empty allowlist excludes the extension", async () => {
      const filePath = await writeUnsupported("data.xyz", "content");
      await expect(
        extractDocument(filePath, {
          aiFallback: { mode: "auto", allowedExtensions: [".abc", ".def"] },
        }),
      ).rejects.toMatchObject({ kind: "unsupported-format" });
    });

    it("auto mode returns content when a non-empty allowlist includes the extension", async () => {
      const filePath = await writeUnsupported("ok.xyz", "content here");
      const result = await extractDocument(filePath, {
        aiFallback: { mode: "auto", allowedExtensions: [".xyz"] },
      });
      expect(result.metadata?.aiFallback).toBe(true);
    });

    it("ask mode surfaces a DISTINCT review-required outcome (askUser), never plain indexed content", async () => {
      const filePath = await writeUnsupported("review.xyz", "needs review body");
      const result = await extractDocument(filePath, {
        aiFallback: { mode: "ask", allowedExtensions: [] },
      });
      // Distinct from a native extraction: the aiFallback marker is set.
      expect(result.metadata?.aiFallback).toBe(true);
      // Distinct from a hard failure: it RESOLVED — but askUser=true means
      // callers must obtain confirmation before indexing it as real content.
      expect(result.metadata?.askUser).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    });

    it("does NOT invoke the AI fallback when a native extractor handles the file", async () => {
      const filePath = path.join(dir, "native.txt");
      await fs.writeFile(filePath, "hello native");
      const result = await extractDocument(filePath, {
        aiFallback: { mode: "auto", allowedExtensions: [] },
      });
      expect(result.content).toBe("hello native");
      expect(result.metadata?.aiFallback).toBeUndefined();
    });

    it("passes the injected cache through to the fallback (cache hit returns cached content)", async () => {
      const body = "cacheable body";
      const filePath = await writeUnsupported("cached.xyz", body);
      const sentinel: AiFallbackContent = {
        content: "PRECOMPUTED-FALLBACK-DESCRIPTION",
        wordCount: 2,
        metadata: {
          detectedFormat: "precomputed format",
          suggestedAction: "convert it",
          mode: "auto",
        },
      };
      const cache = new Map<string, AiFallbackContent>([[sha256(body), sentinel]]);
      const result = await extractDocument(filePath, {
        aiFallback: { mode: "auto", allowedExtensions: [], cache },
      });
      expect(result.content).toBe("PRECOMPUTED-FALLBACK-DESCRIPTION");
      expect(result.metadata?.aiFallback).toBe(true);
      expect(result.metadata?.detectedFormat).toBe("precomputed format");
    });

    it("passes the injected logger through to the fallback", async () => {
      const filePath = await writeUnsupported("logged.xyz", "log me");
      const messages: string[] = [];
      const logger: AiFallbackLogger = {
        info: (m: string): void => {
          messages.push(m);
        },
        warn: (m: string): void => {
          messages.push(m);
        },
      };
      await extractDocument(filePath, {
        aiFallback: { mode: "auto", allowedExtensions: [], logger },
      });
      expect(messages.some((m) => m.includes("ai-fallback"))).toBe(true);
    });
  });

  // #649: the `_realpathOverride` / `_readFileOverride` seams bypass TOCTOU
  // and torn-read guarantees. They must take effect ONLY under test
  // (NODE_ENV === "test") so a production caller cannot pass them to defeat
  // the security sequence. Vitest sets NODE_ENV="test", so the seam works
  // in-suite; flipping NODE_ENV to "production" must make the extractor fall
  // back to the real fs path and ignore the override entirely.
  describe("test-only override gating (#649)", () => {
    const originalEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it("honors _realpathOverride when NODE_ENV='test'", async () => {
      process.env.NODE_ENV = "test";
      const inside = path.join(dir, "real.txt");
      const decoy = path.join(dir, "decoy.txt");
      await fs.writeFile(inside, "real-content");
      await fs.writeFile(decoy, "decoy-content");
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

    it("ignores _realpathOverride in production (real fs path taken)", async () => {
      process.env.NODE_ENV = "production";
      const inside = path.join(dir, "real.txt");
      const decoy = path.join(dir, "decoy.txt");
      await fs.writeFile(inside, "real-content");
      await fs.writeFile(decoy, "decoy-content");
      // If the override were honored it would fake a post-resolve swap and
      // throw TOCTOU; gated off, the real realpath resolves inside → success.
      const result = await extractDocument(inside, {
        confinementRoot: dir,
        _realpathOverride: async (p: string) => {
          if (path.resolve(p) === path.resolve(inside)) return decoy;
          return fs.realpath(p);
        },
      });
      expect(result.content).toBe("real-content");
    });

    it("ignores _readFileOverride in production (real read taken)", async () => {
      process.env.NODE_ENV = "production";
      const filePath = path.join(dir, "doc.txt");
      await fs.writeFile(filePath, "full content here");
      // A honored short-read override would trip torn-read detection; gated
      // off, the real fh.readFile() returns the full bytes → success.
      const result = await extractDocument(filePath, {
        _readFileOverride: async (_fh: fs.FileHandle) => Buffer.from("full", "utf-8"),
      });
      expect(result.content).toBe("full content here");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // #932: resolveExtractor must only swallow unsupported-format; a real
  // loader failure (dynamic import / init error) must propagate, not be
  // masked as a misleading unsupported-format.
  // ──────────────────────────────────────────────────────────────────
  describe("loader-failure propagation (#932)", () => {
    it("propagates a non-ExtractionError loader failure instead of returning null", async () => {
      const reg = await import("../../../../src/core/documents/extractors/index.js");
      const boom = new Error("loader exploded");
      reg.registerExtractor([".loadfail932"], async () => {
        throw boom;
      });
      const filePath = path.join(dir, "broken.loadfail932");
      await fs.writeFile(filePath, "plain text body, no magic bytes");

      let caught: unknown;
      try {
        await extractDocument(filePath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(boom);
      expect((caught as Error).message).toBe("loader exploded");
    });
  });
});
