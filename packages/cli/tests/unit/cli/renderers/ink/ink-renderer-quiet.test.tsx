/**
 * Tests for InkRenderer / DebateApp quiet mode and CostIndicator color branches.
 *
 * Mirrors PlainRenderer quiet behavior (tests/unit/cli/renderers/plain-quiet.test.ts):
 * when quiet=true, the CostIndicator must NOT render — cost counters
 * are informational and noisy on the interactive TTY path.
 *
 * Also covers #713: CostIndicator must render yellow (warning) vs dim (normal)
 * depending on whether the cost ratio exceeds COST_WARNING_THRESHOLD.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  DebateApp,
  COST_WARNING_THRESHOLD,
} from "../../../../../src/cli/renderers/ink/InkRenderer.js";
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
    expect(frame).toContain("[Premium requests: 3 (est. ~10)]");
    expect(frame).not.toContain("3/10");
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

describe("CostIndicator color branches (#713)", () => {
  it("renders in yellow (warning) when cost ratio exceeds the warning threshold", async () => {
    // ratio = 9 / 10 = 0.9 > COST_WARNING_THRESHOLD (0.8) → isCostWarning true → color="yellow"
    expect(9 / 10).toBeGreaterThan(COST_WARNING_THRESHOLD);
    const events = stream({ kind: "cost.update", premiumRequests: 9, estimatedTotal: 10 });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const rawFrame = ui.lastFrame() ?? "";

    expect(stripAnsi(rawFrame)).toContain("[Premium requests: 9 (est. ~10)]");
    // Yellow ANSI code (ESC[33m) must be present — CostIndicator is the only coloured element here
    // eslint-disable-next-line no-control-regex
    expect(rawFrame).toMatch(/\u001b\[33m/);
    // Dim ANSI code (ESC[2m) must be absent — guards against branch-swap regressions
    // eslint-disable-next-line no-control-regex
    expect(rawFrame).not.toMatch(/\u001b\[2m/);
    ui.unmount();
  });

  it("renders in dim (normal) when cost ratio is below the warning threshold", async () => {
    // ratio = 3 / 10 = 0.3 ≤ COST_WARNING_THRESHOLD (0.8) → isCostWarning false → dimColor
    expect(3 / 10).toBeLessThanOrEqual(COST_WARNING_THRESHOLD);
    const events = stream({ kind: "cost.update", premiumRequests: 3, estimatedTotal: 10 });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const rawFrame = ui.lastFrame() ?? "";

    expect(stripAnsi(rawFrame)).toContain("[Premium requests: 3 (est. ~10)]");
    // Dim ANSI code (ESC[2m) must be present
    // eslint-disable-next-line no-control-regex
    expect(rawFrame).toMatch(/\u001b\[2m/);
    // Yellow ANSI code (ESC[33m) must be absent — guards against branch-swap regressions
    // eslint-disable-next-line no-control-regex
    expect(rawFrame).not.toMatch(/\u001b\[33m/);
    ui.unmount();
  });
});
