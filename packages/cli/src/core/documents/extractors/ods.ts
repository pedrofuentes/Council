/**
 * ODS (OpenDocument Spreadsheet) extractor (T10).
 *
 * Reads an `.ods` ZIP archive via the shared `odf-archive` helper,
 * walks the parsed `content.xml` tree, and emits one Markdown table
 * per `<table:table>`. Each table is preceded by a `## SheetName`
 * Markdown header (taken from `@_table:name`); the first row is
 * treated as the header. Sheet names are surfaced via
 * `metadata.sheetNames` in declared order.
 *
 * Self-registers for `.ods` via the registry's lazy loader.
 */
import {
  collectAllText,
  countWords,
  enforceContentCap,
  isRecord,
  readOdfContent,
} from "./odf-archive.js";
import { registerExtractor } from "./registry.js";
import type { ContentExtractor, ExtractedContent, ExtractionContext } from "./types.js";

const FORMAT_LABEL = "ODS";

function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function escapeCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

interface SheetData {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

function readRow(row: unknown): string[] {
  if (!isRecord(row)) return [];
  const rawCells = asArray(row["table:table-cell"]);
  const cells: string[] = [];
  for (const cell of rawCells) {
    cells.push(escapeCell(collectAllText(cell)));
  }
  return cells;
}

function readSheet(table: unknown): SheetData {
  if (!isRecord(table)) {
    return { name: "", rows: [] };
  }
  const rawName = table["@_table:name"];
  const name = typeof rawName === "string" ? rawName : "";
  const rawRows = asArray(table["table:table-row"]);
  const rows: string[][] = [];
  for (const row of rawRows) {
    rows.push(readRow(row));
  }
  return { name, rows };
}

function findTables(node: unknown): unknown[] {
  // Walks the parsed tree and returns every `<table:table>` element in
  // declaration order, regardless of how deeply nested it is inside
  // `<office:body>`/`<office:spreadsheet>` wrappers.
  const found: unknown[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (!isRecord(n)) return;
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_") || key === "#text") continue;
      if (key === "table:table") {
        for (const item of asArray(value)) found.push(item);
        continue;
      }
      visit(value);
    }
  };
  visit(node);
  return found;
}

function renderSheet(sheet: SheetData): string {
  const header = `## ${sheet.name}`;
  if (sheet.rows.length === 0) {
    return `${header}\n\n(empty sheet)`;
  }
  const headerRow = sheet.rows[0] ?? [];
  const dataRows = sheet.rows.slice(1);
  const lines: string[] = [header, ""];
  lines.push(`| ${headerRow.join(" | ")} |`);
  lines.push(`| ${headerRow.map(() => "---").join(" | ")} |`);
  for (const row of dataRows) {
    const padded = [...row];
    while (padded.length < headerRow.length) padded.push("");
    lines.push(`| ${padded.join(" | ")} |`);
  }
  return lines.join("\n");
}

const odsExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const parsed = await readOdfContent(ctx.buffer, ctx.filename, FORMAT_LABEL);
  if (parsed === null) {
    return { content: "", wordCount: 0, metadata: { sheetNames: [] } };
  }

  const tables = findTables(parsed);
  const sheets = tables.map(readSheet);

  const sections: string[] = [];
  let runningBytes = 0;
  for (const sheet of sheets) {
    const rendered = renderSheet(sheet);
    sections.push(rendered);
    runningBytes += Buffer.byteLength(rendered, "utf-8") + 2;
    enforceContentCap(runningBytes, ctx.filename, FORMAT_LABEL);
  }

  const content = sections.join("\n\n").trim();
  return {
    content,
    wordCount: countWords(content),
    metadata: { sheetNames: sheets.map((s) => s.name) },
  };
};

registerExtractor([".ods"], async () => odsExtractor);
