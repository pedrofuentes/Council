/**
 * Shared ODF (OpenDocument Format) archive helper.
 *
 * ODT, ODS and ODP are all ZIP archives containing a `content.xml`
 * payload. This module factors the common code between the three
 * extractors (ZIP-bomb preflight, sanitized XML parsing, content size
 * cap) so each format-specific module can focus on translating the
 * parsed XML into Markdown.
 *
 * Security:
 *   - ZIP-bomb defenses cap entry count (1000), total uncompressed
 *     size (200 MB), per-entry uncompressed size (20 MB), and per-entry
 *     compression ratio (100:1). The per-entry stream is also aborted
 *     if it decodes more bytes than its declared uncompressed size.
 *   - The XML parser runs with entity processing disabled to prevent
 *     XXE and billion-laughs attacks, and DOCTYPE / non-standard entity
 *     references are stripped from the input before parsing.
 *   - Post-inflate extracted content is capped at 10 MB by callers via
 *     `enforceContentCap`.
 */
import { XMLParser } from "fast-xml-parser";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";

import { ExtractionError } from "./errors.js";

export const MAX_ENTRIES = 1000;
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 100;
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

const CONTENT_XML = "content.xml";

const xmlParser = new XMLParser({
  processEntities: false,
  htmlEntities: false,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err !== null || zip === undefined) {
        reject(err ?? new Error("yauzl returned no zip handle"));
        return;
      }
      resolve(zip);
    });
  });
}

function bombError(filename: string, message: string): ExtractionError {
  return new ExtractionError({
    kind: "zip-bomb-detected",
    filePath: filename,
    message,
    suggestion: "Refuse to process this archive — it exceeds safe decompression limits.",
  });
}

function readEntryBuffer(zip: ZipFile, entry: Entry, filename: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err !== null || stream === undefined) {
        reject(err ?? new Error("yauzl returned no read stream"));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;
      stream.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > entry.uncompressedSize) {
          aborted = true;
          stream.destroy();
          reject(
            bombError(
              filename,
              `Entry "${entry.fileName}" decoded to more bytes than its declared uncompressed size (${String(entry.uncompressedSize)}).`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => {
        if (!aborted) resolve(Buffer.concat(chunks));
      });
      stream.on("error", (streamErr) => {
        if (aborted) return;
        if (/too many bytes/i.test(streamErr.message)) {
          aborted = true;
          reject(
            bombError(
              filename,
              `Entry "${entry.fileName}" decoded to more bytes than its declared uncompressed size (${String(entry.uncompressedSize)}).`,
            ),
          );
          return;
        }
        reject(streamErr);
      });
    });
  });
}

async function readContentXmlBuffer(
  buffer: Buffer,
  filename: string,
  formatLabel: string,
): Promise<Buffer | null> {
  let zip: ZipFile;
  try {
    zip = await openZip(buffer);
  } catch (cause) {
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: filename,
      message: `Failed to open ${formatLabel} archive — not a valid ZIP container.`,
      suggestion: `Verify the file is an uncorrupted ${formatLabel} (OpenDocument) document.`,
      cause,
    });
  }

  return new Promise<Buffer | null>((resolve, reject) => {
    let entryCount = 0;
    let totalUncompressed = 0;
    let contentBuf: Buffer | null = null;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        // best-effort close
      }
      fn();
    };

    zip.on("entry", (entry: Entry) => {
      void (async () => {
        try {
          entryCount++;
          if (entryCount > MAX_ENTRIES) {
            throw bombError(
              filename,
              `${formatLabel} archive contains more than ${String(MAX_ENTRIES)} entries.`,
            );
          }
          if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
            throw bombError(
              filename,
              `ZIP entry "${entry.fileName}" uncompressed size ${String(entry.uncompressedSize)} exceeds per-entry limit ${String(MAX_ENTRY_BYTES)}.`,
            );
          }
          if (
            entry.compressedSize > 0 &&
            entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
          ) {
            throw bombError(
              filename,
              `Entry "${entry.fileName}" exceeds the ${String(MAX_COMPRESSION_RATIO)}:1 compression ratio cap.`,
            );
          }
          totalUncompressed += entry.uncompressedSize;
          if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
            throw bombError(
              filename,
              `${formatLabel} archive exceeds ${String(MAX_UNCOMPRESSED_BYTES)} bytes uncompressed.`,
            );
          }
          if (entry.fileName === CONTENT_XML) {
            contentBuf = await readEntryBuffer(zip, entry, filename);
          }
          if (!settled) {
            zip.readEntry();
          }
        } catch (err) {
          settle(() => reject(err));
        }
      })();
    });
    zip.on("end", () => settle(() => resolve(contentBuf)));
    zip.on("error", (err: Error) => settle(() => reject(err)));
    zip.readEntry();
  });
}

function sanitizeXml(xml: string): string {
  // Strip DOCTYPE declarations (incl. internal subsets with ENTITY
  // definitions) and non-standard entity references that would
  // otherwise be expanded or rejected by the parser. With
  // `processEntities: false` set on the parser, this leaves any XXE
  // payload entirely inert.
  let s = xml.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "");
  s = s.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[a-zA-Z][a-zA-Z0-9]*;/g, "");
  return s;
}

/**
 * Reads `content.xml` out of an ODF ZIP archive, applies all
 * decompression-bomb defenses, and returns the parsed XML tree.
 * Returns `null` when the archive contains no `content.xml` entry.
 */
export async function readOdfContent(
  buffer: Buffer,
  filename: string,
  formatLabel: string,
): Promise<unknown> {
  const contentBuf = await readContentXmlBuffer(buffer, filename, formatLabel);
  if (contentBuf === null) {
    return null;
  }
  try {
    return xmlParser.parse(sanitizeXml(contentBuf.toString("utf-8")));
  } catch {
    return null;
  }
}

/** Throws an `oversize-file` ExtractionError when the running byte
 * total of generated content exceeds `MAX_CONTENT_BYTES`. */
export function enforceContentCap(
  runningBytes: number,
  filename: string,
  formatLabel: string,
): void {
  if (runningBytes > MAX_CONTENT_BYTES) {
    throw new ExtractionError({
      kind: "oversize-file",
      filePath: filename,
      message: `Extracted ${formatLabel} content exceeds ${String(MAX_CONTENT_BYTES)} bytes.`,
      suggestion: `Split the document into smaller files or remove oversized text content.`,
    });
  }
}

/** Type guard for plain object shapes returned by fast-xml-parser. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively concatenates all text content from an XML subtree (the
 * `#text` strings of every descendant element, in source order as
 * preserved by fast-xml-parser, ignoring attribute keys).
 */
export function collectAllText(node: unknown): string {
  const parts: string[] = [];
  const visit = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    if (typeof n === "number" || typeof n === "boolean") {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (!isRecord(n)) return;
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_")) continue;
      visit(value);
    }
  };
  visit(node);
  return parts.join("");
}

/** O(n) word counter (whitespace-separated runs). */
export function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isAsciiWs = code === 0x20 || (code >= 0x09 && code <= 0x0d);
    const isWhitespace = isAsciiWs || (code > 0x7f && /\s/.test(text.charAt(i)));
    if (isWhitespace) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}
