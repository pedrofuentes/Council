/**
 * Panel auto-composition (§2.5).
 *
 * When the user runs `council convene "topic"` without `--template`, this
 * module composes a panel by sending a meta-prompt to a temporary "composer"
 * expert and parsing its JSON response into a `PanelDefinition`.
 *
 * Flow:
 *   1. Register a temporary composer expert primed with the meta-prompt
 *   2. Send the topic via `engine.send()` and accumulate `message.delta`
 *      events into the full response text
 *   3. Strip optional Markdown code fences (defense-in-depth: the prompt
 *      tells the model NOT to emit them, but real models often do anyway)
 *   4. Parse as JSON
 *   5. Validate against `PanelDefinitionSchema`
 *   6. Remove the composer expert (cleanup)
 *
 * Engine lifecycle (`start()` / `stop()`) is the caller's responsibility —
 * this function is small and stateless w.r.t. the engine session.
 */
import { ulid } from "ulid";

import type { CouncilEngine, ExpertSpec } from "../engine/index.js";

import type { PanelDefinition } from "./template-loader.js";
import { PanelDefinitionSchema } from "./template-loader.js";

const DEFAULT_MIN_EXPERTS = 3;
const DEFAULT_MAX_EXPERTS = 5;
const DEFAULT_COMPOSER_MODEL = "claude-sonnet-4-20250514";

export interface AutoComposeOptions {
  readonly minExperts?: number;
  readonly maxExperts?: number;
  readonly defaultModel?: string;
}

export async function autoComposePanel(
  topic: string,
  engine: CouncilEngine,
  options?: AutoComposeOptions,
): Promise<PanelDefinition> {
  const minExperts = options?.minExperts ?? DEFAULT_MIN_EXPERTS;
  const maxExperts = options?.maxExperts ?? DEFAULT_MAX_EXPERTS;
  const model = options?.defaultModel ?? DEFAULT_COMPOSER_MODEL;

  const composer: ExpertSpec = {
    id: ulid(),
    slug: "composer",
    displayName: "Panel Composer",
    model,
    systemMessage: buildComposerSystemPrompt(minExperts, maxExperts),
  };

  await engine.addExpert(composer);
  let raw = "";
  try {
    const stream = engine.send({
      expertId: composer.id,
      prompt: `Design an expert panel to debate: "${topic}"`,
    });
    for await (const event of stream) {
      if (event.kind === "message.delta") {
        raw += event.text;
      } else if (event.kind === "error") {
        throw new Error(
          `Auto-compose engine error (${event.error.code}): ${event.error.message}`,
        );
      }
    }
  } finally {
    await engine.removeExpert(composer.id);
  }

  const cleaned = stripCodeFences(raw).trim();
  if (cleaned.length === 0) {
    throw new Error("Auto-compose failed: composer returned an empty response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Auto-compose failed: could not parse composer JSON response (${cause}). ` +
        `First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }

  const result = PanelDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const fieldPath = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  - ${fieldPath}: ${i.message}`;
    });
    throw new Error(
      `Auto-compose produced an invalid panel definition:\n${lines.join("\n")}`,
    );
  }

  return result.data;
}

function buildComposerSystemPrompt(minExperts: number, maxExperts: number): string {
  return `You are a panel composition expert. Given a topic, you design a panel of ${minExperts}-${maxExperts} AI experts who will debate it from genuinely different perspectives.

For each expert, you must specify:
- slug: short kebab-case identifier (e.g., "cto", "skeptic", "customer-advocate")
- displayName: human-readable name with role (e.g., "Dahlia Renner (CTO)")
- role: one-line role description
- expertise.weightedEvidence: 3-5 evidence types this expert prioritizes, ordered by weight
- expertise.referenceCases: 1-3 reference patterns they cite
- expertise.notExpertIn: 1-3 areas they explicitly defer on
- epistemicStance: 2-3 sentences describing HOW this expert forms beliefs

Rules:
- Experts MUST have genuinely different objective functions (not just different labels)
- At least one expert should be structurally opposed to the majority view
- No two experts should weight the same evidence type highest
- Stances should create natural tension that produces useful disagreement

Output valid JSON matching this exact schema:
{
  "name": "<topic-derived-kebab-case-name>",
  "description": "<one-line description of the panel>",
  "experts": [<array of expert definitions>]
}

Output ONLY the JSON, no markdown code fences, no explanation.`;
}

const FENCE_PATTERN = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = FENCE_PATTERN.exec(trimmed);
  if (match && match[1] !== undefined) {
    return match[1];
  }
  return trimmed;
}
