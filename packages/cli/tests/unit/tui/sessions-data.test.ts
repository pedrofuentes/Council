import { describe, expect, it } from "vitest";

import {
  createSessionsDataSource,
  sessionStatusSymbol,
  type TranscriptDoc,
  type SessionsRepos,
} from "../../../src/tui/adapters/sessions-data.js";

interface TestSessionsDeps extends SessionsRepos {
  readonly loadTranscript: (panelName: string) => Promise<TranscriptDoc | undefined>;
}

const createRepos = (overrides: Partial<TestSessionsDeps> = {}): TestSessionsDeps => ({
  panels: {
    findAll: async () => [],
  },
  debates: {
    findByPanelId: async () => [],
  },
  turns: {
    countByDebateId: async () => 0,
  },
  loadTranscript: async () => undefined,
  ...overrides,
});

describe("createSessionsDataSource.loadList", () => {
  it("maps debates with summed turns and the latest status by startedAt", async () => {
    const ds = createSessionsDataSource(
      createRepos({
        panels: {
          findAll: async () => [
            {
              id: "panel-1",
              name: "Executive Council",
              topic: "Market expansion",
              updatedAt: "2026-06-22T12:00:00.000Z",
            },
          ],
        },
        debates: {
          findByPanelId: async () => [
            { id: "debate-old", status: "running", startedAt: "2026-06-22T10:00:00.000Z" },
            { id: "debate-new", status: "completed", startedAt: "2026-06-22T11:00:00.000Z" },
          ],
        },
        turns: {
          countByDebateId: async (debateId) => (debateId === "debate-old" ? 3 : 5),
        },
      }),
    );

    await expect(ds.loadList()).resolves.toEqual([
      {
        panelId: "panel-1",
        panelName: "Executive Council",
        topic: "Market expansion",
        debateCount: 2,
        turnCount: 8,
        latestStatus: "completed",
        updatedAt: "2026-06-22T12:00:00.000Z",
      },
    ]);
  });

  it("uses none status, zero counts, and an empty topic when a panel has no debates", async () => {
    const ds = createSessionsDataSource(
      createRepos({
        panels: {
          findAll: async () => [
            {
              id: "panel-empty",
              name: "Quiet Panel",
              topic: null,
              updatedAt: "2026-06-22T09:00:00.000Z",
            },
          ],
        },
      }),
    );

    await expect(ds.loadList()).resolves.toEqual([
      {
        panelId: "panel-empty",
        panelName: "Quiet Panel",
        topic: "",
        debateCount: 0,
        turnCount: 0,
        latestStatus: "none",
        updatedAt: "2026-06-22T09:00:00.000Z",
      },
    ]);
  });

  it("sorts panels by updatedAt descending", async () => {
    const ds = createSessionsDataSource(
      createRepos({
        panels: {
          findAll: async () => [
            {
              id: "older",
              name: "Older Panel",
              topic: "First",
              updatedAt: "2026-06-21T10:00:00.000Z",
            },
            {
              id: "newer",
              name: "Newer Panel",
              topic: "Second",
              updatedAt: "2026-06-22T10:00:00.000Z",
            },
          ],
        },
      }),
    );

    await expect(ds.loadList()).resolves.toMatchObject([
      { panelId: "newer" },
      { panelId: "older" },
    ]);
  });
});

describe("createSessionsDataSource.loadTranscript", () => {
  it("maps transcript headers and speaker names for known, moderator, and unknown turns", async () => {
    const ds = createSessionsDataSource(
      createRepos({
        loadTranscript: async () => ({
          panel: { name: "Executive Council", topic: "Market expansion" },
          experts: [
            { id: "expert-1", slug: "optimist", displayName: "Optimist" },
            { id: "expert-2", slug: "skeptic", displayName: "Skeptic" },
          ],
          latestDebate: { prompt: "Should we expand?", status: "completed" },
          turns: [
            {
              expertId: "expert-1",
              round: 1,
              content: "Proceed",
              speakerKind: "expert",
            },
            {
              expertId: null,
              round: 1,
              content: "Frame the decision",
              speakerKind: "moderator",
            },
            {
              expertId: "missing-expert",
              round: 2,
              content: "Unmapped speaker",
              speakerKind: "system",
            },
          ],
        }),
      }),
    );

    await expect(ds.loadTranscript("Executive Council")).resolves.toEqual({
      panelName: "Executive Council",
      topic: "Market expansion",
      prompt: "Should we expand?",
      status: "completed",
      lines: [
        { speaker: "Optimist", round: 1, content: "Proceed", kind: "expert" },
        { speaker: "moderator", round: 1, content: "Frame the decision", kind: "moderator" },
        { speaker: "system", round: 2, content: "Unmapped speaker", kind: "system" },
      ],
    });
  });

  it("returns undefined when no transcript document exists", async () => {
    const ds = createSessionsDataSource(createRepos({ loadTranscript: async () => undefined }));

    await expect(ds.loadTranscript("Missing Panel")).resolves.toBeUndefined();
  });

  it("uses an empty topic when the transcript topic is null", async () => {
    const ds = createSessionsDataSource(
      createRepos({
        loadTranscript: async () => ({
          panel: { name: "Quiet Panel", topic: null },
          experts: [],
          latestDebate: { prompt: "What next?", status: "running" },
          turns: [],
        }),
      }),
    );

    await expect(ds.loadTranscript("Quiet Panel")).resolves.toMatchObject({
      panelName: "Quiet Panel",
      topic: "",
      prompt: "What next?",
      status: "running",
      lines: [],
    });
  });

  it("falls back to the expert slug when displayName is empty", async () => {
    const ds = createSessionsDataSource(
      createRepos({
        loadTranscript: async () => ({
          panel: { name: "Slug Panel", topic: "Identity" },
          experts: [{ id: "expert-1", slug: "plain-slug", displayName: "" }],
          latestDebate: { prompt: "Who speaks?", status: "completed" },
          turns: [
            {
              expertId: "expert-1",
              round: 3,
              content: "Use slug",
              speakerKind: "expert",
            },
          ],
        }),
      }),
    );

    await expect(ds.loadTranscript("Slug Panel")).resolves.toMatchObject({
      lines: [{ speaker: "plain-slug", round: 3, content: "Use slug", kind: "expert" }],
    });
  });
});

describe("sessionStatusSymbol", () => {
  it("returns the exact symbol for each visible session status family", () => {
    expect(sessionStatusSymbol("completed")).toBe("✓");
    expect(sessionStatusSymbol("running")).toBe("…");
    expect(sessionStatusSymbol("none")).toBe("·");
    expect(sessionStatusSymbol("interrupted")).toBe("⚠");
    expect(sessionStatusSymbol("aborted")).toBe("⚠");
    expect(sessionStatusSymbol("failed")).toBe("⚠");
  });
});
