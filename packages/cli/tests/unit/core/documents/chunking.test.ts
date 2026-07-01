/**
 * Tests for chunkText — sentence-aligned, size-bounded document chunking
 * (T01: PDF/DOCX retrieval-truncation fix).
 *
 * RED at this commit: src/core/documents/chunking.ts does not exist yet.
 *
 * Rationale: the RAG index previously stored one FTS5 row per document and
 * served retrieval results through `snippet(..., 64)`, which crops long prose
 * (PDF/DOCX) mid-sentence with an ellipsis while short table-shaped content
 * (XLSX/CSV/PPTX/ODT) fits inside the 64-token window untouched. Splitting a
 * document into sentence-aligned, bounded chunks at index time lets retrieval
 * return a whole chunk verbatim — full sentences, no mid-sentence crop.
 */
import { describe, expect, it } from "vitest";

import { chunkText, DEFAULT_CHUNK_MAX_CHARS } from "../../../../src/core/documents/chunking.js";

const FACT =
  "The project codename is BLUEJAY and it was reviewed-by Alice Martinez on the fourteenth of March. " +
  "The deployment window opens at midnight UTC and closes six hours later. " +
  "All changes must be reviewed-by two senior engineers before merge. " +
  "The rollback procedure requires running the restore script from the backup vault. " +
  "Performance budgets cap the page load at two hundred milliseconds. " +
  "The on-call rotation spans four engineers across two time zones. " +
  "Incident severity one requires paging the director within fifteen minutes. " +
  "The data retention policy keeps logs for ninety days and metrics for one year.";

function words(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Deterministic, whitespace-free string of the given length — simulates a
 * single unbreakable "token" (e.g. a long identifier, hash, or URL) with no
 * spaces for `hardSplit` to break on. Cycling the alphabet (rather than
 * repeating one character) means a dropped, duplicated, or reordered
 * character changes the string, so exact-equality checks against it actually
 * catch those regressions.
 */
function unbrokenToken(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[i % alphabet.length];
  return out;
}

describe("chunkText", () => {
  it("returns an empty array for empty or whitespace-only content", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  it("returns a single chunk when content fits within the cap", () => {
    const chunks = chunkText(FACT, { maxChars: 2000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("BLUEJAY");
    expect(chunks[0]).toContain("ninety days and metrics for one year");
  });

  it("keeps a multi-sentence fact intact when it fits the cap", () => {
    const chunks = chunkText(FACT, { maxChars: 2000 });
    // The whole fact — first sentence through last — lives in one chunk.
    expect(chunks[0]).toBe(FACT.trim());
  });

  it("never emits a chunk larger than the cap when sentences are bounded", () => {
    const chunks = chunkText(FACT, { maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(200);
    }
  });

  it("splits at sentence boundaries — every chunk ends sentence-complete", () => {
    const chunks = chunkText(FACT, { maxChars: 200 });
    for (const c of chunks) {
      // Each emitted chunk must end on a sentence terminator, never mid-sentence.
      expect(c.trimEnd()).toMatch(/[.!?]$/);
    }
  });

  it("preserves every word in order across chunk boundaries (no content loss)", () => {
    const chunks = chunkText(FACT, { maxChars: 200 });
    const rejoined = chunks.flatMap((c) => words(c));
    expect(rejoined).toEqual(words(FACT));
  });

  it("hard-splits a single sentence longer than the cap on word boundaries", () => {
    const longSentence = `Numbers ${Array.from({ length: 80 }, (_, i) => `n${i}`).join(" ")} end`;
    const chunks = chunkText(longSentence, { maxChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
    // No word is split across the boundary.
    expect(chunks.flatMap((c) => words(c))).toEqual(words(longSentence));
  });

  it("keeps a single unbroken token exactly at the cap as one chunk (no char-split at the boundary)", () => {
    // Regression guard for the "no-split" side of the hardSplit char-fallback
    // boundary (chunking.ts hardSplit, ~lines 84-89): a token whose length
    // equals maxChars must NOT be sliced — `token.length > maxChars` is
    // strictly greater-than, so an equal-length token takes the untouched path.
    const token = unbrokenToken(DEFAULT_CHUNK_MAX_CHARS);
    const chunks = chunkText(token, { maxChars: DEFAULT_CHUNK_MAX_CHARS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(token);
    expect(chunks[0].length).toBe(DEFAULT_CHUNK_MAX_CHARS);
  });

  it("hard-splits a single unbroken token longer than the cap on character boundaries, with no data loss", () => {
    // Direct regression test for #1092: the hardSplit char-fallback branch
    // (chunking.ts ~lines 84-89) only fires when a lone token — no
    // whitespace anywhere for the word-boundary split to use — exceeds
    // maxChars. A 2000-char run (well over the 1200-char default cap)
    // forces that fallback instead of the word-boundary path exercised by
    // the "hard-splits a single sentence..." test above.
    const maxChars = DEFAULT_CHUNK_MAX_CHARS;
    const token = unbrokenToken(maxChars + 800);
    const chunks = chunkText(token, { maxChars });

    // More than one chunk is produced — the token did not fit in a single chunk.
    expect(chunks.length).toBeGreaterThan(1);
    // Every produced chunk is bounded by maxChars.
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(maxChars);
    }
    // No character loss: concatenating the chunks reconstructs the original
    // token exactly (stronger than a length check — also catches dropped,
    // duplicated, or reordered characters).
    expect(chunks.join("")).toBe(token);
    expect(chunks.reduce((sum, c) => sum + c.length, 0)).toBe(token.length);
  });

  it("treats short table-shaped content as a single chunk (XLSX/CSV/PPTX regression guard)", () => {
    const table =
      "## Sheet1\n| key | value |\n| --- | --- |\n| codename | BLUEJAY |\n| owner | Alice Martinez |";
    const chunks = chunkText(table, { maxChars: DEFAULT_CHUNK_MAX_CHARS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("BLUEJAY");
    expect(chunks[0]).toContain("Alice Martinez");
  });

  it("exposes a positive default cap and chunks long input without an explicit cap", () => {
    expect(DEFAULT_CHUNK_MAX_CHARS).toBeGreaterThan(0);
    const big = `${FACT} `.repeat(40);
    const chunks = chunkText(big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DEFAULT_CHUNK_MAX_CHARS);
    }
  });
});
