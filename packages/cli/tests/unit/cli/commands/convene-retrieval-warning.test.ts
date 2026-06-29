/**
 * Tests for the bounded + sanitized retrieval-failure warning in
 * `council convene` (issue #1052, follow-up #2).
 *
 * The best-effort RAG retrieval-failure path used to write the RAW
 * `err.message` straight to stderr — unbounded length and possible
 * multi-line / internal-detail leak. This mirrors the security risk that
 * `chat`'s bounded retrieval helper (`sanitizeErrorMessage`) already
 * guards against. The warning MUST be collapsed to a single line and
 * length-capped before reaching the terminal.
 */
import { describe, expect, it } from "vitest";

import { formatRetrievalFailureWarning } from "../../../../src/cli/commands/convene.js";

describe("formatRetrievalFailureWarning", () => {
  it("keeps the human-readable prefix and trailing newline", () => {
    const out = formatRetrievalFailureWarning(new Error("boom"));
    expect(out).toBe(
      "!! document retrieval failed (continuing without reference docs): boom\n",
    );
  });

  it("collapses multi-line errors to a single line", () => {
    const out = formatRetrievalFailureWarning(
      new Error("line one\nline two\r\nline three\u2028line four"),
    );
    // Exactly one newline — the trailing terminator — and no embedded breaks.
    expect(out.endsWith("\n")).toBe(true);
    expect(out.slice(0, -1)).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(out).toContain("line one line two line three line four");
  });

  it("bounds an unbounded raw message (caps length, appends ellipsis)", () => {
    const out = formatRetrievalFailureWarning(new Error("x".repeat(5000)));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("...");
  });

  it("strips ANSI / control escape sequences so they cannot reach the TTY", () => {
    const out = formatRetrievalFailureWarning(new Error("\u001b[31mred\u001b[0m\u0007"));
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).toContain("red");
  });

  it("handles non-Error throwables without leaking unbounded content", () => {
    const out = formatRetrievalFailureWarning("z".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.startsWith("!! document retrieval failed")).toBe(true);
  });
});
