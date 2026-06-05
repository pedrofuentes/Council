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

const xlsxExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();

  try {
    await workbook.xlsx.load(
      ctx.buffer.buffer.slice(
        ctx.buffer.byteOffset,
        ctx.buffer.byteOffset + ctx.buffer.byteLength,
      ) as ArrayBuffer,
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

  workbook.eachSheet((worksheet) => {
    sheetNames.push(worksheet.name);

    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(escapeCell(cellToString(cell.value)));
      });
      rows.push(cells);
    });

    if (rows.length === 0) {
      sections.push(`## ${worksheet.name}\n\n(empty sheet)`);
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

    sections.push(table.trimEnd());
  });

  const content = sections.join("\n\n").trim();

  return {
    content,
    wordCount: countWords(content),
    metadata: { sheetNames },
  };
};

registerExtractor([".xlsx", ".xls"], async () => xlsxExtractor);
