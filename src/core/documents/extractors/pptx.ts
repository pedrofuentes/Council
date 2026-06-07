/**
 * PPTX extractor (T9).
 *
 * Reads a `.pptx` ZIP archive with `yauzl`, walks the slide and notes
 * XML parts (`ppt/slides/slideN.xml`, `ppt/notesSlides/notesSlideN.xml`),
 * and produces a Markdown document with one `## Slide N` section per
 * slide. Speaker notes, when present, are rendered as a
 * `> **Speaker Notes:** …` blockquote beneath the corresponding slide.
 *
 * Security:
 *   - ZIP-bomb defenses cap entry count (1000), total uncompressed size
 *     (200 MB), per-entry uncompressed size (20 MB), and per-entry
 *     compression ratio (100:1). The per-entry stream is also aborted
 *     if it decodes more bytes than its declared uncompressed size.
 *   - Post-inflate extracted content is capped at 10 MB to bound
 *     downstream memory use even when individual ZIP entries stay
 *     within their per-entry limits.
 *   - The XML parser runs with entity processing disabled to prevent
 *     XXE and billion-laughs attacks.
 *
 * Self-registers for `.pptx` via the registry's lazy loader.
 */
import { XMLParser } from "fast-xml-parser";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";

import { ExtractionError } from "./errors.js";
import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";

const MAX_ENTRIES = 1000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_PATH = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

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

function readEntryBuffer(
  zip: ZipFile,
  entry: Entry,
  filename: string,
): Promise<Buffer> {
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
        // yauzl validates the decoded stream length against the
        // declared uncompressed size and emits "too many bytes in the
        // stream" when a deflate-compressed entry expands past its
        // header-declared size. Treat this as a zip-bomb signal (a
        // lying header trying to bypass the up-front per-entry cap).
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

function bombError(filename: string, message: string): ExtractionError {
  return new ExtractionError({
    kind: "zip-bomb-detected",
    filePath: filename,
    message,
    suggestion:
      "Refuse to process this archive — it exceeds safe decompression limits.",
  });
}

async function readZipEntries(
  buffer: Buffer,
  filename: string,
): Promise<ReadonlyMap<string, Buffer>> {
  let zip: ZipFile;
  try {
    zip = await openZip(buffer);
  } catch (cause) {
    throw new ExtractionError({
      kind: "corrupt-document",
      filePath: filename,
      message: "Failed to open PPTX archive — not a valid ZIP container.",
      suggestion:
        "Verify the file is an uncorrupted .pptx (Office Open XML) document.",
      cause,
    });
  }

  return new Promise<ReadonlyMap<string, Buffer>>((resolve, reject) => {
    const collected = new Map<string, Buffer>();
    let entryCount = 0;
    let totalUncompressed = 0;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        // best-effort close; ignore double-close errors
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
              `PPTX archive contains more than ${String(MAX_ENTRIES)} entries.`,
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
            entry.uncompressedSize / entry.compressedSize >
              MAX_COMPRESSION_RATIO
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
              `PPTX archive exceeds ${String(MAX_UNCOMPRESSED_BYTES)} bytes uncompressed.`,
            );
          }
          if (
            SLIDE_PATH.test(entry.fileName) ||
            NOTES_PATH.test(entry.fileName)
          ) {
            const data = await readEntryBuffer(zip, entry, filename);
            collected.set(entry.fileName, data);
          }
          if (!settled) {
            zip.readEntry();
          }
        } catch (err) {
          settle(() => reject(err));
        }
      })();
    });
    zip.on("end", () => settle(() => resolve(collected)));
    zip.on("error", (err: Error) => settle(() => reject(err)));
    zip.readEntry();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendRunText(value: unknown, current: string[]): void {
  if (typeof value === "string") {
    current.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    current.push(String(value));
    return;
  }
  if (isRecord(value)) {
    const text = value["#text"];
    if (typeof text === "string" || typeof text === "number") {
      current.push(String(text));
    }
  }
}

function collectText(
  node: unknown,
  paragraphs: string[],
  current: string[],
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, paragraphs, current);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text") continue;
    if (key === "a:p") {
      const items = Array.isArray(value) ? value : [value];
      for (const paragraph of items) {
        const buffer: string[] = [];
        collectText(paragraph, paragraphs, buffer);
        const joined = buffer.join("").trim();
        if (joined.length > 0) paragraphs.push(joined);
      }
      continue;
    }
    if (key === "a:t") {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) appendRunText(item, current);
      continue;
    }
    collectText(value, paragraphs, current);
  }
}

function sanitizeXml(xml: string): string {
  // Defensively strip DOCTYPE declarations (incl. internal subsets with
  // ENTITY definitions) and any non-standard entity references that
  // would otherwise be expanded or rejected by the parser. With
  // `processEntities: false` set on the parser, this leaves the XXE
  // payload entirely inert.
  let s = xml.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "");
  s = s.replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[a-zA-Z][a-zA-Z0-9]*;/g,
    "",
  );
  return s;
}

function extractTextFromXml(xml: string): string {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(sanitizeXml(xml));
  } catch {
    return "";
  }
  const paragraphs: string[] = [];
  collectText(parsed, paragraphs, []);
  return paragraphs.join("\n");
}

function countWords(text: string): number {
  // O(n) time, O(1) space — avoids allocating an O(n) substring array
  // (which `text.split(/\s+/)` would). Matches the same notion of
  // "word" used previously: any maximal run of non-whitespace
  // characters counts as one word. Whitespace classes follow the
  // ECMAScript `\s` definition (covering Unicode whitespace such as
  // NBSP and the Ogham space mark) so behavior is preserved.
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Fast path: ASCII whitespace (space, tab, LF, VT, FF, CR).
    const isAsciiWs =
      code === 0x20 || (code >= 0x09 && code <= 0x0d);
    const isWhitespace =
      isAsciiWs ||
      (code > 0x7f && /\s/.test(text.charAt(i)));
    if (isWhitespace) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

interface SlidePart {
  readonly index: number;
  readonly xml: Buffer;
}

function buildMarkdown(
  slides: readonly SlidePart[],
  notes: ReadonlyMap<number, Buffer>,
  filename: string,
): string {
  const sections: string[] = [];
  let runningBytes = 0;
  const enforceCap = (addition: string): void => {
    runningBytes += Buffer.byteLength(addition, "utf-8");
    if (runningBytes > MAX_CONTENT_BYTES) {
      throw new ExtractionError({
        kind: "oversize-file",
        filePath: filename,
        message: `Extracted PPTX content exceeds ${String(MAX_CONTENT_BYTES)} bytes.`,
        suggestion:
          "Split the presentation into smaller decks or remove oversized text content.",
      });
    }
  };
  for (const slide of slides) {
    const body = extractTextFromXml(slide.xml.toString("utf-8"));
    const lines: string[] = [`## Slide ${String(slide.index)}`, ""];
    if (body.length > 0) lines.push(body);
    const noteBuf = notes.get(slide.index);
    if (noteBuf !== undefined) {
      const noteText = extractTextFromXml(noteBuf.toString("utf-8"));
      if (noteText.length > 0) {
        const flattened = noteText.replace(/\s*\n+\s*/g, " ").trim();
        lines.push("", `> **Speaker Notes:** ${flattened}`);
      }
    }
    const section = lines.join("\n");
    enforceCap(section);
    sections.push(section);
  }
  return sections.join("\n\n").trim();
}

const pptxExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const entries = await readZipEntries(ctx.buffer, ctx.filename);

  const slides: SlidePart[] = [];
  const notes = new Map<number, Buffer>();
  for (const [name, data] of entries) {
    const slideMatch = SLIDE_PATH.exec(name);
    if (slideMatch !== null) {
      slides.push({ index: Number(slideMatch[1]), xml: data });
      continue;
    }
    const notesMatch = NOTES_PATH.exec(name);
    if (notesMatch !== null) {
      notes.set(Number(notesMatch[1]), data);
    }
  }
  slides.sort((a, b) => a.index - b.index);

  const content = buildMarkdown(slides, notes, ctx.filename);
  return {
    content,
    wordCount: countWords(content),
    metadata: { slideCount: slides.length },
  };
};

registerExtractor([".pptx"], async () => pptxExtractor);
