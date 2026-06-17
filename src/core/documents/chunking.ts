/**
 * Sentence-aligned, size-bounded document chunking (T01).
 *
 * The RAG index originally stored one FTS5 row per document and served
 * retrieval through `snippet(document_index, 0, '', '', '...', 64)`. That
 * 64-token window crops long prose (PDF/DOCX) mid-sentence with a trailing
 * ellipsis, while short table-shaped content (XLSX/CSV/PPTX/ODT) fits inside
 * the window untouched — which is why those formats appeared to extract
 * "completely" and PDF/DOCX did not. The extraction stage is sound; the
 * truncation was purely a retrieval artifact.
 *
 * {@link chunkText} splits extracted content into ordered, bounded chunks
 * that break only at sentence terminators or line/paragraph boundaries.
 * Indexing one FTS5 row per chunk (see {@link "./indexer.js"}) lets the
 * retriever return a whole matched chunk verbatim — full sentences, no
 * mid-sentence crop — while keeping each injected excerpt within a
 * predictable size budget.
 *
 * Guarantees:
 *   - Every word of the input is preserved, in order, across the returned
 *     chunks (no content is dropped or reordered).
 *   - No emitted chunk exceeds `maxChars`. A single sentence longer than the
 *     cap is hard-split on word boundaries; a single word longer than the cap
 *     is split on character boundaries as a last resort.
 *   - Splits land on sentence terminators (`.`/`!`/`?` + trailing quote/
 *     bracket + whitespace) or on runs of newlines, never inside a sentence
 *     when avoidable.
 */

/**
 * Default per-chunk character ceiling. Chosen so a typical multi-sentence
 * fact (a few hundred characters) stays within a single chunk while a full
 * page of prose splits into a handful of chunks, keeping injected reference
 * excerpts well under the convene/debate `REFERENCE_DOCS_CHAR_CAP` budget.
 */
export const DEFAULT_CHUNK_MAX_CHARS = 1200;

export interface ChunkOptions {
  /** Maximum characters per chunk. Defaults to {@link DEFAULT_CHUNK_MAX_CHARS}. */
  readonly maxChars?: number;
}

/**
 * Split `content` into sentence/line-aligned segments, preserving the exact
 * original text (each segment ends with its trailing terminator+whitespace or
 * newline run, so concatenating the segments reproduces the input). The final
 * segment carries any trailing remainder with no boundary.
 */
function splitIntoSegments(content: string): string[] {
  const segments: string[] = [];
  // A boundary is a sentence terminator (with optional closing quote/bracket)
  // followed by whitespace, OR a run of one or more newlines.
  const boundary = /([.!?]["')\]]*\s+)|(\n+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(content)) !== null) {
    const end = match.index + match[0].length;
    segments.push(content.slice(lastIndex, end));
    lastIndex = end;
    // Guard against a zero-length match looping forever.
    if (boundary.lastIndex <= match.index) boundary.lastIndex = match.index + 1;
  }
  if (lastIndex < content.length) {
    segments.push(content.slice(lastIndex));
  }
  return segments;
}

/**
 * Break a single oversized segment into pieces no longer than `maxChars`,
 * splitting on whitespace so words stay intact. A lone word longer than the
 * cap is split on character boundaries as a final fallback.
 */
function hardSplit(segment: string, maxChars: number): string[] {
  const pieces: string[] = [];
  const tokens = segment.split(/(\s+)/); // keep whitespace tokens
  let current = "";
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) pieces.push(trimmed);
    current = "";
  };
  for (const token of tokens) {
    if (token.length > maxChars) {
      // A single token longer than the cap: emit current, then slice the token.
      flush();
      for (let i = 0; i < token.length; i += maxChars) {
        pieces.push(token.slice(i, i + maxChars));
      }
      continue;
    }
    if (current.length + token.length > maxChars && current.length > 0) {
      flush();
    }
    current += token;
  }
  flush();
  return pieces;
}

/**
 * Split extracted document content into ordered, sentence-aligned chunks each
 * no longer than `maxChars`. Returns an empty array for empty/whitespace-only
 * input. See the module header for guarantees.
 */
export function chunkText(content: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? DEFAULT_CHUNK_MAX_CHARS;
  if (content.trim().length === 0) return [];

  const segments = splitIntoSegments(content);
  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) chunks.push(trimmed);
    current = "";
  };

  for (const segment of segments) {
    if (segment.length > maxChars) {
      // Segment alone overflows: emit the pending chunk, then hard-split it.
      flush();
      for (const piece of hardSplit(segment, maxChars)) chunks.push(piece);
      continue;
    }
    if (current.length + segment.length > maxChars && current.length > 0) {
      flush();
    }
    current += segment;
  }
  flush();

  return chunks;
}
