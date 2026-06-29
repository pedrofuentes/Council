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
import { sql } from "kysely";

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

/**
 * Thrown by {@link PanelLibraryRepository.setMembers} when the
 * transaction aborts (#298). Mirrors {@link ClearForRetrainError} from
 * document-repository.ts: exposes whether ROLLBACK itself succeeded so
 * call sites can produce honest user-facing messages — when
 * {@link rollbackFailed} is `true`, the database state may be
 * inconsistent (membership rows partially deleted with no replacement)
 * and the message MUST NOT claim that prior data was preserved.
 */
export class SetMembersError extends Error {
  readonly rollbackFailed: boolean;
  readonly rollbackError?: unknown;

  constructor(
    message: string,
    opts: { cause: unknown; rollbackFailed: boolean; rollbackError?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "SetMembersError";
    this.rollbackFailed = opts.rollbackFailed;
    if (opts.rollbackError !== undefined) {
      this.rollbackError = opts.rollbackError;
    }
  }
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

  /**
   * Atomically replace the membership of a panel (#298). Wraps the
   * delete-all + insert-new pair in a raw ``BEGIN``/``COMMIT``/``ROLLBACK``
   * transaction so a failure mid-insert cannot leave the panel with zero
   * (or partial) members.
   *
   * Implemented with raw transaction statements on the libsql client —
   * NOT Kysely's ``db.transaction().execute(...)`` — because the libsql
   * ``:memory:`` dialect opens transactions on a fresh connection that
   * does not see the primary connection's schema, breaking every
   * in-memory unit test (see issue #298). The same workaround is used
   * by ``DocumentRepository.clearForRetrain``.
   *
   * On failure, throws {@link SetMembersError}. Callers MUST inspect
   * ``rollbackFailed``: when the rollback itself failed the DB may be
   * in an inconsistent state and the user-facing message must NOT claim
   * that prior membership was preserved.
   */
  async setMembers(panelName: string, expertSlugs: readonly string[]): Promise<void> {
    try {
      await sql`BEGIN`.execute(this.db);
    } catch (beginErr) {
      const detail = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new SetMembersError(
        `setMembers failed for "${panelName}" before any changes ` +
          `(BEGIN failed; no changes applied): ${detail}`,
        { cause: beginErr, rollbackFailed: false },
      );
    }
    try {
      await this.db.deleteFrom("panel_members").where("panel_name", "=", panelName).execute();
      if (expertSlugs.length > 0) {
        const now = new Date().toISOString();
        const rows = expertSlugs.map((slug, index) => ({
          panel_name: panelName,
          expert_slug: slug,
          position: index,
          created_at: now,
        }));
        await this.db.insertInto("panel_members").values(rows).execute();
      }
      await sql`COMMIT`.execute(this.db);
      // NOTE (#537): if future work is added AFTER the COMMIT above (e.g.
      // post-commit logging, verification reads, cache invalidation), it
      // MUST be guarded so a thrown error is NOT mis-translated by the
      // catch block below into a "transaction rolled back cleanly"
      // message. The recommended pattern is a `committed` flag set right
      // after COMMIT and a `if (committed) throw new SetMembersError(...,
      // { rollbackFailed: true })` branch at the top of catch — note
      // `rollbackFailed: true` (rollback is impossible once committed, so
      // state is NOT preserved; the CLI consumer keys on !rollbackFailed
      // to claim "prior state preserved", which would be false here).
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
        ? `setMembers failed for "${panelName}" and ROLLBACK also failed; ` +
          `database may be in an inconsistent state (panel membership may be ` +
          `partially deleted): ${detail}`
        : `setMembers failed for "${panelName}" (transaction rolled back cleanly): ${detail}`;
      throw new SetMembersError(
        message,
        rollbackError === undefined
          ? { cause: err, rollbackFailed }
          : { cause: err, rollbackFailed, rollbackError },
      );
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

  /**
   * Aggregate member count for every panel in a single query (#1599).
   * Avoids the N+1 of calling getMembers once per saved panel when only
   * the count is needed. Panels with zero members are absent from the
   * map; callers treat a missing key as 0.
   */
  async getMemberCounts(): Promise<ReadonlyMap<string, number>> {
    const rows = await this.db
      .selectFrom("panel_members")
      .select((eb) => ["panel_name", eb.fn.countAll<number>().as("count")])
      .groupBy("panel_name")
      .execute();
    return new Map(rows.map((r) => [r.panel_name, Number(r.count)]));
  }
}
