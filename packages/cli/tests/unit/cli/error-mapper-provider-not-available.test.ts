/**
 * Tests for #1379: error-mapper must provide an actionable hint for the
 * `PROVIDER_NOT_AVAILABLE` engine-construction error. Selecting a
 * known-but-coming-soon provider (openai/anthropic) throws a
 * `ProviderNotAvailableError` at construction; once that failure is routed
 * through `formatEngineError` (#1378), the mapper needs a dedicated case so
 * the user is told how to pick an available provider/engine instead of
 * getting the generic "Engine error." fallback.
 *
 * RED before the fix: `hintForCode` has no `PROVIDER_NOT_AVAILABLE` case, so
 * the output is the generic fallback with no `--engine` guidance.
 */
import { describe, expect, it } from "vitest";

import { formatEngineError } from "../../../src/cli/error-mapper.js";
import { ProviderNotAvailableError } from "../../../src/engine/providers.js";

describe("formatEngineError — PROVIDER_NOT_AVAILABLE hint (#1379)", () => {
  it("returns an actionable hint guiding the user to an available engine (structured shape)", () => {
    const out = formatEngineError({
      code: "PROVIDER_NOT_AVAILABLE",
      message: "Provider 'openai' is not yet available in this release (coming soon).",
    });

    // Guides the user toward an available provider/engine rather than the
    // generic fallback.
    expect(out).toContain("--engine");
    expect(out).toMatch(/copilot/);
    expect(out).toMatch(/mock/);
    expect(out).not.toContain("Engine error.");

    // The underlying provider detail is preserved for diagnostics.
    expect(out).toContain("Underlying:");
    expect(out.toLowerCase()).toContain("openai");
  });

  it("returns the actionable hint for a thrown ProviderNotAvailableError instance", () => {
    const out = formatEngineError(new ProviderNotAvailableError("anthropic"));

    expect(out).toContain("--engine");
    expect(out).toMatch(/copilot/);
    expect(out).not.toContain("Engine error.");
    expect(out).toContain("Underlying:");
    expect(out.toLowerCase()).toContain("anthropic");
  });
});
