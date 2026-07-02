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
  const registry = await import("../../../../../src/core/documents/extractors/registry.js");
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
    // Exact output: {\fonttbl{\f0 Arial;}} is not a {\*\...} destination
    // group, so "Arial;" survives brace-stripping. Assert the full string
    // so any future group-content leak (e.g. "fonttbl" appearing literally,
    // or additional group text) causes an immediate failure (#945).
    expect(out.content).toBe("Arial;bold and italic text");
    expect(out.content).not.toContain("fonttbl");
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
    const rtf = "{\\rtf1\\ansi{\\*\\generator Riched20 10.0;}Visible text}";
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    expect(out.content).toContain("Visible text");
    expect(out.content).not.toContain("Riched20");
    expect(out.content).not.toContain("generator");
  });

  it("strips nested destination groups like {\\*\\a{\\*\\b ...}}", async () => {
    const { extractor } = await loadRtfExtractor();
    const rtf = "{\\rtf1\\ansi{\\*\\a{\\*\\b nested}}Visible}";
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    expect(out.content).toContain("Visible");
    expect(out.content).not.toContain("nested");
    expect(out.content).not.toContain("\\");
    expect(out.content).not.toContain("{");
    expect(out.content).not.toContain("}");
  });

  it("strips deeply nested destination groups in linear time", async () => {
    const { extractor } = await loadRtfExtractor();
    // depth=50000 (~350 KB input) discriminates O(n) from O(n²):
    //   O(n)  impl: single pass through ~350 KB → < ~100 ms on any hardware.
    //   O(n²) impl: ~50 000 peel iterations × ~350 KB each → ~17 500 ms
    //               (extrapolated from 28 ms measured at depth=2 000),
    //               which far exceeds the 5 000 ms budget (#942/#943).
    // Using performance.now() for sub-millisecond resolution; the 5 000 ms
    // ceiling gives >50× headroom for O(n) even under heavy CI load, while
    // an O(n²) regression would overshoot by ~3.5×.
    const depth = 50000;
    const open = "{\\*\\x ".repeat(depth);
    const close = "}".repeat(depth);
    const rtf = `{\\rtf1\\ansi${open}hidden${close}Visible}`;
    const start = performance.now();
    const out = await extractor(ctx(Buffer.from(rtf, "utf-8")));
    const elapsedMs = performance.now() - start;
    expect(out.content).toContain("Visible");
    expect(out.content).not.toContain("hidden");
    expect(
      elapsedMs,
      `elapsed ${elapsedMs.toFixed(1)} ms exceeds 5000 ms budget — likely O(n²) regression`,
    ).toBeLessThan(5000);
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
    const errors = await import("../../../../../src/core/documents/extractors/errors.js");
    const notRtf = Buffer.from("This is not an RTF file.", "utf-8");
    await expect(extractor(ctx(notRtf))).rejects.toBeInstanceOf(errors.ExtractionError);
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
    const registry = await import("../../../../../src/core/documents/extractors/registry.js");
    const ex = await registry.getExtractor(".rtf");
    expect(ex).toBeDefined();
  });
});
