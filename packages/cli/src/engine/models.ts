/**
 * Canonical registry of Copilot-routable model identifiers used across the CLI.
 *
 * This module is the SINGLE source of truth for the static set of models
 * Council guarantees are routable. All three model-facing CLI paths reference
 * it so they can never disagree (bug F02):
 *
 *   1. `council doctor --models` — via the adapter's static discovery fallback.
 *   2. the first-run model-selection wizard — via the same static fallback.
 *   3. `council convene --model` validation — via {@link isSupportedModel}.
 *
 * Live discovery (when the Copilot SDK is reachable) may report a superset that
 * reflects the user's actual Copilot tier; this list is the offline contract.
 *
 * It MUST mirror what live discovery offers so that anything `council models`
 * advertises also passes `council convene --model` validation (bug PM-03 — the
 * static list lagged discovery: it carried a bogus `gpt-5.2` that was never
 * offered, and omitted ids discovery advertised). The special selector `auto`
 * (delegate model choice to Copilot) is a routable selector and lives here too,
 * so it validates and is advertised like any other id.
 *
 * The list is frozen AT DEFINITION via {@link Object.freeze} so its runtime
 * immutability is intrinsic and independent of import order (#1095). `as const`
 * alone is only a compile-time guarantee; freezing here means no consumer can
 * mutate the shared registry and immutability never depends on some other
 * module being evaluated first to apply the freeze.
 */
export const SUPPORTED_MODELS = Object.freeze([
  // Anthropic via Copilot
  "claude-haiku-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-opus-4.8",
  // OpenAI via Copilot
  "gpt-4.1",
  "gpt-5-mini",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  // Google via Copilot
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  // Other Copilot-routable selectors
  "mai-code-1-flash-internal",
  "auto",
] as const);

/** A model identifier known to the canonical {@link SUPPORTED_MODELS} registry. */
export type ModelId = (typeof SUPPORTED_MODELS)[number];

/**
 * Shared validator for the canonical model registry. Every CLI path that must
 * accept or reject a model id MUST go through this guard so they stay in sync.
 */
export function isSupportedModel(id: string): id is ModelId {
  return (SUPPORTED_MODELS as readonly string[]).includes(id);
}

/**
 * Back-compat alias for the canonical list. Kept as the exact same reference so
 * there is exactly ONE source of truth; prefer {@link SUPPORTED_MODELS} in new
 * code.
 *
 * @deprecated Use {@link SUPPORTED_MODELS} (or {@link isSupportedModel}).
 */
export const KNOWN_MODELS: readonly string[] = SUPPORTED_MODELS;
