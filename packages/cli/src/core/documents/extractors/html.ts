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

/**
 * Returns the index of the first real `prefix` tag at/after `from` — one
 * whose following character is not alphanumeric, so `<script` does not match
 * `<scripts>` and `</script` does not match `</scripture>`. Returns -1 if
 * none is found.
 */
function findTag(lower: string, prefix: string, from: number): number {
  let idx = lower.indexOf(prefix, from);
  while (idx !== -1) {
    const after = lower[idx + prefix.length];
    if (after === undefined || !/[a-z0-9]/.test(after)) return idx;
    idx = lower.indexOf(prefix, idx + 1);
  }
  return -1;
}

/**
 * Quote-aware scan: given the index of a `<`, return the index of the `>`
 * that ends the tag, skipping any `>` that appears inside a quoted
 * attribute value. Returns -1 if the tag is never closed.
 */
function scanTagEnd(s: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j;
    }
  }
  return -1;
}

/**
 * Linear, ReDoS-proof removal of `<tag>...</tag>` blocks (script/style).
 *
 * A single O(N) forward pass with a quote-aware tag scanner — no regex
 * backtracking (ReDoS-proof) and no `>`-inside-quoted-attribute bypass.
 * The block is extended over any *orphan* close tag (a `</tag>` not preceded
 * by a new `<tag>` open) so a crafted close such as `</script attr="a>b">`
 * cannot smuggle the script body back into the extracted text, while
 * genuinely separate sibling blocks are still treated independently.
 */
function stripTagBlocks(html: string, tag: string): string {
  const lower = html.toLowerCase();
  const open = "<" + tag;
  const close = "</" + tag;
  let out = "";
  let i = 0;
  while (i < html.length) {
    const start = findTag(lower, open, i);
    if (start === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, start);
    const openEnd = scanTagEnd(html, start);
    if (openEnd === -1) break; // malformed open tag -> drop the rest
    const firstClose = findTag(lower, close, openEnd + 1);
    if (firstClose === -1) {
      i = html.length; // no close tag -> drop body to EOF
      continue;
    }
    let closeEnd = scanTagEnd(html, firstClose);
    if (closeEnd === -1) break; // malformed close tag -> drop the rest
    // First real open tag after this block's open — computed ONCE (a single
    // O(N) scan), not per orphan-close iteration, so the whole pass stays
    // linear and can't be driven into O(N^2) by many trailing close tags.
    const nextOpen = findTag(lower, open, openEnd + 1);
    for (;;) {
      const nextClose = findTag(lower, close, closeEnd + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) break; // a sibling block starts first
      const nextEnd = scanTagEnd(html, nextClose);
      if (nextEnd === -1) {
        closeEnd = html.length - 1;
        break;
      }
      closeEnd = nextEnd;
    }
    i = closeEnd + 1;
  }
  return out;
}

function normalizeHtml(raw: string): string {
  let s = raw;
  s = stripTagBlocks(s, "script");
  s = stripTagBlocks(s, "style");
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
