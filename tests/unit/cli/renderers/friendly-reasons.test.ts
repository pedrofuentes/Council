/**
 * Tests for friendly-reasons mapping (T-10, TUI-09).
 */
import { describe, expect, it } from "vitest";

import { FRIENDLY_REASONS, friendlyReason } from "../../../../src/cli/renderers/friendly-reasons.js";

describe("friendlyReason", () => {
  it("maps rate_limit_error to a human-friendly message", () => {
    expect(friendlyReason("rate_limit_error")).toBe("rate limited, waiting...");
  });

  it("maps timeout to a human-friendly message", () => {
    expect(friendlyReason("timeout")).toBe("request timed out, retrying...");
  });

  it("maps network_error to a human-friendly message", () => {
    expect(friendlyReason("network_error")).toBe("network issue, retrying...");
  });

  it("returns the raw reason when no mapping exists", () => {
    expect(friendlyReason("some_unknown_error")).toBe("some_unknown_error");
  });

  it("exports FRIENDLY_REASONS as a record", () => {
    expect(Object.keys(FRIENDLY_REASONS)).toContain("rate_limit_error");
    expect(Object.keys(FRIENDLY_REASONS)).toContain("timeout");
    expect(Object.keys(FRIENDLY_REASONS)).toContain("network_error");
  });
});
