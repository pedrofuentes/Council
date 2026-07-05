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

/**
 * Tests for the `turn.end` FALLBACK path in InkRenderer (#2480).
 *
 * When a turn ends with no accumulated active-turn text (no prior
 * `turn.delta` streamed, or the active turn belongs to another expert), the
 * reducer falls back to the terminal `ev.content` — the full model output.
 * The streamed-delta path is already sanitized (see the delta tests above),
 * but the fallback rendered `ev.content` RAW to the TTY, so an adversarial
 * turn that emits only a terminal message could inject ANSI/OSC/control
 * sequences. The fallback must apply the same `sanitizeMultiline` treatment.
 *
 * RED before the fix: the reducer uses `ev.content` unsanitized, so the
 * escape bytes below survive into the rendered frame and the assertions fail.
 */
const EVIL_TURN_END_CONTENT =
  "Recovered prose\n" +
  "\u001B[2J\u001B[H" + // ANSI CSI: clear screen + home cursor
  "\u001B]0;exfil\u0007" + // OSC: set terminal title
  "\u009B2K" + // C1 CSI (0x9B): erase line
  "\rFAKE> " + // CR: overwrite current line
  "\u202Ereversed" + // U+202E bidi override
  "\u200Bhidden" + // U+200B zero-width space
  "\nTrailing prose";

describe("InkRenderer — turn.end fallback sanitization (#2480)", () => {
  it("sanitizes ANSI/OSC/control chars in the turn.end ev.content fallback", async () => {
    // A turn that ends with ONLY a terminal message (no prior deltas): the
    // reducer has no accumulated active-turn text and falls back to ev.content.
    const eventStream = events(
      {
        kind: "panel.assembled",
        experts: [{ slug: "cto", displayName: "CTO", model: "claude-sonnet-4" }],
      },
      {
        kind: "turn.end",
        expertSlug: "cto",
        turnId: "t-evil",
        content: EVIL_TURN_END_CONTENT,
      },
    );

    const { lastFrame, unmount } = render(
      <DebateApp events={eventStream} onComplete={() => undefined} />,
    );

    // Wait for the async effect to process the events.
    await new Promise((resolve) => setImmediate(resolve));

    const output = lastFrame() ?? "";
    unmount();

    // Strip Ink's own styling ANSI codes (safe, Ink-generated) to isolate the
    // fallback content for inspection.
    // eslint-disable-next-line no-control-regex
    const strippedOutput = output.replace(/\u001B\[[0-9;]*m/g, "");

    // MUST NOT contain dangerous control chars, bidi overrides, or zero-width.
    expect(strippedOutput).not.toMatch(DANGEROUS_CONTROL_OR_BIDI);
    // MUST NOT contain the malicious CSI/OSC introducers from ev.content.
    expect(strippedOutput).not.toContain("\u001B]0;exfil"); // OSC set-title
    expect(strippedOutput).not.toContain("\u001B[2J"); // CSI clear-screen
    expect(strippedOutput).not.toContain("\r"); // CR

    // MUST preserve legitimate prose.
    expect(strippedOutput).toContain("Recovered prose");
    expect(strippedOutput).toContain("Trailing prose");
  });
});
