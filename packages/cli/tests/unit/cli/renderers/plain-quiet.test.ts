/**
 * Tests for PlainRenderer quiet mode.
 *
 * Quiet mode should suppress informational output like cost counters
 * while preserving essential content (expert responses).
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

describe("PlainRenderer quiet mode", () => {
  it("displays cost updates when quiet is false", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false, quiet: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "expert", displayName: "Expert", model: "claude-sonnet-4" }],
        },
        { kind: "cost.update", premiumRequests: 5, estimatedTotal: 10 },
      ),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("[Premium requests: 5 (est. ~10)]");
  });

  it("suppresses cost updates when quiet is true", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false, quiet: true });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "expert", displayName: "Expert", model: "claude-sonnet-4" }],
        },
        { kind: "cost.update", premiumRequests: 5, estimatedTotal: 10 },
      ),
    );
    const text = stripAnsi(sink.text);
    expect(text).not.toContain("[Cost:");
    expect(text).not.toContain("premium requests");
  });

  it("still displays expert responses when quiet is true", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false, quiet: true });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "expert", displayName: "Expert", model: "claude-sonnet-4" }],
        },
        { kind: "turn.start", expertSlug: "expert", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "expert", text: "Important response." },
        { kind: "turn.end", expertSlug: "expert", turnId: "01HZ", content: "Important response." },
        { kind: "cost.update", premiumRequests: 5, estimatedTotal: 10 },
      ),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("Important response.");
    expect(text).not.toContain("[Cost:");
  });
});
