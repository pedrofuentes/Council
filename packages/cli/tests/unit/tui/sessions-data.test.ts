import { describe, expect, it } from "vitest";

import {
  createSessionsDataSource,
  sessionStatusSymbol,
  type SessionsRepos,
} from "../../../src/tui/adapters/sessions-data.js";

const createRepos = (overrides: Partial<SessionsRepos> = {}): SessionsRepos => ({
  panels: {
    findAll: async () => [],
  },
  debates: {
    findByPanelId: async () => [],
  },
  turns: {
    countByDebateId: async () => 0,
  },
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
