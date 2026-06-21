/**
 * Debate repository — typed CRUD over the `debates` table.
 *
 * A "debate" is one run of a panel against a topic. Status transitions:
 *   running → completed | interrupted | aborted | failed
 *
 * The schema (see src/memory/db.ts) declares `panel_id` as a FK to
 * `panels.id`; create() will throw if the referenced panel does not exist.
 *
 * Returned objects are camelCase domain types. The mapping lives in
 * `toDomain()` so callers never see snake_case columns.
 */
import { sql } from "kysely";
import { ulid } from "ulid";

import type { CouncilDatabase, DebateRow } from "../db.js";

/** Lifecycle status of a debate row. */
export type DebateStatus = "running" | "completed" | "interrupted" | "aborted" | "failed";

export interface Debate {
  readonly id: string;
  readonly panelId: string;
  readonly prompt: string;
  readonly status: DebateStatus;
  readonly moderator: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly costEstimate: number | null;
}

export interface NewDebate {
  readonly panelId: string;
  readonly prompt: string;
  readonly moderator: string;
}

export interface DebateUpdate {
  readonly status?: DebateStatus;
  readonly endedAt?: string;
  readonly costEstimate?: number;
}

function toDomain(row: DebateRow): Debate {
  return {
    id: row.id,
    panelId: row.panel_id,
    prompt: row.prompt,
    status: row.status as DebateStatus,
    moderator: row.moderator,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    costEstimate: row.cost_estimate,
  };
}

export class DebateRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async create(input: NewDebate): Promise<Debate> {
    const id = ulid();
    const startedAt = new Date().toISOString();
    await this.db
      .insertInto("debates")
      .values({
        id,
        panel_id: input.panelId,
        prompt: input.prompt,
        status: "running",
        moderator: input.moderator,
        started_at: startedAt,
        ended_at: null,
        cost_estimate: null,
      })
      .execute();
    const row = await this.db
      .selectFrom("debates")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findById(id: string): Promise<Debate | undefined> {
    const row = await this.db
      .selectFrom("debates")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  async findByPanelId(panelId: string): Promise<readonly Debate[]> {
    const rows = await this.db
      .selectFrom("debates")
      .selectAll()
      .where("panel_id", "=", panelId)
      .orderBy("started_at", "asc")
      .orderBy(sql<number>`rowid`, "asc")
      .execute();
    return rows.map(toDomain);
  }

  async cancelRunning(panelId: string, endedAt: string = new Date().toISOString()): Promise<Debate | undefined> {
    const row = await this.db
      .selectFrom("debates")
      .selectAll()
      .where("panel_id", "=", panelId)
      .where("status", "=", "running")
      .orderBy("started_at", "desc")
      .orderBy(sql<number>`rowid`, "desc")
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }

    const [result] = await this.db
      .updateTable("debates")
      .set({
        status: "interrupted",
        ended_at: endedAt,
      })
      .where("id", "=", row.id)
      .where("status", "=", "running")
      .execute();
    if (Number(result?.numUpdatedRows ?? 0) === 0) {
      return undefined;
    }

    return this.findById(row.id);
  }

  async cancelAllRunning(endedAt: string = new Date().toISOString()): Promise<number> {
    const [result] = await this.db
      .updateTable("debates")
      .set({
        status: "interrupted",
        ended_at: endedAt,
      })
      .where("status", "=", "running")
      .execute();

    return Number(result?.numUpdatedRows ?? 0);
  }

  async update(id: string, patch: DebateUpdate): Promise<Debate | undefined> {
    const updates: Record<string, unknown> = {};
    if (patch.status !== undefined) updates["status"] = patch.status;
    if (patch.endedAt !== undefined) updates["ended_at"] = patch.endedAt;
    if (patch.costEstimate !== undefined) updates["cost_estimate"] = patch.costEstimate;
    if (Object.keys(updates).length > 0) {
      await this.db.updateTable("debates").set(updates).where("id", "=", id).execute();
    }
    return this.findById(id);
  }
}
