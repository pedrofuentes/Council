/**
 * DOCX extractor (T7).
 *
 * Converts Office Open XML word-processing documents (.docx) to
 * markdown via mammoth. Mammoth handles ZIP decompression and OOXML
 * parsing internally, but it performs no decompression-bomb checks of
 * its own: a crafted .docx well under the upstream size cap can still
 * expand to many gigabytes of memory during DEFLATE inflation. To
 * defend against that we run a `yauzl` preflight over the central
 * directory and reject archives that exceed conservative entry-count,
 * uncompressed-total, and per-entry ratio limits before mammoth ever
 * touches the buffer.
 *
 * Failures are mapped to the typed taxonomy: preflight rejections are
 * `zip-bomb-detected`; unparseable archives and parse-time errors
 * (random bytes, truncated archives, missing `word/document.xml`)
 * become `corrupt-document`; mammoth errors hinting at password
 * protection become `encrypted-document`.
 *
 * Self-registers for `.docx` via the registry's lazy loader.
 */
import * as yauzl from "yauzl";

import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";
import { ExtractionError } from "./errors.js";

const MAX_ENTRIES = 1000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MiB
const MAX_RATIO = 100;

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

function openZipBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipFile) => {
      if (err !== null && err !== undefined) {
        reject(err);
        return;
      }
      if (zipFile === undefined) {
        reject(new Error("yauzl returned no zip file"));
        return;
      }
      resolve(zipFile);
    });
  });
}

async function preflightZip(buffer: Buffer, filename: string): Promise<void> {
  let zipFile: yauzl.ZipFile;
  try {
    zipFile = await openZipBuffer(buffer);
  } catch (error: unknown) {
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: filename,
      message: `Failed to parse DOCX archive: ${filename}`,
      suggestion: "The file may be corrupted — try re-saving from Word.",
      cause: error,
    });
  }

  await new Promise<void>((resolve, reject) => {
    let entryCount = 0;
    let totalUncompressed = 0;

    zipFile.on("entry", (entry: yauzl.Entry) => {
      entryCount++;
      if (entryCount > MAX_ENTRIES) {
        reject(
          new ExtractionError({
            kind: "zip-bomb-detected",
            filePath: filename,
            message: `DOCX archive has more than ${MAX_ENTRIES} entries`,
            suggestion: "File has suspicious structure.",
          }),
        );
        return;
      }

      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        reject(
          new ExtractionError({
            kind: "zip-bomb-detected",
            filePath: filename,
            message: `DOCX archive uncompressed total exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`,
            suggestion: "File has suspicious compression characteristics.",
          }),
        );
        return;
      }

      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > MAX_RATIO
      ) {
        const ratio = (entry.uncompressedSize / entry.compressedSize).toFixed(0);
        reject(
          new ExtractionError({
            kind: "zip-bomb-detected",
            filePath: filename,
            message: `DOCX entry compression ratio ${ratio}:1 exceeds limit ${MAX_RATIO}:1`,
            suggestion: "File has suspicious compression characteristics.",
          }),
        );
        return;
      }

      zipFile.readEntry();
    });

    zipFile.on("end", () => {
      resolve();
    });

    zipFile.on("error", (err: Error) => {
      reject(
        new ExtractionError({
          kind: "corrupt-document",
          filePath: filename,
          message: `Failed to read DOCX archive entries: ${filename}`,
          suggestion: "The file may be corrupted — try re-saving from Word.",
          cause: err,
        }),
      );
    });

    zipFile.readEntry();
  });
}

const docxExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  await preflightZip(ctx.buffer, ctx.filename);

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
