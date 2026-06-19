/**
 * ODT (OpenDocument Text) extractor (T10).
 *
 * Reads an `.odt` ZIP archive via the shared `odf-archive` helper,
 * walks the parsed `content.xml` tree, and emits Markdown:
 *   - `<text:h text:outline-level="N">` → `#`-prefixed Markdown header
 *     (level = `outline-level`, defaulting to 1).
 *   - `<text:p>` → plain text block separated from siblings by a blank
 *     line.
 *   - `<text:list>` → Markdown bullets (one `- ` per `<text:list-item>`).
 *   - `<table:table>` → Markdown table; the first row is treated as
 *     the header.
 *
 * Self-registers for `.odt` via the registry's lazy loader.
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

const FORMAT_LABEL = "ODT";

function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderHeading(node: unknown): string {
  const text = collectAllText(node).trim();
  let level = 1;
  if (isRecord(node)) {
    const raw = node["@_text:outline-level"];
    if (typeof raw === "string" || typeof raw === "number") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 6) {
        level = Math.floor(parsed);
      }
    }
  }
  return `${"#".repeat(level)} ${text}`;
}

function renderParagraph(node: unknown): string {
  return collectAllText(node).trim();
}

function renderList(node: unknown): string {
  const items: string[] = [];
  if (isRecord(node)) {
    const rawItems = asArray(node["text:list-item"]);
    for (const item of rawItems) {
      const text = collectAllText(item).trim();
      if (text.length > 0) items.push(`- ${text}`);
    }
  }
  return items.join("\n");
}

function renderTable(node: unknown): string {
  if (!isRecord(node)) return "";
  const rawRows = asArray(node["table:table-row"]);
  const rows: string[][] = [];
  for (const row of rawRows) {
    if (!isRecord(row)) continue;
    const rawCells = asArray(row["table:table-cell"]);
    const cells: string[] = [];
    for (const cell of rawCells) {
      cells.push(escapeCell(collectAllText(cell)));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const lines: string[] = [];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of dataRows) {
    while (row.length < header.length) row.push("");
    lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

interface BlockEmit {
  readonly kind: "heading" | "paragraph" | "list" | "table";
  readonly text: string;
}

function emitBlocks(node: unknown): BlockEmit[] {
  // Walks a body subtree and emits Markdown blocks for each top-level
  // ODF element (paragraphs, headings, lists, tables). Recurses into
  // generic containers (e.g. `<office:text>`, list items used as
  // wrappers) so structural wrappers don't hide their content.
  const blocks: BlockEmit[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (!isRecord(n)) return;
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_") || key === "#text") continue;
      const items = asArray(value);
      for (const item of items) {
        switch (key) {
          case "text:h": {
            blocks.push({ kind: "heading", text: renderHeading(item) });
            break;
          }
          case "text:p": {
            const text = renderParagraph(item);
            if (text.length > 0) {
              blocks.push({ kind: "paragraph", text });
            }
            break;
          }
          case "text:list": {
            const rendered = renderList(item);
            if (rendered.length > 0) {
              blocks.push({ kind: "list", text: rendered });
            }
            break;
          }
          case "table:table": {
            const rendered = renderTable(item);
            if (rendered.length > 0) {
              blocks.push({ kind: "table", text: rendered });
            }
            break;
          }
          default:
            visit(item);
        }
      }
    }
  };
  visit(node);
  return blocks;
}

const odtExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const parsed = await readOdfContent(ctx.buffer, ctx.filename, FORMAT_LABEL);
  if (parsed === null) {
    return { content: "", wordCount: 0, metadata: {} };
  }

  const blocks = emitBlocks(parsed);
  const sections: string[] = [];
  let runningBytes = 0;
  for (const block of blocks) {
    sections.push(block.text);
    runningBytes += Buffer.byteLength(block.text, "utf-8") + 2;
    enforceContentCap(runningBytes, ctx.filename, FORMAT_LABEL);
  }

  const content = sections.join("\n\n").trim();
  if (content.length === 0) {
    return { content: "", wordCount: 0, metadata: {} };
  }
  return {
    content,
    wordCount: countWords(content),
    metadata: {},
  };
};

registerExtractor([".odt"], async () => odtExtractor);
