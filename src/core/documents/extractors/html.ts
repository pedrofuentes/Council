/**
 * HTML extractor (T3).
 *
 * Removes <script> and <style> blocks (issue #344 — their bodies are
 * code, not prose, and would pollute the FTS index), strips remaining
 * tags, decodes a small set of common entities, and collapses
 * whitespace.
 *
 * Self-registers for `.html` and `.htm`.
 */
import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(?:amp|lt|gt|quot|apos|#39|nbsp);/g,
    (m) => HTML_ENTITIES[m] ?? m,
  );
}

function normalizeHtml(raw: string): string {
  let s = raw;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n");
  return s.trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

const htmlExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const raw = ctx.buffer.toString("utf-8");
  const content = normalizeHtml(raw);
  return { content, wordCount: countWords(content) };
};

registerExtractor([".html", ".htm"], async () => htmlExtractor);
