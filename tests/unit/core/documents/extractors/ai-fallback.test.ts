/**
 * Tests for the AI-fallback extractor module (T15).
 *
 * The AI fallback is invoked as a last-resort when no native extractor
 * is registered for a file's extension. It is gated behind the
 * `documents.aiExtraction` configuration setting. This module does NOT
 * call any AI API directly — importing `@github/copilot-sdk` is
 * forbidden outside `engine/copilot/adapter.ts`. Instead, the fallback
 * produces a structured description of the file (extension, size,
 * magic-byte signature) so the caller can route it to an AI surface or
 * surface a friendly error to the user.
 *
 * RED at this commit: src/core/documents/extractors/ai-fallback.ts does
 * not exist yet.
 */
import { describe, expect, it } from "vitest";

import {
  attemptAiFallback,
  type AiFallbackConfig,
  type AiFallbackContent,
  type AiFallbackLogger,
} from "../../../../../src/core/documents/extractors/ai-fallback.js";
import type { ExtractionContext } from "../../../../../src/core/documents/extractors/types.js";

function makeCtx(buffer: Buffer, extension = ".xyz"): ExtractionContext {
  return {
    buffer,
    filename: `mystery${extension}`,
    extension,
    sizeBytes: buffer.byteLength,
  };
}

function captureLogger(): { logger: AiFallbackLogger; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    logger: {
      info: (m: string): void => {
        messages.push(`info:${m}`);
      },
      warn: (m: string): void => {
        messages.push(`warn:${m}`);
      },
    },
  };
}

const AUTO_ANY: AiFallbackConfig = { mode: "auto", allowedExtensions: [] };
const ASK_ANY: AiFallbackConfig = { mode: "ask", allowedExtensions: [] };
const OFF: AiFallbackConfig = { mode: "off", allowedExtensions: [] };

describe("attemptAiFallback — mode gating", () => {
  it("returns null when mode is 'off'", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data")), OFF);
    expect(result).toBeNull();
  });

  it("returns content when mode is 'auto' and extension is eligible", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data")), AUTO_ANY);
    expect(result).not.toBeNull();
    expect(result?.metadata.mode).toBe("auto");
  });

  it("returns content with askUser=true when mode is 'ask'", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data")), ASK_ANY);
    expect(result).not.toBeNull();
    expect(result?.metadata.askUser).toBe(true);
    expect(result?.metadata.mode).toBe("ask");
  });

  it("does not set askUser flag when mode is 'auto'", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data")), AUTO_ANY);
    expect(result?.metadata.askUser).toBeUndefined();
  });
});

describe("attemptAiFallback — extension blocklist", () => {
  const blocklisted: readonly string[] = [
    // executables
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".bin",
    ".com",
    ".bat",
    ".cmd",
    ".sh",
    ".ps1",
    // archives already handled
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    ".rar",
    // media
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".svg",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
    ".wav",
    // databases
    ".db",
    ".sqlite",
    ".sqlite3",
  ];

  for (const ext of blocklisted) {
    it(`returns null for blocklisted extension '${ext}' even in auto mode`, async () => {
      const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ext), AUTO_ANY);
      expect(result).toBeNull();
    });
  }

  it("normalizes extension casing in blocklist check (rejects '.EXE')", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".EXE"), AUTO_ANY);
    expect(result).toBeNull();
  });

  it("blocklist also rejects in ask mode", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".exe"), ASK_ANY);
    expect(result).toBeNull();
  });
});

describe("attemptAiFallback — allowedExtensions whitelist", () => {
  it("returns null when allowedExtensions is non-empty and extension is not listed", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".xyz"), {
      mode: "auto",
      allowedExtensions: [".abc"],
    });
    expect(result).toBeNull();
  });

  it("attempts extraction when extension is listed in allowedExtensions", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".xyz"), {
      mode: "auto",
      allowedExtensions: [".xyz", ".abc"],
    });
    expect(result).not.toBeNull();
  });

  it("normalizes casing in allowedExtensions matching", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".XYZ"), {
      mode: "auto",
      allowedExtensions: [".xyz"],
    });
    expect(result).not.toBeNull();
  });

  it("treats empty allowedExtensions as 'all non-blocklisted are eligible'", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".somewildext"), {
      mode: "auto",
      allowedExtensions: [],
    });
    expect(result).not.toBeNull();
  });

  it("blocklist takes precedence over allowedExtensions", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".exe"), {
      mode: "auto",
      allowedExtensions: [".exe"],
    });
    expect(result).toBeNull();
  });
});

describe("attemptAiFallback — result structure", () => {
  it("returns ExtractedContent shape with content, wordCount, metadata", async () => {
    const result = await attemptAiFallback(
      makeCtx(Buffer.from("hello world bytes"), ".xyz"),
      AUTO_ANY,
    );
    expect(result).not.toBeNull();
    expect(typeof result?.content).toBe("string");
    expect(result?.content.length).toBeGreaterThan(0);
    expect(typeof result?.wordCount).toBe("number");
    expect(result?.wordCount).toBeGreaterThan(0);
    expect(result?.metadata).toBeDefined();
  });

  it("metadata includes detectedFormat and suggestedAction", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".xyz"), AUTO_ANY);
    expect(typeof result?.metadata.detectedFormat).toBe("string");
    expect(result?.metadata.detectedFormat.length).toBeGreaterThan(0);
    expect(typeof result?.metadata.suggestedAction).toBe("string");
    expect(result?.metadata.suggestedAction.length).toBeGreaterThan(0);
  });

  it("describes the file (filename, size, extension) in content text", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("hello"), ".xyz"), AUTO_ANY);
    expect(result?.content).toContain("mystery.xyz");
    expect(result?.content).toContain(".xyz");
    expect(result?.content).toContain("5");
  });

  it("includes a magic-byte signature in the content description", async () => {
    // Include a few recognizable bytes the user would see in the signature.
    const result = await attemptAiFallback(
      makeCtx(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]), ".xyz"),
      AUTO_ANY,
    );
    expect(result?.content.toLowerCase()).toContain("de");
    expect(result?.content.toLowerCase()).toContain("ad");
    expect(result?.content.toLowerCase()).toContain("be");
    expect(result?.content.toLowerCase()).toContain("ef");
  });

  it("identifies known generic format signatures (PNG by magic bytes)", async () => {
    // Even though .png is blocklisted, a file with extension .xyz that
    // starts with PNG magic bytes should have its detected format hint
    // surfaced. (The blocklist would still bar .png by extension; here
    // we test that detection is independent of the extension match.)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await attemptAiFallback(makeCtx(png, ".xyz"), AUTO_ANY);
    expect(result?.metadata.detectedFormat.toLowerCase()).toMatch(/png|image/);
  });

  it("returns wordCount counting whitespace-separated tokens in content", async () => {
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".xyz"), AUTO_ANY);
    expect(result).not.toBeNull();
    const content = result?.content ?? "";
    const expected = content.split(/\s+/).filter((t) => t.length > 0).length;
    expect(result?.wordCount).toBe(expected);
  });
});

describe("attemptAiFallback — caching", () => {
  it("caches results by SHA-256 of buffer content (returns same reference)", async () => {
    const cache = new Map<string, AiFallbackContent>();
    const ctx1 = makeCtx(Buffer.from("hello world"), ".xyz");
    const first = await attemptAiFallback(ctx1, AUTO_ANY, { cache });
    expect(first).not.toBeNull();
    expect(cache.size).toBe(1);

    const ctx2 = makeCtx(Buffer.from("hello world"), ".xyz");
    const second = await attemptAiFallback(ctx2, AUTO_ANY, { cache });
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it("does not cross-pollinate cache across different buffer contents", async () => {
    const cache = new Map<string, AiFallbackContent>();
    const a = await attemptAiFallback(makeCtx(Buffer.from("aaa"), ".xyz"), AUTO_ANY, { cache });
    const b = await attemptAiFallback(makeCtx(Buffer.from("bbb"), ".xyz"), AUTO_ANY, { cache });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(cache.size).toBe(2);
  });

  it("does not consult the cache when cache is not provided", async () => {
    const ctx1 = makeCtx(Buffer.from("hello"), ".xyz");
    const a = await attemptAiFallback(ctx1, AUTO_ANY);
    const b = await attemptAiFallback(ctx1, AUTO_ANY);
    expect(a).not.toBe(b);
    // Equivalent in shape, distinct in identity (no cache wired).
    expect(a?.content).toBe(b?.content);
  });

  it("does not write to cache when result is null (skipped)", async () => {
    const cache = new Map<string, AiFallbackContent>();
    const result = await attemptAiFallback(makeCtx(Buffer.from("data"), ".exe"), AUTO_ANY, {
      cache,
    });
    expect(result).toBeNull();
    expect(cache.size).toBe(0);
  });
});

describe("attemptAiFallback — audit logging", () => {
  it("logs a 'skipped' entry when mode is off", async () => {
    const { logger, messages } = captureLogger();
    await attemptAiFallback(makeCtx(Buffer.from("data")), OFF, { logger });
    expect(messages.some((m) => /off/.test(m) && /skip/i.test(m))).toBe(true);
  });

  it("logs a 'skipped' entry when extension is blocklisted", async () => {
    const { logger, messages } = captureLogger();
    await attemptAiFallback(makeCtx(Buffer.from("data"), ".exe"), AUTO_ANY, { logger });
    expect(messages.some((m) => /blocklist/i.test(m))).toBe(true);
  });

  it("logs a 'skipped' entry when extension is not in allowlist", async () => {
    const { logger, messages } = captureLogger();
    await attemptAiFallback(
      makeCtx(Buffer.from("data"), ".xyz"),
      { mode: "auto", allowedExtensions: [".abc"] },
      { logger },
    );
    expect(messages.some((m) => /allow/i.test(m) || /whitelist/i.test(m))).toBe(true);
  });

  it("logs a 'succeeded' entry when content is produced in auto mode", async () => {
    const { logger, messages } = captureLogger();
    await attemptAiFallback(makeCtx(Buffer.from("data"), ".xyz"), AUTO_ANY, { logger });
    expect(messages.some((m) => /succeed|extract|complete/i.test(m))).toBe(true);
  });

  it("logs an 'ask-user' entry when mode is ask", async () => {
    const { logger, messages } = captureLogger();
    await attemptAiFallback(makeCtx(Buffer.from("data"), ".xyz"), ASK_ANY, { logger });
    expect(messages.some((m) => /ask/i.test(m))).toBe(true);
  });

  it("never includes raw buffer content in logs (security)", async () => {
    const secret = "SECRET_PASSWORD_DO_NOT_LOG_xyz123";
    const { logger, messages } = captureLogger();
    await attemptAiFallback(makeCtx(Buffer.from(secret), ".xyz"), AUTO_ANY, { logger });
    for (const m of messages) {
      expect(m).not.toContain(secret);
    }
  });

  it("logs cache-hit entry on second call with same content", async () => {
    const cache = new Map<string, AiFallbackContent>();
    const { logger, messages } = captureLogger();
    const c = makeCtx(Buffer.from("repeat"), ".xyz");
    await attemptAiFallback(c, AUTO_ANY, { cache, logger });
    messages.length = 0;
    await attemptAiFallback(c, AUTO_ANY, { cache, logger });
    expect(messages.some((m) => /cache/i.test(m))).toBe(true);
  });
});
