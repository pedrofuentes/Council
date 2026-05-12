/**
 * Panel library repository — typed CRUD over the panel_library and
 * panel_members tables (migration 004). Mirrors ExpertLibraryRepository:
 * snake_case columns mapped to camelCase domain objects via toDomain().
 *
 * `name` is the natural primary key.
 */
import type { CouncilDatabase, PanelLibraryRow } from "../db.js";

export interface LibraryPanel {
  readonly name: string;
  readonly description: string | null;
  readonly yamlPath: string;
  readonly yamlChecksum: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewLibraryPanel {
  readonly name: string;
  readonly description?: string;
  readonly yamlPath: string;
  readonly yamlChecksum: string;
}

function toDomain(row: PanelLibraryRow): LibraryPanel {
  return {
    name: row.name,
    description: row.description,
    yamlPath: row.yaml_path,
    yamlChecksum: row.yaml_checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PanelLibraryRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async create(input: NewLibraryPanel): Promise<LibraryPanel> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("panel_library")
      .values({
        name: input.name,
        description: input.description ?? null,
        yaml_path: input.yamlPath,
        yaml_checksum: input.yamlChecksum,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const row = await this.db
      .selectFrom("panel_library")
      .selectAll()
      .where("name", "=", input.name)
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findByName(name: string): Promise<LibraryPanel | undefined> {
    const row = await this.db
      .selectFrom("panel_library")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  async findAll(): Promise<readonly LibraryPanel[]> {
    const rows = await this.db
      .selectFrom("panel_library")
      .selectAll()
      .orderBy("name", "asc")
      .execute();
    return rows.map(toDomain);
  }

  async update(name: string, patch: Partial<NewLibraryPanel>): Promise<void> {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    if (patch.description !== undefined) updates["description"] = patch.description;
    if (patch.yamlPath !== undefined) updates["yaml_path"] = patch.yamlPath;
    if (patch.yamlChecksum !== undefined) updates["yaml_checksum"] = patch.yamlChecksum;
    await this.db.updateTable("panel_library").set(updates).where("name", "=", name).execute();
  }

  async delete(name: string): Promise<void> {
    // ON DELETE CASCADE on panel_members handles membership cleanup.
    await this.db.deleteFrom("panel_library").where("name", "=", name).execute();
  }

  async setMembers(panelName: string, expertSlugs: readonly string[]): Promise<void> {
    await this.db.deleteFrom("panel_members").where("panel_name", "=", panelName).execute();
    if (expertSlugs.length === 0) return;
    const now = new Date().toISOString();
    await this.db
      .insertInto("panel_members")
      .values(
        expertSlugs.map((slug, idx) => ({
          panel_name: panelName,
          expert_slug: slug,
          position: idx,
          created_at: now,
        })),
      )
      .execute();
  }

  async getMembers(panelName: string): Promise<readonly string[]> {
    const rows = await this.db
      .selectFrom("panel_members")
      .select("expert_slug")
      .where("panel_name", "=", panelName)
      .orderBy("position", "asc")
      .execute();
    return rows.map((r) => r.expert_slug);
  }
}
