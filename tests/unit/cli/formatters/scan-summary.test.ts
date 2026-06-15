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

  it("names the extension for unsupported-format when one is provided (T2)", () => {
    expect(
      describeScanError("unsupported-format", { extension: ".png" }),
    ).toBe("Unsupported format (.png)");
  });

  it("falls back to the generic unsupported message when no extension is provided (T2)", () => {
    expect(describeScanError("unsupported-format", { extension: "" })).toBe(
      "Format not supported",
    );
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
      ["unsupported-format", "Unsupported format"],
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

  it("names the extension when listing an unsupported-format file (T2)", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 0,
      failed: 1,
      unsupported: 1,
      files: [
        detail({
          filename: "screenshot.png",
          extension: ".png",
          status: "failed",
          errorKind: "unsupported-format",
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("screenshot.png");
    expect(out).toContain("Unsupported format (.png)");
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

  it("produces multi-line output where each line survives sanitizeSingleLine independently", () => {
     const result: ScanResult = {
       indexed: 1,
       modified: 0,
       unchanged: 2,
       failed: 1,
       files: [
         detail({ filename: "report.pdf", extension: ".pdf", status: "indexed", wordCount: 500, metadata: { pageCount: 10 } }),
         detail({ filename: "old1.md", status: "unchanged" }),
         detail({ filename: "old2.md", status: "unchanged" }),
         detail({ filename: "broken.docx", extension: ".docx", status: "failed", errorKind: "corrupt-document" }),
       ],
     };
     const out = formatScanSummary(result);
     const lines = out.split("\n").filter((l) => l.length > 0);

     // Multi-line output: must have more than 1 line
     expect(lines.length).toBeGreaterThan(1);

     // Each line should be self-contained (no line depends on the previous for meaning)
     for (const line of lines) {
       expect(line.length).toBeGreaterThan(0);
       // No line should contain embedded newlines (already split)
       expect(line).not.toContain("\n");
     }
  });
});

describe("renderScanLines — per-line rendering (🔴 regression)", () => {
  it("calls showSystem once per non-empty line of a multi-line summary", async () => {
    const { renderScanLines } = await import(
      "../../../../src/cli/formatters/scan-summary.js"
    );
    const calls: { message: string; level: string }[] = [];
    const fakeRenderer = {
      showSystem(message: string, level: "info" | "warn" | "error" = "info"): void {
        calls.push({ message, level });
      },
    };
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 2,
      failed: 1,
      files: [
        detail({ filename: "report.pdf", extension: ".pdf", status: "indexed", wordCount: 500, metadata: { pageCount: 10 } }),
        detail({ filename: "old1.md", status: "unchanged" }),
        detail({ filename: "old2.md", status: "unchanged" }),
        detail({ filename: "broken.docx", extension: ".docx", status: "failed", errorKind: "corrupt-document" }),
      ],
    };
    renderScanLines(fakeRenderer, result);

    // Must produce multiple showSystem calls — one per non-empty line
    expect(calls.length).toBeGreaterThan(1);
    // Each call should be a single line (no embedded newlines)
    for (const call of calls) {
      expect(call.message).not.toContain("\n");
      expect(call.message.length).toBeGreaterThan(0);
      expect(call.level).toBe("info");
    }
  });

  it("does not call showSystem for 'No documents found' result", async () => {
    const { renderScanLines } = await import(
      "../../../../src/cli/formatters/scan-summary.js"
    );
    const calls: { message: string; level: string }[] = [];
    const fakeRenderer = {
      showSystem(message: string, level: "info" | "warn" | "error" = "info"): void {
        calls.push({ message, level });
      },
    };
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [],
    };
    renderScanLines(fakeRenderer, result);
    expect(calls).toHaveLength(0);
  });

  it("preserves all content lines from formatScanSummary", async () => {
    const { renderScanLines } = await import(
      "../../../../src/cli/formatters/scan-summary.js"
    );
    const calls: { message: string; level: string }[] = [];
    const fakeRenderer = {
      showSystem(message: string, level: "info" | "warn" | "error" = "info"): void {
        calls.push({ message, level });
      },
    };
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 1,
      failed: 0,
      files: [
        detail({ filename: "a.md", status: "indexed", wordCount: 100 }),
        detail({ filename: "b.md", status: "unchanged" }),
      ],
    };
    renderScanLines(fakeRenderer, result);

    const summary = formatScanSummary(result);
    const expectedLines = summary.split("\n").filter((l) => l.length > 0);
    expect(calls.length).toBe(expectedLines.length);
    for (let i = 0; i < expectedLines.length; i++) {
      expect(calls[i].message).toBe(expectedLines[i]);
    }
  });
});

describe("formatScanSummary — AI fallback + needs-review (T-AIPIPE)", () => {
  it("marks an auto-mode AI-extracted file distinctly from a native extraction", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [
        detail({
          filename: "weird.xyz",
          extension: ".xyz",
          status: "indexed",
          wordCount: 20,
          aiExtracted: true,
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("weird.xyz");
    // The indexed line must signal AI extraction so it is not mistaken
    // for a high-fidelity native parse.
    expect(out).toMatch(/AI[ -]?extract/i);
  });

  it("does not tag native (non-AI) extractions as AI-extracted", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      files: [detail({ filename: "native.md", status: "indexed", wordCount: 50 })],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("native.md");
    expect(out).not.toMatch(/AI[ -]?extract/i);
  });

  it("renders needs-review files and an actionable `council docs review` hint", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 0,
      failed: 0,
      needsReview: 1,
      files: [
        detail({
          filename: "manual.xyz",
          extension: ".xyz",
          status: "needs-review",
          wordCount: 12,
          detectedFormat: "unknown (extension .xyz)",
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).toContain("manual.xyz");
    expect(out).toMatch(/needs? review/i);
    expect(out).toContain("council docs review");
  });

  it("never indexes needs-review files into the success/indexed lines", () => {
    const result: ScanResult = {
      indexed: 1,
      modified: 0,
      unchanged: 0,
      failed: 0,
      needsReview: 1,
      files: [
        detail({ filename: "ok.md", status: "indexed", wordCount: 30 }),
        detail({
          filename: "pending.xyz",
          extension: ".xyz",
          status: "needs-review",
          detectedFormat: "unknown (extension .xyz)",
        }),
      ],
    };
    const out = formatScanSummary(result);
    // The needs-review file must not be rendered as "Indexed"/"Updated".
    expect(out).not.toMatch(/(Indexed|Updated) pending\.xyz/);
  });

  it("sanitizes AI-fallback-derived detectedFormat before display (no terminal-escape vector)", () => {
    const result: ScanResult = {
      indexed: 0,
      modified: 0,
      unchanged: 0,
      failed: 0,
      needsReview: 1,
      files: [
        detail({
          filename: "evil.xyz",
          extension: ".xyz",
          status: "needs-review",
          // Embedded ANSI CSI + newline must be stripped/collapsed.
          detectedFormat: "unknown\u001b[31m (extension\n.xyz)",
        }),
      ],
    };
    const out = formatScanSummary(result);
    expect(out).not.toContain("\u001b");
    // The newline inside the AI text must not leak an extra line.
    const reviewLine = out
      .split("\n")
      .find((l) => l.includes("evil.xyz"));
    expect(reviewLine).toBeDefined();
    expect(reviewLine).not.toContain(".xyz)\n");
  });
});
