/**
 * Panel repository — typed CRUD over the panels table.
 *
 * Returns Council domain objects (camelCase) regardless of the underlying
 * snake_case column names. The conversion lives in `toDomain()`.
 */
import { ulid } from "ulid";

import type { CouncilDatabase, PanelRow } from "../db.js";

export interface Panel {
  readonly id: string;
  readonly name: string;
  readonly topic: string | null;
  readonly copilotHome: string;
  readonly configJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewPanel {
  readonly name: string;
  readonly topic?: string;
  readonly copilotHome: string;
  readonly configJson: string;
}

export interface PanelUpdate {
  readonly name?: string;
  readonly topic?: string;
  readonly copilotHome?: string;
  readonly configJson?: string;
}

function toDomain(row: PanelRow): Panel {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    copilotHome: row.copilot_home,
    configJson: row.config_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PanelRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async create(input: NewPanel): Promise<Panel> {
    const now = new Date().toISOString();
    const id = ulid();
    await this.db
      .insertInto("panels")
      .values({
        id,
        name: input.name,
        topic: input.topic ?? null,
        copilot_home: input.copilotHome,
        config_json: input.configJson,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const row = await this.db.selectFrom("panels").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findById(id: string): Promise<Panel | undefined> {
    const row = await this.db.selectFrom("panels").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  /**
   * Look up a panel by its `name` column. Names are not constrained to
   * be unique by the schema today (debate-orchestrator generates
   * timestamped names); this returns the most-recently-created match.
   * Used by `council resume <panel>` to map a friendly name to a panel.
   */
  async findByName(name: string): Promise<Panel | undefined> {
    const row = await this.db
      .selectFrom("panels")
      .selectAll()
      .where("name", "=", name)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  async findAll(): Promise<readonly Panel[]> {
    const rows = await this.db.selectFrom("panels").selectAll().orderBy("id", "asc").execute();
    return rows.map(toDomain);
  }

  async update(id: string, patch: PanelUpdate): Promise<Panel | undefined> {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    if (patch.name !== undefined) updates["name"] = patch.name;
    if (patch.topic !== undefined) updates["topic"] = patch.topic;
    if (patch.copilotHome !== undefined) updates["copilot_home"] = patch.copilotHome;
    if (patch.configJson !== undefined) updates["config_json"] = patch.configJson;
    await this.db.updateTable("panels").set(updates).where("id", "=", id).execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("panels").where("id", "=", id).execute();
  }
}
