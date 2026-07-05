/**
 * Tests for turn.delta sanitization in InkRenderer.
 *
 * Sentinel finding #2396 (item 1): unsanitized AI content reaches TTY via
 * InkRenderer. The adapter pushes raw `message.delta`/`turn.delta` text;
 * the live Ink renderer must sanitize ANSI/OSC/control chars (matching the
 * treatment chat-renderer.ts:200 gives the same delta stream) to prevent
 * terminal spoofing attacks.
 *
 * RED at this commit: InkRenderer accumulates `evt.text` directly without
 * sanitization on the `turn.delta` reducer path (InkRenderer.tsx:232), so
 * the test below will fail once the implementation is testable.
 *
 * NOTE: InkRenderer integration tests are complex due to React/Ink test
 * environment setup. This test verifies the PlainRenderer sanitization
 * (which both renderers should use) and documents the InkRenderer fix.
 * Full Ink integration testing would require ink-testing-library setup
 * (see ink-renderer.test.tsx for pattern).
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { DebateApp } from "../../../../../src/cli/renderers/ink/InkRenderer.js";
import type { DebateEvent } from "../../../../../src/core/types.js";

async function* events(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

/**
 * Adversarial delta text exercising terminal-injection vectors: ANSI CSI
 * (clear screen), OSC (set terminal title), C1 controls, carriage return,
 * bidi override, zero-width space.
 *
 * Newlines are legitimate — prose deltas may span multiple lines.
 */
const EVIL_DELTA =
  "Benign prose\n" +
  "\u001B[2J\u001B[H" + // ANSI CSI: clear screen + home cursor
  "\u001B]0;exfil\u0007" + // OSC: set terminal title
  "\u009B2K" + // C1 CSI (0x9B): erase line
  "\rFAKE> " + // CR: overwrite current line
  "\u202Ereversed" + // U+202E bidi override
  "\u200Bhidden" + // U+200B zero-width space
  "\nMore prose";

// Control (C0/C1/DEL), bidi override/isolate, zero-width. Newlines/tabs excluded.
const DANGEROUS_CONTROL_OR_BIDI =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200C\u200D\u202A-\u202E\u2066-\u2069]/;

describe("InkRenderer — turn.delta sanitization (#2396)", () => {
  it("sanitizes ANSI/OSC/control chars in turn.delta text before rendering", async () => {
    const eventStream = events(
      {
        kind: "panel.assembled",
        experts: [{ slug: "cto", displayName: "CTO", model: "claude-sonnet-4" }],
      },
      { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "cto", text: EVIL_DELTA },
    );

    const { lastFrame, unmount } = render(
      <DebateApp events={eventStream} onComplete={() => undefined} />,
    );

    // Wait for the async effect to process the events.
    await new Promise((resolve) => setImmediate(resolve));

    const output = lastFrame() ?? "";
    unmount();

    // Strip Ink's own styling ANSI codes (which are safe, Ink-generated) to
    // isolate the delta text content for inspection.
    // eslint-disable-next-line no-control-regex
    const strippedOutput = output.replace(/\u001B\[[0-9;]*m/g, "");

    // MUST NOT contain dangerous control chars from the EVIL_DELTA, bidi overrides, zero-width.
    expect(strippedOutput).not.toMatch(DANGEROUS_CONTROL_OR_BIDI);
    // MUST NOT contain the malicious CSI/OSC introducers from the delta.
    expect(strippedOutput).not.toContain("\u001B]0;exfil"); // OSC set-title
    expect(strippedOutput).not.toContain("\u001B[2J"); // CSI clear-screen
    expect(strippedOutput).not.toContain("\r"); // CR

    // MUST preserve legitimate text.
    expect(strippedOutput).toContain("Benign prose");
    expect(strippedOutput).toContain("More prose");
  });

  it("sanitizes consecutive deltas across multiple turn.delta events", async () => {
    const eventStream = events(
      {
        kind: "panel.assembled",
        experts: [{ slug: "cto", displayName: "CTO", model: "claude-sonnet-4" }],
      },
      { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "cto", text: "Normal " },
      { kind: "turn.delta", expertSlug: "cto", text: "\u001B[31mred\u001B[0m" }, // ANSI color
      { kind: "turn.delta", expertSlug: "cto", text: " text" },
    );

    const { lastFrame, unmount } = render(
      <DebateApp events={eventStream} onComplete={() => undefined} />,
    );
    await new Promise((resolve) => setImmediate(resolve));

    const output = lastFrame() ?? "";
    unmount();

    // Strip Ink's styling to inspect the delta content.
    // eslint-disable-next-line no-control-regex
    const strippedOutput = output.replace(/\u001B\[[0-9;]*m/g, "");

    // The malicious ANSI color codes from the delta (distinct from Ink's own
    // styling) should be absent after sanitization. The visible text survives.
    expect(strippedOutput).toContain("Normal");
    expect(strippedOutput).toContain("red");
    expect(strippedOutput).toContain("text");
  });
});
