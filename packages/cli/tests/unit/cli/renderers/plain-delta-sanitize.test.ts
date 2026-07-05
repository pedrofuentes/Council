/**
 * Tests for turn.delta sanitization in PlainRenderer.
 *
 * Sentinel finding #2396 (item 1): unsanitized AI content reaches TTY via
 * PlainRenderer. The adapter pushes raw `message.delta`/`turn.delta` text;
 * the live renderer must sanitize ANSI/OSC/control chars (matching the
 * treatment chat-renderer.ts:200 gives the same delta stream) to prevent
 * terminal spoofing attacks.
 *
 * RED at this commit: PlainRenderer.render() writes `evt.text` directly without
 * sanitization on the `turn.delta` path (plain.ts:100), so the assertions below
 * fail.
 */
import { describe, expect, it } from "vitest";

import type { DebateEvent } from "../../../../src/core/types.js";
import { PlainRenderer } from "../../../../src/cli/renderers/plain.js";

class StringSink {
  text = "";
  write(s: string): void {
    this.text += s;
  }
}

async function* events(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

/**
 * Adversarial delta text exercising terminal-injection vectors: ANSI CSI
 * (clear screen, cursor positioning), OSC (set terminal title), C1 controls
 * (alternate CSI/OSC introducers), carriage return (CR-overwrite attacks),
 * bidi override (Trojan Source CVE-2021-42574), zero-width space (invisible
 * padding).
 *
 * Newlines (`\n`) are legitimate — prose deltas may span multiple lines — so
 * this string includes `\n` to verify they are preserved, NOT stripped.
 */
const EVIL_DELTA =
  "Benign prose\n" +
  "\u001B[2J\u001B[H" + // ANSI CSI: clear screen + home cursor (spoofing)
  "\u001B]0;exfil-data\u0007" + // OSC: set terminal title (info disclosure)
  "\u009B2K" + // C1 CSI (0x9B): erase line
  "\rFAKE-PROMPT> " + // CR: overwrite the current line
  "\u202Ereversed" + // U+202E right-to-left override (bidi Trojan Source)
  "\u200Bhidden" + // U+200B zero-width space (invisible text)
  "\nMore benign prose";

// Control (C0/C1/DEL), bidi override/isolate, zero-width marks. Newlines and
// tabs are EXCLUDED because they are legitimate whitespace in prose.
const DANGEROUS_CONTROL_OR_BIDI =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200C\u200D\u202A-\u202E\u2066-\u2069]/;

describe("PlainRenderer — turn.delta sanitization (#2396)", () => {
  it("sanitizes ANSI/OSC/control chars in turn.delta text to prevent terminal injection", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "CTO", model: "claude-sonnet-4" }],
        },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "cto", text: EVIL_DELTA },
        { kind: "turn.end", expertSlug: "cto" },
      ),
    );

    // The delta text appears in the output between the turn.start header and turn.end newline.
    const lines = sink.text.split("\n");
    const headerIdx = lines.findIndex((l) => l.includes("[[1] CTO]"));
    if (headerIdx === -1) throw new Error("expected turn.start header line");
    const bodyLines = lines.slice(headerIdx + 1);
    const bodyText = bodyLines.join("\n");

    // MUST NOT contain dangerous control chars, ANSI escape sequences, bidi overrides, zero-width spaces.
    expect(bodyText).not.toMatch(DANGEROUS_CONTROL_OR_BIDI);
    // eslint-disable-next-line no-control-regex
    expect(bodyText).not.toMatch(/\u001B\[/); // ANSI CSI introducer
    // eslint-disable-next-line no-control-regex
    expect(bodyText).not.toMatch(/\u001B\]/); // OSC introducer
    expect(bodyText).not.toContain("\r"); // CR (carriage return)

    // MUST preserve legitimate newlines — prose is multi-line.
    expect(bodyText).toContain("Benign prose");
    expect(bodyText).toContain("More benign prose");
    expect(bodyText).toMatch(/Benign prose[\s\S]*More benign prose/); // multiline span
  });

  it("sanitizes consecutive deltas across multiple turn.delta events", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "CTO", model: "claude-sonnet-4" }],
        },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "cto", text: "Normal text " },
        { kind: "turn.delta", expertSlug: "cto", text: "\u001B[31mred\u001B[0m" }, // ANSI color
        { kind: "turn.delta", expertSlug: "cto", text: " more text" },
        { kind: "turn.end", expertSlug: "cto" },
      ),
    );

    const bodyText = sink.text;
    // The ANSI color codes must be stripped.
    // eslint-disable-next-line no-control-regex
    expect(bodyText).not.toMatch(/\u001B\[/);
    // The visible text "red" survives sanitization.
    expect(bodyText).toContain("Normal text");
    expect(bodyText).toContain("red");
    expect(bodyText).toContain("more text");
  });

  it("still renders legitimate multi-line prose with newlines intact", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    const legitimateMultiline = "First line\nSecond line\n\nFourth line (blank above)";
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "CTO", model: "claude-sonnet-4" }],
        },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "cto", text: legitimateMultiline },
        { kind: "turn.end", expertSlug: "cto" },
      ),
    );

    // Newlines are preserved in the output.
    expect(sink.text).toContain("First line");
    expect(sink.text).toContain("Second line");
    expect(sink.text).toContain("Fourth line (blank above)");
    // Verify structure: "First line" and "Second line" are on separate lines.
    const lines = sink.text.split("\n");
    const firstIdx = lines.findIndex((l) => l.includes("First line"));
    const secondIdx = lines.findIndex((l) => l.includes("Second line"));
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});
