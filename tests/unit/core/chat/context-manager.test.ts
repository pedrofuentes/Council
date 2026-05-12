/**
 * Tests for ContextManager — rolling-summary context window for chat
 * sessions (Roadmap 5.3).
 *
 * RED at this commit: src/core/chat/context-manager.ts does not yet exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ContextManager,
  type ContextManagerConfig,
  createContextManager,
} from "../../../../src/core/chat/context-manager.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { type CouncilDatabase, createDatabase } from "../../../../src/memory/db.js";
import { ChatRepository } from "../../../../src/memory/repositories/chat-repository.js";

const SUMMARY_TEXT = "Rolling summary of the conversation so far.";

const baseConfig: ContextManagerConfig = {
  recentTurnCount: 3,
  summaryMaxWords: 500,
  model: "mock-model",
};

async function seedTurns(repo: ChatRepository, chatId: string, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await repo.addTurn({ chatId, role: "user", content: `user msg ${i}` });
    await repo.addTurn({
      chatId,
      role: "expert",
      expertSlug: "cto",
      content: `expert reply ${i}`,
    });
  }
}

describe("ContextManager", () => {
  let db: CouncilDatabase;
  let repo: ChatRepository;
  let engine: MockEngine;
  let manager: ContextManager;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    repo = new ChatRepository(db);
    engine = new MockEngine();
    await engine.start();
    manager = createContextManager(repo, engine, baseConfig);
  });

  afterEach(async () => {
    await engine.stop();
    await db.destroy();
  });

  // ---------- getContext ----------

  describe("getContext()", () => {
    it("returns null summary and all turns when no summary exists", async () => {
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await seedTurns(repo, session.id, 2); // 4 turns total

      const ctx = await manager.getContext(session.id);

      expect(ctx.summary).toBeNull();
      expect(ctx.recentTurns).toHaveLength(4);
      expect(ctx.recentTurns[0]?.content).toBe("user msg 1");
      expect(ctx.recentTurns[3]?.content).toBe("expert reply 2");
    });

    it("returns stored summary plus only turns after summaryThroughSeq", async () => {
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await seedTurns(repo, session.id, 3); // 6 turns total
      await repo.updateSummary(session.id, SUMMARY_TEXT, 4);

      const ctx = await manager.getContext(session.id);

      expect(ctx.summary).toBe(SUMMARY_TEXT);
      expect(ctx.recentTurns).toHaveLength(2);
      expect(ctx.recentTurns[0]?.seq).toBe(5);
      expect(ctx.recentTurns[1]?.seq).toBe(6);
    });

    it("throws when the chat session does not exist", async () => {
      await expect(manager.getContext("does-not-exist")).rejects.toThrow();
    });
  });

  // ---------- maybeSummarize ----------

  describe("maybeSummarize()", () => {
    it("returns false when total turns are at or below recentTurnCount", async () => {
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      // 3 turns total, recentTurnCount=3 → no summarization needed
      await repo.addTurn({ chatId: session.id, role: "user", content: "q1" });
      await repo.addTurn({ chatId: session.id, role: "expert", expertSlug: "cto", content: "a1" });
      await repo.addTurn({ chatId: session.id, role: "user", content: "q2" });

      const result = await manager.maybeSummarize(session.id);

      expect(result).toBe(false);
      const refreshed = await repo.findSessionById(session.id);
      expect(refreshed?.summary).toBeNull();
      expect(refreshed?.summaryThroughSeq).toBe(0);
    });

    it("calls engine and updates summary when threshold exceeded", async () => {
      const newSummary = "fresh rolling summary";
      const localEngine = new MockEngine({
        // The engine receives a synthetic expertId per addExpert call. Use
        // default response keyed off that id by overriding only via the
        // generic stub: rebuild manager with a custom engine.
      });
      await localEngine.start();
      const localManager = createContextManager(repo, localEngine, baseConfig);

      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await seedTurns(repo, session.id, 3); // 6 turns, recentTurnCount=3

      // Override response after addExpert by intercepting via failures map
      // is awkward — instead spy via sentPrompts & stored summary text.
      const result = await localManager.maybeSummarize(session.id);

      expect(result).toBe(true);
      expect(localEngine.sentPrompts).toHaveLength(1);
      const refreshed = await repo.findSessionById(session.id);
      expect(refreshed?.summary).not.toBeNull();
      expect(refreshed?.summary?.length).toBeGreaterThan(0);
      // Default mock response is "[mock response from <expertId>]"
      expect(refreshed?.summary).toContain("mock response");
      // throughSeq covers everything except the recentTurnCount window:
      // 6 total, recentTurnCount=3 → summarize through seq 3
      expect(refreshed?.summaryThroughSeq).toBe(3);

      // Cleanup: summarizer expert should have been removed
      expect(localEngine.expertCount).toBe(0);

      await localEngine.stop();

      // Suppress unused-variable lint
      void newSummary;
    });

    it("includes the existing summary in the prompt", async () => {
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await seedTurns(repo, session.id, 3); // 6 turns
      await repo.updateSummary(session.id, "PRIOR-SUMMARY-MARKER", 2);

      const result = await manager.maybeSummarize(session.id);

      expect(result).toBe(true);
      expect(engine.sentPrompts).toHaveLength(1);
      const prompt = engine.sentPrompts[0]?.prompt ?? "";
      expect(prompt).toContain("PRIOR-SUMMARY-MARKER");
    });

    it("uses a 'No prior summary.' placeholder when no existing summary", async () => {
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await seedTurns(repo, session.id, 3);

      const result = await manager.maybeSummarize(session.id);

      expect(result).toBe(true);
      const prompt = engine.sentPrompts[0]?.prompt ?? "";
      expect(prompt).toContain("No prior summary.");
    });

    it("returns false when there are no new turns to summarize past summaryThroughSeq", async () => {
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await seedTurns(repo, session.id, 3); // 6 turns
      // Already summarized through seq 3 — leaves only the recent window
      await repo.updateSummary(session.id, SUMMARY_TEXT, 3);

      const result = await manager.maybeSummarize(session.id);

      expect(result).toBe(false);
      expect(engine.sentPrompts).toHaveLength(0);
    });

    it("returns false (and does not crash) when the engine yields an error", async () => {
      const failingEngine = new MockEngine({
        // Fail every send for any expert id by configuring failOnSend
        // dynamically — but failOnSend needs the expertId. Use the
        // generic `failures` map keyed at runtime via a wrapper:
        // simpler — fail the FIRST send via failOnSend with afterN=0 and
        // a wildcard id won't work; instead, intercept by removing
        // experts so send throws.
      });
      await failingEngine.start();
      // Patch send() to yield an error event for any expertId
      const origSend = failingEngine.send.bind(failingEngine);
      failingEngine.send = function patchedSend(opts) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        void origSend;
        async function* gen(): AsyncGenerator<
          import("../../../../src/engine/types.js").EngineEvent,
          void,
          void
        > {
          yield {
            kind: "error",
            expertId: opts.expertId,
            error: { code: "PROVIDER_ERROR", message: "boom", provider: "mock" },
            recoverable: false,
          };
        }
        return gen();
      };

      const failingManager = createContextManager(repo, failingEngine, baseConfig);
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await seedTurns(repo, session.id, 3);

      const result = await failingManager.maybeSummarize(session.id);

      expect(result).toBe(false);
      const refreshed = await repo.findSessionById(session.id);
      expect(refreshed?.summary).toBeNull();
      expect(refreshed?.summaryThroughSeq).toBe(0);

      await failingEngine.stop();
    });

    it("returns false when addExpert rejects", async () => {
      const failingEngine = new MockEngine({ failOnAddExpert: { afterN: 0 } });
      await failingEngine.start();
      const failingManager = createContextManager(repo, failingEngine, baseConfig);

      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await seedTurns(repo, session.id, 3);

      const result = await failingManager.maybeSummarize(session.id);

      expect(result).toBe(false);
      const refreshed = await repo.findSessionById(session.id);
      expect(refreshed?.summary).toBeNull();

      await failingEngine.stop();
    });
  });

  // ---------- forceSummarize ----------

  describe("forceSummarize()", () => {
    it("summarizes even when total turns are below recentTurnCount", async () => {
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      // 2 turns total, recentTurnCount=3 → maybeSummarize would skip
      await repo.addTurn({ chatId: session.id, role: "user", content: "q1" });
      await repo.addTurn({ chatId: session.id, role: "expert", expertSlug: "cto", content: "a1" });

      await manager.forceSummarize(session.id);

      expect(engine.sentPrompts).toHaveLength(1);
      const refreshed = await repo.findSessionById(session.id);
      expect(refreshed?.summary).not.toBeNull();
      expect(refreshed?.summary?.length).toBeGreaterThan(0);
      // forceSummarize covers ALL existing turns (2 turns → seq 2)
      expect(refreshed?.summaryThroughSeq).toBe(2);
    });

    it("is a no-op when there are zero turns", async () => {
      const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });

      await manager.forceSummarize(session.id);

      expect(engine.sentPrompts).toHaveLength(0);
      const refreshed = await repo.findSessionById(session.id);
      expect(refreshed?.summary).toBeNull();
      expect(refreshed?.summaryThroughSeq).toBe(0);
    });
  });
});
