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
import * as path from "node:path";

import { z } from "zod";

const NonEmptyString = z.string().min(1);

/** The two ways a `docsPath` can escape its confinement root (#287, A2). */
type DocsPathViolation = "traversal" | "non-relative";

/**
 * Classify a `docsPath` override against its confinement contract, returning
 * the violation kind or `null` for a safe in-root relative path (issue #287,
 * Sentinel dimension A2).
 *
 * `docsPath` overrides a persona expert's default docs location, which BY
 * DESIGN lives under the per-expert docs root `<dataHome>/experts/<slug>/docs`
 * (see DECISIONS.md). An unconfined override is a path-traversal / arbitrary-
 * read surface: a `..` segment or an absolute/UNC/drive-letter path could
 * redirect the document scanner, indexer, and engine at files outside the data
 * home before any consumer reads the value. This schema rule is the front door
 * (mirroring the section-marker gate and the `resolveManagedDocsDir`
 * `startsWith(root + path.sep)` idiom in `cli/commands/docs.ts`); the read
 * sites still realpath-confine as defense-in-depth (see
 * `core/documents/processor.ts` and `core/documents/detector.ts`).
 *
 *   - "traversal": any `..` path segment — leading, embedded, or trailing;
 *     split on both `/` and `\`. Checked first: it is the more specific,
 *     higher-signal attack shape.
 *   - "non-relative": a POSIX or Windows absolute path, a UNC path, or a
 *     Windows drive-letter prefix (including the drive-relative `C:foo` form).
 *
 * Accepts plain relative paths (resolved under the docs root) and the
 * home-anchored `~/Council/...` default form.
 */
function classifyDocsPath(value: string): DocsPathViolation | null {
  if (value.split(/[/\\]/).some((segment) => segment === "..")) return "traversal";
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return "non-relative";
  }
  return null;
}

/**
 * Discriminating rejection messages — distinct per violation so callers (and
 * tests) can tell the two escape classes apart. Neither echoes the offending
 * path, so no terminal sanitization is required.
 */
const DOCS_PATH_VIOLATION_MESSAGE: Readonly<Record<DocsPathViolation, string>> = {
  traversal: `Field "docsPath" must not contain ".." path-traversal segments.`,
  "non-relative":
    `Field "docsPath" must be a relative path under the expert docs root; ` +
    `absolute, UNC, and drive-letter paths are not allowed.`,
};

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
     * For persona experts: override the default docs location. MUST be a
     * relative path (resolved under the per-expert docs root
     * `<dataHome>/experts/<slug>/docs`); `..` traversal segments and absolute
     * / UNC / drive-letter paths are rejected by the superRefine below so the
     * override cannot escape the docs root (#287, Sentinel A2).
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

    // Confine `docsPath` to its per-expert docs root: reject `..` traversal
    // segments AND absolute / UNC / drive-letter paths so an authored or
    // imported expert cannot redirect the document pipeline outside its
    // resolved root (#287, Sentinel A2). Read sites realpath-confine as
    // defense-in-depth (see core/documents/processor.ts, detector.ts).
    if (val.docsPath !== undefined) {
      const violation = classifyDocsPath(val.docsPath);
      if (violation !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: DOCS_PATH_VIOLATION_MESSAGE[violation],
          path: ["docsPath"],
        });
      }
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
