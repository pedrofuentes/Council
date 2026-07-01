/**
 * Expert definition — the static profile of a single panel participant.
 *
 * Validated by Zod so panel YAML files (Phase 1.11) and ad-hoc CLI definitions
 * (`council convene --experts ...`) hit the same schema gate.
 *
 * Distinguish:
 *   - `ExpertDefinition` (here) — static profile authored by humans / templates
 *   - `ExpertSpec` (in src/engine/types.ts) — runtime spec passed to the engine,
 *     carries the ULID id and the FULLY-RENDERED systemMessage
 *
 * The `core/prompt-builder.ts` function is what turns one into the other.
 */
import { z } from "zod";

const NonEmptyString = z.string().min(1);

/**
 * Path-traversal gate for `docsPath` (issue #287, Sentinel dimension A2).
 *
 * `docsPath` overrides a persona expert's default docs location. Both relative
 * paths (resolved under the per-expert docs root `<dataHome>/experts/<slug>/docs`)
 * and absolute paths — a documented "custom location" feature (see the
 * data-locations reference) — are valid, supported values. This rule does NOT
 * restrict the location; it is a defense-in-depth front door that rejects only
 * the one unambiguous attack shape, a `..` path-traversal segment, before any
 * consumer reads the value. Absolute and relative locations are permitted here
 * and are confined at the READ sites, which realpath-resolve the docs root and
 * refuse to follow symlinks (see `core/documents/processor.ts` and
 * `core/documents/detector.ts`).
 *
 * Rejects any `..` path segment (leading, embedded, or trailing; split on both
 * `/` and `\` separators). Accepts absolute (POSIX / Windows / UNC), Windows
 * drive-prefixed, home-anchored (`~/Council/...`), and plain relative paths.
 */
function isDocsPathConfined(value: string): boolean {
  return !value.split(/[/\\]/).some((segment) => segment === "..");
}

export const ExpertiseSchema = z.object({
  /**
   * Evidence types this expert weights heavily, ordered by priority.
   * MUST contain at least one entry — without weighted evidence the expert
   * cannot reason from a distinct prior (per Prompt Engineering Expert's
   * "expertise is a prior, not a persona" rule).
   */
  weightedEvidence: z.array(NonEmptyString).min(1),
  /**
   * Specific historical patterns or principles the expert cites by name
   * (e.g. "distributed monolith failure"). Empty list is acceptable for
   * generic experts but discouraged.
   */
  referenceCases: z.array(NonEmptyString).default([]),
  /**
   * Areas this expert explicitly disclaims expertise in. Encourages the
   * model to defer rather than hallucinate (per ADR-005 forthcoming).
   */
  notExpertIn: z.array(NonEmptyString).default([]),
});

export const ExpertDefinitionSchema = z
  .object({
    /** Short identifier scoped to the panel (e.g. "cto", "skeptic"). */
    slug: NonEmptyString,
    /** Name shown in transcripts and renderers (e.g. "Dahlia Renner (CTO)"). */
    displayName: NonEmptyString,
    /** One-line role descriptor used in section [1] IDENTITY of the prompt. */
    role: NonEmptyString,
    /** Optional model override. Falls back to panel/global default. */
    model: NonEmptyString.optional(),
    /** Expertise prior (section [2]). */
    expertise: ExpertiseSchema,
    /** Stance from which the expert forms beliefs (section [3]). */
    epistemicStance: NonEmptyString,
    /**
     * Optional override for section [4] DEBATE PROTOCOL. When omitted, the
     * default anti-sycophancy template is used (see prompt-builder.ts).
     */
    debateProtocol: NonEmptyString.optional(),
    /** Optional override for section [5] OUTPUT CONTRACT. */
    outputContract: NonEmptyString.optional(),
    /** Additional forbidden moves; combined with the global defaults. */
    forbiddenMoves: z.array(NonEmptyString).optional(),
    /** Personality flavor — the last 5% of value, applied to identity tone. */
    personality: NonEmptyString.optional(),
    /**
     * Discriminates between generic (template-based) and persona
     * (document-trained) experts. Defaults to "generic" for back-compat.
     */
    kind: z.enum(["generic", "persona"]).default("generic"),
    /**
     * For persona experts: relationship description
     * (e.g. "VP of Engineering I report to").
     */
    personaDescription: NonEmptyString.optional(),
    /**
     * For persona experts: override the default docs location. May be a
     * relative path (resolved under the per-expert docs root) or an absolute
     * "custom location"; must not contain `..` path-traversal segments
     * (enforced in the superRefine below, #287). Absolute and relative
     * locations are confined at read time.
     */
    docsPath: NonEmptyString.optional(),
  })
  .superRefine((val, ctx) => {
    // Reject `[NN]` patterns in user-facing string fields so authored or
    // imported expert YAML cannot smuggle forged section markers into the
    // privileged system prompt. Runtime sanitization in `prompt-builder.ts`
    // is the defense-in-depth backstop; this schema rule is the front door.
    const SECTION_MARKER = /\[\d+\]/;
    const fieldsToCheck: readonly (readonly [string, string | undefined])[] = [
      ["displayName", val.displayName],
      ["role", val.role],
      ["personality", val.personality],
      ["epistemicStance", val.epistemicStance],
    ];
    for (const [field, value] of fieldsToCheck) {
      if (value && SECTION_MARKER.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Field "${field}" must not contain section markers like [1], [2], etc.`,
          path: [field],
        });
      }
    }

    // Guard `docsPath` against path traversal: reject any `..` segment so an
    // authored/imported expert cannot walk the document pipeline out of its
    // resolved root (#287). Absolute and relative locations are both permitted
    // here and confined at the read sites (realpath + symlink refusal).
    if (val.docsPath !== undefined && !isDocsPathConfined(val.docsPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Field "docsPath" must not contain ".." path-traversal segments.`,
        path: ["docsPath"],
      });
    }
  });

export type Expertise = z.infer<typeof ExpertiseSchema>;
export type ExpertDefinition = z.infer<typeof ExpertDefinitionSchema>;
export type ExpertKind = "generic" | "persona";

/**
 * Return a NEW expert object containing ONLY the fields defined by
 * {@link ExpertDefinitionSchema}, dropping any unexpected runtime property.
 *
 * Defense-in-depth: upstream Zod parsing already strips unknown keys, but
 * write sinks that spread a stored expert (`{ ...expert }`) or serialize a
 * resolved template into persistent storage can leak provider-injected or
 * prototype-polluted properties if the object was ever constructed outside
 * the schema gate. Constructing an explicit allowlist at every such sink
 * closes that gap. Every legitimate field is preserved so the persisted
 * shape remains fully re-resolvable (round-trip integrity for `panel save`).
 *
 * @param expert    the source expert definition.
 * @param slugOverride optional replacement slug (used when promotion assigns
 *                  a collision-free slug).
 */
export function allowlistExpertDefinition(
  expert: ExpertDefinition,
  slugOverride?: string,
): ExpertDefinition {
  return {
    slug: slugOverride ?? expert.slug,
    displayName: expert.displayName,
    role: expert.role,
    expertise: {
      weightedEvidence: [...expert.expertise.weightedEvidence],
      referenceCases: [...expert.expertise.referenceCases],
      notExpertIn: [...expert.expertise.notExpertIn],
    },
    epistemicStance: expert.epistemicStance,
    kind: expert.kind,
    ...(expert.model !== undefined ? { model: expert.model } : {}),
    ...(expert.debateProtocol !== undefined ? { debateProtocol: expert.debateProtocol } : {}),
    ...(expert.outputContract !== undefined ? { outputContract: expert.outputContract } : {}),
    ...(expert.forbiddenMoves !== undefined ? { forbiddenMoves: [...expert.forbiddenMoves] } : {}),
    ...(expert.personality !== undefined ? { personality: expert.personality } : {}),
    ...(expert.personaDescription !== undefined
      ? { personaDescription: expert.personaDescription }
      : {}),
    ...(expert.docsPath !== undefined ? { docsPath: expert.docsPath } : {}),
  };
}
