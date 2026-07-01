/**
 * Immutability contract for the canonical model registry (`src/engine/models.ts`).
 *
 * Regression guard for #1095: `SUPPORTED_MODELS` must be frozen AT DEFINITION so
 * its immutability is intrinsic and does NOT depend on import order. Historically
 * the array was only `as const` (a compile-time guarantee) and was frozen lazily
 * as a module-load side-effect elsewhere (the adapter's `STATIC_MODEL_LIST`).
 * Under an import sequence that reached `models.ts` WITHOUT first evaluating the
 * adapter, the list was observably mutable.
 *
 * This suite is deliberately ISOLATED: it imports ONLY `models.js` and nothing
 * that transitively loads the adapter. Vitest runs each test file in its own
 * fork (`isolate: true`, `pool: "forks"`), so if the freeze depended on any
 * other module being loaded first, `Object.isFrozen(...)` here would be `false`.
 * That is exactly what makes these assertions discriminating.
 *
 * The registry holds only primitive strings, so a top-level freeze is sufficient
 * for element-level immutability (strings cannot be mutated); no deep freeze is
 * required.
 */
import { describe, expect, it } from "vitest";

import { isSupportedModel, KNOWN_MODELS, SUPPORTED_MODELS } from "../../../src/engine/models.js";

/** A mutable view onto the same underlying array, to attempt real mutations. */
function mutableView(): string[] {
  return SUPPORTED_MODELS as unknown as string[];
}

describe("SUPPORTED_MODELS is frozen at definition (import-order independent)", () => {
  it("is already frozen at import, with no other module loaded to trigger it", () => {
    expect(Object.isFrozen(SUPPORTED_MODELS)).toBe(true);
  });

  it("exposes KNOWN_MODELS as the same frozen reference", () => {
    expect(KNOWN_MODELS).toBe(SUPPORTED_MODELS);
    expect(Object.isFrozen(KNOWN_MODELS)).toBe(true);
  });

  it("rejects appends: push throws and leaves length and contents unchanged", () => {
    const before = [...SUPPORTED_MODELS];
    expect(() => mutableView().push("malicious-model")).toThrow(TypeError);
    expect(SUPPORTED_MODELS.length).toBe(before.length);
    expect([...SUPPORTED_MODELS]).toEqual(before);
  });

  it("rejects index assignment: it throws and leaves the element unchanged", () => {
    const original = SUPPORTED_MODELS[0];
    expect(() => {
      mutableView()[0] = "hacked-model";
    }).toThrow(TypeError);
    expect(SUPPORTED_MODELS[0]).toBe(original);
  });

  it("rejects removals: pop throws and leaves length unchanged", () => {
    const before = SUPPORTED_MODELS.length;
    expect(() => mutableView().pop()).toThrow(TypeError);
    expect(SUPPORTED_MODELS.length).toBe(before);
  });
});

describe("freezing preserves the full model set (no model dropped)", () => {
  it("keeps a non-empty, de-duplicated registry", () => {
    expect(SUPPORTED_MODELS.length).toBeGreaterThan(0);
    expect(new Set(SUPPORTED_MODELS).size).toBe(SUPPORTED_MODELS.length);
  });

  it("still validates every canonical model through the guard", () => {
    for (const model of SUPPORTED_MODELS) {
      expect(isSupportedModel(model)).toBe(true);
    }
  });

  it("retains representative ids from every provider tier after freezing", () => {
    for (const id of [
      "claude-opus-4.8",
      "gpt-5.5",
      "gemini-3.5-flash",
      "mai-code-1-flash-internal",
      "auto",
    ]) {
      expect(SUPPORTED_MODELS).toContain(id);
    }
  });

  it("still rejects an id that is not in the frozen registry", () => {
    expect(isSupportedModel("bogus-model-xyz")).toBe(false);
  });
});
