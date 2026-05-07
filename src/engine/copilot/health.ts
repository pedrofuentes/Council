/**
 * Provider health probe — re-exports `pingProviderHealth` from the adapter.
 *
 * The implementation lives in `adapter.ts` because ESLint's
 * `no-restricted-imports` rule restricts `@github/copilot-sdk` imports to
 * that single file (per AGENTS.md §Boundaries). This file exists as a
 * stable, narrowly-scoped import surface for `council doctor` so the CLI
 * never needs to reach into the adapter directly.
 */
export { pingProviderHealth, type ProviderHealth } from "./adapter.js";

