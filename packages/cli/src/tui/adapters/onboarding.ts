import { orderModelsByPreference } from "../../cli/first-run-model-select.js";
import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ModelDiscoveryResult } from "../../engine/copilot/health.js";

/**
 * A single selectable model in the first-run onboarding picker.
 *
 * `id` is the raw, unmodified model identifier forwarded verbatim to the
 * persistence layer (mirroring the CLI wizard's `selectModelInteractively`).
 * `label` is the display-only, single-line-sanitized rendering used at the
 * Ink `<Text>` sink — model identifiers are provider/config-derived and so are
 * treated as untrusted.
 */
export interface OnboardingModelOption {
  readonly id: string;
  readonly label: string;
  readonly recommended: boolean;
}

export interface OnboardingView {
  readonly isFirstRun: boolean;
  readonly models: readonly OnboardingModelOption[];
  /** True when discovery fell back to the built-in static model list. */
  readonly usedFallback: boolean;
}

/** Persists a single dot-notation config field (e.g. `updateConfigField`). */
export type OnboardingConfigWriter = (key: string, value: string) => Promise<void>;

export interface OnboardingDeps {
  readonly isFirstRun: boolean;
  readonly discoverModels: () => Promise<ModelDiscoveryResult>;
  readonly updateConfig: OnboardingConfigWriter;
}

export interface OnboardingDataSource {
  /** Resolve the onboarding view; skipped (empty) when it is not the first run. */
  readonly load: () => Promise<OnboardingView>;
  /** Persist the chosen model as the default, completing onboarding. */
  readonly complete: (model: string) => Promise<void>;
}

const SKIPPED: OnboardingView = { isFirstRun: false, models: [], usedFallback: false };

export function createOnboardingSource(deps: OnboardingDeps): OnboardingDataSource {
  return {
    load: async (): Promise<OnboardingView> => {
      if (!deps.isFirstRun) {
        return SKIPPED;
      }

      const discovery = await deps.discoverModels();
      const models = orderModelsByPreference(discovery.models).map((id, index) => ({
        id,
        label: toSingleLineDisplay(id),
        recommended: index === 0,
      }));

      return { isFirstRun: true, models, usedFallback: discovery.source === "static" };
    },
    complete: async (model: string): Promise<void> => {
      await deps.updateConfig("defaults.model", model);
    },
  };
}
