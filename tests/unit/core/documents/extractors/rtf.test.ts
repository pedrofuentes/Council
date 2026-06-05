/**
 * Tests for the RTF extractor module (T5).
 *
 * The RTF extractor strips control words, group braces, and decodes a
 * small set of common escape sequences (`\'XX` hex chars, `\~`, `\-`,
 * `\_`). Magic-byte verification rejects buffers that don't start with
 * `{\rtf`.
 */
import { describe, expect, it, vi } from "vitest";

import type { ContentExtractor } from "../../../../../src/core/documents/extractors/types.js";

async function loadRtfExtractor(): Promise<{ extractor: ContentExtractor }> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/rtf.js");
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const extractor = await registry.getExtractor(".rtf");
  return { extractor };
}

function ctx(buf: Buffer): {
  buffer: Buffer;
  filename: string;
  extension: string;
  sizeBytes: number;
} {
  return {
    buffer: buf,
    filename: "doc.rtf",
    extension: ".rtf",
    sizeBytes: buf.byteLength,
  };
}

describe("rtf extractor", () => {
  it("extracts plain text from a minimal RTF document", async () => {
    const { extractor } = await loadRtfExtractor();
    const rtf = "{\\rtf1\\ansi Hello World}";
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    expect(out.content).toBe("Hello World");
    expect(out.wordCount).toBe(2);
  });

  it("strips formatting control words (bold, italic, font changes)", async () => {
    const { extractor } = await loadRtfExtractor();
    const rtf =
      "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\b bold\\b0  and \\i italic\\i0  text}";
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    expect(out.content).toContain("bold");
    expect(out.content).toContain("italic");
    expect(out.content).toContain("text");
    expect(out.content).not.toContain("\\");
    expect(out.content).not.toContain("{");
    expect(out.content).not.toContain("}");
  });

  it("decodes \\'XX hex escape sequences", async () => {
    const { extractor } = await loadRtfExtractor();
    const rtf = "{\\rtf1\\ansi caf\\'e9}";
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    expect(out.content).toContain("café");
  });

  it("decodes \\~ as a space", async () => {
    const { extractor } = await loadRtfExtractor();
    const rtf = "{\\rtf1\\ansi hello\\~world}";
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    expect(out.content).toContain("hello world");
  });

  it("strips destination groups like {\\*\\generator ...}", async () => {
    const { extractor } = await loadRtfExtractor();
    const rtf =
      "{\\rtf1\\ansi{\\*\\generator Riched20 10.0;}Visible text}";
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    expect(out.content).toContain("Visible text");
    expect(out.content).not.toContain("Riched20");
    expect(out.content).not.toContain("generator");
  });

  it("returns empty content for an RTF document with no text", async () => {
    const { extractor } = await loadRtfExtractor();
    const rtf = "{\\rtf1\\ansi}";
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
  });

  it("throws ExtractionError(corrupt-document) when buffer is not RTF", async () => {
    const { extractor } = await loadRtfExtractor();
    const errors = await import(
      "../../../../../src/core/documents/extractors/errors.js"
    );
    const notRtf = Buffer.from("This is not an RTF file.", "utf-8");
    await expect(extractor(ctx(notRtf))).rejects.toBeInstanceOf(
      errors.ExtractionError,
    );
    try {
      await extractor(ctx(notRtf));
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(errors.ExtractionError);
      const e = err as InstanceType<typeof errors.ExtractionError>;
      expect(e.kind).toBe("corrupt-document");
    }
  });

  it("registers itself for .rtf", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/rtf.js");
    const registry = await import(
      "../../../../../src/core/documents/extractors/registry.js"
    );
    const ex = await registry.getExtractor(".rtf");
    expect(ex).toBeDefined();
  });
});
