/**
 * Provider health and model discovery — re-exports adapter probes from the
 * narrow public surface used by CLI diagnostics and setup flows.
 *
 * The implementation lives in `adapter.ts` because ESLint's
 * `no-restricted-imports` rule restricts `@github/copilot-sdk` imports to
 * that single file (per AGENTS.md §Boundaries). This file exists as a
 * stable, narrowly-scoped import surface so the CLI never needs to reach
 * into the adapter directly.
 */
export {
  discoverAvailableModels,
  pingProviderHealth,
  type ModelDiscoveryResult,
  type ProviderHealth,
} from "./adapter.js";

