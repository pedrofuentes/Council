/**
 * Extraction-completeness tests (T01).
 *
 * Acceptance evidence that PDF and DOCX extraction return the FULL
 * multi-sentence fact with an accurate word count — i.e. the truncation
 * reported by PM testing is NOT in the extractors. Realistic fixtures are
 * built in-memory: the PDF uses one text-showing operator per line (how
 * real PDFs encode paragraphs) and the DOCX uses many runs in one
 * paragraph. These guard against a future extraction regression and
 * anchor the word-count accuracy requirement.
 */
import { deflateRawSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import type {
  ContentExtractor,
  ExtractionContext,
} from "../../../../src/core/documents/extractors/types.js";

const SENTENCES = [
  "The project codename is BLUEJAY and it was reviewed-by Alice Martinez on the fourteenth of March.",
  "The deployment window opens at midnight UTC and closes six hours later.",
  "All changes must be reviewed-by two senior engineers before merge.",
  "The rollback procedure requires running the restore script from the backup vault.",
  "Performance budgets cap the page load at two hundred milliseconds.",
  "The on-call rotation spans four engineers across two time zones.",
  "Incident severity one requires paging the director within fifteen minutes.",
  "The data retention policy keeps logs for ninety days and metrics for one year.",
];

const EXPECTED_WORDS = SENTENCES.join(" ")
  .split(/\s+/)
  .filter((t) => t.length > 0).length;

// ── PDF fixture: one Tj per line on a single page (realistic) ──────────
function makeMultiLinePdf(lines: readonly string[]): Buffer {
  const escape = (s: string): string => s.replace(/[()\\]/g, (c) => `\\${c}`);
  let stream = "BT /F1 12 Tf 50 740 Td ";
  lines.forEach((line, i) => {
    if (i > 0) stream += "0 -14 Td ";
    stream += `(${escape(line)}) Tj `;
  });
  stream += "ET";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${Buffer.byteLength(stream, "binary")}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const offsets: number[] = [0];
  let body = "%PDF-1.4\n%\xff\xff\xff\xff\n";
  objects.forEach((content, i) => {
    offsets[i + 1] = Buffer.byteLength(body, "binary");
    body += `${i + 1} 0 obj\n${content}\nendobj\n`;
  });
  const totalObjs = objects.length + 1;
  const xrefOffset = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
  for (let i = 1; i < totalObjs; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<</Size ${totalObjs}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

// ── DOCX fixture: one paragraph, many runs (realistic) ─────────────────
function crc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) {
    const idx = (crc ^ byte) & 0xff;
    crc = ((table[idx] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  const lastOffsets: number[] = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBuf, compressed);
    lastOffsets.push(offset);
    offset += local.length + nameBuf.length + compressed.length;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(lastOffsets[lastOffsets.length - 1] ?? 0, 42);
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
</Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function buildDocx(bodyXml: string): Buffer {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf-8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf-8") },
    { name: "word/document.xml", data: Buffer.from(doc, "utf-8") },
  ]);
}

async function loadExtractor(
  mod: string,
  ext: string,
): Promise<ContentExtractor> {
  vi.resetModules();
  await import(mod);
  const registry = await import(
    "../../../../src/core/documents/extractors/registry.js"
  );
  const extractor = await registry.getExtractor(ext);
  if (extractor === null) throw new Error(`no extractor for ${ext}`);
  return extractor;
}

function ctx(buf: Buffer, ext: string): ExtractionContext {
  return {
    buffer: buf,
    filename: `fact${ext}`,
    extension: ext,
    sizeBytes: buf.byteLength,
  };
}

describe("extraction completeness (T01)", () => {
  it("PDF: returns the full multi-sentence fact with an accurate word count", async () => {
    const extractor = await loadExtractor(
      "../../../../src/core/documents/extractors/pdf.js",
      ".pdf",
    );
    const out = await extractor(ctx(makeMultiLinePdf(SENTENCES), ".pdf"));
    expect(out.content).toContain("codename is BLUEJAY");
    expect(out.content).toContain("ninety days and metrics for one year");
    expect(out.wordCount).toBe(EXPECTED_WORDS);
  });

  it("DOCX: returns the full multi-sentence fact with an accurate word count", async () => {
    const extractor = await loadExtractor(
      "../../../../src/core/documents/extractors/docx.js",
      ".docx",
    );
    // One paragraph, one run per word — exercises run reassembly.
    const runs = SENTENCES.join(" ")
      .split(" ")
      .map((w) => `<w:r><w:t xml:space="preserve">${w} </w:t></w:r>`)
      .join("");
    const out = await extractor(ctx(buildDocx(`<w:p>${runs}</w:p>`), ".docx"));
    expect(out.content).toContain("BLUEJAY");
    expect(out.content).toContain("ninety days and metrics for one year");
    expect(out.wordCount).toBe(EXPECTED_WORDS);
  });
});
