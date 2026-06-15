/**
 * Tests for the reference-block helpers extracted to core (T1 RAG fix).
 *
 * `appendReferenceDocuments` itself is exercised in detail by
 * `tests/unit/cli/commands/chat-advanced.test.ts`; here we cover the new
 * `capSnippetsByChars` token-budget helper and the `REFERENCE_DOCS_CHAR_CAP`
 * default used to bound injected reference text in convene/Debate.
 */
import { describe, expect, it } from "vitest";

import {
  capSnippetsByChars,
  REFERENCE_DOCS_CHAR_CAP,
} from "../../../../src/core/documents/reference-block.js";
import type { DocumentSnippet } from "../../../../src/core/documents/retriever.js";

function snip(content: string, relevanceScore = 1): DocumentSnippet {
  return { source: "doc.md", sourcePath: "/docs/doc.md", content, relevanceScore };
}

describe("capSnippetsByChars", () => {
  it("returns the input array unchanged when total content fits the cap", () => {
    const snippets = [snip("aaa"), snip("bbb")];
    expect(capSnippetsByChars(snippets, 100)).toBe(snippets);
  });

  it("drops the least-relevant (trailing) snippets until under the cap", () => {
    const snippets = [snip("a".repeat(10)), snip("b".repeat(10)), snip("c".repeat(10))];
    // 10 + 10 = 20 (fits), + 10 = 30 (> 25) → third snippet dropped.
    const out = capSnippetsByChars(snippets, 25);
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe("a".repeat(10));
    expect(out[1]?.content).toBe("b".repeat(10));
  });

  it("always keeps the single most-relevant snippet even if it alone exceeds the cap", () => {
    const snippets = [snip("a".repeat(50)), snip("b".repeat(10))];
    const out = capSnippetsByChars(snippets, 5);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe("a".repeat(50));
  });

  it("returns an empty array unchanged", () => {
    const empty: readonly DocumentSnippet[] = [];
    expect(capSnippetsByChars(empty, 10)).toBe(empty);
  });
});

describe("REFERENCE_DOCS_CHAR_CAP", () => {
  it("is a sane positive default budget", () => {
    expect(REFERENCE_DOCS_CHAR_CAP).toBeGreaterThan(0);
  });
});
