import { describe, expect, it, vi } from "vitest";

import type { ExpertDocument } from "../../../src/memory/repositories/document-repository.js";
import { createExpertDocumentsSource } from "../../../src/tui/adapters/expert-documents.js";

const documentFor = (overrides: Partial<ExpertDocument>): ExpertDocument => ({
  id: "doc-1",
  expertSlug: "cto",
  filePath: "/notes/roadmap.md",
  filename: "roadmap.md",
  checksum: "abc123",
  sizeBytes: 42,
  wordCount: 7,
  status: "processed",
  processedAt: "2026-06-23T00:00:00.000Z",
  createdAt: "2026-06-22T00:00:00.000Z",
  ...overrides,
});

describe("createExpertDocumentsSource", () => {
  it("lists non-removed documents with sanitized filenames", async () => {
    const source = createExpertDocumentsSource({
      repo: {
        findByExpert: async () => [
          documentFor({ id: "active", filename: "roadmap\n\u001B[31m.md" }),
          documentFor({ id: "removed", filename: "old.md", status: "removed" }),
        ],
        markRemoved: async () => undefined,
      },
      indexer: { remove: async () => undefined },
    });

    await expect(source.list("cto")).resolves.toEqual([
      {
        id: "active",
        filename: "roadmap .md",
        sizeBytes: 42,
        wordCount: 7,
        status: "processed",
        processedAt: "2026-06-23T00:00:00.000Z",
      },
    ]);
  });

  it("marks a document removed before deleting its index entry", async () => {
    const calls: string[] = [];
    const markRemoved = vi.fn(async () => {
      calls.push("markRemoved");
    });
    const remove = vi.fn(async () => {
      calls.push("indexer.remove");
    });
    const source = createExpertDocumentsSource({
      repo: {
        findByExpert: async () => [documentFor({ id: "doc-1", filePath: "/notes/roadmap.md" })],
        markRemoved,
      },
      indexer: { remove },
    });

    await expect(source.remove("cto", "doc-1")).resolves.toEqual({ ftsCleanupFailed: false });

    expect(markRemoved).toHaveBeenCalledWith("doc-1");
    expect(remove).toHaveBeenCalledWith("/notes/roadmap.md");
    expect(calls).toEqual(["markRemoved", "indexer.remove"]);
  });

  it("reports FTS cleanup failure after the row is marked removed", async () => {
    const markRemoved = vi.fn(async () => undefined);
    const remove = vi.fn(async () => {
      throw new Error("fts unavailable");
    });
    const source = createExpertDocumentsSource({
      repo: {
        findByExpert: async () => [documentFor({ id: "doc-1" })],
        markRemoved,
      },
      indexer: { remove },
    });

    await expect(source.remove("cto", "doc-1")).resolves.toEqual({ ftsCleanupFailed: true });

    expect(markRemoved).toHaveBeenCalledWith("doc-1");
    expect(remove).toHaveBeenCalledWith("/notes/roadmap.md");
  });

  it("throws when the document id is missing or already removed", async () => {
    const markRemoved = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const source = createExpertDocumentsSource({
      repo: {
        findByExpert: async () => [documentFor({ id: "removed", status: "removed" })],
        markRemoved,
      },
      indexer: { remove },
    });

    await expect(source.remove("cto", "missing")).rejects.toThrow(
      'Document "missing" not found for expert "cto".',
    );
    await expect(source.remove("cto", "removed")).rejects.toThrow(
      'Document "removed" not found for expert "cto".',
    );
    expect(markRemoved).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
