/**
 * Tests for the canonical model registry (`src/engine/models.ts`).
 *
 * This module is the SINGLE source of truth for the model identifiers that
 * Council guarantees are routable. Three independent CLI paths must agree on
 * it:
 *   1. `council doctor --models` (static fallback)
 *   2. the first-run model-selection wizard (static fallback + ranking hints)
 *   3. `council convene --model` validation
 *
 * These tests lock that invariant so the three paths can never drift apart
 * again (bug F02 — the lists used to disagree).
 */
import { describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../src/cli/commands/convene.js";
import {
  WIZARD_GPT_FALLBACK_MODEL,
  WIZARD_RECOMMENDED_MODEL,
} from "../../../src/cli/first-run-model-select.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import {
  isSupportedModel,
  KNOWN_MODELS,
  SUPPORTED_MODELS,
  type ModelId,
} from "../../../src/engine/models.js";

describe("SUPPORTED_MODELS canonical registry", () => {
  it("is a non-empty, de-duplicated list", () => {
    expect(SUPPORTED_MODELS.length).toBeGreaterThan(0);
    expect(new Set(SUPPORTED_MODELS).size).toBe(SUPPORTED_MODELS.length);
  });

  it("exposes KNOWN_MODELS as the same canonical reference (back-compat alias)", () => {
    // doctor + wizard reach the canonical list through the adapter static
    // fallback, which historically imported `KNOWN_MODELS`. The alias must
    // remain identical so there is exactly ONE source of truth.
    expect(KNOWN_MODELS).toBe(SUPPORTED_MODELS);
  });
});

describe("isSupportedModel guard", () => {
  it("accepts every model in the canonical list", () => {
    for (const model of SUPPORTED_MODELS) {
      expect(isSupportedModel(model)).toBe(true);
    }
  });

  it("rejects identifiers that are not in the canonical list", () => {
    expect(isSupportedModel("bogus-model-xyz")).toBe(false);
    expect(isSupportedModel("")).toBe(false);
    expect(isSupportedModel("claude")).toBe(false);
  });

  it("narrows the value to ModelId", () => {
    const candidate = "claude-sonnet-4.5";
    if (isSupportedModel(candidate)) {
      const narrowed: ModelId = candidate;
      expect(SUPPORTED_MODELS).toContain(narrowed);
    }
  });
});

describe("cross-path: convene --model validation references the canonical list", () => {
  function getModelParser(): (value: string, prev: unknown) => unknown {
    const cmd = buildConveneCommand({ engineFactory: () => new MockEngine({ responses: {} }) });
    const modelOpt = cmd.options.find((o) => o.long === "--model");
    const parser = modelOpt?.parseArg as ((v: string, prev: unknown) => unknown) | undefined;
    if (parser === undefined) {
      throw new Error("convene --model option must define a validating parser");
    }
    return parser;
  }

  it("accepts every canonical model unchanged", () => {
    const parse = getModelParser();
    for (const model of SUPPORTED_MODELS) {
      expect(parse(model, undefined)).toBe(model);
    }
  });

  it("rejects a model that is not in the canonical list", () => {
    const parse = getModelParser();
    expect(() => parse("bogus-model-xyz", undefined)).toThrow(/unknown model id/i);
  });
});

describe("cross-path: wizard ranking hints reference the canonical list", () => {
  it("recommends a model from the canonical list", () => {
    expect(isSupportedModel(WIZARD_RECOMMENDED_MODEL)).toBe(true);
  });

  it("uses a canonical GPT fallback for ordering", () => {
    expect(isSupportedModel(WIZARD_GPT_FALLBACK_MODEL)).toBe(true);
  });
});
