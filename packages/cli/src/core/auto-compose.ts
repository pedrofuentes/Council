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
 *   3. Strip optional Markdown code fences and extract the first JSON object
 *      if the model prefixes it with prose
 *   4. Parse as JSON
 *   5. Validate against `PanelDefinitionSchema`
 *   6. Remove the composer expert (cleanup)
 *
 * Engine lifecycle (`start()` / `stop()`) is the caller's responsibility —
 * this function is small and stateless w.r.t. the engine session.
 */
import { ulid } from "ulid";

import { stripControlChars } from "../cli/strip-control-chars.js";
import { DEFAULT_MODEL } from "../config/schema.js";
import type { CouncilEngine, ExpertSpec } from "../engine/index.js";
import { sanitizePromptField } from "./prompt-sanitize.js";

import type { PanelDefinition, ResolvedPanelDefinition } from "./template-loader.js";
import { PanelDefinitionSchema } from "./template-loader.js";

const DEFAULT_MIN_EXPERTS = 3;
const DEFAULT_MAX_EXPERTS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;
const COMPOSER_RETRY_INSTRUCTION =
  "You MUST respond with ONLY a JSON object. No explanation, no preamble.";

export interface AutoComposeOptions {
  readonly minExperts?: number;
  readonly maxExperts?: number;
  readonly defaultModel?: string;
  /** Caller-controlled cancellation for the composer send. */
  readonly signal?: AbortSignal;
  /**
   * Hard wall-clock cap on the composer send. If the engine has not produced
   * a terminal event by this point, the call is aborted and an error is
   * thrown. Defaults to 120 seconds.
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
  const model = options?.defaultModel ?? DEFAULT_MODEL;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const composer: ExpertSpec = {
    id: ulid(),
    slug: "composer",
    displayName: "Panel Composer",
    model,
    systemMessage: buildComposerSystemPrompt(minExperts, maxExperts),
  };

  await engine.addExpert(composer);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  let parsed: unknown;
  try {
    let response = await collectComposerResponse(
      engine,
      composer.id,
      buildComposerUserPrompt(topic),
      signal,
      timeoutSignal,
      options?.signal,
      model,
      timeoutMs,
    );
    let parseResult = parseComposerResponse(response);

    if (parseResult.kind === "mock") {
      return capPanelExperts(createMockFallbackPanel(model), maxExperts);
    }

    if (parseResult.kind === "empty" || parseResult.kind === "no-json") {
      response = await collectComposerResponse(
        engine,
        composer.id,
        buildComposerUserPrompt(topic, { strictJsonOnly: true }),
        signal,
        timeoutSignal,
        options?.signal,
        model,
        timeoutMs,
      );
      parseResult = parseComposerResponse(response);
      if (parseResult.kind === "mock") {
        return capPanelExperts(createMockFallbackPanel(model), maxExperts);
      }
    }

    if (parseResult.kind === "empty") {
      throw createEmptyComposerResponseError();
    }

    if (parseResult.kind === "no-json") {
      throw createMissingJsonObjectError(parseResult.preview);
    }

    parsed = parseResult.value;
  } finally {
    await engine.removeExpert(composer.id);
  }

  const result = PanelDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const fieldPath = sanitizeModelForDisplay(
        i.path.length > 0 ? i.path.join(".") : "(root)",
      );
      return `  - ${fieldPath}: ${sanitizeModelForDisplay(i.message)}`;
    });
    throw new Error(`Auto-compose produced an invalid panel definition:\n${lines.join("\n")}`);
  }

  return capPanelExperts(sanitizeComposedPanel(result.data, model), maxExperts);
}

interface ParsedComposerResponse {
  readonly kind: "parsed";
  readonly value: unknown;
}

interface EmptyComposerResponse {
  readonly kind: "empty";
}

interface MissingJsonComposerResponse {
  readonly kind: "no-json";
  readonly preview: string;
}

interface MockComposerResponse {
  readonly kind: "mock";
}

type ComposerResponseParseResult =
  | ParsedComposerResponse
  | EmptyComposerResponse
  | MissingJsonComposerResponse
  | MockComposerResponse;

interface ComposerPromptOptions {
  readonly strictJsonOnly?: boolean;
}

async function collectComposerResponse(
  engine: CouncilEngine,
  expertId: string,
  prompt: string,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  model: string,
  timeoutMs: number,
): Promise<string> {
  let raw = "";
  const stream = engine.send({ expertId, prompt, signal });
  for await (const event of stream) {
    if (event.kind === "message.delta") {
      raw += event.text;
    } else if (event.kind === "error") {
      if (event.error.code === "ABORTED" && signal.aborted) {
        if (callerSignal?.aborted === true && timeoutSignal.aborted === false) {
          throw new Error(
            `Auto-compose was aborted while using model ${sanitizeModelForDisplay(model)}.`,
          );
        }
        throw new Error(
          `Auto-compose timed out after ${timeoutMs}ms for model ${sanitizeModelForDisplay(model)} — the engine did not respond in time.`,
        );
      }
      throw new Error(
        `Auto-compose engine error (${event.error.code}) for model ${sanitizeModelForDisplay(model)}: ${sanitizeModelForDisplay(event.error.message)}`,
      );
    }
  }
  return raw;
}

function buildComposerUserPrompt(topic: string, options?: ComposerPromptOptions): string {
  if (options?.strictJsonOnly === true) {
    return `${COMPOSER_RETRY_INSTRUCTION} No markdown code fences. Design an expert panel to debate: "${topic}"`;
  }
  return `Design an expert panel to debate: "${topic}"`;
}

function parseComposerResponse(raw: string): ComposerResponseParseResult {
  const cleaned = stripCodeFences(raw).trim();
  if (cleaned.length === 0) {
    return { kind: "empty" };
  }

  if (isMockComposerResponse(cleaned)) {
    return { kind: "mock" };
  }

  const directParse = tryParseJsonObject(cleaned);
  if (directParse !== undefined) {
    return { kind: "parsed", value: directParse };
  }

  const extracted = extractFirstJsonObject(raw);
  if (extracted === undefined) {
    return {
      kind: "no-json",
      preview: sanitizeModelForDisplay(cleaned.slice(0, 200)),
    };
  }

  const extractedParse = tryParseJsonObject(extracted);
  if (extractedParse !== undefined) {
    return { kind: "parsed", value: extractedParse };
  }

  return {
    kind: "no-json",
    preview: sanitizeModelForDisplay(cleaned.slice(0, 200)),
  };
}

function tryParseJsonObject(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractFirstJsonObject(text: string): string | undefined {
  for (let startIndex = text.indexOf("{"); startIndex !== -1; startIndex = text.indexOf("{", startIndex + 1)) {
    const candidate = extractBalancedJsonObject(text, startIndex);
    if (candidate === undefined) {
      continue;
    }
    if (tryParseJsonObject(candidate) !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function extractBalancedJsonObject(text: string, startIndex: number): string | undefined {
  let depth = 0;
  let inString = false;
  let isEscaping = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) {
      return undefined;
    }

    if (inString) {
      if (isEscaping) {
        isEscaping = false;
        continue;
      }
      if (char === "\\") {
        isEscaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return text.slice(startIndex, index + 1);
    }
    if (depth < 0) {
      return undefined;
    }
  }

  return undefined;
}

function isMockComposerResponse(text: string): boolean {
  return /^\[mock response from /.test(text);
}

function createEmptyComposerResponseError(): Error {
  return new Error("Auto-compose failed: composer returned an empty response.");
}

function createMissingJsonObjectError(preview: string): Error {
  return new Error(
    `Auto-compose failed: composer did not return a JSON object. First 200 chars: ${preview}`,
  );
}

/**
 * Returns a deterministic fallback panel when MockEngine is detected.
 * This allows `council convene "topic" --engine mock` to work without
 * requiring a --template argument.
 */
function createMockFallbackPanel(model: string): ResolvedPanelDefinition {
  return {
    name: "mock-panel",
    description: "Deterministic fallback panel for mock engine testing",
    experts: [
      {
        slug: "mock-optimist",
        displayName: "Morgan Chen (Optimist)",
        role: "Identifies opportunities and positive outcomes",
        model,
        expertise: {
          weightedEvidence: ["Growth metrics", "User feedback", "Market trends"],
          referenceCases: ["Successful product launches"],
          notExpertIn: ["Risk analysis", "Cost optimization"],
        },
        epistemicStance:
          "Forms beliefs by prioritizing evidence of potential benefits and forward momentum.",
        kind: "generic",
      },
      {
        slug: "mock-skeptic",
        displayName: "Taylor Kim (Skeptic)",
        role: "Challenges assumptions and identifies risks",
        model,
        expertise: {
          weightedEvidence: ["Historical failures", "Implementation complexity", "Hidden costs"],
          referenceCases: ["Failed initiatives", "Rollback scenarios"],
          notExpertIn: ["Marketing strategy", "User experience design"],
        },
        epistemicStance:
          "Forms beliefs by examining evidence of potential pitfalls and questioning optimistic projections.",
        kind: "generic",
      },
      {
        slug: "mock-pragmatist",
        displayName: "Jordan Lee (Pragmatist)",
        role: "Balances trade-offs and focuses on implementation feasibility",
        model,
        expertise: {
          weightedEvidence: ["Resource constraints", "Team capacity", "Technical debt"],
          referenceCases: ["Incremental rollouts", "Phased approaches"],
          notExpertIn: ["Long-term vision", "Competitive analysis"],
        },
        epistemicStance:
          "Forms beliefs by weighing practical constraints against desired outcomes and prioritizing actionable next steps.",
        kind: "generic",
      },
    ],
  };
}

/**
 * Strip ALL characters unsafe for single-line terminal output:
 * C0/C1 controls, bidi overrides, zero-width chars, Unicode line/paragraph separators.
 */
function sanitizeModelForDisplay(raw: string): string {
  return raw.replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    "",
  );
}

/**
 * Strip terminal controls first (complete ANSI sequences), then prompt-sanitize.
 * All auto-composed expert fields use this to collapse newlines and defang
 * special chars — multiline content from untrusted LLM output would allow
 * prompt injection in downstream system prompts.
 */
function sanitizeField(raw: string, maxLength?: number): string {
  return sanitizePromptField(stripControlChars(raw)).slice(0, maxLength ?? 2000);
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
    const safeSlugs = slugRefs.map((s) => stripControlChars(s)).join(", ");
    throw new Error(
      `Auto-compose failed: composer returned slug references (${safeSlugs}) ` +
        `but inline expert definitions are required. The composer must produce a ` +
        `complete panel — slug references to library experts are not allowed in ` +
        `auto-composed panels.`,
    );
  }
  const inlineEntries = panel.experts.filter(
    (e): e is Exclude<typeof e, string> => typeof e !== "string",
  );
  return {
    name: sanitizeField(panel.name, 100),
    ...(panel.description !== undefined
      ? { description: sanitizeField(panel.description, 500) }
      : {}),
    ...(panel.defaults ? { defaults: panel.defaults } : {}),
    experts: inlineEntries.map((e) => ({
      slug: e.slug,
      displayName: sanitizeField(e.displayName, 80),
      role: sanitizeField(e.role, 200),
      model: defaultModel,
      expertise: {
        weightedEvidence: e.expertise.weightedEvidence.map((w) => sanitizeField(w)),
        referenceCases: e.expertise.referenceCases.map((r) => sanitizeField(r)),
        notExpertIn: e.expertise.notExpertIn.map((n) => sanitizeField(n)),
      },
      epistemicStance: sanitizeField(e.epistemicStance, 1000),
      kind: e.kind,
      ...(e.personality !== undefined
        ? { personality: sanitizeField(e.personality, 200) }
        : {}),
    })),
  };
}

/**
 * Cap the panel to at most `maxExperts` experts, keeping the first N in the
 * order the composer proposed them.
 *
 * The composer is *asked* for `minExperts`-`maxExperts` experts via the system
 * prompt, but the panel schema permits up to 8 and an LLM (or the
 * deterministic mock fallback) can return more than requested. This is the
 * single point that enforces the cap on the returned panel — the same panel
 * feeds both the "Auto-composed panel" banner (convene.ts) and the assembled
 * debate ("Panel assembled"), so capping here keeps those two lists identical
 * under `--max-experts`. Panels already at or under the cap are returned
 * unchanged, preserving behavior when no tighter limit applies.
 */
function capPanelExperts(
  panel: ResolvedPanelDefinition,
  maxExperts: number,
): ResolvedPanelDefinition {
  if (panel.experts.length <= maxExperts) {
    return panel;
  }
  return { ...panel, experts: panel.experts.slice(0, maxExperts) };
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

IMPORTANT: Output ONLY the JSON object. Do not include any text before or after the JSON.
Do not include markdown code fences. Do not explain your reasoning.`;
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
