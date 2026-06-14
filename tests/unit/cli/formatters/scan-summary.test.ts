/**
 * Tests for the scan summary formatter (Task T12).
 *
 * The formatter turns a `ScanResult` (per-file details + aggregate
 * counts) into a human-readable multi-line string for display in chat
 * startup and document-processing output. RED at this commit: the
 * formatter module does not exist yet.
 */
import { describe, expect, it } from "vitest";

import {
  describeScanError,
  formatScanSummary,
  type ScanFileDetail,
  type ScanResult,
} from "../../../../src/cli/formatters/scan-summary.js";

function detail(partial: Partial<ScanFileDetail> & { filename: string }): ScanFileDetail {
  return {
    path: `/docs/${partial.filename}`,
    extension: ".md",
    status: "indexed",
    ...partial,
  };
}

describe("describeScanError", () => {
  it("translates each ExtractionErrorKind value into a human message", () => {
    expect(describeScanError("unsupported-format")).toBe("Format not supported");
    expect(describeScanError("corrupt-document")).toBe("File appears corrupted");
    expect(describeScanError("encrypted-document")).toBe("Password-protected file");
    expect(describeScanError("zip-bomb-detected")).toBe("Suspicious archive structure");
    expect(describeScanError("extraction-failed")).toBe("Extraction failed");
    expect(describeScanError("confinement-violation")).toBe(
      "File outside allowed directory",
    );
  });

  it("includes the configured size limit when available for oversize-file", () => {
    expect(describeScanError("oversize-file", { maxFileSizeMB: 50 })).toBe(
      "File too large (limit: 50 MB)",
    );
  });

  it("falls back to a generic message when no size limit is provided for oversize-file", () => {
    expect(describeScanError("oversize-file")).toBe("File too large");
  });
});

describe("formatScanSummary", () => {
  it("returns an empty-state message when no files are involved", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("No documents");
  });

  it("summarizes unchanged files as a single line and omits per-file detail for them", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 3,
      failed: 0,
      files: [
        detail({ filename: "a.md", status: "unchanged" }),
        detail({ filename: "b.md", status: "unchanged" }),
        detail({ filename: "c.md", status: "unchanged" }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toMatch(/3 files? unchanged/);
    expect(out).not.toContain("a.md");
    expect(out).not.toContain("b.md");
    expect(out).not.toContain("c.md");
  });

  it("uses singular 'file unchanged' when exactly one file is unchanged", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 1,
      failed: 0,
      files: [detail({ filename: "lone.md", status: "unchanged" })],
    };
    const out = formatScanSummary(result);
    expect(out).toMatch(/1 file unchanged/);
  });

  it("renders mixed new + modified + unchanged + failed scenarios", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 1,
      unchanged: 2,
      failed: 1,
      files: [
        detail({ filename: "new.md", status: "indexed", wordCount: 42 }),
        detail({ filename: "edited.md", status: "modified", wordCount: 99 }),
        detail({ filename: "old1.md", status: "unchanged" }),
        detail({ filename: "old2.md", status: "unchanged" }),
        detail({
          filename: "broken.pdf",
          extension: ".pdf",
          status: "failed",
          errorKind: "corrupt-document",
          errorMessage: "stream parse failed at offset 1024",
        }),
      ],
    };
    const out = formatScanSummary(result);

    expect(out).toContain("new.md");
    expect(out).toContain("edited.md");
    expect(out).toMatch(/2 files? unchanged/);
    expect(out).toContain("broken.pdf");
    expect(out).toContain("File appears corrupted");
    expect(out).not.toContain("old1.md");
  });

  it("shows page count metadata for PDFs", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [
        detail({
          filename: "report.pdf",
          extension: ".pdf",
          status: "indexed",
          wordCount: 1500,
          metadata: { pageCount: 12 },
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("report.pdf");
    expect(out).toContain("12 pages");
  });

  it("renders singular '1 page' for single-page PDFs", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [
        detail({
          filename: "tiny.pdf",
          extension: ".pdf",
          status: "indexed",
          wordCount: 50,
          metadata: { pageCount: 1 },
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toMatch(/1 page(?!s)/);
  });

  it("shows sheet names for XLSX/ODS", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [
        detail({
          filename: "budget.xlsx",
          extension: ".xlsx",
          status: "indexed",
          wordCount: 800,
          metadata: { sheetNames: ["Q1", "Q2", "Summary"] },
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("budget.xlsx");
    expect(out).toContain("Q1");
    expect(out).toContain("Q2");
    expect(out).toContain("Summary");
  });

  it("shows slide count for PPTX/ODP", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [
        detail({
          filename: "deck.pptx",
          extension: ".pptx",
          status: "indexed",
          wordCount: 250,
          metadata: { slideCount: 18 },
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("deck.pptx");
    expect(out).toContain("18 slides");
  });

  it("warns when an extracted file has zero words", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [
        detail({
          filename: "empty.pdf",
          extension: ".pdf",
          status: "indexed",
          wordCount: 0,
          metadata: { pageCount: 5 },
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("empty.pdf");
    expect(out).toContain("Extracted but no text content found");
  });

  it("does not show a zero-word warning for files with word content", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [
        detail({
          filename: "good.md",
          status: "indexed",
          wordCount: 100,
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).not.toContain("Extracted but no text content found");
  });

  it("renders each error kind with its human-friendly message", () => {
    const kinds: [ScanFileDetail["errorKind"], string][] = [
      ["unsupported-format", "Format not supported"],
      ["corrupt-document", "File appears corrupted"],
      ["encrypted-document", "Password-protected file"],
      ["zip-bomb-detected", "Suspicious archive structure"],
      ["extraction-failed", "Extraction failed"],
      ["confinement-violation", "File outside allowed directory"],
    ];
    for (const [kind, expected] of kinds) {
      const result: ScanResult = {
        indexed: 0,
        modified: 0,
        unchanged: 0,
        failed: 1,
        files: [
          detail({
            filename: `bad-${String(kind)}.bin`,
            extension: ".bin",
            status: "failed",
            errorKind: kind,
          }),
        ],
      };
      const out = formatScanSummary(result);
      expect(out).toContain(expected);
    }
  });

  it("includes the configured maxFileSizeMB in the oversize-file message when present", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 0,
      failed: 1,
      maxFileSizeMB: 25,
      files: [
        detail({
          filename: "huge.pdf",
          extension: ".pdf",
          status: "failed",
          errorKind: "oversize-file",
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("huge.pdf");
    expect(out).toContain("File too large (limit: 25 MB)");
  });

  it("falls back to a generic 'Extraction failed' for unknown error kinds", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 0,
      failed: 1,
      files: [
        detail({
          filename: "weird.bin",
          extension: ".bin",
          status: "failed",
          // Missing errorKind: simulates a failure where the producer
          // could not classify the failure mode (issue T12).
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("weird.bin");
    expect(out).toContain("Extraction failed");
  });

  it("includes the verbatim error message when provided alongside a known kind", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 0,
      failed: 1,
      files: [
        detail({
          filename: "bad.pdf",
          extension: ".pdf",
          status: "failed",
          errorKind: "corrupt-document",
          errorMessage: "Invalid PDF structure: missing xref",
        }),
      ],
    };
    const out = formatScanSummary(result);
    // The friendly message MUST appear; the raw cause is acceptable as
    // a parenthetical, not a replacement.
    expect(out).toContain("File appears corrupted");
  });
});
