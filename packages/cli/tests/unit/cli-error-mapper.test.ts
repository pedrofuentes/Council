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

  it("MODEL_UNAVAILABLE → suggests config set and doctor --models", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model claude-opus-4.7 not reachable",
    });
    expect(out.toLowerCase()).toMatch(/model|tier|available/);
    expect(out).toContain("claude-opus-4.7");
    expect(out).toContain("Fix: council config set defaults.model <available-model>");
    expect(out).toContain("Run 'council doctor --models' to see available models.");
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

  it("thrown Error with attached .code routes to the matching hint", () => {
    const err = new Error("auth is broken") as Error & { code: string };
    err.code = "NOT_AUTHENTICATED";
    const out = formatEngineError(err);
    expect(out.toLowerCase()).toContain("gh auth login");
    expect(out).toContain("auth is broken");
  });

  it("thrown Error without .code falls back to generic 'Engine error.'", () => {
    const out = formatEngineError(new Error("something went wrong"));
    expect(out).toContain("Engine error.");
    expect(out).toContain("something went wrong");
  });

  it("unknown / unmapped code falls back to generic 'Engine error.'", () => {
    const out = formatEngineError({ code: "BRAND_NEW_CODE" as never, message: "surprise" });
    expect(out).toContain("Engine error.");
    expect(out).toContain("surprise");
  });

  it("MODEL_UNAVAILABLE extracts model identifier from message", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model gpt-5.2 is not available for your tier",
    });
    expect(out).toContain("gpt-5.2");
    expect(out).toContain("Fix: council config set defaults.model <available-model>");
    expect(out).toContain("Run 'council doctor --models' to see available models.");
  });

  it("MODEL_UNAVAILABLE with no parseable model shows (unknown)", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "no models",
    });
    expect(out).toContain("(unknown)");
  });

  it("RATE_LIMITED includes retryAfterMs as seconds", () => {
    const out = formatEngineError({
      code: "RATE_LIMITED",
      message: "rate limited",
      retryAfterMs: 30_000,
    });
    expect(out).toContain("30s");
  });

  it("RATE_LIMITED without retryAfterMs omits wait duration", () => {
    const out = formatEngineError({ code: "RATE_LIMITED", message: "rate limited" });
    expect(out).not.toMatch(/\d+s/);
    expect(out.toLowerCase()).toContain("rate");
  });

  it("PROVIDER_ERROR without provider tag omits provider name", () => {
    const out = formatEngineError({ code: "PROVIDER_ERROR", message: "504 timeout" });
    expect(out).not.toContain("(copilot)");
    expect(out).toContain("504 timeout");
  });
});
