/**
 * Tests for the provider-aware engine registry (`src/engine/providers.ts`).
 *
 * The registry is the SINGLE place where a provider id maps to an engine
 * factory, so future adapters (OpenAI, Anthropic) plug in here rather than
 * being threaded through every command. This suite locks the seam:
 *
 *   - `copilot` and `mock` construct exactly as before (no behavior change).
 *   - `openai` and `anthropic` are KNOWN but NOT YET available — selecting
 *     them yields a graceful, actionable `ProviderNotAvailableError`
 *     ("coming soon") WITHOUT importing any SDK or touching the network.
 *   - A truly-unknown id still throws the legacy "Unknown engine kind"
 *     error (distinct from the not-available case).
 *   - The env-var NAME (never a value) for each future provider is exposed
 *     as registry metadata so a future adapter can read the key from the
 *     environment.
 *
 * RED at this commit: `src/engine/providers.ts` does not exist.
 */
import { describe, expect, it } from "vitest";

import {
  AVAILABLE_PROVIDER_IDS,
  PROVIDER_IDS,
  ProviderNotAvailableError,
  createEngine,
  getProviderApiKeyEnvVar,
  isKnownProvider,
  isProviderAvailable,
  type ProviderId,
} from "../../../src/engine/providers.js";
import { makeEngineFromKind } from "../../../src/cli/run-with-engine.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { CopilotEngine } from "../../../src/engine/copilot/adapter.js";

const ENGINE_METHODS = [
  "start",
  "stop",
  "addExpert",
  "removeExpert",
  "send",
  "listModels",
] as const;

describe("provider registry — PROVIDER_IDS", () => {
  it("knows exactly the four providers (available + coming-soon)", () => {
    expect([...PROVIDER_IDS].sort()).toEqual(["anthropic", "copilot", "mock", "openai"]);
  });

  it("lists copilot and mock as the only available providers", () => {
    expect([...AVAILABLE_PROVIDER_IDS].sort()).toEqual(["copilot", "mock"]);
  });
});

describe("provider registry — isKnownProvider", () => {
  it("accepts the four known provider ids", () => {
    for (const id of ["copilot", "mock", "openai", "anthropic"]) {
      expect(isKnownProvider(id)).toBe(true);
    }
  });

  it("rejects unknown ids", () => {
    expect(isKnownProvider("gemini")).toBe(false);
    expect(isKnownProvider("anthropic-direct")).toBe(false);
    expect(isKnownProvider("")).toBe(false);
  });
});

describe("provider registry — isProviderAvailable", () => {
  it("reports copilot and mock as available", () => {
    expect(isProviderAvailable("copilot")).toBe(true);
    expect(isProviderAvailable("mock")).toBe(true);
  });

  it("reports openai and anthropic as not yet available", () => {
    expect(isProviderAvailable("openai")).toBe(false);
    expect(isProviderAvailable("anthropic")).toBe(false);
  });
});

describe("provider registry — createEngine for available providers", () => {
  it("constructs a MockEngine for 'mock'", () => {
    const engine = createEngine("mock");
    expect(engine).toBeInstanceOf(MockEngine);
    for (const method of ENGINE_METHODS) {
      expect(typeof (engine as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("constructs a CopilotEngine for 'copilot' without starting it (no network)", () => {
    // Construction must NOT touch the network — start() is where the SDK
    // connects. We only assert the object is built and contract-shaped.
    const engine = createEngine("copilot");
    expect(engine).toBeInstanceOf(CopilotEngine);
    for (const method of ENGINE_METHODS) {
      expect(typeof (engine as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });
});

describe("provider registry — createEngine for coming-soon providers", () => {
  it("throws a graceful ProviderNotAvailableError for 'openai'", () => {
    expect(() => createEngine("openai")).toThrow(ProviderNotAvailableError);
    expect(() => createEngine("openai")).toThrow(/not yet available/i);
    expect(() => createEngine("openai")).toThrow(/coming soon/i);
  });

  it("throws a graceful ProviderNotAvailableError for 'anthropic'", () => {
    expect(() => createEngine("anthropic")).toThrow(ProviderNotAvailableError);
    expect(() => createEngine("anthropic")).toThrow(/not yet available/i);
  });

  it("tags the error with the provider id and a stable code", () => {
    try {
      createEngine("openai");
      expect.unreachable("createEngine('openai') should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotAvailableError);
      const e = err as ProviderNotAvailableError;
      expect(e.providerId).toBe("openai");
      expect(e.code).toBe("PROVIDER_NOT_AVAILABLE");
      expect(e.message).toContain("openai");
    }
  });
});

describe("provider registry — createEngine for unknown providers", () => {
  it("throws the legacy 'Unknown engine kind' error (not the not-available error)", () => {
    const unknownId = "anthropic-direct" as unknown as ProviderId;
    expect(() => createEngine(unknownId)).toThrow(/unknown.*engine.*kind/i);
    expect(() => createEngine(unknownId)).not.toThrow(ProviderNotAvailableError);
  });
});

describe("provider registry — env-var NAME metadata (never a key value)", () => {
  it("exposes the conventional env-var NAME for coming-soon providers", () => {
    expect(getProviderApiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
    expect(getProviderApiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
  });

  it("has no api-key env var for copilot or mock (they don't use one)", () => {
    expect(getProviderApiKeyEnvVar("copilot")).toBeUndefined();
    expect(getProviderApiKeyEnvVar("mock")).toBeUndefined();
  });

  it("returns NAMES only — never a value that looks like a secret", () => {
    for (const id of PROVIDER_IDS) {
      const name = getProviderApiKeyEnvVar(id);
      if (name !== undefined) {
        // An env var NAME, e.g. OPENAI_API_KEY — uppercase identifier, no
        // secret-looking prefixes.
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(name).not.toMatch(/^sk-/);
      }
    }
  });
});

describe("CLI seam — makeEngineFromKind delegates to the registry", () => {
  it("constructs mock and copilot", () => {
    expect(makeEngineFromKind("mock")).toBeInstanceOf(MockEngine);
    expect(makeEngineFromKind("copilot")).toBeInstanceOf(CopilotEngine);
  });

  it("yields the graceful not-available error for openai/anthropic", () => {
    expect(() => makeEngineFromKind("openai")).toThrow(/not yet available/i);
    expect(() => makeEngineFromKind("anthropic")).toThrow(/not yet available/i);
  });
});
