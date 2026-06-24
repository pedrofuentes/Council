import { describe, expect, it, vi } from "vitest";

import type { ModelDiscoveryResult } from "../../../src/engine/copilot/health.js";
import {
  createOnboardingSource,
  type OnboardingDeps,
} from "../../../src/tui/adapters/onboarding.js";

const discoveryFor = (overrides: Partial<ModelDiscoveryResult> = {}): ModelDiscoveryResult => ({
  models: ["gpt-5.4", "claude-sonnet-4.5", "zeta-model"],
  source: "live",
  ...overrides,
});

const createDeps = (overrides: Partial<OnboardingDeps> = {}): OnboardingDeps => ({
  isFirstRun: true,
  discoverModels: async () => discoveryFor(),
  updateConfig: async () => undefined,
  ...overrides,
});

describe("createOnboardingSource", () => {
  it("orders discovered models with the recommended model first when first-run", async () => {
    const source = createOnboardingSource(createDeps());

    const view = await source.load();

    expect(view.isFirstRun).toBe(true);
    expect(view.models.map((option) => option.id)).toEqual([
      "claude-sonnet-4.5",
      "gpt-5.4",
      "zeta-model",
    ]);
    expect(view.models[0]).toEqual({
      id: "claude-sonnet-4.5",
      label: "claude-sonnet-4.5",
      recommended: true,
    });
    // The `recommended: index === 0` guard must be false for every later model.
    expect(view.models[1]?.recommended).toBe(false);
    expect(view.models[2]?.recommended).toBe(false);
    expect(view.usedFallback).toBe(false);
  });

  it("flags the built-in fallback when discovery falls back to the static list", async () => {
    const source = createOnboardingSource(
      createDeps({ discoverModels: async () => discoveryFor({ source: "static" }) }),
    );

    const view = await source.load();

    // Bite the `source === "static"` branch — a "live" discovery must report false.
    expect(view.usedFallback).toBe(true);
  });

  it("skips onboarding and never discovers models when it is not the first run", async () => {
    const discoverModels = vi.fn(async () => discoveryFor());
    const source = createOnboardingSource(createDeps({ isFirstRun: false, discoverModels }));

    const view = await source.load();

    expect(view).toEqual({ isFirstRun: false, models: [], usedFallback: false });
    // Early-return bite: a non-first-run load must short-circuit before discovery.
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("persists the chosen model under defaults.model when onboarding completes", async () => {
    const updateConfig = vi.fn(async () => undefined);
    const source = createOnboardingSource(createDeps({ updateConfig }));

    await source.complete("claude-opus-4");

    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith("defaults.model", "claude-opus-4");
  });

  it("sanitizes model labels to a single display line while preserving the raw id", async () => {
    const source = createOnboardingSource(
      createDeps({
        discoverModels: async () => discoveryFor({ models: ["evil\u001B[2K\nmodel"] }),
      }),
    );

    const view = await source.load();

    // toSingleLineDisplay strips the ANSI sequence and collapses the newline so the
    // model id can never break out onto its own terminal line.
    expect(view.models[0]?.label).toBe("evil model");
    expect(view.models[0]?.label).not.toContain("\u001B");
    expect(view.models[0]?.label).not.toContain("\n");
    // The raw id is forwarded verbatim to the persistence layer (display-only sanitization).
    expect(view.models[0]?.id).toBe("evil\u001B[2K\nmodel");
  });
});
