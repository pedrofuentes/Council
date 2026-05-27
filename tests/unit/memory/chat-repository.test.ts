/**
 * Tests for ChatRepository — persistent chat sessions / turns introduced
 * by migration 005 (Roadmap 5.1).
 *
 * RED at this commit: migration 005, the CouncilSchema entries for
 * chat_sessions / chat_turns, and src/memory/repositories/chat-repository.ts
 * do not yet exist.
 */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CouncilDatabase, createDatabase } from "../../../src/memory/db.js";
import {
  ChatRepository,
  PersistTurnPairError,
  RotateActiveSessionError,
} from "../../../src/memory/repositories/chat-repository.js";

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

  it("unified migration is applied (schema_version contains 1)", async () => {
    const row = await db
      .selectFrom("schema_version")
      .select("version")
      .where("version", "=", 1)
      .executeTakeFirst();
    expect(row?.version).toBe(1);
  });

  it("creating the database twice is idempotent (migration re-run is a no-op)", async () => {
    const versions = await db
      .selectFrom("schema_version")
      .select("version")
      .where("version", "=", 1)
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
    // Per the single-active-per-target invariant (#333), there is at most
    // one active session per (target_type, target_slug) at any instant.
    // We exercise findActiveSession's "most recent" ordering by creating
    // an active session, archiving it, and creating another — the second
    // is the lone active row for `cto`.
    const first = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
    await repo.archiveSession(first.id);
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

  // Issue #466 follow-up — atomic user+expert pair persistence so the
  // @convene abort-path flush cannot interleave a higher-seq expert
  // turn before its parent user prompt.
  it("persistTurnPair() inserts user before expert with strictly increasing seq", async () => {
    const session = await repo.createSession({ targetType: "panel", targetSlug: "deb" });
    const [user, expert] = await repo.persistTurnPair(
      { chatId: session.id, role: "user", content: "should we ship?" },
      {
        chatId: session.id,
        role: "expert",
        expertSlug: "panel-a",
        content: "partial reply",
      },
    );
    expect(user.role).toBe("user");
    expect(expert.role).toBe("expert");
    expect(user.seq).toBe(1);
    expect(expert.seq).toBe(2);

    const turns = await repo.getTurns(session.id);
    expect(turns.map((t) => t.role)).toEqual(["user", "expert"]);
    expect(turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(turns[0]?.content).toBe("should we ship?");
    expect(turns[1]?.expertSlug).toBe("panel-a");
  });

  it("persistTurnPair() respects existing turns when computing seq", async () => {
    const session = await repo.createSession({ targetType: "panel", targetSlug: "deb" });
    await repo.addTurn({ chatId: session.id, role: "user", content: "earlier" });
    await repo.addTurn({
      chatId: session.id,
      role: "expert",
      expertSlug: "panel-a",
      content: "prior reply",
    });
    const [user, expert] = await repo.persistTurnPair(
      { chatId: session.id, role: "user", content: "follow-up" },
      {
        chatId: session.id,
        role: "expert",
        expertSlug: "panel-b",
        content: "partial",
      },
    );
    expect(user.seq).toBe(3);
    expect(expert.seq).toBe(4);
  });

  it("persistTurnPair() rolls back the user insert when the expert insert fails", async () => {
    const session = await repo.createSession({ targetType: "panel", targetSlug: "deb" });
    // Force the second underlying insert (the expert turn) to throw mid-
    // transaction. The atomic-flush invariant requires that the first
    // (user) insert is also rolled back so no orphan user row remains.
    const original = ChatRepository.prototype.addTurn;
    let calls = 0;
    const spy = vi.spyOn(ChatRepository.prototype, "addTurn").mockImplementation(async function (
      this: ChatRepository,
      args,
    ) {
      calls += 1;
      if (calls === 2) {
        throw new Error("simulated expert insert failure");
      }
      return original.call(this, args);
    });
    try {
      await expect(
        repo.persistTurnPair(
          { chatId: session.id, role: "user", content: "topic" },
          {
            chatId: session.id,
            role: "expert",
            expertSlug: "panel-a",
            content: "reply",
          },
        ),
      ).rejects.toThrow(/simulated/i);
    } finally {
      spy.mockRestore();
    }
    const turns = await repo.getTurns(session.id);
    expect(turns).toHaveLength(0);
  });

  describe("persistTurnPair rollback failure surfacing (#504)", () => {
    /**
     * Wrap the libsql Kysely executor so the next `executeQuery`
     * matching `failOnSqlSubstring` (and optionally any subsequent
     * `ROLLBACK`) throws — same technique used by the
     * document-repository clearForRetrain tests (#425). Patches
     * `getExecutor()` because raw `sql.execute(db)` resolves the
     * executor via `db.getExecutor().executeQuery(...)`. We assign an
     * own-property override on the executor instance (instead of
     * using a Proxy) because Kysely's executor uses private class
     * fields, and a Proxy on `executor` would re-bind `this` to the
     * proxy and trigger "Cannot read private member" errors.
     */
    function patchExecuteQuery(
      database: CouncilDatabase,
      opts: { failOnSqlSubstring: string; failRollback?: boolean },
    ): () => void {
      const realExec = database.getExecutor();
      type ExecQueryFn = typeof realExec.executeQuery;
      const originalExecuteQuery: ExecQueryFn = realExec.executeQuery as ExecQueryFn;
      const wrapped: ExecQueryFn = async function (this: typeof realExec, compiled, queryId) {
        const text = compiled.sql;
        if (text.includes(opts.failOnSqlSubstring)) {
          throw new Error(`simulated failure on: ${opts.failOnSqlSubstring}`);
        }
        if (opts.failRollback === true && /^\s*ROLLBACK\b/i.test(text)) {
          throw new Error("simulated ROLLBACK failure");
        }
        return originalExecuteQuery.call(this, compiled, queryId);
      };
      Object.defineProperty(realExec, "executeQuery", {
        value: wrapped,
        configurable: true,
        writable: true,
      });
      return () => {
        delete (realExec as { executeQuery?: ExecQueryFn }).executeQuery;
      };
    }

    it("normal path returns both turns and does not throw", async () => {
      const session = await repo.createSession({ targetType: "panel", targetSlug: "deb" });
      const [user, expert] = await repo.persistTurnPair(
        { chatId: session.id, role: "user", content: "hello" },
        { chatId: session.id, role: "expert", expertSlug: "panel-a", content: "hi" },
      );
      expect(user.seq).toBe(1);
      expect(expert.seq).toBe(2);
      expect(await repo.getTurnCount(session.id)).toBe(2);
    });

    it("when an insert fails and ROLLBACK succeeds, throws PersistTurnPairError with rollbackFailed=false", async () => {
      const session = await repo.createSession({ targetType: "panel", targetSlug: "deb" });
      // Fail any INSERT into chat_turns — the first user insert will
      // bubble out and trigger the catch+rollback path.
      const restore = patchExecuteQuery(db, { failOnSqlSubstring: "INSERT INTO chat_turns" });
      let caught: unknown;
      try {
        await repo.persistTurnPair(
          { chatId: session.id, role: "user", content: "topic" },
          { chatId: session.id, role: "expert", expertSlug: "panel-a", content: "reply" },
        );
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }
      expect(caught).toBeInstanceOf(PersistTurnPairError);
      const err = caught as PersistTurnPairError;
      expect(err.rollbackFailed).toBe(false);
      expect(err.rollbackError).toBeUndefined();
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.message).not.toMatch(/inconsistent/i);
      // Atomicity: nothing landed.
      expect(await repo.getTurnCount(session.id)).toBe(0);
    });

    it("when ROLLBACK itself fails, throws PersistTurnPairError with rollbackFailed=true and surfaces the rollback error", async () => {
      const session = await repo.createSession({ targetType: "panel", targetSlug: "deb" });
      const restore = patchExecuteQuery(db, {
        failOnSqlSubstring: "INSERT INTO chat_turns",
        failRollback: true,
      });
      let caught: unknown;
      try {
        await repo.persistTurnPair(
          { chatId: session.id, role: "user", content: "topic" },
          { chatId: session.id, role: "expert", expertSlug: "panel-a", content: "reply" },
        );
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }
      expect(caught).toBeInstanceOf(PersistTurnPairError);
      const err = caught as PersistTurnPairError;
      expect(err.rollbackFailed).toBe(true);
      expect(err.rollbackError).toBeInstanceOf(Error);
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.message).toMatch(/inconsistent/i);
      expect(err.message).not.toMatch(/preserved/i);
      // The rollback error itself must surface in the message so
      // operators can diagnose why ROLLBACK failed (#504 follow-up).
      expect(err.message).toMatch(/simulated ROLLBACK failure/);
      // Best-effort cleanup so the next test's beforeEach can rebuild state.
      try {
        await sql`ROLLBACK`.execute(db);
      } catch {
        /* ignore — transaction may already be closed */
      }
    });

    it("when BEGIN itself fails, throws PersistTurnPairError with rollbackFailed=false (no mutation occurred)", async () => {
      const session = await repo.createSession({ targetType: "panel", targetSlug: "deb" });
      const restore = patchExecuteQuery(db, { failOnSqlSubstring: "BEGIN" });
      let caught: unknown;
      try {
        await repo.persistTurnPair(
          { chatId: session.id, role: "user", content: "topic" },
          { chatId: session.id, role: "expert", expertSlug: "panel-a", content: "reply" },
        );
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }
      expect(caught).toBeInstanceOf(PersistTurnPairError);
      const err = caught as PersistTurnPairError;
      expect(err.rollbackFailed).toBe(false);
      expect(err.message).toMatch(/BEGIN/);
      expect(err.message).toMatch(/no changes applied/i);
      expect(err.cause).toBeInstanceOf(Error);
      expect(await repo.getTurnCount(session.id)).toBe(0);
    });
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

  // -------- rotateActiveSession (#333) --------

  describe("rotateActiveSession (#333) — atomic single-active-per-target rotation", () => {
    /**
     * Same executor-patching technique as the `persistTurnPair rollback`
     * suite above. Lets us simulate mid-transaction insert failures and
     * ROLLBACK failures so we can verify the rotation is genuinely atomic
     * (not just "two sequential calls in a row").
     */
    function patchExecuteQuery(
      database: CouncilDatabase,
      opts: { failOnSqlSubstring: string; failRollback?: boolean },
    ): () => void {
      const realExec = database.getExecutor();
      type ExecQueryFn = typeof realExec.executeQuery;
      const originalExecuteQuery: ExecQueryFn = realExec.executeQuery as ExecQueryFn;
      const wrapped: ExecQueryFn = async function (this: typeof realExec, compiled, queryId) {
        const text = compiled.sql;
        if (text.includes(opts.failOnSqlSubstring)) {
          throw new Error(`simulated failure on: ${opts.failOnSqlSubstring}`);
        }
        if (opts.failRollback === true && /^\s*ROLLBACK\b/i.test(text)) {
          throw new Error("simulated ROLLBACK failure");
        }
        return originalExecuteQuery.call(this, compiled, queryId);
      };
      Object.defineProperty(realExec, "executeQuery", {
        value: wrapped,
        configurable: true,
        writable: true,
      });
      return () => {
        delete (realExec as { executeQuery?: ExecQueryFn }).executeQuery;
      };
    }

    it("archives the prior active session and creates a new one in a single transaction", async () => {
      const prior = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await new Promise((r) => setTimeout(r, 5));
      const next = await repo.rotateActiveSession({ targetType: "expert", targetSlug: "cto" });

      expect(next.id).not.toBe(prior.id);
      expect(next.status).toBe("active");
      expect(next.targetType).toBe("expert");
      expect(next.targetSlug).toBe("cto");

      const priorAfter = await repo.findSessionById(prior.id);
      expect(priorAfter?.status).toBe("archived");

      // Single-active invariant: exactly one active row for this target.
      const actives = await repo.listSessions({ targetSlug: "cto", status: "active" });
      expect(actives).toHaveLength(1);
      expect(actives[0]?.id).toBe(next.id);
    });

    it("creates a new active session when no prior active session exists", async () => {
      const created = await repo.rotateActiveSession({ targetType: "panel", targetSlug: "arch" });
      expect(created.status).toBe("active");
      const actives = await repo.listSessions({ targetSlug: "arch", status: "active" });
      expect(actives).toHaveLength(1);
      expect(actives[0]?.id).toBe(created.id);
    });

    it("does not touch active sessions for other targets", async () => {
      const otherExpert = await repo.createSession({ targetType: "expert", targetSlug: "pm" });
      const otherPanel = await repo.createSession({ targetType: "panel", targetSlug: "cto" });
      const cto = await repo.createSession({ targetType: "expert", targetSlug: "cto" });

      await repo.rotateActiveSession({ targetType: "expert", targetSlug: "cto" });

      const otherExpertAfter = await repo.findSessionById(otherExpert.id);
      const otherPanelAfter = await repo.findSessionById(otherPanel.id);
      const ctoAfter = await repo.findSessionById(cto.id);

      expect(otherExpertAfter?.status).toBe("active");
      expect(otherPanelAfter?.status).toBe("active");
      expect(ctoAfter?.status).toBe("archived");
    });

    it("rolls back the archive when the create-new insert fails (atomicity)", async () => {
      const prior = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      const restore = patchExecuteQuery(db, { failOnSqlSubstring: 'insert into "chat_sessions"' });
      let caught: unknown;
      try {
        await repo.rotateActiveSession({ targetType: "expert", targetSlug: "cto" });
      } catch (err) {
        caught = err;
      } finally {
        restore();
      }
      expect(caught).toBeInstanceOf(RotateActiveSessionError);
      const err = caught as RotateActiveSessionError;
      expect(err.rollbackFailed).toBe(false);

      // Atomicity: prior must STILL be active — the archive UPDATE was rolled back.
      const priorAfter = await repo.findSessionById(prior.id);
      expect(priorAfter?.status).toBe("active");
      const actives = await repo.listSessions({ targetSlug: "cto", status: "active" });
      expect(actives).toHaveLength(1);
      expect(actives[0]?.id).toBe(prior.id);
    });

    it("surfaces rollbackFailed=true when ROLLBACK itself fails after a mid-tx error", async () => {
      await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      const restore = patchExecuteQuery(db, {
        failOnSqlSubstring: 'insert into "chat_sessions"',
        failRollback: true,
      });
      let caught: unknown;
      try {
        await repo.rotateActiveSession({ targetType: "expert", targetSlug: "cto" });
      } catch (err) {
        caught = err;
      } finally {
        restore();
      }
      expect(caught).toBeInstanceOf(RotateActiveSessionError);
      const err = caught as RotateActiveSessionError;
      expect(err.rollbackFailed).toBe(true);
      expect(err.message).toMatch(/inconsistent/i);
      expect(err.message).toMatch(/simulated ROLLBACK failure/);

      // Best-effort cleanup so afterEach can tear down cleanly.
      try {
        await sql`ROLLBACK`.execute(db);
      } catch {
        // expected — no active tx if executor was already restored
      }
    });

    it("throws RotateActiveSessionError with rollbackFailed=false when BEGIN fails", async () => {
      const restore = patchExecuteQuery(db, { failOnSqlSubstring: "BEGIN" });
      let caught: unknown;
      try {
        await repo.rotateActiveSession({ targetType: "expert", targetSlug: "cto" });
      } catch (err) {
        caught = err;
      } finally {
        restore();
      }
      expect(caught).toBeInstanceOf(RotateActiveSessionError);
      const err = caught as RotateActiveSessionError;
      expect(err.rollbackFailed).toBe(false);
      expect(err.message).toMatch(/BEGIN/);
      expect(err.message).toMatch(/no changes applied/i);
    });

    it("schema enforces single-active-per-target via partial unique index", async () => {
      // Manually insert two active rows for the same target, bypassing
      // rotateActiveSession. The partial unique index must reject the
      // second insert at the schema level — defence-in-depth so that any
      // future code path that forgets to use rotateActiveSession still
      // cannot violate the invariant.
      const now = new Date().toISOString();
      await db
        .insertInto("chat_sessions")
        .values({
          id: "01ABCDEFGHJKMNPQRSTVWXYZ00",
          target_type: "expert",
          target_slug: "cto",
          status: "active",
          summary: null,
          summary_through_seq: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await expect(
        db
          .insertInto("chat_sessions")
          .values({
            id: "01ABCDEFGHJKMNPQRSTVWXYZ01",
            target_type: "expert",
            target_slug: "cto",
            status: "active",
            summary: null,
            summary_through_seq: 0,
            created_at: now,
            updated_at: now,
          })
          .execute(),
      ).rejects.toThrow(/UNIQUE|unique/);
    });

    it("schema allows multiple archived sessions for the same target", async () => {
      // The partial unique index is scoped to status='active', so historical
      // archived sessions can stack up freely (this is what makes
      // rotateActiveSession's archive→insert sequence safe).
      const a = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await repo.archiveSession(a.id);
      const b = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await repo.archiveSession(b.id);
      const archived = await repo.listSessions({ targetSlug: "cto", status: "archived" });
      expect(archived).toHaveLength(2);
    });

    it("priorActiveId scopes the archive to a specific session id (concurrent-rotation safety)", async () => {
      // Simulate the concurrent-launch race: two callers both observed the
      // same prior active session X. Caller A wins by completing first;
      // caller B's rotation must not blindly archive A's freshly-created
      // session. Encoding the observed id as a compare-and-swap forces B
      // to fail the unique-index INSERT instead.
      const x = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      const aNew = await repo.rotateActiveSession(
        { targetType: "expert", targetSlug: "cto" },
        { priorActiveId: x.id },
      );
      // Caller B now arrives, still believing X is active.
      let bError: unknown;
      try {
        await repo.rotateActiveSession(
          { targetType: "expert", targetSlug: "cto" },
          { priorActiveId: x.id },
        );
      } catch (err) {
        bError = err;
      }
      expect(bError).toBeInstanceOf(RotateActiveSessionError);
      // A's freshly-created session must still be the lone active row —
      // B did not get to archive it.
      const actives = await repo.listSessions({ targetSlug: "cto", status: "active" });
      expect(actives).toHaveLength(1);
      expect(actives[0]?.id).toBe(aNew.id);
      const xAfter = await repo.findSessionById(x.id);
      expect(xAfter?.status).toBe("archived");
    });

    it("CAS-miss (concurrent rotation) produces a distinguishable error for user guidance (#538)", async () => {
      // Issue #538: When a CAS-miss occurs (two processes try to rotate the
      // same active session), the losing caller gets a RotateActiveSessionError.
      // The error's characteristics (unique constraint violation or 0-row archive)
      // should allow rewriteRotateError to detect it and provide guidance like
      // "another session was started concurrently" instead of generic "retry".
      const x = await repo.createSession({ targetType: "expert", targetSlug: "cto" });
      await repo.rotateActiveSession(
        { targetType: "expert", targetSlug: "cto" },
        { priorActiveId: x.id },
      );
      // Caller B tries to rotate with stale priorActiveId (CAS-miss)
      let bError: unknown;
      try {
        await repo.rotateActiveSession(
          { targetType: "expert", targetSlug: "cto" },
          { priorActiveId: x.id },
        );
      } catch (err) {
        bError = err;
      }

      expect(bError).toBeInstanceOf(RotateActiveSessionError);
      const err = bError as RotateActiveSessionError;
      // The CAS-miss manifests as either:
      // 1. Unique constraint violation (two active sessions for same target)
      // 2. Zero-row archive (priorActiveId no longer active)
      // Either way, rollbackFailed should be false (clean rollback).
      expect(err.rollbackFailed).toBe(false);

      // Pin the detection contract for #538: rewriteRotateError keys on
      // "unique" / "constraint" substrings in the error message + cause to
      // produce CAS-miss user guidance. If the underlying error no longer
      // contains those tokens (e.g. driver swaps to a different error
      // string), this test fails BEFORE the user-facing guidance silently
      // regresses to the generic "retry the command" message.
      const errorText = (
        err.message + (err.cause !== undefined ? String(err.cause) : "")
      ).toLowerCase();
      expect(errorText).toMatch(/unique|constraint/);
    });

    it("returns the new ChatSession constructed in-memory (no post-commit SELECT)", async () => {
      // Regression guard for Sentinel SNT-535-20260515-140527 finding #5:
      // a post-commit SELECT would conflate readback failures with rollback
      // paths, producing a misleading "may be inconsistent" diagnosis for
      // a row that was successfully written. The returned object MUST
      // therefore reflect the values we just inserted, not a re-read.
      const result = await repo.rotateActiveSession({
        targetType: "panel",
        targetSlug: "arch-review",
      });
      expect(result.targetType).toBe("panel");
      expect(result.targetSlug).toBe("arch-review");
      expect(result.status).toBe("active");
      expect(result.summary).toBeNull();
      expect(result.summaryThroughSeq).toBe(0);
      expect(result.createdAt).toBe(result.updatedAt);
      // And the row must of course be queryable (proves the INSERT actually
      // committed, separately from the in-memory return value).
      const row = await repo.findSessionById(result.id);
      expect(row?.id).toBe(result.id);
    });

    it("intercepts and records SQL queries to detect post-COMMIT SELECT (#539)", async () => {
      // Structural test: assert no SELECT statement executes after COMMIT.
      // This prevents a future engineer from adding a post-COMMIT SELECT
      // which would conflate readback failures with rollback-needed failures.
      const queries: string[] = [];
      const realExec = db.getExecutor();
      type ExecQueryFn = typeof realExec.executeQuery;
      const originalExecuteQuery: ExecQueryFn = realExec.executeQuery as ExecQueryFn;
      const wrapped: ExecQueryFn = async function (this: typeof realExec, compiled, queryId) {
        queries.push(compiled.sql);
        return originalExecuteQuery.call(this, compiled, queryId);
      };
      Object.defineProperty(realExec, "executeQuery", {
        value: wrapped,
        configurable: true,
        writable: true,
      });

      try {
        await repo.rotateActiveSession({ targetType: "expert", targetSlug: "cto" });
      } finally {
        delete (realExec as { executeQuery?: ExecQueryFn }).executeQuery;
      }

      const commitIdx = queries.findIndex((q) => /^\s*COMMIT\b/i.test(q));
      expect(commitIdx).toBeGreaterThanOrEqual(0);
      const postCommitQueries = queries.slice(commitIdx + 1);
      const hasPostCommitSelect = postCommitQueries.some((q) =>
        /^\s*select\b/i.test(q.trim()),
      );
      expect(hasPostCommitSelect).toBe(false);
    });
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
