/**
 * Plaintext extractor (T3).
 *
 * Decodes a UTF-8 buffer to a trimmed string. Before returning, applies
 * a binary-content guard: if more than 10% of the underlying bytes are
 * non-printable control characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F,
 * 0x7F), the buffer is rejected with `corrupt-document`. Bytes ≥ 0x80
 * are treated as text because they are valid UTF-8 multi-byte
 * continuations or lead bytes (so genuine UTF-8 prose like "café —
 * naïve" is not flagged as binary).
 *
 * Self-registers for `.txt`.
 */
import { ExtractionError } from "./errors.js";
import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";

const BINARY_THRESHOLD = 0.1;

function isNonPrintableByte(b: number): boolean {
  if (b >= 0x80) return false;
  if (b >= 0x09 && b <= 0x0d) return false;
  if (b >= 0x20 && b <= 0x7e) return false;
  return true;
}

function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let nonPrintable = 0;
  for (const b of buf) {
    if (isNonPrintableByte(b)) nonPrintable += 1;
  }
  return nonPrintable / buf.length > BINARY_THRESHOLD;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

const plaintextExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  if (looksBinary(ctx.buffer)) {
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: ctx.filename,
      message: `Plaintext extractor rejected ${ctx.filename}: high non-printable byte ratio`,
      suggestion: "File appears to be binary — check file type.",
    });
  }
  const content = ctx.buffer.toString("utf-8").trim();
  return { content, wordCount: countWords(content) };
};

registerExtractor([".txt"], async () => plaintextExtractor);
