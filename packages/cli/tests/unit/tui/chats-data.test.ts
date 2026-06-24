import { describe, expect, it } from "vitest";

import {
  chatTargetSymbol,
  createChatsDataSource,
  toChatListItem,
  type ChatSessionSummary,
} from "../../../src/tui/adapters/chats-data.js";

const base: ChatSessionSummary = {
  id: "chat-1",
  targetType: "expert",
  targetSlug: "cto",
  summary: "Roadmap planning",
  status: "active",
  updatedAt: new Date().toISOString(),
};

describe("chatTargetSymbol", () => {
  it("uses a panel glyph for panel targets", () => {
    expect(chatTargetSymbol("panel")).toBe("📋");
  });

  it("uses an expert glyph for expert targets", () => {
    expect(chatTargetSymbol("expert")).toBe("👤");
  });
});

describe("toChatListItem", () => {
  it("uses the summary as the title when present", () => {
    expect(toChatListItem(base).title).toBe("Roadmap planning");
  });

  it("falls back to the targetSlug when the summary is null", () => {
    expect(toChatListItem({ ...base, summary: null, targetSlug: "growth-panel" }).title).toBe(
      "growth-panel",
    );
  });

  it("carries id, targetType, targetSlug, and status through", () => {
    const item = toChatListItem({
      ...base,
      targetType: "panel",
      targetSlug: "growth",
      status: "archived",
    });
    expect(item.id).toBe("chat-1");
    expect(item.targetType).toBe("panel");
    expect(item.targetSlug).toBe("growth");
    expect(item.status).toBe("archived");
  });

  it("renders a compact relative timestamp", () => {
    const item = toChatListItem({
      ...base,
      updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    expect(item.when).toBe("2h");
  });

  it("sanitizes the title to a single control-free line (bites the sanitizer)", () => {
    const item = toChatListItem({ ...base, summary: "Plan\u001B[31m\r\nB\u0007\u2028C" });
    expect(item.title).toBe("Plan B C");
    expect(item.title).not.toContain("\u001B");
    expect(item.title).not.toContain("\r");
    expect(item.title).not.toContain("\n");
    expect(item.title).not.toContain("\u0007");
    expect(item.title).not.toContain("\u2028");
  });

  it("sanitizes the slug-derived title when the summary is null", () => {
    const item = toChatListItem({ ...base, summary: null, targetSlug: "ops\u001B[32m\nteam" });
    expect(item.title).toBe("ops team");
  });

  it("keeps the raw targetSlug for navigation (does not collapse it)", () => {
    const item = toChatListItem({ ...base, summary: "x", targetSlug: "ops-team-2" });
    expect(item.targetSlug).toBe("ops-team-2");
  });
});

describe("createChatsDataSource", () => {
  it("maps every persisted session to a sanitized list item", async () => {
    const source = createChatsDataSource({
      chat: {
        listSessions: async (): Promise<readonly ChatSessionSummary[]> => [
          {
            id: "a",
            targetType: "expert",
            targetSlug: "cto",
            summary: "Alpha\u001B[31m",
            status: "active",
            updatedAt: new Date().toISOString(),
          },
          {
            id: "b",
            targetType: "panel",
            targetSlug: "growth-panel",
            summary: null,
            status: "archived",
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });

    const items = await source.list();
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("Alpha");
    expect(items[0]?.targetType).toBe("expert");
    expect(items[1]?.title).toBe("growth-panel");
    expect(items[1]?.targetType).toBe("panel");
    expect(items[1]?.targetSlug).toBe("growth-panel");
  });

  it("returns an empty list when there are no sessions", async () => {
    const source = createChatsDataSource({
      chat: { listSessions: async (): Promise<readonly ChatSessionSummary[]> => [] },
    });
    expect(await source.list()).toEqual([]);
  });
});
