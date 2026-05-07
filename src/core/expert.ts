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

export const ExpertDefinitionSchema = z.object({
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
});

export type Expertise = z.infer<typeof ExpertiseSchema>;
export type ExpertDefinition = z.infer<typeof ExpertDefinitionSchema>;
