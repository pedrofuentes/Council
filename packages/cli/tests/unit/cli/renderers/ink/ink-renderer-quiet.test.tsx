/**
 * Tests for InkRenderer / DebateApp quiet mode.
 *
 * Mirrors PlainRenderer quiet behavior (tests/unit/cli/renderers/plain-quiet.test.ts):
 * when quiet=true, the CostIndicator must NOT render — cost counters
 * are informational and noisy on the interactive TTY path.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { DebateApp } from "../../../../../src/cli/renderers/ink/InkRenderer.js";
import type { DebateEvent } from "../../../../../src/core/types.js";

async function* stream(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("DebateApp quiet mode", () => {
  it("shows the cost indicator when quiet is false (default)", async () => {
    const events = stream({
      kind: "cost.update",
      premiumRequests: 3,
      estimatedTotal: 10,
    });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("Cost:");
    expect(frame).toContain("3");
    expect(frame).toContain("10");
    ui.unmount();
  });

  it("suppresses the cost indicator when quiet is true", async () => {
    const events = stream({
      kind: "cost.update",
      premiumRequests: 3,
      estimatedTotal: 10,
    });
    const ui = render(<DebateApp events={events} quiet={true} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).not.toContain("Cost:");
    expect(frame).not.toContain("premium requests");
    ui.unmount();
  });

  it("still renders expert turns when quiet is true", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "Important." },
      {
        kind: "turn.end",
        expertSlug: "alice",
        turnId: "t1",
        content: "Important.",
      },
      { kind: "cost.update", premiumRequests: 3, estimatedTotal: 10 },
    );
    const ui = render(<DebateApp events={events} quiet={true} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("Important.");
    expect(frame).not.toContain("Cost:");
    ui.unmount();
  });
});
