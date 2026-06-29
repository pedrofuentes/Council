/**
 * Tests for friendly-reasons mapping (T-10, TUI-09).
 */
import { describe, expect, it } from "vitest";

import {
  FRIENDLY_REASONS,
  friendlyReason,
} from "../../../../src/cli/renderers/friendly-reasons.js";

describe("friendlyReason", () => {
  it("maps RATE_LIMITED to a human-friendly message", () => {
    expect(friendlyReason("RATE_LIMITED")).toBe("rate limited, waiting...");
  });

  it("maps NETWORK to a human-friendly message", () => {
    expect(friendlyReason("NETWORK")).toBe("network issue, retrying...");
  });

  it("returns the raw reason when no mapping exists", () => {
    expect(friendlyReason("some_unknown_error", "some_unknown_error")).toBe("some_unknown_error");
  });

  it("exports FRIENDLY_REASONS as a record", () => {
    expect(Object.keys(FRIENDLY_REASONS)).toContain("RATE_LIMITED");
    expect(Object.keys(FRIENDLY_REASONS)).toContain("NETWORK");
  });
});
