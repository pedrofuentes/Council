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
import { stripControlChars } from "../cli/strip-control-chars.js";

import type { PanelDefinition, ResolvedPanelDefinition } from "./template-loader.js";
import { PanelDefinitionSchema } from "./template-loader.js";

const DEFAULT_MIN_EXPERTS = 3;
const DEFAULT_MAX_EXPERTS = 5;
const DEFAULT_COMPOSER_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface AutoComposeOptions {
  readonly minExperts?: number;
  readonly maxExperts?: number;
  readonly defaultModel?: string;
  /**
   * Hard wall-clock cap on the composer send. If the engine has not produced
   * a terminal event by this point, the call is aborted and an error is
   * thrown. Defaults to 30 seconds.
   */
  readonly timeoutMs?: number;
}

export async function autoComposePanel(
  topic: string,
  engine: CouncilEngine,
  options?: AutoComposeOptions,
): Promise<ResolvedPanelDefinition> {
  const minExperts = options?.minExperts ?? DEFAULT_MIN_EXPERTS;
  const maxExperts = options?.maxExperts ?? DEFAULT_MAX_EXPERTS;
  const model = options?.defaultModel ?? DEFAULT_COMPOSER_MODEL;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const composer: ExpertSpec = {
    id: ulid(),
    slug: "composer",
    displayName: "Panel Composer",
    model,
    systemMessage: buildComposerSystemPrompt(minExperts, maxExperts),
  };

  await engine.addExpert(composer);
  let raw = "";
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const stream = engine.send({
      expertId: composer.id,
      prompt: `Design an expert panel to debate: "${topic}"`,
      signal,
    });
    for await (const event of stream) {
      if (event.kind === "message.delta") {
        raw += event.text;
      } else if (event.kind === "error") {
        if (event.error.code === "ABORTED" && signal.aborted) {
          throw new Error(
            `Auto-compose timed out after ${timeoutMs}ms — the engine did not respond in time.`,
          );
        }
        throw new Error(`Auto-compose engine error (${event.error.code}): ${event.error.message}`);
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
      `Auto-compose failed: could not parse composer JSON response (${stripControlChars(cause)}). ` +
        `First 200 chars: ${stripControlChars(cleaned.slice(0, 200))}`,
    );
  }

  const result = PanelDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const fieldPath = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  - ${fieldPath}: ${i.message}`;
    });
    throw new Error(`Auto-compose produced an invalid panel definition:\n${lines.join("\n")}`);
  }

  return sanitizeComposedPanel(result.data, model);
}

/**
 * Strip policy-bearing fields the LLM may have injected and force every
 * expert's `model` to the trusted default. The composer is untrusted —
 * it must not be able to override the debate protocol, output contract,
 * forbidden moves, or routing model from the JSON it returns.
 *
 * Safe fields kept: slug, displayName, role, expertise, epistemicStance,
 *                   personality. Plus panel-level name + description.
 */
function sanitizeComposedPanel(
  panel: PanelDefinition,
  defaultModel: string,
): ResolvedPanelDefinition {
  // The composer is instructed to return inline definitions only. A slug
  // reference would indicate either a misbehaving model or an attempt to
  // bypass policy by pointing at an arbitrary library expert. Reject loudly
  // rather than silently drop, so the user sees the broken response.
  const slugRefs = panel.experts.filter((e): e is string => typeof e === "string");
  if (slugRefs.length > 0) {
    throw new Error(
      `Auto-compose failed: composer returned slug references (${slugRefs.join(", ")}) ` +
        `but inline expert definitions are required. The composer must produce a ` +
        `complete panel — slug references to library experts are not allowed in ` +
        `auto-composed panels.`,
    );
  }
  const inlineEntries = panel.experts.filter(
    (e): e is Exclude<typeof e, string> => typeof e !== "string",
  );
  return {
    name: panel.name,
    ...(panel.description !== undefined ? { description: panel.description } : {}),
    ...(panel.defaults ? { defaults: panel.defaults } : {}),
    experts: inlineEntries.map((e) => ({
      slug: e.slug,
      displayName: e.displayName,
      role: e.role,
      model: defaultModel,
      expertise: e.expertise,
      epistemicStance: e.epistemicStance,
      kind: e.kind,
      ...(e.personality !== undefined ? { personality: e.personality } : {}),
    })),
  };
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
