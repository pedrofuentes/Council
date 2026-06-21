/**
 * Provider-aware engine registry — the SINGLE place that maps a provider
 * id to an engine factory.
 *
 * Council keeps the AI provider behind the {@link CouncilEngine} seam (see
 * `engine/index.ts` and DECISIONS.md ADR-003). This registry is where each
 * provider plugs in:
 *
 *   - `copilot` and `mock` are available today and construct their adapters.
 *   - `openai` and `anthropic` are KNOWN but NOT YET wired up. Selecting one
 *     yields a graceful {@link ProviderNotAvailableError} ("coming soon")
 *     instead of a crash — and crucially imports NO SDK and makes NO network
 *     call. Their real adapters (with API-key handling) land in a separate,
 *     human-gated task.
 *
 * Adding a real adapter later is a one-line change here: flip `available`
 * to `true` and supply a `create` factory. Nothing else in the CLI needs to
 * change — commands already surface whatever this registry decides.
 *
 * This module imports the concrete adapters (`MockEngine`, `CopilotEngine`)
 * but NEVER `@github/copilot-sdk` directly — that import is confined to
 * `engine/copilot/adapter.ts` by ESLint `no-restricted-imports`.
 */
import { ENGINE_CHOICES, type EngineChoice } from "../config/schema.js";

import type { CouncilEngine } from "./index.js";
import { MockEngine } from "./mock/mock-engine.js";
import { CopilotEngine } from "./copilot/adapter.js";

/** Canonical provider ids Council knows about (available + coming-soon). */
export const PROVIDER_IDS = ENGINE_CHOICES;

/** A provider id Council recognizes. */
export type ProviderId = EngineChoice;

/** Stable error code carried by {@link ProviderNotAvailableError}. */
export const PROVIDER_NOT_AVAILABLE = "PROVIDER_NOT_AVAILABLE";

/**
 * Thrown when a KNOWN provider is selected before its adapter ships.
 *
 * Distinct from the legacy "Unknown engine kind" error, which is reserved
 * for ids Council doesn't recognize at all. The message is user-facing and
 * actionable ("coming soon"); the `code` lets the CLI map it to a
 * user-error exit code.
 */
export class ProviderNotAvailableError extends Error {
  readonly code = PROVIDER_NOT_AVAILABLE;
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super(`Provider '${providerId}' is not yet available in this release (coming soon).`);
    this.name = "ProviderNotAvailableError";
    this.providerId = providerId;
  }
}

interface ProviderRegistration {
  readonly id: ProviderId;
  /** Whether the provider can construct a working engine today. */
  readonly available: boolean;
  /** Factory for available providers; absent for coming-soon ones. */
  readonly create?: () => CouncilEngine;
  /**
   * NAME of the environment variable a future adapter reads the API key
   * from (e.g. "OPENAI_API_KEY"). A NAME only — never a key value, and
   * never persisted to SQLite. `undefined` for providers that don't use a
   * standalone API key (copilot uses GitHub auth; mock needs nothing).
   */
  readonly apiKeyEnvVar?: string;
}

const REGISTRY: Readonly<Record<ProviderId, ProviderRegistration>> = {
  copilot: { id: "copilot", available: true, create: (): CouncilEngine => new CopilotEngine() },
  mock: { id: "mock", available: true, create: (): CouncilEngine => new MockEngine() },
  openai: { id: "openai", available: false, apiKeyEnvVar: "OPENAI_API_KEY" },
  anthropic: { id: "anthropic", available: false, apiKeyEnvVar: "ANTHROPIC_API_KEY" },
};

/** Provider ids that can construct a working engine today. */
export const AVAILABLE_PROVIDER_IDS: readonly ProviderId[] = PROVIDER_IDS.filter(
  (id) => REGISTRY[id].available,
);

/** Type guard: is `id` a provider Council recognizes? */
export function isKnownProvider(id: string): id is ProviderId {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id);
}

/** Whether `id`'s adapter is available (constructable) today. */
export function isProviderAvailable(id: ProviderId): boolean {
  return REGISTRY[id].available;
}

/**
 * The env-var NAME (never a value) a future adapter reads the API key
 * from, or `undefined` if the provider doesn't use one.
 */
export function getProviderApiKeyEnvVar(id: ProviderId): string | undefined {
  return REGISTRY[id].apiKeyEnvVar;
}

/**
 * Construct the engine for `id`.
 *
 *   - available provider (copilot/mock) → a fresh {@link CouncilEngine}.
 *     Construction only — the network is touched on `start()`, not here.
 *   - known-but-not-yet-available (openai/anthropic) → throws a graceful
 *     {@link ProviderNotAvailableError} with no SDK import and no network.
 *   - an unrecognized id → throws the legacy "Unknown engine kind" error.
 */
export function createEngine(id: ProviderId): CouncilEngine {
  const registration = REGISTRY[id] as ProviderRegistration | undefined;
  if (registration === undefined) {
    throw new Error(`Unknown engine kind: ${String(id)}`);
  }
  if (!registration.available || registration.create === undefined) {
    throw new ProviderNotAvailableError(id);
  }
  return registration.create();
}
