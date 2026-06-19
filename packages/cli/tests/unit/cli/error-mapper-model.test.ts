/**
 * Tests for DX-15 fix: error-mapper MODEL_UNAVAILABLE uses
 * ErrorLike.model field directly when available, falling back to regex.
 *
 * RED at this commit: ErrorLike doesn't have a model field.
 */
import { describe, expect, it } from "vitest";

import { formatEngineError } from "../../../src/cli/error-mapper.js";

describe("formatEngineError — model field (DX-15)", () => {
  it("uses model field directly when provided", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model not available",
      model: "o1-preview",
    });
    expect(out).toContain("o1-preview");
  });

  it("uses model field for grok-* models that fail regex", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "grok-2 not available",
      model: "grok-2",
    });
    expect(out).toContain("grok-2");
  });

  it("uses model field for llama-* models that fail regex", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "llama-3.1-70b not reachable",
      model: "llama-3.1-70b",
    });
    expect(out).toContain("llama-3.1-70b");
  });

  it("falls back to regex extraction when model field is absent", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model claude-sonnet-4.5 is not available",
    });
    expect(out).toContain("claude-sonnet-4.5");
  });

  it("shows (unknown) when neither model field nor regex matches", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "some model is broken",
    });
    expect(out).toContain("(unknown)");
  });
});
