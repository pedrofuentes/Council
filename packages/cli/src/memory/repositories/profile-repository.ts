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

function safeParseArray(
  json: string,
  context: { slug: string; field: string },
): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn(
      `[profile-repository] Corrupt JSON in persona_profiles.${context.field} for slug "${context.slug}": ${json} (${(err as Error).message}). Recovering as []; profile data may be damaged.`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(
      `[profile-repository] Expected JSON array in persona_profiles.${context.field} for slug "${context.slug}" but got ${typeof parsed}: ${json}. Recovering as []; profile data may be damaged.`,
    );
    return [];
  }
  return parsed.filter((v): v is string => typeof v === "string");
}

function toDomain(row: PersonaProfileRow): PersonaProfile {
  return {
    communicationStyle: row.communication_style,
    decisionPatterns: safeParseArray(row.decision_patterns, {
      slug: row.expert_slug,
      field: "decision_patterns",
    }),
    biases: safeParseArray(row.biases, {
      slug: row.expert_slug,
      field: "biases",
    }),
    vocabulary: safeParseArray(row.vocabulary, {
      slug: row.expert_slug,
      field: "vocabulary",
    }),
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
    const updatedAt = profile.lastUpdated || now;
    // Atomic upsert via SQLite's ON CONFLICT DO UPDATE — eliminates the
    // SELECT-then-INSERT race where two concurrent calls could both
    // observe "no row" and both attempt INSERT (#363).
    await this.db
      .insertInto("persona_profiles")
      .values({
        expert_slug: expertSlug,
        communication_style: profile.communicationStyle,
        decision_patterns: JSON.stringify(profile.decisionPatterns),
        biases: JSON.stringify(profile.biases),
        vocabulary: JSON.stringify(profile.vocabulary),
        epistemic_stance: profile.epistemicStance,
        document_count: profile.documentCount,
        total_words: profile.totalWords,
        created_at: now,
        updated_at: updatedAt,
      })
      .onConflict((oc) =>
        oc.column("expert_slug").doUpdateSet({
          communication_style: profile.communicationStyle,
          decision_patterns: JSON.stringify(profile.decisionPatterns),
          biases: JSON.stringify(profile.biases),
          vocabulary: JSON.stringify(profile.vocabulary),
          epistemic_stance: profile.epistemicStance,
          document_count: profile.documentCount,
          total_words: profile.totalWords,
          updated_at: updatedAt,
        }),
      )
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
