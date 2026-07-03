/**
 * Display annotations that flag live-discovered models absent from the canonical
 * offline registry ({@link SUPPORTED_MODELS}).
 *
 * When the Copilot SDK is reachable, `doctor --models`, `council models`, the
 * first-run wizard, and the `council config model` picker all use LIVE
 * discovery — an intentional superset of the offline contract. Any
 * live-discovered id that is NOT in `SUPPORTED_MODELS` would be REJECTED by the
 * offline `council convene --model` validator, so it must be visibly flagged
 * (bug F02 residual — issue #1094).
 *
 * This module is DISPLAY/LABELING ONLY: it never changes discovery, the
 * registry, or validation behavior. It is the single source of the marker/legend
 * wording so every model-display path renders identically and can never drift
 * (bug F02 — the model lists must stay consistent).
 */
import { isSupportedModel } from "../engine/models.js";

/** Provenance of a discovered model list (mirrors `ModelDiscoveryResult.source`). */
export type ModelDiscoverySource = "live" | "static";

/**
 * Inline suffix appended to a live-only model id. Includes the leading space so
 * callers can concatenate it directly onto a rendered id.
 */
export const LIVE_ONLY_MODEL_ANNOTATION = " (live-only — not offline-validatable)";

/**
 * One-line explanation shown when at least one live-only model is listed, so the
 * user understands the consequence: these ids will not pass offline validation.
 */
export const LIVE_ONLY_MODEL_LEGEND =
  'Models tagged "live-only — not offline-validatable" come from live discovery ' +
  "but are not in Council's offline registry, so 'council convene --model <id>' " +
  "rejects them without a live connection.";

/**
 * A model is "live-only" when it was reported by LIVE discovery yet is absent
 * from the canonical offline registry — i.e. offline `convene --model` would
 * reject it. Static-fallback lists ARE the offline contract, so nothing in a
 * static list is ever live-only.
 */
export function isLiveOnlyModel(id: string, source: ModelDiscoverySource): boolean {
  return source === "live" && !isSupportedModel(id);
}

/**
 * Append the live-only marker to a model id when it will not pass offline
 * validation; return the id unchanged otherwise. Display-only — callers must
 * keep using the raw id for grouping, selection, and persistence.
 */
export function annotateLiveOnlyModel(id: string, source: ModelDiscoverySource): string {
  return isLiveOnlyModel(id, source) ? `${id}${LIVE_ONLY_MODEL_ANNOTATION}` : id;
}

/** Whether any id in the list is live-only (gates the explanatory legend). */
export function hasLiveOnlyModels(ids: readonly string[], source: ModelDiscoverySource): boolean {
  return ids.some((id) => isLiveOnlyModel(id, source));
}
