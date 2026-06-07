/**
 * Tests for the XLSX extractor module (T8).
 *
 * The XLSX extractor uses `exceljs` to read .xlsx workbook buffers and
 * emits one Markdown table per sheet, prefixed by a `## SheetName`
 * header. The first data row becomes the table header. Sheet names are
 * also surfaced in `metadata.sheetNames`. Old binary `.xls` files are
 * not natively supported by exceljs; loading one should yield a
 * `corrupt-document` ExtractionError with a re-save suggestion.
 */
import { deflateRawSync } from "node:zlib";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function tinyValidXlsxZip(): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from("<x/>", "utf-8") },
    { name: "xl/workbook.xml", data: Buffer.from("<x/>", "utf-8") },
  ]);
}

interface SheetSpec {
  readonly name: string;
  readonly rows: readonly (readonly (string | number | Date | boolean)[])[];
}

async function loadXlsxExtractor(ext = ".xlsx"): Promise<{
  extractor: ContentExtractor;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/xlsx.js");
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const extractor = await registry.getExtractor(ext);
  return { extractor };
}

async function createTestXlsx(sheets: readonly SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.rows) {
      ws.addRow([...row]);
    }
  }
  const arrayBuf = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuf as ArrayBuffer);
}

function ctx(buf: Buffer, ext = ".xlsx"): ExtractionContext {
  return {
    buffer: buf,
    filename: `doc${ext}`,
    extension: ext,
    sizeBytes: buf.byteLength,
  };
}

describe("xlsx extractor", () => {
  it("renders a single sheet as a markdown table with sheet name header", async () => {
    const { extractor } = await loadXlsxExtractor();
    const buf = await createTestXlsx([
      {
        name: "People",
        rows: [
          ["Name", "Age"],
          ["Alice", 30],
          ["Bob", 25],
        ],
      },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("## People");
    expect(out.content).toContain("| Name | Age |");
    expect(out.content).toContain("| --- | --- |");
    expect(out.content).toContain("| Alice | 30 |");
    expect(out.content).toContain("| Bob | 25 |");
    expect(out.wordCount).toBeGreaterThan(0);
  });

  it("renders multiple sheets as separate sections", async () => {
    const { extractor } = await loadXlsxExtractor();
    const buf = await createTestXlsx([
      { name: "Alpha", rows: [["a", "b"], ["1", "2"]] },
      { name: "Beta", rows: [["x", "y"], ["9", "8"]] },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("## Alpha");
    expect(out.content).toContain("## Beta");
    expect(out.content.indexOf("## Alpha")).toBeLessThan(
      out.content.indexOf("## Beta"),
    );
  });

  it("surfaces sheet names in metadata", async () => {
    const { extractor } = await loadXlsxExtractor();
    const buf = await createTestXlsx([
      { name: "First", rows: [["h"]] },
      { name: "Second", rows: [["h"]] },
      { name: "Third", rows: [["h"]] },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.metadata?.sheetNames).toEqual(["First", "Second", "Third"]);
  });

  it("emits an empty sheet placeholder when a sheet has no rows", async () => {
    const { extractor } = await loadXlsxExtractor();
    const buf = await createTestXlsx([{ name: "Blank", rows: [] }]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("## Blank");
    expect(out.content).toContain("(empty sheet)");
  });

  it("converts mixed cell types (numbers, booleans, dates) to strings", async () => {
    const { extractor } = await loadXlsxExtractor();
    const date = new Date("2024-01-15T00:00:00.000Z");
    const buf = await createTestXlsx([
      {
        name: "Mixed",
        rows: [
          ["s", "n", "b", "d"],
          ["text", 42, true, date],
        ],
      },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("text");
    expect(out.content).toContain("42");
    expect(out.content).toContain("true");
    expect(out.content).toContain("2024-01-15");
  });

  it("uses the result of a formula cell, not the formula text", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Calc");
    ws.addRow(["a", "b", "sum"]);
    const row = ws.addRow([1, 2, null]);
    row.getCell(3).value = { formula: "A2+B2", result: 3 };
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const { extractor } = await loadXlsxExtractor();
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("| 1 | 2 | 3 |");
    expect(out.content).not.toContain("A2+B2");
  });

  it("concatenates rich text runs into a single string", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Rich");
    ws.addRow(["header"]);
    const row = ws.addRow([null]);
    row.getCell(1).value = {
      richText: [
        { text: "Hello " },
        { text: "World" },
      ],
    };
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const { extractor } = await loadXlsxExtractor();
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("Hello World");
  });

  it("escapes pipe characters in cell values to keep table safe", async () => {
    const { extractor } = await loadXlsxExtractor();
    const buf = await createTestXlsx([
      {
        name: "Pipes",
        rows: [
          ["col"],
          ["a|b"],
        ],
      },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("a\\|b");
    expect(out.content).not.toMatch(/\| a\|b \|/);
  });

  it("throws ExtractionError(corrupt-document) on random bytes", async () => {
    const { extractor } = await loadXlsxExtractor();
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
    await expect(extractor(ctx(garbage))).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "corrupt-document",
    });
  });

  it("returns empty content for an empty workbook with no sheets", async () => {
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const { extractor } = await loadXlsxExtractor();
    const out = await extractor(ctx(buf));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
    expect(out.metadata?.sheetNames).toEqual([]);
  });

  it("registers itself for both .xlsx and .xls", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/xlsx.js");
    const registry = await import(
      "../../../../../src/core/documents/extractors/registry.js"
    );
    const a = await registry.getExtractor(".xlsx");
    const b = await registry.getExtractor(".xls");
    expect(a).toBe(b);
  });

  it("rejects .xls binary files with a re-save suggestion", async () => {
    // Classic BIFF8 .xls file signature (OLE2 compound document)
    const xlsHeader = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    const buf = Buffer.concat([xlsHeader, Buffer.alloc(512)]);
    const { extractor } = await loadXlsxExtractor(".xls");
    await expect(extractor(ctx(buf, ".xls"))).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "corrupt-document",
      suggestion: expect.stringMatching(/xlsx/i),
    });
  });

  it("uses hyperlink cell text when present, ignoring the URL", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Links");
    ws.addRow(["url"]);
    const row = ws.addRow([null]);
    row.getCell(1).value = {
      text: "Click here",
      hyperlink: "https://example.com",
    };
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const { extractor } = await loadXlsxExtractor();
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("Click here");
    expect(out.content).not.toContain("https://example.com");
  });

  it("falls back to hyperlink URL when no text is set", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Links");
    ws.addRow(["url"]);
    const row = ws.addRow([null]);
    row.getCell(1).value = { hyperlink: "https://example.com/path" };
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const { extractor } = await loadXlsxExtractor();
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("https://example.com/path");
  });

  it("renders error cells as their error string", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Errs");
    ws.addRow(["x"]);
    const row = ws.addRow([null]);
    row.getCell(1).value = { error: "#REF!" };
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const { extractor } = await loadXlsxExtractor();
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("#REF!");
  });

  it("collapses newlines in cell values to single-line table rows", async () => {
    const { extractor } = await loadXlsxExtractor();
    const buf = await createTestXlsx([
      { name: "NL", rows: [["col"], ["line1\nline2"]] },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("| line1 line2 |");
    expect(out.content).not.toMatch(/line1\r?\nline2/);
  });

  it("pads ragged rows shorter than the header with empty cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ragged");
    ws.addRow(["a", "b", "c"]);
    ws.addRow(["x"]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const { extractor } = await loadXlsxExtractor();
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("| x |  |  |");
  });
});

interface MockWorkbookOptions {
  readonly loadError?: Error;
  readonly sheetCount?: number;
  readonly rowsPerSheet?: number;
  readonly cellsPerRow?: number;
  readonly cellValue?: unknown;
}

function mockExcelJs(opts: MockWorkbookOptions): void {
  const sheetCount = opts.sheetCount ?? 1;
  const rowsPerSheet = opts.rowsPerSheet ?? 1;
  const cellsPerRow = opts.cellsPerRow ?? 1;
  const cellValue = opts.cellValue ?? "x";
  const loadError = opts.loadError;

  vi.doMock("exceljs", () => {
    class MockWorkbook {
      public readonly xlsx: {
        readonly load: (buf: unknown) => Promise<void>;
      };
      public constructor() {
        this.xlsx = {
          load: async (): Promise<void> => {
            if (loadError !== undefined) {
              throw loadError;
            }
          },
        };
      }
      public eachSheet(cb: (ws: unknown) => void): void {
        for (let s = 0; s < sheetCount; s++) {
          cb({
            name: `S${s}`,
            eachRow: (
              _o: unknown,
              rowCb: (row: unknown) => void,
            ): void => {
              for (let r = 0; r < rowsPerSheet; r++) {
                rowCb({
                  eachCell: (
                    _oo: unknown,
                    cellCb: (cell: { value: unknown }) => void,
                  ): void => {
                    for (let c = 0; c < cellsPerRow; c++) {
                      cellCb({ value: cellValue });
                    }
                  },
                });
              }
            },
          });
        }
      }
    }
    return { default: { Workbook: MockWorkbook } };
  });
}

async function loadMockedExtractor(): Promise<ContentExtractor> {
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  await import("../../../../../src/core/documents/extractors/xlsx.js");
  return await registry.getExtractor(".xlsx");
}

describe("xlsx extractor - encrypted documents (mocked)", () => {
  afterEach(() => {
    vi.doUnmock("exceljs");
    vi.resetModules();
  });

  it("throws ExtractionError(encrypted-document) when load reports password protection", async () => {
    vi.resetModules();
    mockExcelJs({ loadError: new Error("File is password-protected") });
    const extractor = await loadMockedExtractor();
    await expect(
      extractor(ctx(tinyValidXlsxZip())),
    ).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "encrypted-document",
      suggestion: expect.stringMatching(/password/i),
    });
  });

  it("recognizes 'encrypted' wording in the underlying error", async () => {
    vi.resetModules();
    mockExcelJs({ loadError: new Error("workbook is encrypted") });
    const extractor = await loadMockedExtractor();
    await expect(
      extractor(ctx(tinyValidXlsxZip())),
    ).rejects.toMatchObject({ kind: "encrypted-document" });
  });
});

describe("xlsx extractor - DoS limits (mocked)", () => {
  afterEach(() => {
    vi.doUnmock("exceljs");
    vi.resetModules();
  });

  it("rejects workbooks with more than 100 sheets", async () => {
    vi.resetModules();
    mockExcelJs({ sheetCount: 101 });
    const extractor = await loadMockedExtractor();
    await expect(
      extractor(ctx(tinyValidXlsxZip())),
    ).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "oversize-file",
      suggestion: expect.stringMatching(/split/i),
    });
  });

  it("rejects workbooks with more than 100,000 total rows", async () => {
    vi.resetModules();
    mockExcelJs({ rowsPerSheet: 100_001 });
    const extractor = await loadMockedExtractor();
    await expect(
      extractor(ctx(tinyValidXlsxZip())),
    ).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "oversize-file",
    });
  }, 30_000);

  it("rejects workbooks with more than 1,000,000 total cells", async () => {
    vi.resetModules();
    mockExcelJs({ rowsPerSheet: 1, cellsPerRow: 1_000_001 });
    const extractor = await loadMockedExtractor();
    await expect(
      extractor(ctx(tinyValidXlsxZip())),
    ).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "oversize-file",
    });
  }, 60_000);

  it("rejects workbooks whose rendered output exceeds 10MB", async () => {
    vi.resetModules();
    const bigCell = "x".repeat(11 * 1024 * 1024);
    mockExcelJs({
      sheetCount: 1,
      rowsPerSheet: 2,
      cellsPerRow: 1,
      cellValue: bigCell,
    });
    const extractor = await loadMockedExtractor();
    await expect(
      extractor(ctx(tinyValidXlsxZip())),
    ).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "oversize-file",
    });
  }, 30_000);
});

describe("xlsx extractor - zip-bomb preflight", () => {
  it("throws ExtractionError(zip-bomb-detected) when an entry's compression ratio is suspiciously high", async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024, 0);
    const buf = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from("<x/>", "utf-8") },
      { name: "xl/sharedStrings.xml", data: huge },
    ]);
    const { extractor } = await loadXlsxExtractor();
    await expect(extractor(ctx(buf))).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "zip-bomb-detected",
      filePath: "doc.xlsx",
    });
  });

  it("throws ExtractionError(zip-bomb-detected) when archive has too many entries", async () => {
    const entries: ZipEntry[] = [];
    for (let i = 0; i < 1100; i++) {
      entries.push({
        name: `xl/sheet${String(i)}.xml`,
        data: Buffer.from(`<s${String(i)}/>`, "utf-8"),
      });
    }
    const buf = buildZip(entries);
    const { extractor } = await loadXlsxExtractor();
    await expect(extractor(ctx(buf))).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "zip-bomb-detected",
    });
  });

  it("throws ExtractionError(zip-bomb-detected) when total uncompressed size exceeds the cap", async () => {
    // Build many entries that each fit under the per-entry ratio limit
    // but together exceed the 200 MiB total uncompressed cap. Random
    // bytes don't deflate well, so each entry's individual ratio stays
    // around 1:1 — only the running total trips the guard.
    const entries: ZipEntry[] = [];
    const chunkSize = 1024 * 1024; // 1 MiB
    const chunk = Buffer.alloc(chunkSize);
    for (let i = 0; i < chunkSize; i++) {
      chunk[i] = (i * 1103515245 + 12345) & 0xff;
    }
    for (let i = 0; i < 220; i++) {
      entries.push({ name: `xl/blob${String(i)}.bin`, data: chunk });
    }
    const buf = buildZip(entries);
    const { extractor } = await loadXlsxExtractor();
    // The 1000-entry limit fires first if entries exceed that — keep
    // entry count under MAX_ENTRIES so the uncompressed-total guard is
    // exercised. 220 × 1 MiB = 220 MiB > 200 MiB cap.
    await expect(extractor(ctx(buf))).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "zip-bomb-detected",
    });
  }, 30_000);

  it("throws ExtractionError(corrupt-document) when the buffer is not a valid ZIP", async () => {
    const garbage = Buffer.from("this is not a zip archive at all", "utf-8");
    const { extractor } = await loadXlsxExtractor();
    await expect(extractor(ctx(garbage))).rejects.toMatchObject({
      name: "ExtractionError",
      kind: "corrupt-document",
    });
  });
});
