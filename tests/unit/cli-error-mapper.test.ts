/**
 * Tests for `formatEngineError` — the shared CLI error mapper that
 * turns engine error codes into actionable user-facing messages
 * (closes #133).
 *
 * Used by convene, resume, memory and any other command that may
 * surface engine errors. Each EngineErrorCode maps to a hint that
 * tells the user what to do next.
 *
 * RED at this commit: src/cli/error-mapper.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import { formatEngineError } from "../../src/cli/error-mapper.js";

describe("formatEngineError", () => {
  it("NOT_AUTHENTICATED → suggests `gh auth login`", () => {
    const err = new Error("[copilot] not authenticated");
    // Tagged engine error: pass code + original error.
    const out = formatEngineError({ code: "NOT_AUTHENTICATED", message: "not authenticated" });
    expect(out.toLowerCase()).toContain("gh auth login");
    void err;
  });

  it("MODEL_UNAVAILABLE → mentions the model and tier guidance", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model claude-opus-4.7 not reachable",
    });
    expect(out.toLowerCase()).toMatch(/model|tier|available/);
    expect(out).toContain("claude-opus-4.7");
  });

  it("NETWORK → suggests checking connection", () => {
    const out = formatEngineError({ code: "NETWORK", message: "DNS failure" });
    expect(out.toLowerCase()).toMatch(/network|connection|connectivity/);
  });

  it("RATE_LIMITED → suggests backing off + retry", () => {
    const out = formatEngineError({
      code: "RATE_LIMITED",
      message: "rate limit exceeded",
      retryAfterMs: 5000,
    });
    expect(out.toLowerCase()).toMatch(/rate.?limit|back.?off|throttl/);
  });

  it("CONTEXT_OVERFLOW → mentions prompt size", () => {
    const out = formatEngineError({
      code: "CONTEXT_OVERFLOW",
      message: "context too long",
    });
    expect(out.toLowerCase()).toMatch(/context|size|too long|too many/);
  });

  it("ABORTED → succinct cancellation message", () => {
    const out = formatEngineError({ code: "ABORTED", message: "stop requested" });
    expect(out.toLowerCase()).toMatch(/cancel|abort|stop/);
  });

  it("INTERNAL → flags as a Council bug + asks for issue", () => {
    const out = formatEngineError({
      code: "INTERNAL",
      message: "assertion failed",
    });
    expect(out.toLowerCase()).toMatch(/internal|bug|file an issue|github/);
  });

  it("PROVIDER_ERROR → falls through with provider tag if present", () => {
    const out = formatEngineError({
      code: "PROVIDER_ERROR",
      message: "Copilot API returned 503",
      provider: "copilot",
    });
    expect(out.toLowerCase()).toContain("copilot");
    expect(out).toContain("503");
  });

  it("includes the underlying message verbatim for diagnostic use", () => {
    const msg = "uniquely-identifiable-message-12345";
    const out = formatEngineError({ code: "NETWORK", message: msg });
    expect(out).toContain(msg);
  });

  it("accepts a thrown Error and extracts code from cause / fallback", () => {
    // When the engine throws a wrapped Error rather than emitting an
    // event, formatEngineError can still extract structure if the
    // underlying object exposes a `code` field.
    const out = formatEngineError(new Error("opaque failure"));
    expect(out.length).toBeGreaterThan(0);
    expect(out.toLowerCase()).toMatch(/error|fail/);
  });
});
