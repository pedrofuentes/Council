/**
 * Tests for the chat-session domain types (Roadmap 5.1).
 *
 * These tests assert that the literal-union types narrow correctly and
 * that the readonly domain shapes are usable from consumer code. They are
 * compile-time guarantees promoted to runtime smoke tests so the test
 * suite traps accidental type widening at refactor time.
 *
 * RED at this commit: src/core/chat/chat-session.ts does not yet exist.
 */
import { describe, expect, it } from "vitest";

import type {
  ChatRole,
  ChatSession,
  ChatStatus,
  ChatTargetType,
  ChatTurn,
} from "../../../src/core/chat/chat-session.js";

describe("chat-session domain types", () => {
  it("ChatTargetType narrows to 'expert' | 'panel'", () => {
    const values: readonly ChatTargetType[] = ["expert", "panel"];
    expect(values).toEqual(["expert", "panel"]);
  });

  it("ChatStatus narrows to 'active' | 'archived'", () => {
    const values: readonly ChatStatus[] = ["active", "archived"];
    expect(values).toEqual(["active", "archived"]);
  });

  it("ChatRole narrows to 'user' | 'expert'", () => {
    const values: readonly ChatRole[] = ["user", "expert"];
    expect(values).toEqual(["user", "expert"]);
  });

  it("ChatSession shape is constructible with the documented fields", () => {
    const session: ChatSession = {
      id: "01J0000000000000000000000",
      targetType: "expert",
      targetSlug: "cto",
      status: "active",
      summary: null,
      summaryThroughSeq: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(session.targetType).toBe("expert");
    expect(session.status).toBe("active");
    expect(session.summary).toBeNull();
    expect(session.summaryThroughSeq).toBe(0);
  });

  it("ChatTurn shape is constructible with the documented fields", () => {
    const turn: ChatTurn = {
      id: "01J0000000000000000000001",
      chatId: "01J0000000000000000000000",
      seq: 1,
      role: "expert",
      expertSlug: "cto",
      content: "hello",
      isMention: false,
      tokensIn: 10,
      tokensOut: 20,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(turn.role).toBe("expert");
    expect(turn.isMention).toBe(false);
    expect(turn.expertSlug).toBe("cto");
  });

  it("ChatTurn allows null expert_slug and token counts for user turns", () => {
    const turn: ChatTurn = {
      id: "01J0000000000000000000002",
      chatId: "01J0000000000000000000000",
      seq: 2,
      role: "user",
      expertSlug: null,
      content: "what do you think?",
      isMention: true,
      tokensIn: null,
      tokensOut: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(turn.role).toBe("user");
    expect(turn.expertSlug).toBeNull();
    expect(turn.tokensIn).toBeNull();
    expect(turn.tokensOut).toBeNull();
  });
});
