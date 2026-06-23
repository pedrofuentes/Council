import { describe, expect, it } from "vitest";

import {
  createHomeDataSources,
  formatRelativeTime,
  toRecentSession,
  type SessionRow,
} from "../../../src/tui/adapters/home-data-sources.js";

describe("formatRelativeTime", () => {
  it("formats days, hours, minutes, and now", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 3 * 86_400_000).toISOString())).toBe("3d");
    expect(formatRelativeTime(new Date(now - 5 * 3_600_000).toISOString())).toBe("5h");
    expect(formatRelativeTime(new Date(now - 10 * 60_000).toISOString())).toBe("10m");
    expect(formatRelativeTime(new Date(now - 5_000).toISOString())).toBe("now");
  });
});

describe("toRecentSession", () => {
  const base: SessionRow = {
    id: "s1",
    summary: "My summary",
    targetSlug: "panel-x",
    updatedAt: new Date().toISOString(),
    status: "active",
  };

  it("uses the summary as the title when present", () => {
    expect(toRecentSession(base).title).toBe("My summary");
  });

  it("falls back to the targetSlug when summary is null", () => {
    expect(toRecentSession({ ...base, summary: null }).title).toBe("panel-x");
  });

  it("maps archived status to concluded", () => {
    expect(toRecentSession({ ...base, status: "archived" }).status).toBe("concluded");
  });

  it("maps non-archived status to convened", () => {
    expect(toRecentSession({ ...base, status: "active" }).status).toBe("convened");
  });

  it("carries the id through", () => {
    expect(toRecentSession(base).id).toBe("s1");
  });
});

describe("createHomeDataSources", () => {
  it("maps sessions and aggregates expert/panel counts", async () => {
    const sources = createHomeDataSources({
      chat: {
        listSessions: async () => [
          {
            id: "a",
            summary: "Alpha",
            targetSlug: "x",
            updatedAt: new Date().toISOString(),
            status: "active",
          },
          {
            id: "b",
            summary: null,
            targetSlug: "beta-panel",
            updatedAt: new Date().toISOString(),
            status: "archived",
          },
        ],
      },
      panels: {
        findAll: async () => [{ id: "p1" }, { id: "p2" }],
      },
      experts: {
        findByPanelId: async (panelId) => (panelId === "p1" ? [{}, {}] : [{}]),
      },
    });

    const sessions = await sources.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.title).toBe("Alpha");
    expect(sessions[1]?.title).toBe("beta-panel");
    expect(sessions[1]?.status).toBe("concluded");
    expect(await sources.countExperts()).toBe(3);
    expect(await sources.countPanels()).toBe(2);
  });
});
