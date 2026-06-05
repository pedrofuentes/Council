/**
 * RTF extractor (T5).
 *
 * Strips RTF control words, group braces, and decodes a small set of
 * common escape sequences (`\'XX` hex chars, `\~` non-breaking space,
 * `\-` optional hyphen, `\_` non-breaking hyphen) using regex passes.
 * Not a full RTF parser — the goal is to extract prose for indexing,
 * not to render or round-trip RTF.
 *
 * Self-registers for `.rtf`.
 */
import { ExtractionError } from "./errors.js";
import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";

function stripRtf(raw: string): string {
  let s = raw;

  // Remove destination groups like {\*\generator ...}. Replace with a
  // space to preserve the delimiter that originally terminated any
  // adjacent control word. Apply repeatedly to peel off non-nested
  // layers from the outside in.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\{\\\*[^{}]*\}/g, " ");
  } while (s !== prev);

  // Decode hex escape sequences (\'XX) using the byte value as a
  // codepoint — adequate for the Latin-1 / Windows-1252 range that
  // covers the majority of real-world RTF documents.
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );

  // Common symbol escapes.
  s = s.replace(/\\~/g, " ");
  s = s.replace(/\\_/g, "-");
  s = s.replace(/\\-/g, "");

  // Strip control words: \word, \word123, optional trailing space
  // delimiter is consumed (per RTF spec).
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, "");

  // Strip any remaining group braces.
  s = s.replace(/[{}]/g, "");

  // Collapse whitespace and trim.
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n");
  return s.trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

const rtfExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const raw = ctx.buffer.toString("utf-8");
  if (!raw.startsWith("{\\rtf")) {
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: ctx.filename,
      message: "RTF magic-byte check failed: buffer does not start with '{\\rtf'.",
      suggestion: "File does not appear to be a valid RTF document.",
    });
  }
  const content = stripRtf(raw);
  return { content, wordCount: countWords(content) };
};

registerExtractor([".rtf"], async () => rtfExtractor);
