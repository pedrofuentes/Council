/**
 * ODP (OpenDocument Presentation) extractor (T10).
 *
 * Reads an `.odp` ZIP archive via the shared `odf-archive` helper,
 * walks the parsed `content.xml` tree, and emits one Markdown section
 * per `<draw:page>`. Each section is prefixed by a `## Slide N` header
 * (N is the 1-based page index in declaration order) and contains the
 * concatenated text content of all `<text:p>` and `<text:h>` elements
 * found within the page. Slide count is surfaced via
 * `metadata.slideCount`.
 *
 * Self-registers for `.odp` via the registry's lazy loader.
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

const FORMAT_LABEL = "ODP";

function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function findPages(node: unknown): unknown[] {
  // Walks the parsed tree and returns every `<draw:page>` element in
  // declaration order.
  const found: unknown[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (!isRecord(n)) return;
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_") || key === "#text") continue;
      if (key === "draw:page") {
        for (const item of asArray(value)) found.push(item);
        continue;
      }
      visit(value);
    }
  };
  visit(node);
  return found;
}

function collectPageText(page: unknown): string {
  // Collects each `<text:p>` and `<text:h>` text within a page as its
  // own line, separated by `\n`. Other structural wrappers (frames,
  // text boxes) are traversed transparently.
  const lines: string[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (!isRecord(n)) return;
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_") || key === "#text") continue;
      if (key === "text:p" || key === "text:h") {
        for (const item of asArray(value)) {
          const text = collectAllText(item).trim();
          if (text.length > 0) lines.push(text);
        }
        continue;
      }
      visit(value);
    }
  };
  visit(page);
  return lines.join("\n");
}

const odpExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const parsed = await readOdfContent(ctx.buffer, ctx.filename, FORMAT_LABEL);
  if (parsed === null) {
    return { content: "", wordCount: 0, metadata: { slideCount: 0 } };
  }

  const pages = findPages(parsed);
  const sections: string[] = [];
  let runningBytes = 0;
  pages.forEach((page, i) => {
    const slideNumber = i + 1;
    const body = collectPageText(page);
    const lines: string[] = [`## Slide ${String(slideNumber)}`, ""];
    if (body.length > 0) lines.push(body);
    const section = lines.join("\n");
    sections.push(section);
    runningBytes += Buffer.byteLength(section, "utf-8") + 2;
    enforceContentCap(runningBytes, ctx.filename, FORMAT_LABEL);
  });

  const content = sections.join("\n\n").trim();
  return {
    content,
    wordCount: countWords(content),
    metadata: { slideCount: pages.length },
  };
};

registerExtractor([".odp"], async () => odpExtractor);
