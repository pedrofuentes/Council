/**
 * Tests for the markdown extractor module (T3).
 *
 * The markdown extractor normalizes CommonMark-ish source by stripping
 * formatting (headers, bold, italic, links, images, code fences), then
 * returns plain prose plus a whitespace-token word count.
 */
import { describe, expect, it, vi } from "vitest";

import type { ContentExtractor } from "../../../../../src/core/documents/extractors/types.js";

async function loadMarkdownExtractor(): Promise<{
  extractor: ContentExtractor;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/markdown.js");
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const extractor = await registry.getExtractor(".md");
  return { extractor };
}

function ctx(buf: Buffer, ext = ".md"): {
  buffer: Buffer;
  filename: string;
  extension: string;
  sizeBytes: number;
} {
  return {
    buffer: buf,
    filename: `doc${ext}`,
    extension: ext,
    sizeBytes: buf.byteLength,
  };
}

describe("markdown extractor", () => {
  it("strips headers, bold, italic, links, images, and code fences", async () => {
    const { extractor } = await loadMarkdownExtractor();
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
    const out = await extractor(ctx(Buffer.from(md, "utf-8")));
    expect(out.content).not.toContain("#");
    expect(out.content).not.toContain("**");
    expect(out.content).not.toContain("```");
    expect(out.content).not.toContain("](");
    expect(out.content).not.toContain("![");
    expect(out.content).toContain("Heading One");
    expect(out.content).toContain("Heading Two");
    expect(out.content).toContain("bold");
    expect(out.content).toContain("italic");
    expect(out.content).toContain("link");
    expect(out.content).not.toContain("https://example.com");
    expect(out.content).not.toContain("image.png");
    expect(out.content).not.toContain("const x = 1;");
  });

  it("counts words by whitespace tokens", async () => {
    const { extractor } = await loadMarkdownExtractor();
    const out = await extractor(ctx(Buffer.from("one two three four", "utf-8")));
    expect(out.wordCount).toBe(4);
  });

  it("registers itself for both .md and .markdown", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/markdown.js");
    const registry = await import(
      "../../../../../src/core/documents/extractors/registry.js"
    );
    const a = await registry.getExtractor(".md");
    const b = await registry.getExtractor(".markdown");
    expect(a).toBe(b);
  });

  it("decodes UTF-8 multi-byte characters", async () => {
    const { extractor } = await loadMarkdownExtractor();
    const out = await extractor(ctx(Buffer.from("café — naïve résumé", "utf-8")));
    expect(out.content).toBe("café — naïve résumé");
    expect(out.wordCount).toBe(4);
  });
});
