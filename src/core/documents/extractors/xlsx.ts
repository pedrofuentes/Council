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
import * as yauzl from "yauzl";

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

// DoS guards. `.xlsx` is a ZIP container; we run a yauzl-based
// preflight over the central directory before handing bytes to exceljs
// so we can reject decompression-bomb archives (huge entry counts,
// pathological compression ratios, or oversized uncompressed totals)
// up front. After the preflight succeeds we still cap CPU/heap totals
// observed during traversal — exceljs can synthesize cells from
// SharedStrings / styles / formulas in ways that aren't visible from
// the ZIP central directory alone, so the post-load caps remain a
// necessary second line of defense.
const MAX_ENTRIES = 1000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MiB
const MAX_RATIO = 100;
const MAX_SHEETS = 100;
const MAX_ROWS = 100_000;
const MAX_CELLS = 1_000_000;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const OVERSIZE_SUGGESTION =
  "Reduce the number of sheets/rows or split into smaller files.";

function openZipBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipFile) => {
      if (err !== null && err !== undefined) {
        reject(err);
        return;
      }
      if (zipFile === undefined) {
        reject(new Error("yauzl returned no zip file"));
        return;
      }
      resolve(zipFile);
    });
  });
}

async function preflightZip(buffer: Buffer, filename: string): Promise<void> {
  let zipFile: yauzl.ZipFile;
  try {
    zipFile = await openZipBuffer(buffer);
  } catch (error: unknown) {
    // yauzl scans backwards for the End-of-Central-Directory signature
    // before doing anything else. If it can't find one, the buffer is
    // not a ZIP at all — most commonly a genuine BIFF8 `.xls` (OLE2
    // compound document), random binary, or text. Return so that
    // exceljs can take over and surface the correct format-specific
    // error (the legacy `.xls` branch produces an actionable "re-save
    // as .xlsx" suggestion). This is the ONLY yauzl failure mode we
    // tolerate: any other error (truncated EOCD, multi-disk, etc.)
    // indicates a ZIP-shaped-but-broken input — including
    // OLE/PDF/junk-prefixed polyglots whose shifted central directory
    // offset trips yauzl but is silently absorbed by JSZip — and must
    // be surfaced rather than handed off to a more lenient parser.
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("End of central directory record signature not found")) {
      return;
    }
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: filename,
      message: `Failed to parse XLSX archive: ${filename}`,
      suggestion: "The file may be corrupted — try re-saving from Excel as .xlsx.",
      cause: error,
    });
  }

  await new Promise<void>((resolve, reject) => {
    let entryCount = 0;
    let totalUncompressed = 0;

    zipFile.on("entry", (entry: yauzl.Entry) => {
      entryCount++;
      if (entryCount > MAX_ENTRIES) {
        reject(
          new ExtractionError({
            kind: "zip-bomb-detected",
            filePath: filename,
            message: `XLSX archive has more than ${String(MAX_ENTRIES)} entries`,
            suggestion: "File has suspicious structure.",
          }),
        );
        return;
      }

      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        reject(
          new ExtractionError({
            kind: "zip-bomb-detected",
            filePath: filename,
            message: `XLSX archive uncompressed total exceeds ${String(MAX_UNCOMPRESSED_BYTES)} bytes`,
            suggestion: "File has suspicious compression characteristics.",
          }),
        );
        return;
      }

      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > MAX_RATIO
      ) {
        const ratio = (entry.uncompressedSize / entry.compressedSize).toFixed(0);
        reject(
          new ExtractionError({
            kind: "zip-bomb-detected",
            filePath: filename,
            message: `XLSX entry compression ratio ${ratio}:1 exceeds limit ${String(MAX_RATIO)}:1`,
            suggestion: "File has suspicious compression characteristics.",
          }),
        );
        return;
      }

      zipFile.readEntry();
    });

    zipFile.on("end", () => {
      resolve();
    });

    zipFile.on("error", (err: Error) => {
      reject(
        new ExtractionError({
          kind: "corrupt-document",
          filePath: filename,
          message: `Failed to read XLSX archive entries: ${filename}`,
          suggestion:
            "The file may be corrupted — try re-saving from Excel as .xlsx.",
          cause: err,
        }),
      );
    });

    zipFile.readEntry();
  });
}

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
  const isXls = ctx.extension.toLowerCase() === ".xls";

  // Always preflight every buffer through yauzl — no extension- or
  // magic-byte-based gate. Prior gating attempts (allow-list on `PK`
  // at offset 0, deny-list on the OLE/BIFF8 signature, extension
  // checks) were each bypassed: stub-prefixed ZIPs evade an offset-0
  // PK check, attacker-renamed `.xls` evades extension checks, and
  // OLE-prefixed ZIP polyglots evade an OLE deny-list because
  // exceljs/JSZip tolerates the shifted central directory. An
  // always-on preflight eliminates the whole class. `preflightZip`
  // returns gracefully only when yauzl reports
  // "End of central directory record signature not found" — i.e.
  // when the buffer is genuinely not a ZIP (e.g., real BIFF8 `.xls`)
  // and there is no bomb risk to gate against. Any other yauzl
  // failure (truncated EOCD, multi-disk, invalid central directory
  // signature from a shifted offset) is surfaced as a
  // `corrupt-document` ExtractionError to keep polyglot inputs from
  // reaching the more lenient JSZip backend underneath exceljs.
  await preflightZip(ctx.buffer, ctx.filename);

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
