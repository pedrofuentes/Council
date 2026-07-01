/**
 * Tests for the CSV/TSV extractor module (T5).
 *
 * The CSV extractor parses RFC 4180-style delimited text into rows and
 * emits a Markdown table. Delimiter is selected by extension only:
 * `.csv` → comma, `.tsv` → tab.
 */
import { describe, expect, it, vi } from "vitest";

import type { ContentExtractor } from "../../../../../src/core/documents/extractors/types.js";

async function loadCsvExtractor(ext: string): Promise<{
  extractor: ContentExtractor;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/csv.js");
  const registry = await import("../../../../../src/core/documents/extractors/registry.js");
  const extractor = await registry.getExtractor(ext);
  return { extractor };
}

function ctx(
  buf: Buffer,
  ext = ".csv",
): {
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

/** Markdown table rows (header, separator, and data lines all start with "|"). */
function tableRowLines(content: string): string[] {
  return content.split("\n").filter((l) => l.startsWith("|"));
}

describe("csv extractor", () => {
  it("renders a simple CSV as a Markdown table", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const csv = "name,age,city\nAlice,30,Paris\nBob,25,Berlin";
    const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
    expect(out.content).toContain("| name | age | city |");
    expect(out.content).toContain("|------|-----|------|");
    expect(out.content).toContain("| Alice | 30 | Paris |");
    expect(out.content).toContain("| Bob | 25 | Berlin |");
    expect(out.wordCount).toBeGreaterThan(0);
  });

  it("renders a TSV (tab-separated) as a Markdown table", async () => {
    const { extractor } = await loadCsvExtractor(".tsv");
    const tsv = "name\tage\nAlice\t30\nBob\t25";
    const out = await extractor(ctx(Buffer.from(tsv, "utf-8"), ".tsv"));
    expect(out.content).toContain("| name | age |");
    expect(out.content).toContain("| Alice | 30 |");
    expect(out.content).toContain("| Bob | 25 |");
  });

  it("treats commas inside quoted fields as literal", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const csv = 'greeting,target\n"hello, world",everyone';
    const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
    expect(out.content).toContain("| hello, world | everyone |");
  });

  it("preserves newlines inside quoted fields", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const csv = 'a,b\n"line1\nline2",x';
    const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
    // Newline inside the cell should be preserved (not split into a new row).
    expect(out.content).toMatch(/\|\s*line1\nline2\s*\|\s*x\s*\|/);
  });

  it("decodes escaped double quotes inside quoted fields", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const csv = 'q,n\n"she said ""hi""",1';
    const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
    expect(out.content).toContain('| she said "hi" | 1 |');
  });

  it("returns empty content for an empty buffer", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const out = await extractor(ctx(Buffer.from("", "utf-8")));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
  });

  it("emits header-only table when only the header row is present", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const out = await extractor(ctx(Buffer.from("a,b,c", "utf-8")));
    expect(out.content).toContain("| a | b | c |");
    expect(out.content).toContain("|---|---|---|");
    // No data rows beyond header + separator.
    expect(out.content.split("\n").filter((l) => l.startsWith("|")).length).toBe(2);
  });

  it("registers itself for both .csv and .tsv", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/csv.js");
    const registry = await import("../../../../../src/core/documents/extractors/registry.js");
    const a = await registry.getExtractor(".csv");
    const b = await registry.getExtractor(".tsv");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it("decodes UTF-8 multi-byte characters", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const csv = "name,emoji\ncafé,🎉";
    const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
    expect(out.content).toContain("café");
    expect(out.content).toContain("🎉");
  });

  it("throws ExtractionError(corrupt-document) on an unterminated quote", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const errors = await import("../../../../../src/core/documents/extractors/errors.js");
    // The quoted field around "Alice,30 is never closed (mismatched quotes).
    const csv = 'name,age\n"Alice,30';
    await expect(extractor(ctx(Buffer.from(csv, "utf-8")))).rejects.toBeInstanceOf(
      errors.ExtractionError,
    );
    try {
      await extractor(ctx(Buffer.from(csv, "utf-8")));
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(errors.ExtractionError);
      const e = err as InstanceType<typeof errors.ExtractionError>;
      expect(e.kind).toBe("corrupt-document");
    }
  });

  it("throws ExtractionError(corrupt-document) on inconsistent column counts", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const errors = await import("../../../../../src/core/documents/extractors/errors.js");
    // Header has 3 columns; second data row has only 2.
    const csv = "a,b,c\n1,2,3\n4,5";
    await expect(extractor(ctx(Buffer.from(csv, "utf-8")))).rejects.toBeInstanceOf(
      errors.ExtractionError,
    );
    try {
      await extractor(ctx(Buffer.from(csv, "utf-8")));
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(errors.ExtractionError);
      const e = err as InstanceType<typeof errors.ExtractionError>;
      expect(e.kind).toBe("corrupt-document");
    }
  });

  // Regression: blank/whitespace lines produce a phantom 1-column [""] row
  // from the parser. That must be skipped BEFORE the column-count check so a
  // valid file with blank lines is not falsely rejected as corrupt-document.
  // The genuine column-mismatch guard must stay intact (see the inverse test).
  describe("blank-line handling (#1801)", () => {
    const HEADER = "| name | age |";
    const ALICE = "| Alice | 30 |";
    const BOB = "| Bob | 25 |";

    // No phantom empty row should ever be emitted into the Markdown table.
    const PHANTOM_ROW = /^\|\s+\|$/m;

    it("extracts a file with a trailing double newline (no corrupt-document throw)", async () => {
      const { extractor } = await loadCsvExtractor(".csv");
      const csv = "name,age\nAlice,30\n\n";
      const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
      expect(out.content).toContain(HEADER);
      expect(out.content).toContain(ALICE);
      // header + separator + exactly one real data row.
      expect(tableRowLines(out.content)).toHaveLength(3);
      expect(out.content).not.toMatch(PHANTOM_ROW);
      expect(out.wordCount).toBeGreaterThan(0);
    });

    it("extracts a file with multiple trailing blank lines", async () => {
      const { extractor } = await loadCsvExtractor(".csv");
      const csv = "name,age\nAlice,30\n\n\n";
      const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
      expect(out.content).toContain(HEADER);
      expect(out.content).toContain(ALICE);
      expect(tableRowLines(out.content)).toHaveLength(3);
      expect(out.content).not.toMatch(PHANTOM_ROW);
    });

    it("extracts a file with an interior blank line right after the header", async () => {
      const { extractor } = await loadCsvExtractor(".csv");
      const csv = "name,age\n\nAlice,30\n";
      const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
      expect(out.content).toContain(HEADER);
      expect(out.content).toContain(ALICE);
      expect(tableRowLines(out.content)).toHaveLength(3);
      expect(out.content).not.toMatch(PHANTOM_ROW);
    });

    it("extracts a file with a blank line between two data rows", async () => {
      const { extractor } = await loadCsvExtractor(".csv");
      const csv = "name,age\nAlice,30\n\nBob,25\n";
      const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
      expect(out.content).toContain(HEADER);
      expect(out.content).toContain(ALICE);
      expect(out.content).toContain(BOB);
      // header + separator + two real data rows (blank line dropped, not counted).
      expect(tableRowLines(out.content)).toHaveLength(4);
      expect(out.content).not.toMatch(PHANTOM_ROW);
    });

    it("extracts a file with a leading blank line (header is the first real row)", async () => {
      const { extractor } = await loadCsvExtractor(".csv");
      const csv = "\nname,age\nAlice,30\n";
      const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
      expect(out.content).toContain(HEADER);
      expect(out.content).toContain(ALICE);
      expect(tableRowLines(out.content)).toHaveLength(3);
      expect(out.content).not.toMatch(PHANTOM_ROW);
    });

    it("still extracts a file with a single trailing newline", async () => {
      const { extractor } = await loadCsvExtractor(".csv");
      const csv = "name,age\nAlice,30\n";
      const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
      expect(out.content).toContain(HEADER);
      expect(out.content).toContain(ALICE);
      expect(tableRowLines(out.content)).toHaveLength(3);
      expect(out.content).not.toMatch(PHANTOM_ROW);
    });

    it("skips a CRLF blank line (\\r\\n\\r\\n) without false corruption", async () => {
      const { extractor } = await loadCsvExtractor(".csv");
      const csv = "name,age\r\nAlice,30\r\n\r\n";
      const out = await extractor(ctx(Buffer.from(csv, "utf-8")));
      expect(out.content).toContain(HEADER);
      expect(out.content).toContain(ALICE);
      expect(tableRowLines(out.content)).toHaveLength(3);
      expect(out.content).not.toMatch(PHANTOM_ROW);
      expect(out.content).not.toContain("\r");
    });

    it("still throws corrupt-document for a genuine wrong-column row (guard preserved)", async () => {
      const { extractor } = await loadCsvExtractor(".csv");
      const errors = await import("../../../../../src/core/documents/extractors/errors.js");
      // Real data row has 3 columns vs a 2-column header; trailing newline must
      // NOT mask this genuine mismatch. This holds before AND after the fix.
      const csv = "name,age\nAlice,30,extra\n";
      await expect(extractor(ctx(Buffer.from(csv, "utf-8")))).rejects.toBeInstanceOf(
        errors.ExtractionError,
      );
      try {
        await extractor(ctx(Buffer.from(csv, "utf-8")));
        throw new Error("should not reach");
      } catch (err) {
        expect(err).toBeInstanceOf(errors.ExtractionError);
        const e = err as InstanceType<typeof errors.ExtractionError>;
        expect(e.kind).toBe("corrupt-document");
      }
    });
  });

  it("parses CRLF line endings identically to LF, with no stray carriage returns (#946)", async () => {
    const { extractor } = await loadCsvExtractor(".csv");
    const lfOut = await extractor(ctx(Buffer.from("name,age\nAlice,30\nBob,25\n", "utf-8")));
    const crlfOut = await extractor(
      ctx(Buffer.from("name,age\r\nAlice,30\r\nBob,25\r\n", "utf-8")),
    );
    // Line-ending flavor must not change the extracted rows/cells.
    expect(crlfOut.content).toBe(lfOut.content);
    expect(crlfOut.wordCount).toBe(lfOut.wordCount);
    // No stray carriage returns should survive into the cell values.
    expect(crlfOut.content).not.toContain("\r");
    expect(crlfOut.content).toContain("| Alice | 30 |");
    expect(crlfOut.content).toContain("| Bob | 25 |");
  });
});
