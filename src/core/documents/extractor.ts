/**
 * Document content extraction and normalization (Roadmap 6.1).
 *
 * Reads a document file, normalizes its text content per format, and
 * returns the plain-text body, word count, SHA-256 checksum of the raw
 * bytes, and size. The normalizer is intentionally simple (regex-based);
 * it strips formatting but does not aim to be a full parser.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface DocumentContent {
  readonly path: string;
  readonly filename: string;
  readonly content: string;
  readonly wordCount: number;
  readonly checksum: string;
  readonly sizeBytes: number;
}

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
  return input.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function normalizeMarkdown(raw: string): string {
  let s = raw;
  // Fenced code blocks ```...```
  s = s.replace(/```[\s\S]*?```/g, "");
  // Inline code `...`
  s = s.replace(/`([^`]*)`/g, "$1");
  // Images ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Headers (# at start of line)
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // Bold **text** / __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  // Italic *text* / _text_
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
  // Blockquote markers
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  // List markers
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, "");
  s = s.replace(/^\s{0,3}\d+\.\s+/gm, "");
  return s.trim();
}

function normalizeHtml(raw: string): string {
  let s = raw;
  // Strip script/style content first
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  // Strip all tags
  s = s.replace(/<[^>]+>/g, " ");
  // Decode entities
  s = decodeHtmlEntities(s);
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n");
  return s.trim();
}

function countWords(text: string): number {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length;
}

export async function extractDocument(filePath: string): Promise<DocumentContent> {
  const buf = await fs.readFile(filePath);
  const raw = buf.toString("utf-8");
  const checksum = createHash("sha256").update(buf).digest("hex");
  const ext = path.extname(filePath).toLowerCase();

  let content: string;
  if (ext === ".md" || ext === ".markdown") content = normalizeMarkdown(raw);
  else if (ext === ".html" || ext === ".htm") content = normalizeHtml(raw);
  else content = raw.trim();

  return {
    path: filePath,
    filename: path.basename(filePath),
    content,
    wordCount: countWords(content),
    checksum,
    sizeBytes: buf.byteLength,
  };
}
