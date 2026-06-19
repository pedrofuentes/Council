/**
 * Expert library repository — typed CRUD over the expert_library table
 * (migration 004). Mirrors the pattern in panels.ts: snake_case columns
 * mapped to camelCase domain objects via toDomain().
 *
 * Note: `slug` is the natural primary key — no ulid is generated here.
 */
import type { CouncilDatabase, ExpertLibraryRow } from "../db.js";

export interface LibraryExpert {
  readonly slug: string;
  readonly kind: string;
  readonly displayName: string;
  readonly yamlPath: string;
  readonly yamlChecksum: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewLibraryExpert {
  readonly slug: string;
  readonly kind: string;
  readonly displayName: string;
  readonly yamlPath: string;
  readonly yamlChecksum: string;
}

function toDomain(row: ExpertLibraryRow): LibraryExpert {
  return {
    slug: row.slug,
    kind: row.kind,
    displayName: row.display_name,
    yamlPath: row.yaml_path,
    yamlChecksum: row.yaml_checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExpertLibraryRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async create(input: NewLibraryExpert): Promise<LibraryExpert> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("expert_library")
      .values({
        slug: input.slug,
        kind: input.kind,
        display_name: input.displayName,
        yaml_path: input.yamlPath,
        yaml_checksum: input.yamlChecksum,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("slug").doUpdateSet({
          kind: input.kind,
          display_name: input.displayName,
          yaml_path: input.yamlPath,
          yaml_checksum: input.yamlChecksum,
          updated_at: now,
        }),
      )
      .execute();
    const row = await this.db
      .selectFrom("expert_library")
      .selectAll()
      .where("slug", "=", input.slug)
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findBySlug(slug: string): Promise<LibraryExpert | undefined> {
    const row = await this.db
      .selectFrom("expert_library")
      .selectAll()
      .where("slug", "=", slug)
      .executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  async findAll(): Promise<readonly LibraryExpert[]> {
    const rows = await this.db
      .selectFrom("expert_library")
      .selectAll()
      .orderBy("slug", "asc")
      .execute();
    return rows.map(toDomain);
  }

  async update(slug: string, patch: Partial<NewLibraryExpert>): Promise<void> {
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };
    if (patch.kind !== undefined) updates["kind"] = patch.kind;
    if (patch.displayName !== undefined) updates["display_name"] = patch.displayName;
    if (patch.yamlPath !== undefined) updates["yaml_path"] = patch.yamlPath;
    if (patch.yamlChecksum !== undefined) updates["yaml_checksum"] = patch.yamlChecksum;
    await this.db.updateTable("expert_library").set(updates).where("slug", "=", slug).execute();
  }

  async delete(slug: string): Promise<void> {
    await this.db.deleteFrom("expert_library").where("slug", "=", slug).execute();
  }

  async findPanelsForExpert(slug: string): Promise<readonly string[]> {
    const rows = await this.db
      .selectFrom("panel_members")
      .select("panel_name")
      .where("expert_slug", "=", slug)
      .orderBy("panel_name", "asc")
      .execute();
    return rows.map((r) => r.panel_name);
  }
}
