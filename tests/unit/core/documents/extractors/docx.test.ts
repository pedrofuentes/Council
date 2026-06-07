/**
 * Tests for the DOCX extractor module (T7).
 *
 * The DOCX extractor uses mammoth to convert .docx files to markdown,
 * surfacing encrypted documents and corrupt ZIPs as typed
 * ExtractionError instances.
 *
 * Test fixtures are built programmatically as minimal Office Open XML
 * packages (stored, uncompressed ZIP entries) to avoid committing
 * binary blobs to the repo.
 */
import { deflateRawSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import type {
  ContentExtractor,
  ExtractionContext,
} from "../../../../../src/core/documents/extractors/types.js";

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

function crc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) {
    const idx = (crc ^ byte) & 0xff;
    crc = ((table[idx] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: readonly ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const uncompressed = entry.data;
    const compressed = deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);
    const method = 8; // DEFLATE

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    localChunks.push(local, nameBuf, compressed);
    offsets.push(offset);
    offset += local.length + nameBuf.length + compressed.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offsets[offsets.length - 1] ?? 0, 42);
    centralChunks.push(central, nameBuf);
  }

  const localPart = Buffer.concat(localChunks);
  const centralPart = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style>
</w:styles>`;

function wrapDocument(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
  </w:body>
</w:document>`;
}

function buildDocx(bodyXml: string): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf-8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf-8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(DOC_RELS, "utf-8") },
    { name: "word/styles.xml", data: Buffer.from(STYLES_XML, "utf-8") },
    { name: "word/document.xml", data: Buffer.from(wrapDocument(bodyXml), "utf-8") },
  ]);
}

async function loadDocxExtractor(): Promise<{
  extractor: ContentExtractor;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/docx.js");
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const extractor = await registry.getExtractor(".docx");
  if (!extractor) {
    throw new Error("docx extractor not registered");
  }
  return { extractor };
}

function ctx(buf: Buffer, filename = "doc.docx"): ExtractionContext {
  return {
    buffer: buf,
    filename,
    extension: ".docx",
    sizeBytes: buf.byteLength,
  };
}

describe("docx extractor", () => {
  it("registers itself for .docx", async () => {
    const { extractor } = await loadDocxExtractor();
    expect(typeof extractor).toBe("function");
  });

  it("extracts plain paragraphs as markdown text", async () => {
    const { extractor } = await loadDocxExtractor();
    const buf = buildDocx(
      "<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Second paragraph here</w:t></w:r></w:p>",
    );
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("Hello world");
    expect(out.content).toContain("Second paragraph here");
    expect(out.wordCount).toBe(5);
  });

  it("converts headings to markdown # syntax", async () => {
    const { extractor } = await loadDocxExtractor();
    const buf = buildDocx(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Big Title</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Subtitle</w:t></w:r></w:p>`,
    );
    const out = await extractor(ctx(buf));
    expect(out.content).toMatch(/^#\s+Big Title/m);
    expect(out.content).toMatch(/^##\s+Subtitle/m);
  });

  it("converts bold and italic runs to markdown emphasis", async () => {
    const { extractor } = await loadDocxExtractor();
    const buf = buildDocx(
      "<w:p>" +
        "<w:r><w:rPr><w:b/></w:rPr><w:t>strongtext</w:t></w:r>" +
        "<w:r><w:t> and </w:t></w:r>" +
        "<w:r><w:rPr><w:i/></w:rPr><w:t>emphtext</w:t></w:r>" +
        "</w:p>",
    );
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("__strongtext__");
    expect(out.content).toContain("*emphtext*");
  });

  it("returns empty content and zero word count for an empty document", async () => {
    const { extractor } = await loadDocxExtractor();
    const buf = buildDocx("<w:p></w:p>");
    const out = await extractor(ctx(buf));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
  });

  it("throws ExtractionError(corrupt-document) for random non-ZIP bytes", async () => {
    const { extractor } = await loadDocxExtractor();
    const garbage = Buffer.from("this is not a docx, not even a zip", "utf-8");
    await expect(extractor(ctx(garbage, "broken.docx"))).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "corrupt-document",
      filePath: "broken.docx",
    });
  });

  it("throws ExtractionError(zip-bomb-detected) when an entry's compression ratio is suspiciously high", async () => {
    const { extractor } = await loadDocxExtractor();
    // 10 MiB of zeros deflates to a few KB → ratio ~thousands:1, well above the 100:1 limit.
    const huge = Buffer.alloc(10 * 1024 * 1024, 0);
    const buf = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf-8") },
      { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf-8") },
      { name: "word/document.xml", data: huge },
    ]);
    await expect(extractor(ctx(buf, "bomb.docx"))).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "zip-bomb-detected",
      filePath: "bomb.docx",
    });
  });

  it("throws ExtractionError(corrupt-document) for a ZIP missing word/document.xml", async () => {
    const { extractor } = await loadDocxExtractor();
    const buf = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf-8") },
      { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf-8") },
    ]);
    await expect(
      extractor(ctx(buf, "missing-doc.docx")),
    ).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "corrupt-document",
      filePath: "missing-doc.docx",
    });
  });
});
