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

/**
 * Strip RTF destination groups like `{\*\generator ...}` in a single
 * O(n) pass. Tracks brace depth and, when entering a `{\*` group at
 * the current depth, marks a "skip region" that ends when we close
 * back below the entry depth. Handles arbitrary nesting without the
 * quadratic blow-up of an iterative innermost-regex peel loop.
 *
 * Returns the input with each destination group replaced by a single
 * space (preserving the delimiter that would otherwise terminate an
 * adjacent control word).
 */
function stripDestinationGroups(input: string): string {
  const out: string[] = [];
  let depth = 0;
  let skipDepth = -1;
  let i = 0;

  while (i < input.length) {
    const ch = input[i] as string;

    if (ch === "{") {
      if (
        skipDepth < 0 &&
        i + 2 < input.length &&
        input[i + 1] === "\\" &&
        input[i + 2] === "*"
      ) {
        skipDepth = depth;
        depth++;
        i += 3;
        continue;
      }
      depth++;
      if (skipDepth < 0) out.push(ch);
      i++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (skipDepth >= 0 && depth <= skipDepth) {
        skipDepth = -1;
        out.push(" ");
      } else if (skipDepth < 0) {
        out.push(ch);
      }
      i++;
      continue;
    }

    if (skipDepth < 0) out.push(ch);
    i++;
  }

  return out.join("");
}

function stripRtf(raw: string): string {
  let s = stripDestinationGroups(raw);

  // Decode hex escape sequences (\'XX) using the byte value as a
  // codepoint — correct for Latin-1 (ISO-8859-1), which covers the
  // majority of real-world RTF documents. This is NOT a full
  // Windows-1252 decode: bytes 0x80-0x9F map to C1 control
  // codepoints here instead of the printable glyphs (curly quotes,
  // em/en dash, etc.) Windows-1252 assigns to that range.
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
