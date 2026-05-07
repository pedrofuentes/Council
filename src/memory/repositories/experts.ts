/**
 * Expert repository — typed CRUD over the experts table.
 *
 * UNIQUE (panel_id, slug) is enforced by the schema; `create()` will throw
 * on collision. The caller is expected to surface a friendly error.
 */
import { ulid } from "ulid";

import type { CouncilDatabase, ExpertRow } from "../db.js";

export interface Expert {
  readonly id: string;
  readonly panelId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly model: string;
  readonly systemMessage: string;
  readonly copilotSessionId: string | null;
  readonly createdAt: string;
}

export interface NewExpert {
  readonly panelId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly model: string;
  readonly systemMessage: string;
  readonly copilotSessionId?: string;
}

export interface ExpertUpdate {
  readonly displayName?: string;
  readonly model?: string;
  readonly systemMessage?: string;
  readonly copilotSessionId?: string | null;
}

function toDomain(row: ExpertRow): Expert {
  return {
    id: row.id,
    panelId: row.panel_id,
    slug: row.slug,
    displayName: row.display_name,
    model: row.model,
    systemMessage: row.system_message,
    copilotSessionId: row.copilot_session_id,
    createdAt: row.created_at,
  };
}

export class ExpertRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async create(input: NewExpert): Promise<Expert> {
    const id = ulid();
    const now = new Date().toISOString();
    await this.db
      .insertInto("experts")
      .values({
        id,
        panel_id: input.panelId,
        slug: input.slug,
        display_name: input.displayName,
        model: input.model,
        system_message: input.systemMessage,
        copilot_session_id: input.copilotSessionId ?? null,
        created_at: now,
      })
      .execute();
    const row = await this.db.selectFrom("experts").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findById(id: string): Promise<Expert | undefined> {
    const row = await this.db.selectFrom("experts").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  async findByPanelId(panelId: string): Promise<readonly Expert[]> {
    const rows = await this.db
      .selectFrom("experts")
      .selectAll()
      .where("panel_id", "=", panelId)
      .orderBy("id", "asc")
      .execute();
    return rows.map(toDomain);
  }

  async update(id: string, patch: ExpertUpdate): Promise<Expert | undefined> {
    const updates: Record<string, unknown> = {};
    if (patch.displayName !== undefined) updates["display_name"] = patch.displayName;
    if (patch.model !== undefined) updates["model"] = patch.model;
    if (patch.systemMessage !== undefined) updates["system_message"] = patch.systemMessage;
    if (patch.copilotSessionId !== undefined) updates["copilot_session_id"] = patch.copilotSessionId;
    if (Object.keys(updates).length > 0) {
      await this.db.updateTable("experts").set(updates).where("id", "=", id).execute();
    }
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("experts").where("id", "=", id).execute();
  }
}
