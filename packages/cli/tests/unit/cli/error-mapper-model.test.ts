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

  it("echoes the upstream message when neither model field nor regex matches", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "some model is broken",
    });
    expect(out).toContain("some model is broken");
    expect(out).not.toContain("(unknown)");
  });
});

/**
 * Security: the `model` field is interpolated into a stderr message. A crafted
 * model identifier could smuggle ANSI/OSC escapes, C0 controls, or CR/LF into
 * the terminal (spoofing, title injection, line-break forgery). Sanitize the
 * value with `toSingleLineDisplay` before interpolation (issue #668).
 *
 * RED before the fix: the raw escape/control bytes flow straight through.
 */
describe("formatEngineError — model sanitization (#668)", () => {
  it("strips ANSI escape sequences from the model field", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model unavailable",
      model: "claude\u001b[31mHACKED\u001b[0m",
    });
    expect(out).not.toContain("\u001b");
    expect(out).toContain("claudeHACKED");
  });

  it("collapses CR/LF in the model field onto a single line", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model unavailable",
      model: "gpt-4\r\nInjected: approved",
    });
    expect(out).not.toContain("\r");
    expect(out).toContain("gpt-4 Injected: approved");
  });

  it("strips C0 control characters (e.g. BEL) from the model field", () => {
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model unavailable",
      model: "gpt\u00074o",
    });
    expect(out).not.toContain("\u0007");
    expect(out).toContain("gpt4o");
  });

  it("strips OSC-8 hyperlink escape sequences from the model field", () => {
    // An OSC-8 hyperlink (ESC ] 8 ; ; URL BEL … ESC ] 8 ; ; BEL) can turn the
    // model label into a clickable link that exfiltrates data on click. The
    // whole sequence — introducer, URL payload AND terminator — must be
    // stripped, not merely the escape bytes, so no live link reaches the
    // terminal (#1913, #668).
    const out = formatEngineError({
      code: "MODEL_UNAVAILABLE",
      message: "model unavailable",
      model: "claude\u001b]8;;http://evil.example\u0007pwned\u001b]8;;\u0007",
    });
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).not.toContain("evil.example");
    // Printable text survives with the escapes/URL removed.
    expect(out).toContain("claudepwned");
  });
});
