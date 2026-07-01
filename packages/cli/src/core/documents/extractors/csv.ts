/**
 * CSV/TSV extractor (T5).
 *
 * Parses RFC 4180-style delimited text (with quoted fields, escaped
 * double-quotes, and embedded newlines) and emits a Markdown table.
 * The delimiter is selected by extension only — `.csv` uses comma,
 * `.tsv` uses tab — to keep behavior deterministic across files.
 *
 * Malformed input is rejected with a `corrupt-document` ExtractionError:
 * unterminated quoted fields (mismatched quotes) and rows whose column
 * count differs from the header are not silently accepted. Blank lines
 * (including CRLF `\r\n\r\n` gaps and leading/trailing newlines) are not
 * malformed — they are skipped rather than treated as zero/one-column
 * data rows, so a valid file containing blank lines is never rejected.
 *
 * Self-registers for `.csv` and `.tsv`.
 */
import { ExtractionError } from "./errors.js";
import { registerExtractor } from "./registry.js";
import type { ContentExtractor, ExtractedContent, ExtractionContext } from "./types.js";

interface ParseResult {
  readonly rows: string[][];
  /** True when the input ended while still inside an unterminated quote. */
  readonly unterminatedQuote: boolean;
}

function parseDelimited(text: string, delimiter: string): ParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows, unterminatedQuote: inQuotes };
}

function toMarkdownTable(rows: readonly (readonly string[])[]): string {
  const header = rows[0];
  if (header === undefined) return "";
  const separator = header.map((h) => "-".repeat(Math.max(h.length + 2, 3))).join("|");
  const lines: string[] = [`| ${header.join(" | ")} |`, `|${separator}|`];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

/**
 * A blank line yields a phantom single-column row holding only an empty
 * field: the delimiter parser has nothing to split, so it produces `[""]`
 * (or `[]` defensively). Such a row is not real data and must be skipped
 * before the column-count check, otherwise a valid file that merely
 * contains blank lines (e.g. a trailing double newline, an interior blank
 * line, or a CRLF `\r\n\r\n` gap) is falsely rejected as corrupt. Genuine
 * multi-column rows always have `length >= 2`, so this never masks a real
 * column-count mismatch.
 */
function isBlankRow(row: readonly string[]): boolean {
  return row.length <= 1 && (row[0] ?? "") === "";
}

const csvExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const raw = ctx.buffer.toString("utf-8");
  if (raw.length === 0) {
    return { content: "", wordCount: 0 };
  }
  const delimiter = ctx.extension.toLowerCase() === ".tsv" ? "\t" : ",";
  const { rows: parsedRows, unterminatedQuote } = parseDelimited(raw, delimiter);
  if (unterminatedQuote) {
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: ctx.filename,
      message: "CSV/TSV parse failed: unterminated quoted field (mismatched quotes).",
      suggestion:
        "Ensure every opening double-quote has a matching closing quote, then re-save the file.",
    });
  }
  const rows = parsedRows.filter((row) => !isBlankRow(row));
  const header = rows[0];
  if (header !== undefined) {
    const expectedColumns = header.length;
    for (let r = 1; r < rows.length; r++) {
      const actual = rows[r]?.length ?? 0;
      if (actual !== expectedColumns) {
        throw new ExtractionError({
          kind: "corrupt-document",
          filePath: ctx.filename,
          message: `CSV/TSV parse failed: row ${r + 1} has ${actual} columns but the header has ${expectedColumns}.`,
          suggestion:
            "Ensure every row has the same number of columns as the header, then re-save the file.",
        });
      }
    }
  }
  const content = toMarkdownTable(rows);
  return { content, wordCount: countWords(content) };
};

registerExtractor([".csv", ".tsv"], async () => csvExtractor);
