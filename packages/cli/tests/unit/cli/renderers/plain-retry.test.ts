/**
 * Tests for PlainRenderer retry handling and recoverable text (T-10).
 *
 * Covers:
 * - TUI-08: turn.retry handling in PlainRenderer
 * - TUI-09: Friendly retry reason messages
 * - TUI-23: "(recoverable)" → "— retrying automatically"
 */
import { describe, expect, it } from "vitest";

import type { DebateEvent } from "../../../../src/core/types.js";
import { PlainRenderer } from "../../../../src/cli/renderers/plain.js";

class StringSink {
  text = "";
  errText = "";
  write(s: string): void {
    this.text += s;
  }
  writeError(s: string): void {
    this.errText += s;
  }
}

async function* events(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

// Strip ANSI escape sequences for assertion convenience.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("PlainRenderer retry handling", () => {
  describe("TUI-08: turn.retry case", () => {
    it("renders turn.retry events with expert slug and attempt number", async () => {
      const sink = new StringSink();
      const renderer = new PlainRenderer(sink, { color: false });
      await renderer.render(
        events({
          kind: "turn.retry",
          expertSlug: "cto",
          attempt: 1,
          reason: "timeout",
        }),
      );
      const text = stripAnsi(sink.text);
      expect(text).toContain("[retry]");
      expect(text).toContain("cto");
      expect(text).toContain("attempt 1");
    });

    it("uses friendly reason text for known reason strings", async () => {
      const sink = new StringSink();
      const renderer = new PlainRenderer(sink, { color: false });
      await renderer.render(
        events({
          kind: "turn.retry",
          expertSlug: "cto",
          attempt: 2,
          reason: "throttled",
          reasonCode: "RATE_LIMITED",
        }),
      );
      const text = stripAnsi(sink.text);
      expect(text).toContain("rate limited, waiting...");
    });

    it("passes through raw reason when reasonCode is unmapped", async () => {
      const sink = new StringSink();
      const renderer = new PlainRenderer(sink, { color: false });
      await renderer.render(
        events({
          kind: "turn.retry",
          expertSlug: "cto",
          attempt: 1,
          reason: "some_custom_error",
        }),
      );
      const text = stripAnsi(sink.text);
      expect(text).toContain("some_custom_error");
    });
  });

  describe("TUI-23: recoverable error text", () => {
    it("uses '— retrying automatically' instead of '(recoverable)'", async () => {
      const sink = new StringSink();
      const renderer = new PlainRenderer(sink, { color: false });
      await renderer.render(
        events({
          kind: "error",
          expertSlug: "cto",
          message: "Quota exhausted",
          recoverable: true,
        }),
      );
      const text = stripAnsi(sink.errText);
      expect(text).toContain("— retrying automatically");
      expect(text).not.toContain("(recoverable)");
    });

    it("does not add suffix for non-recoverable errors", async () => {
      const sink = new StringSink();
      const renderer = new PlainRenderer(sink, { color: false });
      await renderer.render(
        events({
          kind: "error",
          expertSlug: "cto",
          message: "Fatal error",
          recoverable: false,
        }),
      );
      const text = stripAnsi(sink.errText);
      expect(text).not.toContain("retrying");
      expect(text).not.toContain("(recoverable)");
    });
  });
});

/**
 * Regression suite for GH-675: turn.retry terminal-injection sanitization.
 *
 * Anchored at the `sanitizeLine` retry path in PlainRenderer. Verifies that
 * adversarial control/ANSI/bidi bytes embedded in a turn.retry reason are
 * flattened to a single safe line before reaching the terminal.
 */
describe("GH-675: turn.retry sanitizeLine regression", () => {
  it("flattens adversarial control/ANSI/bidi bytes in turn.retry reason to one safe line", async () => {
    // Adversarial-byte oracle covering every byte class from the spec:
    // ANSI CSI, NUL, BS, LF (embedded newline), TAB, C1, DEL,
    // bidi overrides/isolates, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR.
    const adversarialReason =
      "\u001b[31m" + // ANSI CSI  — red escape sequence
      "visible" +
      "\u0000" + // NUL        (C0 \x00)
      "\u0008" + // BS         (C0 \x08)
      "\n" + // LF         — would split to second line
      "\t" + // TAB        (U+0009 — C0)
      "\u0080" + // C1 byte    (U+0080)
      "\u007f" + // DEL        (U+007F)
      "\u202a" + // bidi LRE   (U+202A)
      "\u202e" + // bidi RLO   (U+202E)
      "\u2066" + // bidi LRI   (U+2066)
      "\u2069" + // bidi PDI   (U+2069)
      "\r" + // CR         — would overwrite line
      "\u2028" + // LINE SEP   (U+2028)
      "\u2029" + // PARA SEP   (U+2029)
      "text";

    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({
        kind: "turn.retry",
        expertSlug: "sec",
        attempt: 1,
        reason: adversarialReason,
      }),
    );

    // Strip any residual ANSI (defensive — color: false disables chalk output).
    const rendered = stripAnsi(sink.text);

    // Renderer must emit exactly ONE line.
    // trimEnd() drops the renderer's own trailing line-terminator so the
    // "no embedded \n" check isn't tripped by the normal line ending.
    expect(rendered.trimEnd()).not.toContain("\n");

    // The line content (minus the renderer's trailing line-terminator) must be
    // free of every control / ANSI / bidi byte class from the oracle.
    // eslint-disable-next-line no-control-regex
    const controlBytePattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
    expect(rendered.trimEnd()).not.toMatch(controlBytePattern);

    // Discriminating: visible ASCII text must survive sanitization intact.
    expect(rendered).toContain("visible");
    expect(rendered).toContain("text");
  });
});
