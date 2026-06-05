/**
 * Markdown extractor (T3).
 *
 * Strips CommonMark formatting (headers, bold/italic emphasis, links,
 * images, code fences, blockquotes, list bullets) using a small set of
 * regex passes. Not a full parser — the goal is to extract prose for
 * indexing/search, not to render or round-trip Markdown.
 *
 * Self-registers for `.md` and `.markdown` via the registry's lazy
 * loader so it can be discovered through `getExtractor`.
 */
import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";

function normalizeMarkdown(raw: string): string {
  let s = raw;
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, "");
  s = s.replace(/^\s{0,3}\d+\.\s+/gm, "");
  return s.trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

const markdownExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  const raw = ctx.buffer.toString("utf-8");
  const content = normalizeMarkdown(raw);
  return { content, wordCount: countWords(content) };
};

registerExtractor([".md", ".markdown"], async () => markdownExtractor);
