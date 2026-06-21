/**
 * Expert repository — typed CRUD over the experts table.
 *
 * UNIQUE (panel_id, slug) is enforced by the schema; `create()` will throw
 * on collision. The caller is expected to surface a friendly error.
 */
import { monotonicFactory } from "ulid";

import type { CouncilDatabase, ExpertRow } from "../db.js";

/**
 * Monotonic ULID factory shared across all expert inserts in this process.
 *
 * Unlike the per-call `ulid()`, this guarantees strictly increasing ids even
 * for experts created within the same millisecond. Because `findByPanelId`
 * orders by `id ASC`, monotonic ids preserve insertion order — which the
 * default-expert selection in `council ask` relies on (#1281).
 */
const ulidMonotonic = monotonicFactory();

export interface Expert {
  readonly id: string;
  readonly panelId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly model: string;
  readonly systemMessage: string;
  readonly copilotSessionId: string | null;
  readonly createdAt: string;
  /**
   * JSON-encoded {@link ExpertMemory} produced by the LLM extraction
   * pass at the end of a debate. `null` when no extraction has run
   * yet for this expert (or when extraction failed best-effort).
   */
  readonly extractedMemoryJson: string | null;
  /**
   * Memory provenance (T-2 / #569): records WHERE the cached memory
   * came from, HOW it was produced, and the producer's trust score.
   * All four fields are `null` when no LLM extraction has run (the
   * heuristic recall path computes memory on-the-fly and does not
   * persist provenance).
   */
  readonly memorySourceDebateId: string | null;
  readonly memoryDerivation: string | null;
  readonly memoryTrustScore: number | null;
  readonly memoryExtractedAt: string | null;
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
  /**
   * JSON-encoded {@link ExpertMemory}. Use `null` to clear the cache.
   */
  readonly extractedMemoryJson?: string | null;
  /** Memory provenance fields (T-2 / #569). `null` clears the field. */
  readonly memorySourceDebateId?: string | null;
  readonly memoryDerivation?: string | null;
  readonly memoryTrustScore?: number | null;
  readonly memoryExtractedAt?: string | null;
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
    extractedMemoryJson: row.extracted_memory_json,
    memorySourceDebateId: row.memory_source_debate_id,
    memoryDerivation: row.memory_derivation,
    memoryTrustScore: row.memory_trust_score,
    memoryExtractedAt: row.memory_extracted_at,
  };
}

export class ExpertRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async create(input: NewExpert): Promise<Expert> {
    const id = ulidMonotonic();
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
        extracted_memory_json: null,
        memory_source_debate_id: null,
        memory_derivation: null,
        memory_trust_score: null,
        memory_extracted_at: null,
      })
      .execute();
    const row = await this.db
      .selectFrom("experts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findById(id: string): Promise<Expert | undefined> {
    const row = await this.db
      .selectFrom("experts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  async findByPanelId(panelId: string): Promise<readonly Expert[]> {
    const rows = await this.db
      .selectFrom("experts")
      .selectAll()
      .where("panel_id", "=", panelId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toDomain);
  }

  async update(id: string, patch: ExpertUpdate): Promise<Expert | undefined> {
    const updates: Record<string, unknown> = {};
    if (patch.displayName !== undefined) updates["display_name"] = patch.displayName;
    if (patch.model !== undefined) updates["model"] = patch.model;
    if (patch.systemMessage !== undefined) updates["system_message"] = patch.systemMessage;
    if (patch.copilotSessionId !== undefined)
      updates["copilot_session_id"] = patch.copilotSessionId;
    if (patch.extractedMemoryJson !== undefined)
      updates["extracted_memory_json"] = patch.extractedMemoryJson;
    if (patch.memorySourceDebateId !== undefined)
      updates["memory_source_debate_id"] = patch.memorySourceDebateId;
    if (patch.memoryDerivation !== undefined) updates["memory_derivation"] = patch.memoryDerivation;
    if (patch.memoryTrustScore !== undefined)
      updates["memory_trust_score"] = patch.memoryTrustScore;
    if (patch.memoryExtractedAt !== undefined)
      updates["memory_extracted_at"] = patch.memoryExtractedAt;
    if (Object.keys(updates).length > 0) {
      await this.db.updateTable("experts").set(updates).where("id", "=", id).execute();
    }
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("experts").where("id", "=", id).execute();
  }
}
