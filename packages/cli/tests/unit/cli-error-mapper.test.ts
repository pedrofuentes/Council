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

// Bytes spanning the terminal-escape-injection class enumerated in #1910:
// an ANSI CSI colour sequence (ESC [ 31 m), a C1 CSI introducer (U+009B),
// CR/LF, the Unicode line/paragraph separators (U+2028/U+2029) and a Bidi
// override (U+202E). After single-line sanitization only "copilot bad"
// survives — every control/separator/Bidi codepoint must be gone.
const ADVERSARIAL_PROVIDER = "co\x1B[31mpilot\x9B\r\n\u2028\u2029\u202Ebad";

// Control, DEL, C1, line/paragraph-separator and Bidi codepoints that must
// never reach the terminal after sanitization (mirrors the sink guarantee).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Return the hint portion — everything before the verbatim `Underlying:` echo. */
function hintOf(rendered: string): string {
  return rendered.split("\n\n  Underlying:")[0] ?? rendered;
}

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

  // --- Untagged Error robustness (issue #188) ---------------------------
  // engine.start() lifecycle failures from CopilotEngine surface as thrown
  // Errors that lack a `code` property. Rather than degrade every one of
  // them to the bare "Engine error." fallback, recover structure from the
  // error's `cause` chain and, failing that, infer a hint from well-known
  // message substrings (auth / network / timeout).

  it("recovers the code from an EngineError-shaped cause chain", () => {
    const err = new Error("engine.start() failed", {
      cause: { code: "NOT_AUTHENTICATED", message: "missing Copilot token" },
    });
    const out = formatEngineError(err);
    expect(out.toLowerCase()).toContain("gh auth login");
    expect(out).toContain("engine.start() failed");
  });

  it("recovers the code from a nested (grand-parent) cause chain", () => {
    const inner = new Error("DNS lookup failed", {
      cause: { code: "NETWORK", message: "ENOTFOUND api.githubcopilot.com" },
    });
    const outer = new Error("could not start engine", { cause: inner });
    const out = formatEngineError(outer);
    expect(out.toLowerCase()).toMatch(/network|connection/);
  });

  it("infers an auth hint from an untagged Error message", () => {
    const out = formatEngineError(new Error("Request failed: 401 Unauthorized"));
    expect(out.toLowerCase()).toContain("gh auth login");
    expect(out).toContain("401 Unauthorized");
  });

  it("infers a network hint from an untagged Error message", () => {
    const out = formatEngineError(new Error("connect ECONNREFUSED 127.0.0.1:443"));
    expect(out.toLowerCase()).toMatch(/network|connection/);
  });

  it("infers a network hint from a timeout message", () => {
    const out = formatEngineError(new Error("socket hang up: request timed out"));
    expect(out.toLowerCase()).toMatch(/network|connection/);
  });

  // --- Terminal-escape sanitization of the `provider` label (#1910) --------
  // `formatEngineError` recovers `provider` from an untrusted Error `cause`
  // chain and also accepts it on the structured EngineError shape, then
  // interpolates it into the PROVIDER_ERROR stderr hint. Like the `model`
  // field (#668), it MUST be run through the single-line sanitizer so a
  // crafted provider can't smuggle ANSI/OSC escapes, C0/C1 controls, CR/LF,
  // line/paragraph separators or Bidi overrides into the terminal.

  it("sanitizes a provider recovered from the cause chain before the PROVIDER_ERROR hint (#1910)", () => {
    const err = new Error("engine.start() failed", {
      cause: {
        code: "PROVIDER_ERROR",
        provider: ADVERSARIAL_PROVIDER,
        message: "provider blew up",
      },
    });
    const hint = hintOf(formatEngineError(err));
    expect(hint).not.toContain("\n");
    expect(hint).not.toMatch(FORBIDDEN_CHARS);
    // Printable letters survive the strip so the label stays informative.
    expect(hint).toContain("copilot");
  });

  it("sanitizes a provider supplied on the structured EngineError before the PROVIDER_ERROR hint (#1910)", () => {
    const hint = hintOf(
      formatEngineError({
        code: "PROVIDER_ERROR",
        message: "503 from provider",
        provider: ADVERSARIAL_PROVIDER,
      }),
    );
    expect(hint).not.toContain("\n");
    expect(hint).not.toMatch(FORBIDDEN_CHARS);
    expect(hint).toContain("copilot");
  });

  // --- Throwing-getter safety across the cause chain (#1911) ---------------
  // `formatEngineError` must ALWAYS return a string for stderr. An untrusted
  // error whose `cause` (or a property on it) is an accessor that throws must
  // not let the exception escape `findEngineErrorInCause` or its call site;
  // the mapper degrades to the message-inferred / generic hint instead.

  it("returns a mapping when a cause object's `code` getter throws (#1911)", () => {
    const cause: Record<string, unknown> = {};
    Object.defineProperty(cause, "code", {
      enumerable: true,
      get() {
        throw new Error("boom: code getter");
      },
    });
    const out = formatEngineError(new Error("cause code getter explodes", { cause }));
    expect(out).toContain("Engine error.");
    expect(out).toContain("cause code getter explodes");
  });

  it("returns a mapping when the top-level Error's `cause` getter throws (#1911)", () => {
    const err = new Error("top-level cause getter explodes");
    Object.defineProperty(err, "cause", {
      configurable: true,
      get() {
        throw new Error("boom: top-level cause getter");
      },
    });
    const out = formatEngineError(err);
    expect(out).toContain("Engine error.");
    expect(out).toContain("top-level cause getter explodes");
  });

  it("returns a mapping when a nested `cause` getter throws during traversal (#1911)", () => {
    const inner: Record<string, unknown> = { message: "no code on this link" };
    Object.defineProperty(inner, "cause", {
      enumerable: true,
      get() {
        throw new Error("boom: nested cause getter");
      },
    });
    const out = formatEngineError(new Error("nested cause getter explodes", { cause: inner }));
    expect(out).toContain("Engine error.");
    expect(out).toContain("nested cause getter explodes");
  });

  it("returns a mapping when a coded cause's `provider` getter throws (#1911)", () => {
    const cause: Record<string, unknown> = { code: "PROVIDER_ERROR" };
    Object.defineProperty(cause, "provider", {
      enumerable: true,
      get() {
        throw new Error("boom: provider getter");
      },
    });
    const out = formatEngineError(new Error("provider getter explodes", { cause }));
    // Recovery must not throw even though `provider` is unreadable; the
    // underlying message is always echoed verbatim after the hint.
    expect(out).toContain("Underlying: provider getter explodes");
  });
});
