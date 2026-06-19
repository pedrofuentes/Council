/**
 * CSV/TSV extractor (T5).
 *
 * Parses RFC 4180-style delimited text (with quoted fields, escaped
 * double-quotes, and embedded newlines) and emits a Markdown table.
 * The delimiter is selected by extension only — `.csv` uses comma,
 * `.tsv` uses tab — to keep behavior deterministic across files.
 *
 * Self-registers for `.csv` and `.tsv`.
 */
import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";

function parseDelimited(text: string, delimiter: string): string[][] {
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
  return rows;
}

function toMarkdownTable(rows: readonly (readonly string[])[]): string {
  const header = rows[0];
  if (header === undefined) return "";
  const separator = header
    .map((h) => "-".repeat(Math.max(h.length + 2, 3)))
    .join("|");
  const lines: string[] = [
    `| ${header.join(" | ")} |`,
    `|${separator}|`,
  ];
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

const csvExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const raw = ctx.buffer.toString("utf-8");
  if (raw.length === 0) {
    return { content: "", wordCount: 0 };
  }
  const delimiter = ctx.extension.toLowerCase() === ".tsv" ? "\t" : ",";
  const rows = parseDelimited(raw, delimiter);
  const content = toMarkdownTable(rows);
  return { content, wordCount: countWords(content) };
};

registerExtractor([".csv", ".tsv"], async () => csvExtractor);
