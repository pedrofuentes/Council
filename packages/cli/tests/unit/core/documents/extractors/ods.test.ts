/**
 * Tests for the ODS (OpenDocument Spreadsheet) extractor (T10).
 *
 * Behavior:
 *   - Decompresses the .ods ZIP archive with `yauzl` and parses
 *     `content.xml` with `fast-xml-parser`.
 *   - For each `<table:table>`, emits a `## TableName` Markdown header
 *     followed by a Markdown table whose first row is the header.
 *   - Surfaces `metadata.sheetNames` in declared order.
 *   - Enforces ZIP-bomb defenses and disables XML entity expansion.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  ContentExtractor,
  ExtractionContext,
} from "../../../../../src/core/documents/extractors/types.js";
import type * as ErrorsModuleNS from "../../../../../src/core/documents/extractors/errors.js";

import { buildZip, odfContentXml, type ZipEntry } from "./_zip-fixtures.js";

// --- ODS XML fixture builders -----------------------------------------

interface SheetSpec {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

function sheetXml(spec: SheetSpec): string {
  const rows = spec.rows
    .map((row) => {
      const cells = row
        .map((cell) => `<table:table-cell><text:p>${cell}</text:p></table:table-cell>`)
        .join("");
      return `<table:table-row>${cells}</table:table-row>`;
    })
    .join("");
  return `<table:table table:name="${spec.name}">${rows}</table:table>`;
}

function odsBody(sheets: readonly SheetSpec[]): string {
  const tables = sheets.map(sheetXml).join("");
  return odfContentXml(
    `<office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body>`,
  );
}

function makeOds(sheets: readonly SheetSpec[]): Buffer {
  return buildZip([
    {
      name: "mimetype",
      data: Buffer.from("application/vnd.oasis.opendocument.spreadsheet", "utf-8"),
    },
    {
      name: "content.xml",
      data: Buffer.from(odsBody(sheets), "utf-8"),
    },
  ]);
}

// --- Extractor loader --------------------------------------------------

async function loadOdsExtractor(): Promise<{
  extractor: ContentExtractor;
  errors: typeof ErrorsModuleNS;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/ods.js");
  const registry = await import("../../../../../src/core/documents/extractors/registry.js");
  const errors = await import("../../../../../src/core/documents/extractors/errors.js");
  const extractor = await registry.getExtractor(".ods");
  return { extractor, errors };
}

function ctx(buf: Buffer): ExtractionContext {
  return {
    buffer: buf,
    filename: "doc.ods",
    extension: ".ods",
    sizeBytes: buf.byteLength,
  };
}

// --- Tests -------------------------------------------------------------

describe("ods extractor", () => {
  it("renders a single sheet as a markdown table with the sheet name as header", async () => {
    const { extractor } = await loadOdsExtractor();
    const buf = makeOds([
      {
        name: "People",
        rows: [
          ["Name", "Age"],
          ["Alice", "30"],
          ["Bob", "25"],
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

  it("renders multiple sheets as separate sections in declared order", async () => {
    const { extractor } = await loadOdsExtractor();
    const buf = makeOds([
      {
        name: "Alpha",
        rows: [
          ["a", "b"],
          ["1", "2"],
        ],
      },
      {
        name: "Beta",
        rows: [
          ["x", "y"],
          ["9", "8"],
        ],
      },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("## Alpha");
    expect(out.content).toContain("## Beta");
    expect(out.content.indexOf("## Alpha")).toBeLessThan(out.content.indexOf("## Beta"));
  });

  it("surfaces sheet names in metadata.sheetNames", async () => {
    const { extractor } = await loadOdsExtractor();
    const buf = makeOds([
      { name: "First", rows: [["h"]] },
      { name: "Second", rows: [["h"]] },
      { name: "Third", rows: [["h"]] },
    ]);
    const out = await extractor(ctx(buf));
    expect(out.metadata?.sheetNames).toEqual(["First", "Second", "Third"]);
  });

  it("returns empty content with empty sheet names for a workbook with no tables", async () => {
    const { extractor } = await loadOdsExtractor();
    const buf = makeOds([]);
    const out = await extractor(ctx(buf));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
    expect(out.metadata?.sheetNames).toEqual([]);
  });

  it("emits an empty sheet placeholder for a sheet with no rows", async () => {
    const { extractor } = await loadOdsExtractor();
    const buf = makeOds([{ name: "Blank", rows: [] }]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("## Blank");
    expect(out.content).toContain("(empty sheet)");
    expect(out.metadata?.sheetNames).toEqual(["Blank"]);
  });

  it("throws ExtractionError(corrupt-document) on a non-ZIP buffer", async () => {
    const { extractor, errors } = await loadOdsExtractor();
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
    const { extractor, errors } = await loadOdsExtractor();
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
    const { extractor, errors } = await loadOdsExtractor();
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
    const { extractor, errors } = await loadOdsExtractor();
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
    const { extractor } = await loadOdsExtractor();
    const malicious = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe "INJECTED_CONTENT">]>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
    xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body><office:spreadsheet>
    <table:table table:name="Sheet1">
      <table:table-row>
        <table:table-cell><text:p>safe&xxe;tail</text:p></table:table-cell>
      </table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
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
    const { extractor, errors } = await loadOdsExtractor();
    // 20 sheets, each with one row of ~600 KB of text → ~12 MB extracted
    // content, exceeding the 10 MB MAX_CONTENT_BYTES cap.
    const chunk = "x ".repeat(300 * 1024);
    const sheets: SheetSpec[] = [];
    for (let i = 0; i < 20; i++) {
      sheets.push({ name: `S${String(i)}`, rows: [[chunk]] });
    }
    const buf = makeOds(sheets);
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    expect((caught as InstanceType<typeof errors.ExtractionError>).kind).toBe("oversize-file");
  });

  it("escapes backslashes in cell values so they cannot corrupt the markdown row", async () => {
    const { extractor } = await loadOdsExtractor();
    const buf = makeOds([{ name: "BS", rows: [["col"], ["a\\|b"]] }]);
    const out = await extractor(ctx(buf));
    // Backslash must be escaped (\\) before the pipe (\|), yielding "a\\\|b".
    expect(out.content).toContain("a\\\\\\|b");
  });

  it("registers itself for .ods", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/ods.js");
    const registry = await import("../../../../../src/core/documents/extractors/registry.js");
    expect(registry.getSupportedExtensions()).toContain(".ods");
  });
});
