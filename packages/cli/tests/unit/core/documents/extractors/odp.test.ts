/**
 * Tests for the ODP (OpenDocument Presentation) extractor (T10).
 *
 * Behavior:
 *   - Decompresses the .odp ZIP archive with `yauzl` and parses
 *     `content.xml` with `fast-xml-parser`.
 *   - For each `<draw:page>`, emits a `## Slide N` Markdown header
 *     followed by the text content of `<text:p>` and `<text:h>`
 *     elements within the page.
 *   - Surfaces `metadata.slideCount`.
 *   - Enforces ZIP-bomb defenses and disables XML entity expansion.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  ContentExtractor,
  ExtractionContext,
} from "../../../../../src/core/documents/extractors/types.js";
import type * as ErrorsModuleNS from "../../../../../src/core/documents/extractors/errors.js";

import { buildZip, odfContentXml, type ZipEntry } from "./_zip-fixtures.js";

// --- ODP XML fixture builders -----------------------------------------

interface SlideSpec {
  readonly paragraphs: readonly string[];
}

function pageXml(spec: SlideSpec, index: number): string {
  const ps = spec.paragraphs.map((p) => `<text:p>${p}</text:p>`).join("");
  return `<draw:page draw:name="page${String(index)}"><draw:frame><draw:text-box>${ps}</draw:text-box></draw:frame></draw:page>`;
}

function odpBody(slides: readonly SlideSpec[]): string {
  const pages = slides.map((s, i) => pageXml(s, i + 1)).join("");
  return odfContentXml(
    `<office:body><office:presentation>${pages}</office:presentation></office:body>`,
  );
}

function makeOdp(slides: readonly SlideSpec[]): Buffer {
  return buildZip([
    {
      name: "mimetype",
      data: Buffer.from("application/vnd.oasis.opendocument.presentation", "utf-8"),
    },
    {
      name: "content.xml",
      data: Buffer.from(odpBody(slides), "utf-8"),
    },
  ]);
}

// --- Extractor loader --------------------------------------------------

async function loadOdpExtractor(): Promise<{
  extractor: ContentExtractor;
  errors: typeof ErrorsModuleNS;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/odp.js");
  const registry = await import("../../../../../src/core/documents/extractors/registry.js");
  const errors = await import("../../../../../src/core/documents/extractors/errors.js");
  const extractor = await registry.getExtractor(".odp");
  return { extractor, errors };
}

function ctx(buf: Buffer): ExtractionContext {
  return {
    buffer: buf,
    filename: "deck.odp",
    extension: ".odp",
    sizeBytes: buf.byteLength,
  };
}

// --- Tests -------------------------------------------------------------

describe("odp extractor", () => {
  it("extracts each draw:page as a ## Slide N section with slideCount metadata", async () => {
    const { extractor } = await loadOdpExtractor();
    const buf = makeOdp([
      { paragraphs: ["First slide body"] },
      { paragraphs: ["Second slide body"] },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("## Slide 1");
    expect(out.content).toContain("First slide body");
    expect(out.content).toContain("## Slide 2");
    expect(out.content).toContain("Second slide body");
    expect(out.metadata?.slideCount).toBe(2);
    expect(out.wordCount).toBeGreaterThan(0);
  });

  it("preserves slide order across many slides (page2 before page10)", async () => {
    const { extractor } = await loadOdpExtractor();
    const slides: SlideSpec[] = [];
    for (let i = 1; i <= 11; i++) {
      slides.push({ paragraphs: [`Body-${String(i)}`] });
    }
    const buf = makeOdp(slides);
    const out = await extractor(ctx(buf));
    const idx2 = out.content.indexOf("Body-2");
    const idx10 = out.content.indexOf("Body-10");
    const idx11 = out.content.indexOf("Body-11");
    expect(idx2).toBeGreaterThan(-1);
    expect(idx10).toBeGreaterThan(idx2);
    expect(idx11).toBeGreaterThan(idx10);
    expect(out.metadata?.slideCount).toBe(11);
  });

  it("preserves multi-paragraph slide text as separate lines", async () => {
    const { extractor } = await loadOdpExtractor();
    const buf = makeOdp([{ paragraphs: ["Alpha line", "Beta line", "Gamma line"] }]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("Alpha line");
    expect(out.content).toContain("Beta line");
    expect(out.content).toContain("Gamma line");
    expect(out.content.indexOf("Alpha line")).toBeLessThan(out.content.indexOf("Beta line"));
  });

  it("collects text from text:h headings within a page", async () => {
    const { extractor } = await loadOdpExtractor();
    const inner = odfContentXml(
      `<office:body><office:presentation>` +
        `<draw:page draw:name="page1">` +
        `<draw:frame><draw:text-box>` +
        `<text:h>Big Heading</text:h>` +
        `<text:p>Body paragraph</text:p>` +
        `</draw:text-box></draw:frame>` +
        `</draw:page>` +
        `</office:presentation></office:body>`,
    );
    const buf = buildZip([{ name: "content.xml", data: Buffer.from(inner, "utf-8") }]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("Big Heading");
    expect(out.content).toContain("Body paragraph");
  });

  it("returns empty content and slideCount 0 for a presentation with no pages", async () => {
    const { extractor } = await loadOdpExtractor();
    const buf = makeOdp([]);
    const out = await extractor(ctx(buf));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
    expect(out.metadata?.slideCount).toBe(0);
  });

  it("throws ExtractionError(corrupt-document) on a non-ZIP buffer", async () => {
    const { extractor, errors } = await loadOdpExtractor();
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
    const { extractor, errors } = await loadOdpExtractor();
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
    const { extractor, errors } = await loadOdpExtractor();
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
    const { extractor, errors } = await loadOdpExtractor();
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
    const { extractor } = await loadOdpExtractor();
    const malicious = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe "INJECTED_CONTENT">]>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
    xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0">
  <office:body><office:presentation>
    <draw:page draw:name="page1"><draw:frame><draw:text-box>
      <text:p>safe&xxe;tail</text:p>
    </draw:text-box></draw:frame></draw:page>
  </office:presentation></office:body>
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
    const { extractor, errors } = await loadOdpExtractor();
    // 20 slides, each with ~600 KB body text → ~12 MB extracted
    // content, exceeding the 10 MB MAX_CONTENT_BYTES cap.
    const chunk = "x ".repeat(300 * 1024);
    const slides: SlideSpec[] = [];
    for (let i = 0; i < 20; i++) {
      slides.push({ paragraphs: [chunk] });
    }
    const buf = makeOdp(slides);
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe("oversize-file");
  });

  it("registers itself for .odp", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/odp.js");
    const registry = await import("../../../../../src/core/documents/extractors/registry.js");
    expect(registry.getSupportedExtensions()).toContain(".odp");
  });
});
