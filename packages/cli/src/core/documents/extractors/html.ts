/**
 * HTML extractor (T3).
 *
 * Removes <script> and <style> elements (issue #344 — their bodies are
 * code, not prose, and would pollute the FTS index), then extracts the
 * remaining text, decodes entities, strips C0 control characters, and
 * collapses whitespace.
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
 * `node-html-parser` walks the DOM recursively (in both `querySelectorAll`
 * and `structuredText`), so a pathologically deep document (>= ~5000
 * nesting levels) overflows the call stack and throws `RangeError`. A
 * single crafted untrusted file must not crash the extractor, so parsing
 * and text extraction are guarded and degrade gracefully to empty content
 * on `RangeError` (the stack-overflow signal) ONLY. Any other parse failure
 * is a genuinely corrupt document and is surfaced through the same
 * `ExtractionError` (`corrupt-document`) taxonomy the peer extractors (pdf,
 * pptx, docx) use, rather than being silently swallowed to empty content
 * (issue #1214).
 *
 * Extraction also honors `ctx.signal`: a pre-aborted signal short-circuits
 * with `ExtractionError` (`extraction-timeout`) before the synchronous parse
 * runs, so an upstream-timed-out extraction does not perform the work
 * (issue #1216) — matching the cooperative-cancellation contract of the peer
 * extractors.
 *
 * Self-registers for `.html` and `.htm`.
 */
import { parse } from "node-html-parser";

import { ExtractionError } from "./errors.js";
import { registerExtractor } from "./registry.js";
import type { ContentExtractor, ExtractedContent, ExtractionContext } from "./types.js";

// Full HTML5 entity decoding means numeric entities (e.g. `&#27;` -> ESC)
// survive into extracted content, which flows to SQLite/FTS and the LLM
// prompt. The terminal is protected by stripControlChars, but the indexed
// content is not, so strip the C0 control range (plus DEL) here as
// defense-in-depth — keeping tab/newline/CR, which whitespace collapsing
// normalizes (issue #1215).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Collapse whitespace in a single linear pass (issue #933). Each maximal
 * run of whitespace becomes one newline if it contained a line break, else
 * a single space; leading/trailing whitespace is dropped. This replaces the
 * chained space and "\s*\n\s*"-style passes, whose pattern scaled
 * super-linearly (~4x per doubling) on a long whitespace-only run. The
 * scanner is O(n) with no regex backtracking.
 */
function collapseWhitespace(text: string): string {
  const parts: string[] = [];
  let runHasNewline = false;
  let inRun = false;
  for (const c of text) {
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      inRun = true;
      if (c === "\n" || c === "\r") runHasNewline = true;
      continue;
    }
    if (inRun) {
      if (parts.length > 0) parts.push(runHasNewline ? "\n" : " ");
      inRun = false;
      runHasNewline = false;
    }
    parts.push(c);
  }
  return parts.join("");
}

function normalizeHtml(raw: string, filename: string): string {
  try {
    const root = parse(raw, { comment: false });
    for (const el of root.querySelectorAll("script, style")) {
      el.remove();
    }
    return collapseWhitespace(root.structuredText.replace(CONTROL_CHARS, ""));
  } catch (err) {
    // A pathologically deep document overflows the parser's recursive DOM
    // walk and throws `RangeError`; that single crafted untrusted file must
    // not crash extraction, so degrade gracefully to empty content on
    // `RangeError` ONLY. Any other failure is a genuinely corrupt document
    // and is surfaced through the same `corrupt-document` taxonomy the peer
    // extractors use, never silently swallowed to empty content (issue
    // #1214).
    if (err instanceof RangeError) {
      return "";
    }
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: filename,
      message: `Failed to parse HTML: ${err instanceof Error ? err.message : String(err)}`,
      suggestion: "The file may be corrupt or not valid HTML.",
      cause: err,
    });
  }
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

const htmlExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  // Honor cooperative cancellation before running the synchronous parse, so
  // an upstream-timed-out extraction does no work (issue #1216). Matches the
  // pre-work abort checkpoint of the peer extractors (pdf, pptx, ai-fallback).
  if (ctx.signal?.aborted === true) {
    throw new ExtractionError({
      kind: "extraction-timeout",
      filePath: ctx.filename,
      message: "HTML extraction aborted before it began.",
      cause: ctx.signal.reason,
    });
  }

  const raw = ctx.buffer.toString("utf-8");
  const content = normalizeHtml(raw, ctx.filename);
  return { content, wordCount: countWords(content) };
};

registerExtractor([".html", ".htm"], async () => htmlExtractor);
