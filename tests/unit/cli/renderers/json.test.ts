/**
 * Tests for the JSON renderer.
 *
 * NDJSON output: one JSON object per line, one per DebateEvent. Designed
 * for CI / scripts / pipelines that parse the stream programmatically.
 *
 * RED at this commit: src/cli/renderers/json.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import type { DebateEvent } from "../../../../src/core/types.js";
import { JsonRenderer } from "../../../../src/cli/renderers/json.js";

class StringSink {
  text = "";
  write(s: string): void {
    this.text += s;
  }
}

async function* events(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

describe("JsonRenderer", () => {
  it("writes one NDJSON line per event terminated by a newline", async () => {
    const sink = new StringSink();
    const renderer = new JsonRenderer(sink);
    await renderer.render(
      events(
        { kind: "panel.assembled", experts: [{ slug: "cto", displayName: "CTO", model: "x" }] },
        { kind: "round.start", round: 0 },
        { kind: "debate.end", reason: "completed" },
      ),
    );
    const lines = sink.text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("preserves field values exactly through JSON round-trip", async () => {
    const sink = new StringSink();
    const renderer = new JsonRenderer(sink);
    await renderer.render(
      events(
        { kind: "turn.delta", expertSlug: "cto", text: "Hello world." },
      ),
    );
    const parsed = JSON.parse(sink.text.trim());
    expect(parsed).toEqual({ kind: "turn.delta", expertSlug: "cto", text: "Hello world." });
  });

  it("emits no formatting/colors", async () => {
    const sink = new StringSink();
    const renderer = new JsonRenderer(sink);
    await renderer.render(
      events({ kind: "round.start", round: 0 }),
    );
    // ANSI escape sequences would start with \u001b
    expect(sink.text).not.toMatch(/\u001b/);
  });
});
