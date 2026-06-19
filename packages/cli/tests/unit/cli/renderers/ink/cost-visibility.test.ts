/**
 * Cost visibility tests for the Ink renderer state machine.
 *
 * RED at this commit: cost.update always populates state.cost, even when
 * the renderer is configured to suppress the cost indicator.
 */
import { describe, expect, it } from "vitest";

import { INITIAL_STATE, reduce } from "../../../../../src/cli/renderers/ink/InkRenderer.js";

describe("InkRenderer cost visibility", () => {
  it("ignores cost.update when cost display is disabled", () => {
    const hiddenCostState = { ...INITIAL_STATE, showCost: false };

    const next = reduce(hiddenCostState, {
      kind: "cost.update",
      premiumRequests: 1,
      estimatedTotal: 3,
    });

    expect(next.cost).toBeNull();
  });

  it("keeps cost.update when cost display is enabled", () => {
    const visibleCostState = { ...INITIAL_STATE, showCost: true };

    const next = reduce(visibleCostState, {
      kind: "cost.update",
      premiumRequests: 2,
      estimatedTotal: 3,
    });

    expect(next.cost).toEqual({ premiumRequests: 2, estimatedTotal: 3 });
  });
});
