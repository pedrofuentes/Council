// packages/cli/tests/unit/tui/home-data.test.ts
import { describe, expect, it } from "vitest";

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
      countExperts: () => Promise.resolve(9),
      countPanels: () => Promise.resolve(5),
    });
    expect(data.counts).toEqual({ sessions: 12, experts: 9, panels: 5 });
    expect(data.recent).toHaveLength(10);
    expect(data.recent[0]?.id).toBe("s0");
  });

  it("handles an empty library", async () => {
    const data = await loadHomeData({
      listSessions: () => Promise.resolve([]),
      countExperts: () => Promise.resolve(0),
      countPanels: () => Promise.resolve(0),
    });
    expect(data.counts.sessions).toBe(0);
    expect(data.recent).toEqual([]);
  });
});
