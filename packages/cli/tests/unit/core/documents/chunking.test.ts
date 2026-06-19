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
