/**
 * Tests for the Plain renderer.
 *
 * Human-readable text rendering for any TTY or non-TTY consumer that
 * doesn't want JSON. Streams turn deltas immediately (no buffering)
 * so users see responses appear as they're generated.
 *
 * RED at this commit: src/cli/renderers/plain.ts does not exist.
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

describe("PlainRenderer", () => {
  it("prints panel.assembled with expert names and models", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({
        kind: "panel.assembled",
        experts: [
          { slug: "cto", displayName: "Dahlia Renner (CTO)", model: "claude-sonnet-4" },
          { slug: "pm", displayName: "Liam Park (PM)", model: "gpt-5" },
        ],
      }),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("Dahlia Renner (CTO)");
    expect(text).toContain("Liam Park (PM)");
    expect(text).toContain("claude-sonnet-4");
    expect(text).toContain("gpt-5");
  });

  it("prints expert name as a header before turn.start", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "Dahlia Renner (CTO)", model: "x" }],
        },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "cto", text: "Hello." },
        { kind: "turn.end", expertSlug: "cto", turnId: "01HZ", content: "Hello." },
      ),
    );
    const text = stripAnsi(sink.text);
    // Header should reference the displayName (or slug as fallback)
    expect(text).toMatch(/Dahlia Renner \(CTO\)|cto/);
  });

  it("streams turn.delta text in order without buffering", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "CTO", model: "x" }],
        },
        { kind: "turn.start", expertSlug: "cto", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "cto", text: "Hello " },
        { kind: "turn.delta", expertSlug: "cto", text: "world." },
        { kind: "turn.end", expertSlug: "cto", turnId: "01HZ", content: "Hello world." },
      ),
    );
    const text = stripAnsi(sink.text);
    // The deltas concatenate to "Hello world." in order
    const helloIdx = text.indexOf("Hello ");
    const worldIdx = text.indexOf("world.");
    expect(helloIdx).toBeGreaterThanOrEqual(0);
    expect(worldIdx).toBeGreaterThan(helloIdx);
  });

  it("writes error events to the error sink in red (color mode)", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: true });
    await renderer.render(
      events({
        kind: "error",
        expertSlug: "cto",
        message: "Quota exhausted",
        recoverable: true,
      }),
    );
    expect(sink.errText).toContain("Quota exhausted");
    // ANSI red has ESC (0x1b)
    expect(sink.errText.includes("\u001b")).toBe(true);
  });

  it("prints debate.end with the reason", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(events({ kind: "debate.end", reason: "completed" }));
    const text = stripAnsi(sink.text);
    expect(text.toLowerCase()).toMatch(/debate.*complete|complete.*debate/);
  });

  it("prints cost.update on its own line with the running count and estimated total", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(events({ kind: "cost.update", premiumRequests: 4, estimatedTotal: 16 }));
    const text = stripAnsi(sink.text);
    expect(text).toContain("[Premium requests: 4 (est. ~16)]");
    expect(text).not.toContain("4/16");
  });

  it("suppresses cost.update when cost display is disabled", async () => {
    const sink = new StringSink();
    const options = { color: false, showCost: false };
    const renderer = new PlainRenderer(sink, options);
    await renderer.render(events({ kind: "cost.update", premiumRequests: 4, estimatedTotal: 16 }));
    expect(stripAnsi(sink.text)).toBe("");
  });
});
