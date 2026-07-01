import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../../src/memory/db.js";
import { ChatRepository } from "../../../src/memory/repositories/chat-repository.js";
import { ExpertRepository, type NewExpert } from "../../../src/memory/repositories/experts.js";
import { PanelRepository, type NewPanel } from "../../../src/memory/repositories/panels.js";
import {
  createHomeDataSources,
  formatRelativeTime,
  toRecentSession,
  type SessionRow,
} from "../../../src/tui/adapters/home-data-sources.js";

function samplePanel(name: string): NewPanel {
  return { name, copilotHome: `/tmp/council/${name}`, configJson: "{}" };
}

function sampleExpert(panelId: string, slug: string): NewExpert {
  return {
    panelId,
    slug,
    displayName: slug.toUpperCase(),
    model: "claude-sonnet-4",
    systemMessage: `You are ${slug}.`,
  };
}

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
  it("maps sessions and tallies experts/panels/sessions via aggregate COUNT (#1589)", async () => {
    const listSessions = vi.fn(
      async (): Promise<readonly SessionRow[]> => [
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
    );
    const countSessions = vi.fn(async () => 7);
    const countExpertsAgg = vi.fn(async () => 3);
    const countPanelsAgg = vi.fn(async () => 2);
    // Legacy N+1 / full-materialisation methods — must NOT be touched now
    // that the counts come from single aggregate queries (#1589).
    const findAll = vi.fn(async () => [{ id: "p1" }, { id: "p2" }]);
    const findByPanelId = vi.fn(async () => [{}]);

    const sources = createHomeDataSources({
      chat: { listSessions, countSessions },
      panels: { countAll: countPanelsAgg, findAll },
      experts: { countAll: countExpertsAgg, findByPanelId },
    });

    const sessions = await sources.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.title).toBe("Alpha");
    expect(sessions[1]?.title).toBe("beta-panel");
    expect(sessions[1]?.status).toBe("concluded");

    // Exact counts flow straight from the aggregate sources.
    expect(await sources.countExperts()).toBe(3);
    expect(await sources.countPanels()).toBe(2);
    expect(await sources.countSessions()).toBe(7);

    // Each aggregate is issued exactly once — no per-panel loop, no scan.
    expect(countExpertsAgg).toHaveBeenCalledTimes(1);
    expect(countPanelsAgg).toHaveBeenCalledTimes(1);
    expect(countSessions).toHaveBeenCalledTimes(1);
    // The old N+1 path is gone entirely.
    expect(findByPanelId).not.toHaveBeenCalled();
    expect(findAll).not.toHaveBeenCalled();
  });

  it("counts experts spanning multiple panels via real repositories (#1589)", async () => {
    const db = await createDatabase(":memory:");
    try {
      const panelRepo = new PanelRepository(db);
      const expertRepo = new ExpertRepository(db);
      const chatRepo = new ChatRepository(db);

      // Three panels holding 0 / 2 / 3 experts → 5 experts total. Spreading
      // across panels catches any single-panel-only regression.
      const empty = await panelRepo.create(samplePanel("empty-panel"));
      const two = await panelRepo.create(samplePanel("two-panel"));
      const three = await panelRepo.create(samplePanel("three-panel"));
      expect(empty.id).toBeTypeOf("string"); // empty-panel intentionally has no experts
      await expertRepo.create(sampleExpert(two.id, "cto"));
      await expertRepo.create(sampleExpert(two.id, "pm"));
      await expertRepo.create(sampleExpert(three.id, "sre"));
      await expertRepo.create(sampleExpert(three.id, "qa"));
      await expertRepo.create(sampleExpert(three.id, "designer"));

      await chatRepo.createSession({ targetType: "expert", targetSlug: "cto" });
      await chatRepo.createSession({ targetType: "expert", targetSlug: "pm" });
      await chatRepo.createSession({ targetType: "panel", targetSlug: "three-panel" });
      await chatRepo.createSession({ targetType: "panel", targetSlug: "two-panel" });

      const sources = createHomeDataSources({
        chat: chatRepo,
        panels: panelRepo,
        experts: expertRepo,
      });

      expect(await sources.countPanels()).toBe(3);
      expect(await sources.countExperts()).toBe(5);
      expect(await sources.countSessions()).toBe(4);
    } finally {
      await db.destroy();
    }
  });

  it("returns 0 counts for an empty database without throwing (#1589)", async () => {
    const db = await createDatabase(":memory:");
    try {
      const sources = createHomeDataSources({
        chat: new ChatRepository(db),
        panels: new PanelRepository(db),
        experts: new ExpertRepository(db),
      });
      expect(await sources.countPanels()).toBe(0);
      expect(await sources.countExperts()).toBe(0);
      expect(await sources.countSessions()).toBe(0);
      expect(await sources.listSessions()).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
