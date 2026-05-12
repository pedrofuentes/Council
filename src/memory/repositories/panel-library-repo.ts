/**
 * Panel library repository — typed CRUD over the panel_library and
 * panel_members tables (migration 004). Mirrors ExpertLibraryRepository:
 * snake_case columns mapped to camelCase domain objects via toDomain().
 *
 * The natural key is `name` — kebab-case panel slug — so no ulid is
 * generated here. `panel_members` carries the ordered membership list
 * via the `position` column; setMembers replaces the full list
 * transactionally.
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
  readonly description: string | null;
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
        description: input.description,
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
    await this.db.deleteFrom("panel_library").where("name", "=", name).execute();
  }

  async setMembers(panelName: string, expertSlugs: readonly string[]): Promise<void> {
    // Snapshot existing membership so we can restore on failure. We can't
    // use a Kysely transaction here because the libsql :memory: dialect
    // opens transactions on a fresh connection that does not see the
    // primary connection's schema, which breaks every in-memory unit test.
    const snapshot = await this.db
      .selectFrom("panel_members")
      .selectAll()
      .where("panel_name", "=", panelName)
      .execute();
    await this.db.deleteFrom("panel_members").where("panel_name", "=", panelName).execute();
    if (expertSlugs.length === 0) return;
    const now = new Date().toISOString();
    const rows = expertSlugs.map((slug, index) => ({
      panel_name: panelName,
      expert_slug: slug,
      position: index,
      created_at: now,
    }));
    try {
      await this.db.insertInto("panel_members").values(rows).execute();
    } catch (err) {
      if (snapshot.length > 0) {
        try {
          await this.db
            .insertInto("panel_members")
            .values(
              snapshot.map((s) => ({
                panel_name: s.panel_name,
                expert_slug: s.expert_slug,
                position: s.position,
                created_at: s.created_at,
              })),
            )
            .execute();
        } catch (restoreErr) {
          throw new AggregateError(
            [err, restoreErr],
            `setMembers("${panelName}") failed and restoring prior membership also failed — storage may be inconsistent`,
          );
        }
      }
      throw err;
    }
  }

  async getMembers(panelName: string): Promise<readonly string[]> {
    const rows = await this.db
      .selectFrom("panel_members")
      .select(["expert_slug", "position"])
      .where("panel_name", "=", panelName)
      .orderBy("position", "asc")
      .execute();
    return rows.map((r) => r.expert_slug);
  }
}
