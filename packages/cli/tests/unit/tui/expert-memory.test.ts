import { describe, expect, it, vi } from "vitest";

import type { PersonaProfile } from "../../../src/core/documents/profile-analyzer.js";
import type { ExpertDocument } from "../../../src/memory/repositories/document-repository.js";
import {
  createExpertMemorySource,
  type ExpertMemoryDeps,
} from "../../../src/tui/adapters/expert-memory.js";

const profileFor = (overrides: Partial<PersonaProfile> = {}): PersonaProfile => ({
  communicationStyle: "Direct and concise",
  decisionPatterns: ["Weighs tradeoffs"],
  biases: ["Optimism bias"],
  vocabulary: ["leverage"],
  epistemicStance: "Evidence-weighted",
  documentCount: 3,
  totalWords: 1234,
  lastUpdated: "2026-06-23T00:00:00.000Z",
  ...overrides,
});

const documentFor = (overrides: Partial<ExpertDocument> = {}): ExpertDocument => ({
  id: "doc-1",
  expertSlug: "cto",
  filePath: "/notes/roadmap.md",
  filename: "roadmap.md",
  checksum: "abc123",
  sizeBytes: 10,
  wordCount: 5,
  status: "processed",
  processedAt: null,
  createdAt: "2026-06-22T00:00:00.000Z",
  ...overrides,
});

const createDeps = (
  overrides: {
    findBySlug?: (slug: string) => Promise<PersonaProfile | null>;
    findByExpert?: (slug: string) => Promise<readonly ExpertDocument[]>;
  } = {},
): ExpertMemoryDeps => ({
  profileRepo: { findBySlug: overrides.findBySlug ?? (async () => null) },
  documentRepo: { findByExpert: overrides.findByExpert ?? (async () => []) },
});

describe("createExpertMemorySource", () => {
  it("maps a seeded persona profile into a sanitized memory view", async () => {
    const source = createExpertMemorySource(
      createDeps({
        findBySlug: async (slug) => (slug === "cto" ? profileFor() : null),
        findByExpert: async () => [
          documentFor({ id: "a", filename: "roadmap.md", wordCount: 100 }),
          documentFor({ id: "b", filename: "vision.md", wordCount: 50 }),
          documentFor({ id: "removed", filename: "old.md", wordCount: 999, status: "removed" }),
        ],
      }),
    );

    await expect(source.load("cto")).resolves.toEqual({
      hasMemory: true,
      communicationStyle: "Direct and concise",
      decisionPatterns: ["Weighs tradeoffs"],
      biases: ["Optimism bias"],
      vocabulary: ["leverage"],
      epistemicStance: "Evidence-weighted",
      documentCount: 3,
      totalWords: 1234,
      lastUpdated: "2026-06-23T00:00:00.000Z",
      documents: { count: 2, totalWords: 150, filenames: ["roadmap.md", "vision.md"] },
    });
  });

  it("returns a defined no-memory view when the profile is absent (does not throw)", async () => {
    const findByExpert = vi.fn(async () => [documentFor()]);
    const source = createExpertMemorySource(
      createDeps({ findBySlug: async () => null, findByExpert }),
    );

    await expect(source.load("missing")).resolves.toEqual({
      hasMemory: false,
      communicationStyle: "",
      decisionPatterns: [],
      biases: [],
      vocabulary: [],
      epistemicStance: "",
      documentCount: 0,
      totalWords: 0,
      lastUpdated: "",
      documents: { count: 0, totalWords: 0, filenames: [] },
    });
    // Early-return bite: a missing profile must short-circuit before any
    // document lookup, proving the null branch is taken (not the has-memory one).
    expect(findByExpert).not.toHaveBeenCalled();
  });

  it("handles a persona profile with no documents", async () => {
    const source = createExpertMemorySource(
      createDeps({ findBySlug: async () => profileFor(), findByExpert: async () => [] }),
    );

    const view = await source.load("cto");

    expect(view.hasMemory).toBe(true);
    expect(view.documents).toEqual({ count: 0, totalWords: 0, filenames: [] });
  });

  it("strips control characters from multi-line memory body fields", async () => {
    const source = createExpertMemorySource(
      createDeps({
        findBySlug: async () =>
          profileFor({
            communicationStyle: "Direct\u001B[2K and\nconcise",
            decisionPatterns: ["Weighs\u001B[31m tradeoffs"],
            biases: ["Optimism\u001B[2K bias"],
            vocabulary: ["lev\u001B[32merage"],
            epistemicStance: "Evidence\u001B[33m-weighted",
          }),
      }),
    );

    const view = await source.load("cto");

    // stripControlChars removes the ANSI/control sequences but preserves the
    // intended newline in multi-line prose. If the sanitizer call is removed,
    // the raw ESC sequence survives and these assertions fail.
    expect(view.communicationStyle).toBe("Direct and\nconcise");
    expect(view.decisionPatterns).toEqual(["Weighs tradeoffs"]);
    expect(view.biases).toEqual(["Optimism bias"]);
    expect(view.vocabulary).toEqual(["leverage"]);
    expect(view.epistemicStance).toBe("Evidence-weighted");
    expect(JSON.stringify(view)).not.toContain("\u001B");
  });

  it("collapses control characters and newlines in single-line label fields", async () => {
    const source = createExpertMemorySource(
      createDeps({
        findBySlug: async () => profileFor({ lastUpdated: "2026-06-23\u001B[2K\nT00:00" }),
        findByExpert: async () => [
          documentFor({ filename: "road\u001B[31mmap\n.md", wordCount: 5 }),
        ],
      }),
    );

    const view = await source.load("cto");

    // toSingleLineDisplay strips control sequences AND collapses newlines to a
    // single space so date/filename labels can never break out onto a new line.
    expect(view.lastUpdated).toBe("2026-06-23 T00:00");
    expect(view.lastUpdated).not.toContain("\u001B");
    expect(view.lastUpdated).not.toContain("\n");
    expect(view.documents.filenames).toEqual(["roadmap .md"]);
  });
});
