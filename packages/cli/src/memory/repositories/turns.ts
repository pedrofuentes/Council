/**
 * Turn repository — append-only writes + ordered reads + FTS5 search.
 *
 * Turns represent a single contribution (an expert response, a moderator
 * synthesis, a user prompt). Per ADR-002 we store the content here for
 * orchestration purposes; the SDK retains the canonical transcript.
 */
import { sql } from "kysely";
import { ulid } from "ulid";

import type { CouncilDatabase, TurnRow } from "../db.js";

export type SpeakerKind = "user" | "expert" | "moderator" | "system" | "human";

export interface Turn {
  readonly id: string;
  readonly debateId: string;
  readonly round: number;
  readonly seq: number;
  readonly speakerKind: SpeakerKind;
  readonly expertId: string | null;
  readonly content: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly latencyMs: number | null;
  readonly createdAt: string;
}

export interface NewTurn {
  readonly debateId: string;
  readonly round: number;
  readonly seq: number;
  readonly speakerKind: SpeakerKind;
  readonly expertId?: string | null;
  readonly content: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly latencyMs?: number;
}

function toDomain(row: TurnRow): Turn {
  return {
    id: row.id,
    debateId: row.debate_id,
    round: row.round,
    seq: row.seq,
    speakerKind: row.speaker_kind as SpeakerKind,
    expertId: row.expert_id,
    content: row.content,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

export class TurnRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async create(input: NewTurn): Promise<Turn> {
    const id = ulid();
    const now = new Date().toISOString();
    await this.db
      .insertInto("turns")
      .values({
        id,
        debate_id: input.debateId,
        round: input.round,
        seq: input.seq,
        speaker_kind: input.speakerKind,
        expert_id: input.expertId ?? null,
        content: input.content,
        tokens_in: input.tokensIn ?? null,
        tokens_out: input.tokensOut ?? null,
        latency_ms: input.latencyMs ?? null,
        created_at: now,
      })
      .execute();
    const row = await this.db.selectFrom("turns").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findByDebateId(debateId: string): Promise<readonly Turn[]> {
    const rows = await this.db
      .selectFrom("turns")
      .selectAll()
      .where("debate_id", "=", debateId)
      .orderBy("round", "asc")
      .orderBy("seq", "asc")
      .execute();
    return rows.map(toDomain);
  }

  async findLatestByDebateId(debateId: string): Promise<Turn | undefined> {
    const row = await this.db
      .selectFrom("turns")
      .selectAll()
      .where("debate_id", "=", debateId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  async countByDebateId(debateId: string): Promise<number> {
    const row = await this.db
      .selectFrom("turns")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("debate_id", "=", debateId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countByExpertId(expertId: string): Promise<number> {
    const row = await this.db
      .selectFrom("turns")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("expert_id", "=", expertId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Full-text search across all turn content via the FTS5 mirror table.
   * `query` is interpreted by FTS5 (tokens implicitly AND-ed; quotes for phrases).
   *
   * Implementation: Kysely doesn't model FTS5 in its type system, so we run
   * the join via a raw SQL query. The shape of each row matches TurnRow.
   */
  async search(query: string): Promise<readonly Turn[]> {
    const result = await sql<TurnRow>`
      SELECT t.id, t.debate_id, t.round, t.seq, t.speaker_kind, t.expert_id,
             t.content, t.tokens_in, t.tokens_out, t.latency_ms, t.created_at
      FROM turns AS t
      INNER JOIN turns_fts AS f ON f.rowid = t.rowid
      WHERE turns_fts MATCH ${query}
      ORDER BY t.round ASC, t.seq ASC
    `.execute(this.db);
    return result.rows.map(toDomain);
  }
}
