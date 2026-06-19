/**
 * Central model resolution utility.
 *
 * Implements a layered model hierarchy:
 *   1. Per-expert override (expert YAML `model` field)
 *   2. Per-panel default (panel YAML `defaults.model`)
 *   3. Global config default (`config.yaml` `defaults.model`)
 *
 * Empty strings are treated as "unset" so a YAML field set to `""` falls
 * through to the next layer rather than sending an empty model to the SDK.
 */

export interface ResolveModelOptions {
  /** Model from the expert definition (highest priority). */
  readonly expertModel?: string | undefined;
  /** Default model from the panel definition. */
  readonly panelDefaultModel?: string | undefined;
  /** Global default from config.yaml (loaded at runtime via loadConfig). */
  readonly configDefaultModel: string;
}

/**
 * Resolve which model to use for an expert, applying the 3-layer hierarchy.
 *
 * Returns the first non-empty value in priority order:
 * expertModel → panelDefaultModel → configDefaultModel
 */
export function resolveModel(opts: ResolveModelOptions): string {
  if (opts.expertModel && opts.expertModel.length > 0) return opts.expertModel;
  if (opts.panelDefaultModel && opts.panelDefaultModel.length > 0) return opts.panelDefaultModel;
  return opts.configDefaultModel;
}
