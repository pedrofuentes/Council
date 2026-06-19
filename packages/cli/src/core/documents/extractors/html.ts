/**
 * HTML extractor (T3).
 *
 * Removes <script> and <style> elements (issue #344 — their bodies are
 * code, not prose, and would pollute the FTS index), then extracts the
 * remaining text, decodes entities, and collapses whitespace.
 *
 * Extraction uses `node-html-parser`, a maintained, ESM-compatible,
 * tokenizer-based HTML parser. This replaces the previous hand-rolled
 * regex/scanner stripping, which suffered from regex-bypass classes
 * (whitespace/case variation, attributes, orphan close tags, quoted `>`
 * inside attributes) flagged by CodeQL
 * (`js/incomplete-multi-character-sanitization`, `js/bad-tag-filter`)
 * and catastrophic backtracking / O(n^2) behaviour (issue #1212). The
 * tokenizer runs in linear time with no regex backtracking and removes
 * script/style element bodies by construction.
 *
 * `structuredText` (not `textContent`) is used so that block elements
 * stay separated by whitespace — otherwise adjacent blocks such as
 * `<p>a</p><p>b</p>` would be concatenated ("ab"), merging distinct
 * words and corrupting the FTS index.
 *
 * Self-registers for `.html` and `.htm`.
 */
import { parse } from "node-html-parser";

import { registerExtractor } from "./registry.js";
import type { ContentExtractor, ExtractedContent, ExtractionContext } from "./types.js";

function normalizeHtml(raw: string): string {
  const root = parse(raw, { comment: false });
  for (const el of root.querySelectorAll("script, style")) {
    el.remove();
  }
  return root.structuredText
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
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
