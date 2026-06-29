/**
 * Regression tests for #674: FRIENDLY_REASONS must be keyed by the stable
 * runtime EngineErrorCode values emitted via turn.retry.reasonCode, not by
 * synthetic strings ("rate_limit_error", "timeout", "network_error") that
 * never appear in real retry paths.
 */
import { describe, expect, it } from "vitest";

import { FRIENDLY_REASONS, friendlyReason } from "../../../../src/cli/renderers/friendly-reasons.js";

describe("friendlyReason — keyed by EngineErrorCode (#674)", () => {
  it("maps RATE_LIMITED to a human-friendly message", () => {
    expect(friendlyReason("RATE_LIMITED")).toBe("rate limited, waiting...");
  });

  it("maps NETWORK to a human-friendly message", () => {
    expect(friendlyReason("NETWORK")).toBe("network issue, retrying...");
  });

  it("exposes the real engine codes as keys", () => {
    expect(Object.keys(FRIENDLY_REASONS)).toContain("RATE_LIMITED");
    expect(Object.keys(FRIENDLY_REASONS)).toContain("NETWORK");
  });

  it("falls back to the raw message when no code matches", () => {
    expect(friendlyReason(undefined, "connection reset")).toBe("connection reset");
    expect(friendlyReason("UNKNOWN_CODE", "boom")).toBe("boom");
  });
});
