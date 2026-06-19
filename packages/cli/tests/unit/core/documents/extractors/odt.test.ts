/**
 * Tests for the ODT (OpenDocument Text) extractor (T10).
 *
 * Behavior:
 *   - Decompresses the .odt ZIP archive with `yauzl` and parses
 *     `content.xml` with `fast-xml-parser`.
 *   - Produces a Markdown document where `<text:h>` headings render as
 *     `#`-prefixed Markdown headers (level taken from
 *     `text:outline-level`), `<text:p>` paragraphs render as plain text
 *     blocks separated by blank lines, `<text:list>`/`<text:list-item>`
 *     render as `-` bullets, and `<table:table>` renders as a Markdown
 *     table.
 *   - Enforces ZIP-bomb defenses (entry count, total uncompressed size,
 *     per-entry compression ratio, per-entry size cap) and disables XML
 *     entity expansion to prevent XXE / billion-laughs attacks.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  ContentExtractor,
  ExtractionContext,
} from "../../../../../src/core/documents/extractors/types.js";
import type * as ErrorsModuleNS from "../../../../../src/core/documents/extractors/errors.js";

import { buildZip, odfContentXml, type ZipEntry } from "./_zip-fixtures.js";

// --- ODT XML fixture builders -----------------------------------------

function odtBody(inner: string): string {
  return odfContentXml(`<office:body><office:text>${inner}</office:text></office:body>`);
}

function makeOdt(inner: string): Buffer {
  return buildZip([
    {
      name: "mimetype",
      data: Buffer.from("application/vnd.oasis.opendocument.text", "utf-8"),
    },
    {
      name: "content.xml",
      data: Buffer.from(odtBody(inner), "utf-8"),
    },
  ]);
}

// --- Extractor loader --------------------------------------------------

async function loadOdtExtractor(): Promise<{
  extractor: ContentExtractor;
  errors: typeof ErrorsModuleNS;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/odt.js");
  const registry = await import("../../../../../src/core/documents/extractors/registry.js");
  const errors = await import("../../../../../src/core/documents/extractors/errors.js");
  const extractor = await registry.getExtractor(".odt");
  return { extractor, errors };
}

function ctx(buf: Buffer): ExtractionContext {
  return {
    buffer: buf,
    filename: "doc.odt",
    extension: ".odt",
    sizeBytes: buf.byteLength,
  };
}

// --- Tests -------------------------------------------------------------

describe("odt extractor", () => {
  it("extracts a single paragraph as plain text", async () => {
    const { extractor } = await loadOdtExtractor();
    const buf = makeOdt(`<text:p>Hello world</text:p>`);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("Hello world");
    expect(out.wordCount).toBeGreaterThan(0);
  });

  it("renders multiple paragraphs separated by blank lines", async () => {
    const { extractor } = await loadOdtExtractor();
    const buf = makeOdt(`<text:p>First paragraph</text:p><text:p>Second paragraph</text:p>`);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("First paragraph");
    expect(out.content).toContain("Second paragraph");
    expect(out.content).toMatch(/First paragraph\s*\n\s*\n\s*Second paragraph/);
  });

  it("renders headings with markdown # prefixes based on outline level", async () => {
    const { extractor } = await loadOdtExtractor();
    const buf = makeOdt(
      `<text:h text:outline-level="1">Top heading</text:h>` +
        `<text:p>Body text</text:p>` +
        `<text:h text:outline-level="2">Sub heading</text:h>` +
        `<text:p>More body</text:p>`,
    );
    const out = await extractor(ctx(buf));
    expect(out.content).toMatch(/^# Top heading/m);
    expect(out.content).toMatch(/^## Sub heading/m);
    expect(out.content).toContain("Body text");
    expect(out.content).toContain("More body");
  });

  it("defaults heading level to 1 when outline-level is absent", async () => {
    const { extractor } = await loadOdtExtractor();
    const buf = makeOdt(`<text:h>No level set</text:h>`);
    const out = await extractor(ctx(buf));
    expect(out.content).toMatch(/^# No level set/m);
  });

  it("renders list items as markdown bullets", async () => {
    const { extractor } = await loadOdtExtractor();
    const buf = makeOdt(
      `<text:list>` +
        `<text:list-item><text:p>Apples</text:p></text:list-item>` +
        `<text:list-item><text:p>Bananas</text:p></text:list-item>` +
        `<text:list-item><text:p>Cherries</text:p></text:list-item>` +
        `</text:list>`,
    );
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("- Apples");
    expect(out.content).toContain("- Bananas");
    expect(out.content).toContain("- Cherries");
  });

  it("renders tables as markdown tables with the first row as header", async () => {
    const { extractor } = await loadOdtExtractor();
    const buf = makeOdt(
      `<table:table>` +
        `<table:table-row>` +
        `<table:table-cell><text:p>Name</text:p></table:table-cell>` +
        `<table:table-cell><text:p>Age</text:p></table:table-cell>` +
        `</table:table-row>` +
        `<table:table-row>` +
        `<table:table-cell><text:p>Alice</text:p></table:table-cell>` +
        `<table:table-cell><text:p>30</text:p></table:table-cell>` +
        `</table:table-row>` +
        `</table:table>`,
    );
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("| Name | Age |");
    expect(out.content).toContain("| --- | --- |");
    expect(out.content).toContain("| Alice | 30 |");
  });

  it("returns empty content for a document with no body text", async () => {
    const { extractor } = await loadOdtExtractor();
    const buf = makeOdt("");
    const out = await extractor(ctx(buf));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
  });

  it("throws ExtractionError(corrupt-document) on a non-ZIP buffer", async () => {
    const { extractor, errors } = await loadOdtExtractor();
    const garbage = Buffer.from("not a zip file at all", "utf-8");
    let caught: unknown;
    try {
      await extractor(ctx(garbage));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe("corrupt-document");
  });

  it("rejects an archive with > 1000 entries as a zip bomb", async () => {
    const { extractor, errors } = await loadOdtExtractor();
    const entries: ZipEntry[] = [];
    for (let i = 0; i < 1001; i++) {
      entries.push({
        name: `pad/file${i}.bin`,
        data: Buffer.from([0]),
      });
    }
    const buf = buildZip(entries);
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe("zip-bomb-detected");
  });

  it("rejects an entry whose compression ratio exceeds 100:1", async () => {
    const { extractor, errors } = await loadOdtExtractor();
    const huge = Buffer.alloc(100_000, 0);
    const buf = buildZip([
      {
        name: "content.xml",
        data: huge,
        method: "deflate",
      },
    ]);
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe("zip-bomb-detected");
  });

  it("rejects an entry whose declared uncompressed size exceeds the 20 MB per-entry cap", async () => {
    const { extractor, errors } = await loadOdtExtractor();
    const buf = buildZip([
      {
        name: "content.xml",
        data: Buffer.from("<x/>", "utf-8"),
        fakeUncompressedSize: 21 * 1024 * 1024,
        fakeCompressedSize: 21 * 1024 * 1024,
      },
    ]);
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe("zip-bomb-detected");
  });

  it("does not expand internal XML entities (XXE / billion-laughs)", async () => {
    const { extractor } = await loadOdtExtractor();
    const malicious = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe "INJECTED_CONTENT">]>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text>
    <text:p>safe&xxe;tail</text:p>
  </office:text></office:body>
</office:document-content>`;
    const buf = buildZip([
      {
        name: "content.xml",
        data: Buffer.from(malicious, "utf-8"),
      },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).not.toContain("INJECTED_CONTENT");
    expect(out.content).toContain("safe");
    expect(out.content).toContain("tail");
  });

  it("rejects extracted content larger than the per-document cap with oversize-file", async () => {
    const { extractor, errors } = await loadOdtExtractor();
    // Each paragraph carries ~600 KB of body text; 20 paragraphs → ~12 MB
    // of extracted content, exceeding the 10 MB MAX_CONTENT_BYTES cap.
    const chunk = "x ".repeat(300 * 1024);
    let inner = "";
    for (let i = 0; i < 20; i++) {
      inner += `<text:p>${chunk}</text:p>`;
    }
    const buf = makeOdt(inner);
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe("oversize-file");
  });

  it("does not catastrophically backtrack on a malformed DOCTYPE without closing '>' (ReDoS regression)", async () => {
    const { extractor, errors } = await loadOdtExtractor();
    // Construct a content.xml whose payload is "<!DOCTYPE" followed by
    // a long run of characters with no closing '>'. The previous
    // DOCTYPE-strip regex (with overlapping `[^>[]*` and `[^>]*` classes)
    // backtracks catastrophically on this input — O(N²) — taking many
    // seconds for even modest N. The fix replaces the regex with a
    // bounded forward scan that either rejects with `corrupt-document`
    // or completes in well under 1s on the same input.
    const malicious = "<!DOCTYPE" + "A".repeat(100_000);
    const buf = buildZip([
      {
        name: "content.xml",
        data: Buffer.from(malicious, "utf-8"),
      },
    ]);
    const start = Date.now();
    let caught: unknown;
    let result: unknown;
    try {
      result = await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(errors.ExtractionError);
      expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe(
        "corrupt-document",
      );
    } else {
      expect(result).toBeDefined();
    }
  }, 3000);

  it("escapes backslashes in table cell values so they cannot corrupt the markdown row", async () => {
    const { extractor } = await loadOdtExtractor();
    const buf = makeOdt(
      `<table:table>` +
        `<table:table-row>` +
        `<table:table-cell><text:p>col</text:p></table:table-cell>` +
        `</table:table-row>` +
        `<table:table-row>` +
        `<table:table-cell><text:p>a\\|b</text:p></table:table-cell>` +
        `</table:table-row>` +
        `</table:table>`,
    );
    const out = await extractor(ctx(buf));
    // Backslash must be escaped (\\) before the pipe (\|), yielding "a\\\|b".
    expect(out.content).toContain("a\\\\\\|b");
  });

  it("registers itself for .odt", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/odt.js");
    const registry = await import("../../../../../src/core/documents/extractors/registry.js");
    expect(registry.getSupportedExtensions()).toContain(".odt");
  });
});
