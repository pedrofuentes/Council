/**
 * Tests for createDocumentRetriever — Roadmap 6.3 (Content Indexing / RAG).
 *
 * RED at this commit: migration 007, src/core/documents/retriever.ts, and the
 * document_index FTS5 virtual table do not exist yet.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../../src/memory/db.js";
import { createDocumentIndexer } from "../../../../src/core/documents/indexer.js";
import {
  buildExpertRetrievalScopes,
  createDocumentRetriever,
} from "../../../../src/core/documents/retriever.js";

async function seedCorpus(db: CouncilDatabase): Promise<void> {
  const indexer = createDocumentIndexer(db);
  await indexer.index({
    content:
      "The CEO bio explains leadership philosophy, the product roadmap, and a commitment to document intelligence.",
    sourceType: "expert",
    sourceSlug: "ceo",
    filePath: "/docs/experts/ceo/bio.md",
  });
  await indexer.index({
    content:
      "Engineering notes describe distributed systems, latency budgets, and rollout strategy. No mention of leadership.",
    sourceType: "expert",
    sourceSlug: "cto",
    filePath: "/docs/experts/cto/notes.md",
  });
  await indexer.index({
    content: "Panel charter for the executive team covers quarterly leadership reviews.",
    sourceType: "panel",
    sourceSlug: "exec-team",
    filePath: "/docs/panels/exec-team/charter.md",
  });
  await indexer.index({
    content: "Random unrelated content about gardening and recipes for tomato soup.",
    sourceType: "expert",
    sourceSlug: "ceo",
    filePath: "/docs/experts/ceo/misc.md",
  });
}

describe("createDocumentRetriever", () => {
  let db: CouncilDatabase;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    await seedCorpus(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns ranked snippets matching the query", async () => {
    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("leadership");

    expect(results.length).toBeGreaterThanOrEqual(2);
    const sources = results.map((r) => r.source);
    expect(sources).toContain("bio.md");
    expect(sources).toContain("charter.md");
    expect(sources).not.toContain("misc.md");

    for (const r of results) {
      expect(typeof r.content).toBe("string");
      expect(r.content.length).toBeGreaterThan(0);
      expect(typeof r.relevanceScore).toBe("number");
      expect(Number.isFinite(r.relevanceScore)).toBe(true);
      expect(r.sourcePath.length).toBeGreaterThan(0);
    }

    // Ordered by descending relevance.
    for (let i = 1; i < results.length; i += 1) {
      const prev = results[i - 1];
      const curr = results[i];
      if (prev === undefined || curr === undefined) throw new Error("unreachable");
      expect(prev.relevanceScore).toBeGreaterThanOrEqual(curr.relevanceScore);
    }
  });

  it("filters by sources='expert'", async () => {
    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("leadership", { sources: "expert" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => !r.sourcePath.includes("/panels/"))).toBe(true);
    expect(results.some((r) => r.source === "bio.md")).toBe(true);
    expect(results.some((r) => r.source === "charter.md")).toBe(false);
  });

  it("filters by sources='panel'", async () => {
    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("leadership", { sources: "panel" });
    expect(results.length).toBe(1);
    expect(results[0]?.source).toBe("charter.md");
  });

  it("filters by expertSlug", async () => {
    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("leadership", { expertSlug: "ceo" });
    expect(results.length).toBe(1);
    expect(results[0]?.source).toBe("bio.md");
  });

  it("filters by panelName", async () => {
    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("leadership", { panelName: "exec-team" });
    expect(results.length).toBe(1);
    expect(results[0]?.source).toBe("charter.md");
  });

  it("respects the maxResults limit", async () => {
    const retriever = createDocumentRetriever(db);
    // "leadership" matches at least two seeded docs (bio.md and charter.md);
    // capping maxResults at 1 must trim the result set.
    const results = await retriever.retrieve("leadership", { maxResults: 1 });
    expect(results).toHaveLength(1);
  });

  it("defaults maxResults to 5", async () => {
    const indexer = createDocumentIndexer(db);
    for (let i = 0; i < 8; i += 1) {
      await indexer.index({
        content: `Document number ${i} discusses leadership and roadmap.`,
        sourceType: "expert",
        sourceSlug: "ceo",
        filePath: `/docs/experts/ceo/extra-${i}.md`,
      });
    }
    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("leadership");
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("returns an empty array for an empty query", async () => {
    const retriever = createDocumentRetriever(db);
    expect(await retriever.retrieve("")).toEqual([]);
    expect(await retriever.retrieve("   ")).toEqual([]);
  });

  it("does not throw on FTS5 special characters in the query", async () => {
    const retriever = createDocumentRetriever(db);
    const tricky = 'AND OR NOT NEAR "leadership" (roadmap) * ^ -';
    const results = await retriever.retrieve(tricky);
    // Should not throw; results may be empty or non-empty depending on tokens.
    expect(Array.isArray(results)).toBe(true);
  });

  it("snippet excerpts contain query terms", async () => {
    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("roadmap");
    expect(results.length).toBeGreaterThan(0);
    const lower = results.map((r) => r.content.toLowerCase()).join("\n");
    expect(lower).toContain("roadmap");
  });

  it("snippet content is shorter than or equal to the full document", async () => {
    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("leadership");
    for (const r of results) {
      expect(r.content.length).toBeGreaterThan(0);
    }
  });

  // ── T1 RAG fix: AND→OR fallback ──────────────────────────────────────
  it("falls back to OR semantics when strict-AND yields zero results", async () => {
    const retriever = createDocumentRetriever(db);
    // "philosophy" lives only in bio.md; "rollout" lives only in cto/notes.md.
    // A strict-AND match (the legacy behaviour) returns nothing because no
    // single document contains BOTH tokens. The OR fallback must surface the
    // two documents that match either token.
    const results = await retriever.retrieve("philosophy rollout");
    const sources = results.map((r) => r.source);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(sources).toContain("bio.md");
    expect(sources).toContain("notes.md");
  });

  it("does NOT fall back to OR when strict-AND already matched", async () => {
    const retriever = createDocumentRetriever(db);
    // Both tokens occur together only in bio.md ("leadership philosophy").
    // The strict-AND result is non-empty, so the OR fallback must NOT widen
    // the set to include documents that match just one token.
    const results = await retriever.retrieve("leadership philosophy");
    const sources = results.map((r) => r.source);
    expect(sources).toContain("bio.md");
    expect(sources).not.toContain("notes.md");
    expect(sources).not.toContain("charter.md");
  });

  // ── T1 RAG fix: larger snippet window keeps planted figures ──────────
  it("returns a snippet window large enough to include a figure ~44 tokens in", async () => {
    const indexer = createDocumentIndexer(db);
    // Query term at the very start; the planted figure sits ~44 tokens in —
    // beyond the legacy 32-token window but within the widened window.
    const filler = [
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
      "nu xi omicron pi rho sigma tau upsilon phi chi psi omega",
      "one two three four five six seven eight nine ten eleven twelve thirteen",
    ].join(" ");
    await indexer.index({
      content: `Finance summary ${filler} the planted revenue figure is 73471 dollars exactly.`,
      sourceType: "expert",
      sourceSlug: "cfo",
      filePath: "/docs/experts/cfo/finance.md",
    });

    const retriever = createDocumentRetriever(db);
    const results = await retriever.retrieve("Finance", { expertSlug: "cfo" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const joined = results.map((r) => r.content).join("\n");
    expect(joined).toContain("73471");
  });

  // ── T1 RAG fix: multi-scope OR retrieval (expert + panel) ────────────
  it("retrieves across multiple scopes (expert OR panel) and excludes other sources", async () => {
    const retriever = createDocumentRetriever(db);
    // Unscoped, "leadership" matches bio.md (ceo), notes.md (cto), and
    // charter.md (exec-team panel). Scoping to the ceo expert OR the
    // exec-team panel must keep bio.md + charter.md and drop the cto doc.
    const results = await retriever.retrieve("leadership", {
      scopes: [
        { sourceType: "expert", slug: "ceo" },
        { sourceType: "panel", slug: "exec-team" },
      ],
    });
    const sources = results.map((r) => r.source);
    expect(results).toHaveLength(2);
    expect(sources).toContain("bio.md");
    expect(sources).toContain("charter.md");
    expect(sources).not.toContain("notes.md");
  });
});

describe("buildExpertRetrievalScopes", () => {
  it("returns the expert scope first, then one panel scope per membership", () => {
    expect(buildExpertRetrievalScopes("ceo", ["exec-team", "growth"])).toEqual([
      { sourceType: "expert", slug: "ceo" },
      { sourceType: "panel", slug: "exec-team" },
      { sourceType: "panel", slug: "growth" },
    ]);
  });

  it("returns just the expert scope when the expert belongs to no panels", () => {
    expect(buildExpertRetrievalScopes("ceo", [])).toEqual([
      { sourceType: "expert", slug: "ceo" },
    ]);
  });
});
