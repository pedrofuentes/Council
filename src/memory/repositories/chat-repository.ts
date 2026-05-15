/**
 * Chat repository — typed CRUD over the `chat_sessions` and `chat_turns`
 * tables introduced by migration 005 (Roadmap 5.1, persistent chat).
 *
 * Mirrors the pattern used by panels.ts / expert-library-repo.ts:
 *   - snake_case row shapes → camelCase domain objects via toDomain()
 *   - ULID id generation for sessions and turns
 *   - readonly returns; immutable-by-default
 *
 * Turn ordering: each session has its own monotonically-increasing `seq`,
 * assigned by `addTurn()` as `getLatestSeq() + 1`. Callers should not set
 * `seq` directly.
 *
 * Full-text search: `searchTurns()` queries the FTS5 `chat_turns_fts`
 * virtual table populated by the after-insert / after-delete triggers in
 * migration 005, then re-hydrates matching rows from `chat_turns`.
 */
import { sql } from "kysely";
import { ulid } from "ulid";

import type {
  ChatRole,
  ChatSession,
  ChatStatus,
  ChatTargetType,
  ChatTurn,
} from "../../core/chat/chat-session.js";
import type { ChatSessionRow, ChatTurnRow, CouncilDatabase } from "../db.js";

/**
 * Thrown by {@link ChatRepository.persistTurnPair} when the user+expert
 * transaction aborts. Mirrors {@link ClearForRetrainError} (#425): the
 * {@link rollbackFailed} flag lets callers produce honest user-facing
 * messages — when `true`, the database state may be inconsistent and
 * the message MUST NOT claim that data was preserved.
 */
export class PersistTurnPairError extends Error {
  readonly rollbackFailed: boolean;
  readonly rollbackError?: unknown;

  constructor(
    message: string,
    opts: { cause: unknown; rollbackFailed: boolean; rollbackError?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "PersistTurnPairError";
    this.rollbackFailed = opts.rollbackFailed;
    if (opts.rollbackError !== undefined) {
      this.rollbackError = opts.rollbackError;
    }
  }
}

/**
 * Thrown by {@link ChatRepository.rotateActiveSession} when the
 * archive-old + insert-new transaction aborts (#333). Mirrors
 * {@link PersistTurnPairError}: the {@link rollbackFailed} flag lets
 * callers produce honest user-facing messages — when `true`, the database
 * state may be inconsistent and the message MUST NOT claim that the prior
 * session was preserved.
 */
export class RotateActiveSessionError extends Error {
  readonly rollbackFailed: boolean;
  readonly rollbackError?: unknown;

  constructor(
    message: string,
    opts: { cause: unknown; rollbackFailed: boolean; rollbackError?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "RotateActiveSessionError";
    this.rollbackFailed = opts.rollbackFailed;
    if (opts.rollbackError !== undefined) {
      this.rollbackError = opts.rollbackError;
    }
  }
}

export interface NewChatSession {
  readonly targetType: ChatTargetType;
  readonly targetSlug: string;
}

export interface NewChatTurn {
  readonly chatId: string;
  readonly role: ChatRole;
  readonly expertSlug?: string;
  readonly content: string;
  readonly isMention?: boolean;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

export interface ListSessionsOptions {
  readonly targetSlug?: string;
  readonly status?: ChatStatus;
}

export interface GetTurnsOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface SearchTurnsOptions {
  readonly chatId?: string;
  readonly limit?: number;
}

function sessionToDomain(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    targetType: row.target_type as ChatTargetType,
    targetSlug: row.target_slug,
    status: row.status as ChatStatus,
    summary: row.summary,
    summaryThroughSeq: row.summary_through_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function turnToDomain(row: ChatTurnRow): ChatTurn {
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    role: row.role as ChatRole,
    expertSlug: row.expert_slug,
    content: row.content,
    isMention: row.is_mention !== 0,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
  };
}

export class ChatRepository {
  constructor(private readonly db: CouncilDatabase) {}

  // ---------- sessions ----------

  async createSession(input: NewChatSession): Promise<ChatSession> {
    const now = new Date().toISOString();
    const id = ulid();
    await this.db
      .insertInto("chat_sessions")
      .values({
        id,
        target_type: input.targetType,
        target_slug: input.targetSlug,
        status: "active",
        summary: null,
        summary_through_seq: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const row = await this.db
      .selectFrom("chat_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return sessionToDomain(row);
  }

  async findSessionById(id: string): Promise<ChatSession | undefined> {
    const row = await this.db
      .selectFrom("chat_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? sessionToDomain(row) : undefined;
  }

  /**
   * Most-recently-created active session for the given target, or
   * undefined if none exist. Used by `council chat` to resume the
   * latest conversation with an expert/panel.
   */
  async findActiveSession(
    targetType: ChatTargetType,
    targetSlug: string,
  ): Promise<ChatSession | undefined> {
    const row = await this.db
      .selectFrom("chat_sessions")
      .selectAll()
      .where("target_type", "=", targetType)
      .where("target_slug", "=", targetSlug)
      .where("status", "=", "active")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row ? sessionToDomain(row) : undefined;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<readonly ChatSession[]> {
    let query = this.db.selectFrom("chat_sessions").selectAll();
    if (options.targetSlug !== undefined) {
      query = query.where("target_slug", "=", options.targetSlug);
    }
    if (options.status !== undefined) {
      query = query.where("status", "=", options.status);
    }
    const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").execute();
    return rows.map(sessionToDomain);
  }

  async archiveSession(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .updateTable("chat_sessions")
      .set({ status: "archived", updated_at: now })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Atomically rotate the active session for a given target (#333).
   *
   * Within a single SQLite transaction:
   *   1. Archive every currently-active session for `(targetType, targetSlug)`
   *      (in practice at most one, enforced by the partial unique index
   *      `idx_chat_sessions_active_unique` from migration 010).
   *   2. Insert a new active session for the same target.
   *
   * The transaction guarantees that a crash mid-rotation cannot leave the
   * target with zero active sessions: either both steps land or neither
   * does. The partial unique index provides defence-in-depth so any future
   * code path that bypasses this helper still cannot create two active
   * sessions for the same target.
   *
   * Implemented with raw `BEGIN`/`COMMIT`/`ROLLBACK` for the same reason as
   * {@link persistTurnPair} and `clearForRetrain` (see
   * document-repository.ts): Kysely's `transaction()` helper reconnects the
   * libsql `:memory:` connection and would lose virtual FTS5 tables.
   *
   * On failure throws {@link RotateActiveSessionError}. Callers MUST inspect
   * `rollbackFailed`: when the rollback itself failed the DB may be in an
   * inconsistent state and any user-facing message must NOT claim that the
   * prior session was preserved.
   */
  async rotateActiveSession(input: NewChatSession): Promise<ChatSession> {
    try {
      await sql`BEGIN`.execute(this.db);
    } catch (beginErr) {
      const detail = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new RotateActiveSessionError(
        `rotateActiveSession failed before any changes ` +
          `(BEGIN failed; no changes applied): ${detail}`,
        { cause: beginErr, rollbackFailed: false },
      );
    }
    try {
      const now = new Date().toISOString();
      await this.db
        .updateTable("chat_sessions")
        .set({ status: "archived", updated_at: now })
        .where("target_type", "=", input.targetType)
        .where("target_slug", "=", input.targetSlug)
        .where("status", "=", "active")
        .execute();
      const id = ulid();
      await this.db
        .insertInto("chat_sessions")
        .values({
          id,
          target_type: input.targetType,
          target_slug: input.targetSlug,
          status: "active",
          summary: null,
          summary_through_seq: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await sql`COMMIT`.execute(this.db);
      const row = await this.db
        .selectFrom("chat_sessions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return sessionToDomain(row);
    } catch (err) {
      let rollbackFailed = false;
      let rollbackError: unknown;
      try {
        await sql`ROLLBACK`.execute(this.db);
      } catch (rbErr) {
        rollbackFailed = true;
        rollbackError = rbErr;
      }
      const detail = err instanceof Error ? err.message : String(err);
      const message = rollbackFailed
        ? `rotateActiveSession failed and ROLLBACK also failed; ` +
          `database may be in an inconsistent state ` +
          `(prior session may have been archived without a replacement): ${detail} ` +
          `[rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}]`
        : `rotateActiveSession failed (transaction rolled back cleanly; prior active session preserved): ${detail}`;
      throw new RotateActiveSessionError(
        message,
        rollbackError === undefined
          ? { cause: err, rollbackFailed }
          : { cause: err, rollbackFailed, rollbackError },
      );
    }
  }

  async updateSummary(id: string, summary: string, throughSeq: number): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .updateTable("chat_sessions")
      .set({ summary, summary_through_seq: throughSeq, updated_at: now })
      .where("id", "=", id)
      .execute();
  }

  // ---------- turns ----------

  async addTurn(input: NewChatTurn): Promise<ChatTurn> {
    const now = new Date().toISOString();
    const id = ulid();
    const expertSlug = input.expertSlug ?? null;
    const isMention = input.isMention === true ? 1 : 0;
    const tokensIn = input.tokensIn ?? null;
    const tokensOut = input.tokensOut ?? null;
    // Atomic seq allocation: compute COALESCE(MAX(seq), 0) + 1 inside the
    // same INSERT statement so SQLite's per-statement write serialization
    // protects against the read-modify-write race that a separate
    // getLatestSeq() + insert would have. The UNIQUE (chat_id, seq)
    // constraint in migration 005 backs this up at the schema level.
    await sql`
      INSERT INTO chat_turns
        (id, chat_id, seq, role, expert_slug, content, is_mention, tokens_in, tokens_out, created_at)
      SELECT ${id}, ${input.chatId}, COALESCE(MAX(seq), 0) + 1,
        ${input.role}, ${expertSlug}, ${input.content},
        ${isMention}, ${tokensIn}, ${tokensOut}, ${now}
      FROM chat_turns
      WHERE chat_id = ${input.chatId}
    `.execute(this.db);
    const row = await this.db
      .selectFrom("chat_turns")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return turnToDomain(row);
  }

  /**
   * Atomically persist a user turn followed by an expert turn within a
   * single SQLite transaction (#466 follow-up). The user turn is
   * inserted first so its allocated `seq` is strictly less than the
   * expert turn's `seq`, ensuring `getTurns()` returns the prompt
   * before the reply that it triggered.
   *
   * Used by the `@convene` Ctrl+C abort path in chat.ts: when an abort
   * lands mid-stream of the FIRST expert turn, the deferred user prompt
   * and the partial expert reply must land together — either both
   * succeed with correct ordering, or neither lands (no orphan rows).
   *
   * Implemented with raw `BEGIN`/`COMMIT`/`ROLLBACK` for the same
   * reason as `clearForRetrain` (see document-repository.ts): Kysely's
   * `transaction()` helper reconnects the libsql `:memory:` connection
   * and would lose virtual FTS5 tables.
   *
   * On failure throws {@link PersistTurnPairError} (#504). Callers MUST
   * inspect `rollbackFailed`: when the rollback itself failed the DB
   * may be in an inconsistent state and any user-facing message must
   * NOT claim that prior data was preserved.
   */
  async persistTurnPair(
    userInput: NewChatTurn,
    expertInput: NewChatTurn,
  ): Promise<readonly [ChatTurn, ChatTurn]> {
    try {
      await sql`BEGIN`.execute(this.db);
    } catch (beginErr) {
      const detail = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new PersistTurnPairError(
        `persistTurnPair failed before any changes ` +
          `(BEGIN failed; no changes applied): ${detail}`,
        { cause: beginErr, rollbackFailed: false },
      );
    }
    try {
      const user = await this.addTurn(userInput);
      const expert = await this.addTurn(expertInput);
      await sql`COMMIT`.execute(this.db);
      return [user, expert] as const;
    } catch (err) {
      let rollbackFailed = false;
      let rollbackError: unknown;
      try {
        await sql`ROLLBACK`.execute(this.db);
      } catch (rbErr) {
        rollbackFailed = true;
        rollbackError = rbErr;
      }
      const detail = err instanceof Error ? err.message : String(err);
      const message = rollbackFailed
        ? `persistTurnPair failed and ROLLBACK also failed; ` +
          `database may be in an inconsistent state ` +
          `(an orphan user or expert turn may have landed): ${detail} ` +
          `[rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}]`
        : `persistTurnPair failed (transaction rolled back cleanly): ${detail}`;
      throw new PersistTurnPairError(
        message,
        rollbackError === undefined
          ? { cause: err, rollbackFailed }
          : { cause: err, rollbackFailed, rollbackError },
      );
    }
  }

  async getTurns(chatId: string, options: GetTurnsOptions = {}): Promise<readonly ChatTurn[]> {
    let query = this.db.selectFrom("chat_turns").selectAll().where("chat_id", "=", chatId);
    if (options.afterSeq !== undefined) {
      query = query.where("seq", ">", options.afterSeq);
    }
    query = query.orderBy("seq", "asc");
    if (options.limit !== undefined) {
      query = query.limit(options.limit);
    }
    const rows = await query.execute();
    return rows.map(turnToDomain);
  }

  async getTurnCount(chatId: string): Promise<number> {
    const row = await this.db
      .selectFrom("chat_turns")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("chat_id", "=", chatId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async getLatestSeq(chatId: string): Promise<number> {
    const row = await this.db
      .selectFrom("chat_turns")
      .select((eb) => eb.fn.max<number | null>("seq").as("max_seq"))
      .where("chat_id", "=", chatId)
      .executeTakeFirst();
    const value = row?.max_seq;
    return value === null || value === undefined ? 0 : Number(value);
  }

  // ---------- search ----------

  /**
   * Full-text search over chat_turns content via the FTS5 virtual table
   * `chat_turns_fts`. Returns matching turns as domain objects, optionally
   * scoped to a single chat session and/or capped at `limit`.
   *
   * FTS5 is queried with the standard MATCH operator; callers are
   * responsible for escaping any operator characters in `query` if they
   * need to pass user-controlled tokens.
   */
  async searchTurns(query: string, options: SearchTurnsOptions = {}): Promise<readonly ChatTurn[]> {
    let builder = this.db
      .selectFrom("chat_turns")
      .innerJoin(sql<{ rowid: number }>`chat_turns_fts`.as("fts"), (join) =>
        join.onRef(sql`fts.rowid`, "=", sql`chat_turns.rowid`),
      )
      .selectAll("chat_turns")
      .where(sql`chat_turns_fts`, "match", query);

    if (options.chatId !== undefined) {
      builder = builder.where("chat_id", "=", options.chatId);
    }
    builder = builder.orderBy("chat_turns.chat_id", "asc").orderBy("chat_turns.seq", "asc");
    if (options.limit !== undefined) {
      builder = builder.limit(options.limit);
    }
    const rows = await builder.execute();
    return rows.map(turnToDomain);
  }
}
