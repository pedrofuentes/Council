/**
 * Tests for the plaintext extractor module (T3).
 *
 * Behavior:
 *   - Decodes UTF-8 buffer and returns the trimmed string.
 *   - Rejects buffers whose non-printable byte ratio exceeds 10% with
 *     ExtractionError(corrupt-document) — defends against accidentally
 *     passing a binary blob to the text pipeline.
 */
import { describe, expect, it, vi } from "vitest";

import type { ContentExtractor } from "../../../../../src/core/documents/extractors/types.js";
import type * as ErrorsModuleNS from "../../../../../src/core/documents/extractors/errors.js";

async function loadPlaintextExtractor(): Promise<{
  extractor: ContentExtractor;
  errors: typeof ErrorsModuleNS;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/plaintext.js");
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const errors = await import(
    "../../../../../src/core/documents/extractors/errors.js"
  );
  const extractor = await registry.getExtractor(".txt");
  return { extractor, errors };
}

function ctx(buf: Buffer, ext = ".txt"): {
  buffer: Buffer;
  filename: string;
  extension: string;
  sizeBytes: number;
} {
  return {
    buffer: buf,
    filename: `notes${ext}`,
    extension: ext,
    sizeBytes: buf.byteLength,
  };
}

describe("plaintext extractor", () => {
  it("decodes UTF-8 and trims surrounding whitespace", async () => {
    const { extractor } = await loadPlaintextExtractor();
    const out = await extractor(
      ctx(Buffer.from("  hello world\nthis is text  \n", "utf-8")),
    );
    expect(out.content).toBe("hello world\nthis is text");
  });

  it("counts words by whitespace tokens", async () => {
    const { extractor } = await loadPlaintextExtractor();
    const out = await extractor(
      ctx(Buffer.from("one two three   four\nfive", "utf-8")),
    );
    expect(out.wordCount).toBe(5);
  });

  it("returns wordCount=0 for whitespace-only buffer", async () => {
    const { extractor } = await loadPlaintextExtractor();
    const out = await extractor(ctx(Buffer.from("   \n  ", "utf-8")));
    expect(out.wordCount).toBe(0);
  });

  it("accepts UTF-8 multi-byte characters without flagging as binary", async () => {
    const { extractor } = await loadPlaintextExtractor();
    const out = await extractor(
      ctx(Buffer.from("café — naïve résumé", "utf-8")),
    );
    expect(out.content).toBe("café — naïve résumé");
    expect(out.wordCount).toBe(4);
  });

  it("rejects a buffer with high non-printable byte ratio (binary guard)", async () => {
    const { extractor, errors } = await loadPlaintextExtractor();
    // 80 bytes total: 40 printable ASCII letters + 40 NUL bytes (50% non-printable).
    const printable = Buffer.from("a".repeat(40), "utf-8");
    const nonPrintable = Buffer.alloc(40, 0x00);
    const buf = Buffer.concat([printable, nonPrintable]);
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    const e = caught as InstanceType<typeof errors.ExtractionError>;
    expect(e.kind).toBe("corrupt-document");
    expect(e.suggestion).toMatch(/binary/i);
  });

  it("registers itself for .txt", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/plaintext.js");
    const registry = await import(
      "../../../../../src/core/documents/extractors/registry.js"
    );
    expect(registry.getSupportedExtensions()).toContain(".txt");
  });
});
