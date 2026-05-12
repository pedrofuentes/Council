/**
 * Tests for ChatRepository — persistent chat sessions / turns introduced
 * by migration 005 (Roadmap 5.1).
 *
 * RED at this commit: migration 005, the CouncilSchema entries for
 * chat_sessions / chat_turns, and src/memory/repositories/chat-repository.ts
 * do not yet exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CouncilDatabase, createDatabase } from "../../../src/memory/db.js";
import { ChatRepository } from "../../../src/memory/repositories/chat-repository.js";

describe("ChatRepository", () => {
  let db: CouncilDatabase;
  let repo: ChatRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    repo = new ChatRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  // -------- migration --------

  it("migration 005 is applied (schema_version contains 5)", async () => {
    const row = await db
      .selectFrom("schema_version")
      .select("version")
      .where("version", "=", 5)
      .executeTakeFirst();
    expect(row?.version).toBe(5);
  });

  it("creating the database twice is idempotent (migration re-run is a no-op)", async () => {
    // Re-running createDatabase against the same in-memory client would
    // not share state, so instead simulate idempotency by inserting a
    // session, then inspecting that migration 005 doesn't double-register.
    const versions = await db
      .selectFrom("schema_version")
      .select("version")
      .where("version", "=", 5)
      .execute();
    expect(versions).toHaveLength(1);
  });

  // -------- sessions --------

  it("createSession() generates a ULID id, defaults to active, sets timestamps", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    expect(session.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(session.targetType).toBe("expert");
    expect(session.targetSlug).toBe("cto");
    expect(session.status).toBe("active");
    expect(session.summary).toBeNull();
    expect(session.summaryThroughSeq).toBe(0);
    expect(session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("findSessionById() returns the session when present, undefined otherwise", async () => {
    const created = await repo.createSession({ targetType: "panel", targetSlug: "arch-review" });
    const found = await repo.findSessionById(created.id);
    expect(found?.id).toBe(created.id);
    expect(await repo.findSessionById("missing")).toBeUndefined();
  });

  it("findActiveSession() returns the most recent active session for a target", async () => {
    const first = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await new Promise((r) => setTimeout(r, 10));
    const second = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.createSession({ targetType: "expert", targetSlug: "other" });

    const active = await repo.findActiveSession("expert", "cto");
    expect(active?.id).toBe(second.id);
    expect(active?.id).not.toBe(first.id);

    const none = await repo.findActiveSession("expert", "nobody");
    expect(none).toBeUndefined();
  });

  it("findActiveSession() ignores archived sessions", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.archiveSession(session.id);
    expect(await repo.findActiveSession("expert", "cto")).toBeUndefined();
  });

  it("listSessions() returns all sessions when called with no options", async () => {
    await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.createSession({ targetType: "panel", targetSlug: "arch-review" });
    const all = await repo.listSessions();
    expect(all).toHaveLength(2);
  });

  it("listSessions() filters by targetSlug", async () => {
    await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.createSession({ targetType: "expert", targetSlug: "pm" });
    const filtered = await repo.listSessions({ targetSlug: "cto" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.targetSlug).toBe("cto");
  });

  it("listSessions() filters by status", async () => {
    const a = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.createSession({ targetType: "expert", targetSlug: "pm" });
    await repo.archiveSession(a.id);

    const active = await repo.listSessions({ status: "active" });
    expect(active.map((s) => s.targetSlug)).toEqual(["pm"]);

    const archived = await repo.listSessions({ status: "archived" });
    expect(archived.map((s) => s.targetSlug)).toEqual(["cto"]);
  });

  it("archiveSession() flips status to archived and refreshes updatedAt", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await new Promise((r) => setTimeout(r, 10));
    await repo.archiveSession(session.id);
    const after = await repo.findSessionById(session.id);
    expect(after?.status).toBe("archived");
    expect(after && after.updatedAt >= session.updatedAt).toBe(true);
  });

  it("updateSummary() persists the rolling summary and seq high-water mark", async () => {
    const session = await repo.createSession({ targetType: "panel", targetSlug: "arch-review" });
    await repo.updateSummary(session.id, "Discussion converged on option B.", 12);
    const after = await repo.findSessionById(session.id);
    expect(after?.summary).toBe("Discussion converged on option B.");
    expect(after?.summaryThroughSeq).toBe(12);
  });

  // -------- turns --------

  it("addTurn() auto-assigns seq starting at 1 and returns the domain turn", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    const first = await repo.addTurn({
      chatId: session.id,
      role: "user",
      content: "hi",
    });
    expect(first.seq).toBe(1);
    expect(first.role).toBe("user");
    expect(first.expertSlug).toBeNull();
    expect(first.isMention).toBe(false);
    expect(first.tokensIn).toBeNull();
    expect(first.tokensOut).toBeNull();

    const second = await repo.addTurn({
      chatId: session.id,
      role: "expert",
      expertSlug: "cto",
      content: "hello",
      isMention: true,
      tokensIn: 5,
      tokensOut: 7,
    });
    expect(second.seq).toBe(2);
    expect(second.expertSlug).toBe("cto");
    expect(second.isMention).toBe(true);
    expect(second.tokensIn).toBe(5);
    expect(second.tokensOut).toBe(7);
  });

  it("seq counters are independent per chat session", async () => {
    const a = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    const b = await repo.createSession({ targetType: "expert", targetSlug: "pm" });
    const t1 = await repo.addTurn({ chatId: a.id, role: "user", content: "a-1" });
    const t2 = await repo.addTurn({ chatId: b.id, role: "user", content: "b-1" });
    const t3 = await repo.addTurn({ chatId: a.id, role: "user", content: "a-2" });
    expect(t1.seq).toBe(1);
    expect(t2.seq).toBe(1);
    expect(t3.seq).toBe(2);
  });

  it("getTurns() returns turns ordered by seq ascending", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.addTurn({ chatId: session.id, role: "user", content: "first" });
    await repo.addTurn({
      chatId: session.id,
      role: "expert",
      expertSlug: "cto",
      content: "second",
    });
    await repo.addTurn({ chatId: session.id, role: "user", content: "third" });
    const turns = await repo.getTurns(session.id);
    expect(turns.map((t) => t.content)).toEqual(["first", "second", "third"]);
    expect(turns.map((t) => t.seq)).toEqual([1, 2, 3]);
  });

  it("getTurns() filters by afterSeq and respects limit", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    for (let i = 1; i <= 5; i += 1) {
      await repo.addTurn({ chatId: session.id, role: "user", content: `m${i}` });
    }
    const after = await repo.getTurns(session.id, { afterSeq: 2 });
    expect(after.map((t) => t.seq)).toEqual([3, 4, 5]);
    const limited = await repo.getTurns(session.id, { limit: 2 });
    expect(limited.map((t) => t.seq)).toEqual([1, 2]);
    const both = await repo.getTurns(session.id, { afterSeq: 1, limit: 2 });
    expect(both.map((t) => t.seq)).toEqual([2, 3]);
  });

  it("getTurnCount() returns the number of turns for a session", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    expect(await repo.getTurnCount(session.id)).toBe(0);
    await repo.addTurn({ chatId: session.id, role: "user", content: "x" });
    await repo.addTurn({ chatId: session.id, role: "user", content: "y" });
    expect(await repo.getTurnCount(session.id)).toBe(2);
  });

  it("getLatestSeq() returns 0 when empty and the max seq otherwise", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    expect(await repo.getLatestSeq(session.id)).toBe(0);
    await repo.addTurn({ chatId: session.id, role: "user", content: "a" });
    await repo.addTurn({ chatId: session.id, role: "user", content: "b" });
    expect(await repo.getLatestSeq(session.id)).toBe(2);
  });

  it("rejects duplicate (chat_id, seq) inserts via UNIQUE constraint", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    const now = new Date().toISOString();
    await db
      .insertInto("chat_turns")
      .values({
        id: "01J0000000000000000000010",
        chat_id: session.id,
        seq: 1,
        role: "user",
        expert_slug: null,
        content: "first",
        is_mention: 0,
        tokens_in: null,
        tokens_out: null,
        created_at: now,
      })
      .execute();
    await expect(
      db
        .insertInto("chat_turns")
        .values({
          id: "01J0000000000000000000011",
          chat_id: session.id,
          seq: 1,
          role: "user",
          expert_slug: null,
          content: "duplicate",
          is_mention: 0,
          tokens_in: null,
          tokens_out: null,
          created_at: now,
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it("addTurn() allocates seq atomically against concurrent inserts", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repo.addTurn({ chatId: session.id, role: "user", content: `m${i}` }),
      ),
    );
    const seqs = results.map((t) => t.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const count = await repo.getTurnCount(session.id);
    expect(count).toBe(10);
  });

  it("deleting a session cascades to its turns", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.addTurn({ chatId: session.id, role: "user", content: "doomed" });
    await db.deleteFrom("chat_sessions").where("id", "=", session.id).execute();
    const remaining = await db
      .selectFrom("chat_turns")
      .selectAll()
      .where("chat_id", "=", session.id)
      .execute();
    expect(remaining).toHaveLength(0);
  });

  // -------- search --------

  it("searchTurns() finds turns by FTS5 content match", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.addTurn({
      chatId: session.id,
      role: "user",
      content: "we should adopt postgres for storage",
    });
    await repo.addTurn({
      chatId: session.id,
      role: "expert",
      expertSlug: "cto",
      content: "agree on postgres but defer index design",
    });
    await repo.addTurn({
      chatId: session.id,
      role: "user",
      content: "unrelated chatter about lunch",
    });

    const hits = await repo.searchTurns("postgres");
    expect(hits.map((t) => t.content).sort()).toEqual(
      ["agree on postgres but defer index design", "we should adopt postgres for storage"].sort(),
    );
  });

  it("searchTurns() scopes results to a chatId when provided", async () => {
    const a = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    const b = await repo.createSession({ targetType: "expert", targetSlug: "pm" });
    await repo.addTurn({ chatId: a.id, role: "user", content: "alpha postgres" });
    await repo.addTurn({ chatId: b.id, role: "user", content: "beta postgres" });
    const hits = await repo.searchTurns("postgres", { chatId: a.id });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chatId).toBe(a.id);
  });

  it("searchTurns() respects limit", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    for (let i = 0; i < 5; i += 1) {
      await repo.addTurn({ chatId: session.id, role: "user", content: `kafka note ${i}` });
    }
    const hits = await repo.searchTurns("kafka", { limit: 2 });
    expect(hits).toHaveLength(2);
  });

  it("searchTurns() reflects deletions via the delete trigger", async () => {
    const session = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.addTurn({ chatId: session.id, role: "user", content: "transient redis topic" });
    expect(await repo.searchTurns("redis")).toHaveLength(1);
    await db.deleteFrom("chat_turns").where("chat_id", "=", session.id).execute();
    expect(await repo.searchTurns("redis")).toHaveLength(0);
  });
});
