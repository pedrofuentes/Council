/**
 * Tests for PlainRenderer handling of the `turn.quality_gate` event.
 *
 * The renderer must surface a concise, SANITIZED one-line notice (it must
 * never print response content) and must collapse any control characters so
 * untrusted, model-derived expert display names cannot break out of the line.
 *
 * RED at this commit: PlainRenderer does not handle `turn.quality_gate`.
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

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("PlainRenderer quality-gate handling", () => {
  it("renders a concise one-line notice for a warned response", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        { kind: "panel.assembled", experts: [{ slug: "cto", displayName: "CTO", model: "m" }] },
        {
          kind: "turn.quality_gate",
          expertSlug: "cto",
          round: 0,
          mode: "warn",
          action: "warned",
          failures: ["forbidden_phrase", "no_disagreement_signal"],
          priorSpeakers: ["cfo"],
        },
      ),
    );
    const text = stripAnsi(sink.text);
    expect(text.toLowerCase()).toContain("quality gate");
    expect(text).toContain("CTO");
    expect(text).toContain("forbidden_phrase");
  });

  it("sanitizes control characters in the expert display name (single line)", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "cto", displayName: "CTO\r\n[fake] OK", model: "m" }],
        },
        {
          kind: "turn.quality_gate",
          expertSlug: "cto",
          round: 0,
          mode: "warn",
          action: "warned",
          failures: ["too_short"],
          priorSpeakers: [],
        },
      ),
    );
    const text = stripAnsi(sink.text);
    // The notice itself must be a single line — no CR/LF injected mid-notice.
    const noticeLine = text.split("\n").find((l) => l.toLowerCase().includes("quality gate")) ?? "";
    expect(noticeLine).toContain("[fake] OK");
    expect(noticeLine).not.toContain("\r");
  });

  it("describes the regeneration attempt for a regenerating action", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({
        kind: "turn.quality_gate",
        expertSlug: "cto",
        round: 0,
        mode: "regenerate",
        action: "regenerating",
        failures: ["forbidden_phrase"],
        regenerationAttempt: 1,
        maxRegenerations: 2,
        priorSpeakers: [],
      }),
    );
    const text = stripAnsi(sink.text);
    expect(text.toLowerCase()).toContain("regenerat");
    expect(text).toContain("1");
    expect(text).toContain("2");
  });
});
