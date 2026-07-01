// packages/cli/tests/unit/tui/home-data.test.ts
import { describe, expect, it, vi } from "vitest";

import { loadHomeData } from "../../../src/tui/adapters/home-data.js";

describe("loadHomeData", () => {
  it("aggregates counts and caps recent sessions to 10 newest", async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      when: "2d",
      status: "convened" as const,
    }));
    const data = await loadHomeData({
      listSessions: () => Promise.resolve(sessions),
      countSessions: () => Promise.resolve(12),
      countExperts: () => Promise.resolve(9),
      countPanels: () => Promise.resolve(5),
    });
    expect(data.counts).toEqual({ sessions: 12, experts: 9, panels: 5 });
    expect(data.recent).toHaveLength(10);
    expect(data.recent[0]?.id).toBe("s0");
  });

  it("takes counts.sessions from countSessions(), not listSessions().length (#1582)", async () => {
    // Simulate a future paginated listSessions that returns only the newest
    // page (10 rows) while the true total is far larger. The rendered count
    // MUST come from the aggregate source, not the page length.
    const page = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      when: "1h",
      status: "convened" as const,
    }));
    const listSessions = vi.fn(() => Promise.resolve(page));
    const countSessions = vi.fn(() => Promise.resolve(42));

    const data = await loadHomeData({
      listSessions,
      countSessions,
      countExperts: () => Promise.resolve(0),
      countPanels: () => Promise.resolve(0),
    });

    expect(data.counts.sessions).toBe(42);
    expect(countSessions).toHaveBeenCalledTimes(1);
    // recent is still capped to the (already-limited) page.
    expect(data.recent).toHaveLength(10);
  });

  it("handles an empty library", async () => {
    const data = await loadHomeData({
      listSessions: () => Promise.resolve([]),
      countSessions: () => Promise.resolve(0),
      countExperts: () => Promise.resolve(0),
      countPanels: () => Promise.resolve(0),
    });
    expect(data.counts.sessions).toBe(0);
    expect(data.recent).toEqual([]);
  });
});
