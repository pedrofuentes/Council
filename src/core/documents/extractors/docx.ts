/**
 * DOCX extractor (T7).
 *
 * Converts Office Open XML word-processing documents (.docx) to
 * markdown via mammoth. Mammoth handles ZIP decompression and OOXML
 * parsing internally; the upstream `extractor.ts` already enforces a
 * size cap on the buffer it hands us, so ZIP-bomb amplification is
 * bounded by that cap.
 *
 * Failures are mapped to the typed taxonomy: parse-time errors whose
 * message hints at password protection become `encrypted-document`,
 * everything else (random bytes, truncated archives, missing
 * `word/document.xml`) becomes `corrupt-document`.
 *
 * Self-registers for `.docx` via the registry's lazy loader.
 */
import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";
import { ExtractionError } from "./errors.js";

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

function isEncryptedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return msg.includes("encrypt") || msg.includes("password");
}

const docxExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const mammoth = await import("mammoth");

  try {
    const result = await mammoth.convertToMarkdown({ buffer: ctx.buffer });
    const content = result.value.trim();
    return { content, wordCount: countWords(content) };
  } catch (error: unknown) {
    if (isEncryptedError(error)) {
      throw new ExtractionError({
        kind: "encrypted-document",
        filePath: ctx.filename,
        message: `DOCX file appears to be password-protected: ${ctx.filename}`,
        suggestion: "Remove password protection and re-add the file.",
        cause: error,
      });
    }
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: ctx.filename,
      message: `Failed to extract DOCX: ${ctx.filename}`,
      suggestion: "The file may be corrupted — try re-saving from Word.",
      cause: error,
    });
  }
};

registerExtractor([".docx"], async () => docxExtractor);
