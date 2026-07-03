import { stripControlChars, toSingleLineDisplay } from "../strip-control-chars.js";

export function sanitizeExportBlock(text: string): string {
  return stripControlChars(text.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n"));
}

export function sanitizeExportLine(text: string): string {
  return toSingleLineDisplay(text);
}

export function sanitizeExportBlockLines(text: string): readonly string[] {
  return sanitizeExportBlock(text).split("\n");
}

/**
 * Neutralize a leading block-level Markdown marker on a single line so
 * untrusted transcript text emitted inside a blockquote (`> ${line}`) can
 * never open a nested block and forge document structure (outline spoofing —
 * #2110 in export.ts, #2123 in export-share.ts). CommonMark honours block
 * markers INSIDE a blockquote, so a `> ` prefix does NOT suppress them:
 *   - `> ## X`  -> ATX heading
 *   - `> ---`   -> thematic break (or a setext-H2 underline beneath text)
 *   - `> ===`   -> setext-H1 underline (never a thematic break)
 *   - `> 1. x`  -> ordered list (any 1-9 digit start, `.` or `)` delimiter)
 *   - `> ``` `  -> fenced code
 *   - `> <x>`   -> raw HTML
 *   - `>     x` -> indented code
 *
 * Three steps, in order:
 *   1. Strip leading indentation. A 4+ column indent opens an INDENTED code
 *      block, and unlike the punctuation markers below there is no character
 *      to escape (the code block would swallow an escaped marker as literal
 *      text). De-indenting keeps the content at the paragraph column so it
 *      can never start a code block.
 *   2. Backslash-escape a single leading block-punctuation marker — ATX
 *      headings (`#`), setext underlines (`=`), thematic breaks / list bullets
 *      (`-`/`*`/`+`/`_`), blockquotes (`>`), fenced code (`` ` ``/`~`) and
 *      raw-HTML (`<`) — so the de-indented line parses as a literal paragraph
 *      while preserving the visible text.
 *   3. Backslash-escape a leading ORDERED-list marker: 1-9 digits followed by
 *      `.` or `)` and then a space/tab or end of line (e.g. `1. x` -> `1\. x`),
 *      so it cannot open an `<ol>`. The trailing-delimiter guard leaves inline
 *      decimals such as `3.14` untouched.
 */
export function escapeBlockLeadingMarkdown(line: string): string {
  return line
    .replace(/^[ \t]+/, "")
    .replace(/^([#>=~`*+_<-])/, "\\$1")
    .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, "$1\\$2");
}
