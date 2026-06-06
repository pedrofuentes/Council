/**
 * XLSX extractor (T8).
 *
 * Uses `exceljs` to parse `.xlsx` workbook buffers and emit one Markdown
 * table per sheet, prefixed by a `## SheetName` header. The first row
 * of each sheet is treated as the table header. Sheet names are also
 * surfaced via `metadata.sheetNames` so higher layers can present them
 * without re-parsing.
 *
 * `.xls` (BIFF8 binary) is intentionally NOT supported by exceljs; we
 * still register the extension so the user gets a precise, actionable
 * `corrupt-document` error with a "re-save as .xlsx" suggestion rather
 * than a generic "unsupported-format" rejection.
 *
 * Self-registers for `.xlsx` and `.xls`.
 */
import { registerExtractor } from "./registry.js";
import { ExtractionError } from "./errors.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";

interface FormulaCellValue {
  readonly formula: string;
  readonly result?: unknown;
}

interface RichTextRun {
  readonly text: string;
}

interface RichTextCellValue {
  readonly richText: readonly RichTextRun[];
}

interface HyperlinkCellValue {
  readonly text?: string;
  readonly hyperlink: string;
}

interface ErrorCellValue {
  readonly error: string;
}

function isFormulaCellValue(v: unknown): v is FormulaCellValue {
  return (
    typeof v === "object" &&
    v !== null &&
    "formula" in v &&
    typeof (v as { formula: unknown }).formula === "string"
  );
}

function isRichTextCellValue(v: unknown): v is RichTextCellValue {
  return (
    typeof v === "object" &&
    v !== null &&
    "richText" in v &&
    Array.isArray((v as { richText: unknown }).richText)
  );
}

function isHyperlinkCellValue(v: unknown): v is HyperlinkCellValue {
  return (
    typeof v === "object" &&
    v !== null &&
    "hyperlink" in v &&
    typeof (v as { hyperlink: unknown }).hyperlink === "string"
  );
}

function isErrorCellValue(v: unknown): v is ErrorCellValue {
  return (
    typeof v === "object" &&
    v !== null &&
    "error" in v &&
    typeof (v as { error: unknown }).error === "string"
  );
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isFormulaCellValue(value)) {
    return cellToString(value.result ?? "");
  }
  if (isRichTextCellValue(value)) {
    return value.richText.map((run) => run.text).join("");
  }
  if (isHyperlinkCellValue(value)) {
    return value.text ?? value.hyperlink;
  }
  if (isErrorCellValue(value)) {
    return value.error;
  }
  return String(value);
}

function escapeCell(value: string): string {
  // Escape pipes and collapse newlines so a single cell never breaks the
  // surrounding Markdown table row.
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function isEncryptedError(error: unknown): boolean {
  const msg =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    msg.includes("encrypted") ||
    msg.includes("password") ||
    msg.includes("protected")
  );
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

// DoS guards. `.xlsx` is a ZIP container parsed entirely by exceljs, so
// we cannot inspect the archive ahead of time. Instead we cap totals
// observed during traversal and bail out the moment any cap is
// exceeded — this bounds CPU/heap exhaustion from adversarial
// "zip-bomb"–style workbooks (huge sheet/row/cell counts or
// pathologically large cell payloads).
const MAX_SHEETS = 100;
const MAX_ROWS = 100_000;
const MAX_CELLS = 1_000_000;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const OVERSIZE_SUGGESTION =
  "Reduce the number of sheets/rows or split into smaller files.";

function oversizeError(filename: string, detail: string): ExtractionError {
  return new ExtractionError({
    kind: "oversize-file",
    filePath: filename,
    message: `XLSX exceeds maximum ${detail}: ${filename}`,
    suggestion: OVERSIZE_SUGGESTION,
  });
}

const xlsxExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();

  try {
    // exceljs accepts Buffer | ArrayBuffer | Uint8Array at runtime, but
    // its .d.ts narrows the param to a stale Buffer type that is not
    // assignable from the current @types/node Buffer<ArrayBufferLike>.
    // Build a zero-copy Uint8Array view over the existing memory and
    // hand it off through an explicit cast.
    const view = new Uint8Array(
      ctx.buffer.buffer,
      ctx.buffer.byteOffset,
      ctx.buffer.byteLength,
    );
    await (workbook.xlsx.load as unknown as (b: Uint8Array) => Promise<unknown>)(
      view,
    );
  } catch (error: unknown) {
    if (isEncryptedError(error)) {
      throw new ExtractionError({
        kind: "encrypted-document",
        filePath: ctx.filename,
        message: `XLSX file appears to be password-protected: ${ctx.filename}`,
        suggestion: "Remove password protection and re-add the file.",
        cause: error,
      });
    }
    const isXls = ctx.extension.toLowerCase() === ".xls";
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: ctx.filename,
      message: isXls
        ? `Legacy .xls binary format is not supported: ${ctx.filename}`
        : `Failed to parse spreadsheet: ${ctx.filename}`,
      suggestion: isXls
        ? "Re-save the file as .xlsx from Excel and re-add it."
        : "The file may be corrupted — try re-saving from Excel as .xlsx.",
      cause: error,
    });
  }

  const sheetNames: string[] = [];
  const sections: string[] = [];
  let sheetCount = 0;
  let totalRows = 0;
  let totalCells = 0;
  let totalContentLength = 0;

  workbook.eachSheet((worksheet) => {
    sheetCount++;
    if (sheetCount > MAX_SHEETS) {
      throw oversizeError(ctx.filename, `sheet count (${MAX_SHEETS})`);
    }
    sheetNames.push(worksheet.name);

    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      totalRows++;
      if (totalRows > MAX_ROWS) {
        throw oversizeError(ctx.filename, `row count (${MAX_ROWS})`);
      }
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        totalCells++;
        if (totalCells > MAX_CELLS) {
          throw oversizeError(ctx.filename, `cell count (${MAX_CELLS})`);
        }
        cells.push(escapeCell(cellToString(cell.value)));
      });
      rows.push(cells);
    });

    if (rows.length === 0) {
      const placeholder = `## ${worksheet.name}\n\n(empty sheet)`;
      sections.push(placeholder);
      totalContentLength += placeholder.length;
      if (totalContentLength > MAX_CONTENT_BYTES) {
        throw oversizeError(
          ctx.filename,
          `output size (${MAX_CONTENT_BYTES} bytes)`,
        );
      }
      return;
    }

    const header = rows[0] ?? [];
    const dataRows = rows.slice(1);

    let table = `## ${worksheet.name}\n\n`;
    table += `| ${header.join(" | ")} |\n`;
    table += `| ${header.map(() => "---").join(" | ")} |\n`;
    for (const row of dataRows) {
      while (row.length < header.length) {
        row.push("");
      }
      table += `| ${row.join(" | ")} |\n`;
    }

    const trimmed = table.trimEnd();
    sections.push(trimmed);
    totalContentLength += trimmed.length;
    if (totalContentLength > MAX_CONTENT_BYTES) {
      throw oversizeError(
        ctx.filename,
        `output size (${MAX_CONTENT_BYTES} bytes)`,
      );
    }
  });

  const content = sections.join("\n\n").trim();

  return {
    content,
    wordCount: countWords(content),
    metadata: { sheetNames },
  };
};

registerExtractor([".xlsx", ".xls"], async () => xlsxExtractor);
