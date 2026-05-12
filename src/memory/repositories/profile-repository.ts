/**
 * Profile repository — typed CRUD over the persona_profiles table
 * (migration 007). Follows the snake_case-row → camelCase-domain pattern
 * established by document-repository.ts and expert-library-repo.ts.
 *
 * Stores the structured behavioral profile that `analyzeDocuments()`
 * extracts from an expert's documents. List-of-strings fields are
 * persisted as JSON-encoded TEXT columns and decoded back on read.
 */
import type { CouncilDatabase, PersonaProfileRow } from "../db.js";
import type { PersonaProfile } from "../../core/documents/profile-analyzer.js";

function safeParseArray(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function toDomain(row: PersonaProfileRow): PersonaProfile {
  return {
    communicationStyle: row.communication_style,
    decisionPatterns: safeParseArray(row.decision_patterns),
    biases: safeParseArray(row.biases),
    vocabulary: safeParseArray(row.vocabulary),
    epistemicStance: row.epistemic_stance,
    documentCount: row.document_count,
    totalWords: row.total_words,
    lastUpdated: row.updated_at,
  };
}

export class ProfileRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async upsert(expertSlug: string, profile: PersonaProfile): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db
      .selectFrom("persona_profiles")
      .select("expert_slug")
      .where("expert_slug", "=", expertSlug)
      .executeTakeFirst();
    const values = {
      communication_style: profile.communicationStyle,
      decision_patterns: JSON.stringify(profile.decisionPatterns),
      biases: JSON.stringify(profile.biases),
      vocabulary: JSON.stringify(profile.vocabulary),
      epistemic_stance: profile.epistemicStance,
      document_count: profile.documentCount,
      total_words: profile.totalWords,
      updated_at: profile.lastUpdated || now,
    };
    if (existing) {
      await this.db
        .updateTable("persona_profiles")
        .set(values)
        .where("expert_slug", "=", expertSlug)
        .execute();
      return;
    }
    await this.db
      .insertInto("persona_profiles")
      .values({
        expert_slug: expertSlug,
        ...values,
        created_at: now,
      })
      .execute();
  }

  async findBySlug(slug: string): Promise<PersonaProfile | null> {
    const row = await this.db
      .selectFrom("persona_profiles")
      .selectAll()
      .where("expert_slug", "=", slug)
      .executeTakeFirst();
    return row ? toDomain(row) : null;
  }

  async delete(slug: string): Promise<void> {
    await this.db
      .deleteFrom("persona_profiles")
      .where("expert_slug", "=", slug)
      .execute();
  }
}
