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
          reason: "rate_limit_error",
        }),
      );
      const text = stripAnsi(sink.text);
      expect(text).toContain("rate limited, waiting...");
    });

    it("passes through unknown reason strings as-is", async () => {
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
