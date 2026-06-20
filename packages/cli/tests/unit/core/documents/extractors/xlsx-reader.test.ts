/**
 * Tests for the dependency-light XLSX reader module.
 *
 * `readXlsxSheets` parses a raw `.xlsx` buffer (a ZIP of XML parts)
 * using `yauzl` + `fast-xml-parser` and returns one entry per worksheet
 * in document order, with every cell already stringified using the same
 * semantics the old exceljs-based extractor relied on (shared strings,
 * rich-text concatenation, ISO dates, cached formula values, booleans,
 * error codes, inline strings). It does NOT apply markdown escaping or
 * enforce DoS limits — that stays in `xlsx.ts`.
 *
 * Encrypted workbooks (OLE/CFB containers carrying an `EncryptedPackage`
 * stream) surface as `XlsxEncryptedError`; everything else that fails to
 * parse surfaces as `XlsxParseError`, so the extractor can map them to
 * `encrypted-document` vs `corrupt-document`.
 */
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  readXlsxSheets,
  XlsxEncryptedError,
  XlsxParseError,
} from "../../../../../src/core/documents/extractors/xlsx-reader.js";

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
    const method = 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
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
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
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

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const SSML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

interface SheetPart {
  readonly name: string;
  /** Inner XML of the `<sheetData>` element (a sequence of `<row>`s). */
  readonly sheetData: string;
}

interface WorkbookParts {
  readonly sheets: readonly SheetPart[];
  readonly sharedStrings?: string;
  readonly styles?: string;
}

function buildXlsx(parts: WorkbookParts): Buffer {
  const entries: ZipEntry[] = [];
  const rels: string[] = [];
  let relId = 0;

  if (parts.sharedStrings !== undefined) {
    relId++;
    rels.push(
      `<Relationship Id="rId${String(relId)}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>`,
    );
    entries.push({
      name: "xl/sharedStrings.xml",
      data: Buffer.from(`${XML_DECL}<sst xmlns="${SSML}">${parts.sharedStrings}</sst>`, "utf-8"),
    });
  }

  if (parts.styles !== undefined) {
    relId++;
    rels.push(
      `<Relationship Id="rId${String(relId)}" Type="${REL_NS}/styles" Target="styles.xml"/>`,
    );
    entries.push({
      name: "xl/styles.xml",
      data: Buffer.from(
        `${XML_DECL}<styleSheet xmlns="${SSML}">${parts.styles}</styleSheet>`,
        "utf-8",
      ),
    });
  }

  const sheetTags: string[] = [];
  parts.sheets.forEach((sheet, i) => {
    relId++;
    const rid = `rId${String(relId)}`;
    const target = `worksheets/sheet${String(i + 1)}.xml`;
    rels.push(`<Relationship Id="${rid}" Type="${REL_NS}/worksheet" Target="${target}"/>`);
    sheetTags.push(`<sheet name="${sheet.name}" sheetId="${String(i + 1)}" r:id="${rid}"/>`);
    entries.push({
      name: `xl/${target}`,
      data: Buffer.from(
        `${XML_DECL}<worksheet xmlns="${SSML}" xmlns:r="${REL_NS}"><sheetData>${sheet.sheetData}</sheetData></worksheet>`,
        "utf-8",
      ),
    });
  });

  entries.push({
    name: "xl/workbook.xml",
    data: Buffer.from(
      `${XML_DECL}<workbook xmlns="${SSML}" xmlns:r="${REL_NS}"><sheets>${sheetTags.join("")}</sheets></workbook>`,
      "utf-8",
    ),
  });
  entries.push({
    name: "xl/_rels/workbook.xml.rels",
    data: Buffer.from(
      `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
      "utf-8",
    ),
  });
  entries.push({
    name: "[Content_Types].xml",
    data: Buffer.from(`${XML_DECL}<Types/>`, "utf-8"),
  });

  return buildZip(entries);
}

describe("xlsx-reader: readXlsxSheets", () => {
  it("resolves shared strings and numbers into stringified cells", async () => {
    const buf = buildXlsx({
      sharedStrings: "<si><t>Name</t></si><si><t>Alice</t></si>",
      sheets: [
        {
          name: "People",
          sheetData:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>30</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>',
        },
      ],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.name).toBe("People");
    expect(sheets[0]?.rows).toEqual([
      ["Name", "30"],
      ["Alice", "42"],
    ]);
  });

  it("concatenates rich-text runs in a shared string", async () => {
    const buf = buildXlsx({
      sharedStrings: '<si><r><t xml:space="preserve">Hello </t></r><r><t>World</t></r></si>',
      sheets: [{ name: "Rich", sheetData: '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' }],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["Hello World"]]);
  });

  it("converts a date-styled serial to an ISO string (1900 system)", async () => {
    const buf = buildXlsx({
      styles: '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>',
      sheets: [{ name: "Dates", sheetData: '<row r="1"><c r="A1" s="1"><v>45306</v></c></row>' }],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["2024-01-15T00:00:00.000Z"]]);
  });

  it("recognises custom date format codes via numFmts", async () => {
    const buf = buildXlsx({
      styles:
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
        '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs>',
      sheets: [{ name: "Custom", sheetData: '<row r="1"><c r="A1" s="1"><v>45306</v></c></row>' }],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["2024-01-15T00:00:00.000Z"]]);
  });

  it("does not date-convert numbers with a non-date style", async () => {
    const buf = buildXlsx({
      styles: '<cellXfs count="1"><xf numFmtId="0"/></cellXfs>',
      sheets: [{ name: "Nums", sheetData: '<row r="1"><c r="A1" s="0"><v>45306</v></c></row>' }],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["45306"]]);
  });

  it("reads inline strings (t=inlineStr)", async () => {
    const buf = buildXlsx({
      sheets: [
        {
          name: "Inline",
          sheetData: '<row r="1"><c r="A1" t="inlineStr"><is><t>inline text</t></is></c></row>',
        },
      ],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["inline text"]]);
  });

  it("stringifies booleans as true/false", async () => {
    const buf = buildXlsx({
      sheets: [
        {
          name: "Bools",
          sheetData: '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c></row>',
        },
      ],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["true", "false"]]);
  });

  it("renders error cells as their error code", async () => {
    const buf = buildXlsx({
      sheets: [{ name: "Errs", sheetData: '<row r="1"><c r="A1" t="e"><v>#REF!</v></c></row>' }],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["#REF!"]]);
  });

  it("uses the cached value of a formula cell, not the formula", async () => {
    const buf = buildXlsx({
      sheets: [
        {
          name: "Calc",
          sheetData: '<row r="1"><c r="A1"><f>B1+C1</f><v>3</v></c></row>',
        },
      ],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["3"]]);
  });

  it("uses the cached string result of a formula cell (t=str)", async () => {
    const buf = buildXlsx({
      sheets: [
        {
          name: "Calc",
          sheetData: '<row r="1"><c r="A1" t="str"><f>X</f><v>done</v></c></row>',
        },
      ],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["done"]]);
  });

  it("fills gaps in sparse rows and trims to the last populated column", async () => {
    const buf = buildXlsx({
      sheets: [
        {
          name: "Sparse",
          sheetData:
            '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row>' +
            // Only column A populated -> ragged row of length 1.
            '<row r="2"><c r="A2"><v>9</v></c></row>' +
            // Gap at A, value at C -> ["", "", value].
            '<row r="3"><c r="C3"><v>7</v></c></row>',
        },
      ],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["1", "2", "3"], ["9"], ["", "", "7"]]);
  });

  it("skips fully empty rows", async () => {
    const buf = buildXlsx({
      sheets: [
        {
          name: "Gappy",
          sheetData:
            '<row r="1"><c r="A1"><v>1</v></c></row>' +
            '<row r="2"/>' +
            '<row r="3"><c r="A3"><v>2</v></c></row>',
        },
      ],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.rows).toEqual([["1"], ["2"]]);
  });

  it("returns an empty rows array for a sheet with no data", async () => {
    const buf = buildXlsx({
      sheets: [{ name: "Blank", sheetData: "" }],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets[0]?.name).toBe("Blank");
    expect(sheets[0]?.rows).toEqual([]);
  });

  it("preserves multi-sheet document order", async () => {
    const buf = buildXlsx({
      sheets: [
        { name: "First", sheetData: '<row r="1"><c r="A1"><v>1</v></c></row>' },
        { name: "Second", sheetData: '<row r="1"><c r="A1"><v>2</v></c></row>' },
        { name: "Third", sheetData: '<row r="1"><c r="A1"><v>3</v></c></row>' },
      ],
    });
    const sheets = await readXlsxSheets(buf);
    expect(sheets.map((s) => s.name)).toEqual(["First", "Second", "Third"]);
  });

  it("returns an empty array for a workbook with no sheets", async () => {
    const buf = buildXlsx({ sheets: [] });
    const sheets = await readXlsxSheets(buf);
    expect(sheets).toEqual([]);
  });

  it("throws XlsxEncryptedError for an encrypted OLE package", async () => {
    const oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const marker = Buffer.from("EncryptedPackage", "utf16le");
    const buf = Buffer.concat([oleHeader, Buffer.alloc(64), marker, Buffer.alloc(64)]);
    await expect(readXlsxSheets(buf)).rejects.toBeInstanceOf(XlsxEncryptedError);
  });

  it("throws XlsxParseError for a legacy OLE container without encryption markers", async () => {
    const oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const buf = Buffer.concat([oleHeader, Buffer.alloc(512)]);
    await expect(readXlsxSheets(buf)).rejects.toBeInstanceOf(XlsxParseError);
  });

  it("throws XlsxParseError for non-zip garbage", async () => {
    const buf = Buffer.from("this is not a zip archive at all", "utf-8");
    await expect(readXlsxSheets(buf)).rejects.toBeInstanceOf(XlsxParseError);
  });
});
