/**
 * Tests for the PPTX extractor module (T9).
 *
 * Behavior:
 *   - Decompresses the .pptx ZIP archive with `yauzl` and walks
 *     `ppt/slides/slideN.xml` (+ optional `ppt/notesSlides/notesSlideN.xml`)
 *     entries in numeric order, parsing each with `fast-xml-parser`.
 *   - Produces a Markdown document with one `## Slide N` section per
 *     slide, body text, and a `> **Speaker Notes:** …` blockquote for
 *     any matching notes slide.
 *   - Enforces ZIP-bomb defenses (entry count, total uncompressed size,
 *     per-entry compression ratio) and disables XML entity expansion to
 *     prevent XXE / billion-laughs attacks.
 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import type { ContentExtractor } from "../../../../../src/core/documents/extractors/types.js";
import type * as ErrorsModuleNS from "../../../../../src/core/documents/extractors/errors.js";

// --- CRC-32 (IEEE 802.3) -----------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- Minimal ZIP writer (stored or deflate-raw) ------------------------

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  /** "stored" (no compression) by default. "deflate" uses raw DEFLATE. */
  readonly method?: "stored" | "deflate";
  /** Override the uncompressed size reported in headers (for bomb tests). */
  readonly fakeUncompressedSize?: number;
  /** Override the compressed size reported in headers (for bomb tests). */
  readonly fakeCompressedSize?: number;
}

function buildZip(entries: readonly ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? "stored";
    const compressed =
      method === "deflate" ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const uncompressedSize =
      entry.fakeUncompressedSize ?? entry.data.length;
    const compressedSize = entry.fakeCompressedSize ?? compressed.length;
    const methodCode = method === "deflate" ? 8 : 0;
    const nameBuf = Buffer.from(entry.name, "utf-8");

    const local = Buffer.alloc(30 + nameBuf.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // gpbf
    local.writeUInt16LE(methodCode, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);
    compressed.copy(local, 30 + nameBuf.length);
    localChunks.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // gpbf
    central.writeUInt16LE(methodCode, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralChunks.push(central);

    offset += local.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

// --- PPTX XML fixture builders -----------------------------------------

function slideXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>${body}</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
}

function multiParagraphSlideXml(paragraphs: readonly string[]): string {
  const ps = paragraphs
    .map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)
    .join("");
  return `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>${ps}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
}

function notesXml(body: string): string {
  return `<?xml version="1.0"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
         xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>${body}</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`;
}

interface SlideSpec {
  readonly body: string;
  readonly notes?: string;
}

function makePptx(slides: readonly SlideSpec[]): Buffer {
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from("<?xml version=\"1.0\"?><Types/>", "utf-8"),
    },
    {
      name: "ppt/presentation.xml",
      data: Buffer.from("<?xml version=\"1.0\"?><p:presentation/>", "utf-8"),
    },
  ];
  slides.forEach((spec, i) => {
    const n = i + 1;
    entries.push({
      name: `ppt/slides/slide${n}.xml`,
      data: Buffer.from(slideXml(spec.body), "utf-8"),
    });
    if (spec.notes !== undefined) {
      entries.push({
        name: `ppt/notesSlides/notesSlide${n}.xml`,
        data: Buffer.from(notesXml(spec.notes), "utf-8"),
      });
    }
  });
  return buildZip(entries);
}

// --- Extractor loader --------------------------------------------------

async function loadPptxExtractor(): Promise<{
  extractor: ContentExtractor;
  errors: typeof ErrorsModuleNS;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/pptx.js");
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const errors = await import(
    "../../../../../src/core/documents/extractors/errors.js"
  );
  const extractor = await registry.getExtractor(".pptx");
  return { extractor, errors };
}

function ctx(buf: Buffer): {
  buffer: Buffer;
  filename: string;
  extension: string;
  sizeBytes: number;
} {
  return {
    buffer: buf,
    filename: "deck.pptx",
    extension: ".pptx",
    sizeBytes: buf.byteLength,
  };
}

// --- Tests -------------------------------------------------------------

describe("pptx extractor", () => {
  it("extracts slides as ## Slide N markdown sections with slideCount metadata", async () => {
    const { extractor } = await loadPptxExtractor();
    const buf = makePptx([{ body: "First slide body" }, { body: "Second" }]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("## Slide 1");
    expect(out.content).toContain("First slide body");
    expect(out.content).toContain("## Slide 2");
    expect(out.content).toContain("Second");
    expect(out.metadata?.slideCount).toBe(2);
    expect(out.wordCount).toBeGreaterThan(0);
  });

  it("renders speaker notes as a blockquote below the slide body", async () => {
    const { extractor } = await loadPptxExtractor();
    const buf = makePptx([
      { body: "Topic intro", notes: "Remember to mention the deadline" },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toMatch(
      /## Slide 1[\s\S]*Topic intro[\s\S]*> \*\*Speaker Notes:\*\* Remember to mention the deadline/,
    );
  });

  it("orders slides numerically (slide2 before slide10)", async () => {
    const { extractor } = await loadPptxExtractor();
    const slides: SlideSpec[] = [];
    for (let i = 1; i <= 11; i++) {
      slides.push({ body: `Body-${i}` });
    }
    const buf = makePptx(slides);
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
    const { extractor } = await loadPptxExtractor();
    const buf = buildZip([
      {
        name: "ppt/slides/slide1.xml",
        data: Buffer.from(
          multiParagraphSlideXml(["Alpha line", "Beta line", "Gamma line"]),
          "utf-8",
        ),
      },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("Alpha line");
    expect(out.content).toContain("Beta line");
    expect(out.content).toContain("Gamma line");
    expect(out.content.indexOf("Alpha line")).toBeLessThan(
      out.content.indexOf("Beta line"),
    );
  });

  it("returns empty content and slideCount 0 for a presentation with no slides", async () => {
    const { extractor } = await loadPptxExtractor();
    const buf = buildZip([
      {
        name: "[Content_Types].xml",
        data: Buffer.from("<?xml version=\"1.0\"?><Types/>", "utf-8"),
      },
      {
        name: "ppt/presentation.xml",
        data: Buffer.from("<?xml version=\"1.0\"?><p:presentation/>", "utf-8"),
      },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
    expect(out.metadata?.slideCount).toBe(0);
  });

  it("throws ExtractionError(corrupt-document) on a non-ZIP buffer", async () => {
    const { extractor, errors } = await loadPptxExtractor();
    const garbage = Buffer.from("this is not a zip file at all", "utf-8");
    let caught: unknown;
    try {
      await extractor(ctx(garbage));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe(
      "corrupt-document",
    );
  });

  it("rejects an archive with > 1000 entries as a zip bomb", async () => {
    const { extractor, errors } = await loadPptxExtractor();
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
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe(
      "zip-bomb-detected",
    );
  });

  it("rejects an entry whose compression ratio exceeds 100:1", async () => {
    const { extractor, errors } = await loadPptxExtractor();
    // 100 KB of zeros compresses to ~100 bytes — ratio ~1000:1.
    const huge = Buffer.alloc(100_000, 0);
    const buf = buildZip([
      {
        name: "ppt/slides/slide1.xml",
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
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe(
      "zip-bomb-detected",
    );
  });

  it("rejects an archive whose total uncompressed size exceeds 200 MB", async () => {
    const { extractor, errors } = await loadPptxExtractor();
    // Use fake uncompressed sizes in the headers to avoid actually
    // building a 200 MB buffer in memory.
    const entries: ZipEntry[] = [];
    for (let i = 0; i < 3; i++) {
      entries.push({
        name: `pad/blob${i}.bin`,
        data: Buffer.from([0]),
        fakeUncompressedSize: 80 * 1024 * 1024, // 80 MB each → 240 MB total
        fakeCompressedSize: 80 * 1024 * 1024, // match to satisfy yauzl
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
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe(
      "zip-bomb-detected",
    );
  });

  it("rejects an entry whose declared uncompressed size exceeds the 20 MB per-entry cap", async () => {
    const { extractor, errors } = await loadPptxExtractor();
    // Declare a single slide entry with a 21 MB uncompressed size in the
    // ZIP headers without actually allocating that buffer. The extractor
    // must refuse the entry up-front (before opening the read stream) to
    // bound peak memory.
    const buf = buildZip([
      {
        name: "ppt/slides/slide1.xml",
        data: Buffer.from("<p:sld/>", "utf-8"),
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
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe(
      "zip-bomb-detected",
    );
  });

  it("aborts a read stream that delivers more bytes than the declared uncompressed size", async () => {
    const { extractor, errors } = await loadPptxExtractor();
    // Lie in the local file header: declare a tiny uncompressed size
    // (well under the 20 MB per-entry cap) while the deflated stream
    // actually decodes to 1 MB. The extractor must abort mid-stream once
    // the byte count exceeds the declared size (defense-in-depth against
    // headers that lie about uncompressed size to bypass the up-front
    // entry cap).
    const real = Buffer.alloc(1024 * 1024, 0x20);
    const buf = buildZip([
      {
        name: "ppt/slides/slide1.xml",
        data: real,
        method: "deflate",
        fakeUncompressedSize: 8,
      },
    ]);
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe(
      "zip-bomb-detected",
    );
  });

  it("does not resolve external XML entities (XXE / billion-laughs)", async () => {
    const { extractor } = await loadPptxExtractor();
    const malicious = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>safe&xxe;tail</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
    const buf = buildZip([
      {
        name: "ppt/slides/slide1.xml",
        data: Buffer.from(malicious, "utf-8"),
      },
    ]);
    const out = await extractor(ctx(buf));
    // The literal entity reference must NOT be expanded to file contents.
    expect(out.content).not.toMatch(/root:|\/bin\/(ba)?sh/);
    // Entity expansion is disabled, so the raw "&xxe;" token is left in
    // place (the parser does not silently expand it).
    expect(out.content).toContain("safe");
    expect(out.content).toContain("tail");
  });

  it("registers itself for .pptx", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/pptx.js");
    const registry = await import(
      "../../../../../src/core/documents/extractors/registry.js"
    );
    expect(registry.getSupportedExtensions()).toContain(".pptx");
  });
});
