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
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

import type {
  ContentExtractor,
  ExtractionContext,
} from "../../../../../src/core/documents/extractors/types.js";

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
});
