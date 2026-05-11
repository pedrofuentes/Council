/**
 * Tests for the Ink-based DebateApp + InkRenderer.
 *
 * Uses ink-testing-library to render the component into an in-memory
 * stdout buffer, then asserts on the latest frame.
 *
 * RED at this commit: src/cli/renderers/ink/InkRenderer.tsx does not exist.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  DebateApp,
  InkRenderer,
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
  // Allow the React effect that consumes the iterable to drain.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("DebateApp", () => {
  it("renders panel roster on panel.assembled", async () => {
    const events = stream({
      kind: "panel.assembled",
      experts: [
        { slug: "alice", displayName: "Alice", model: "gpt-5" },
        { slug: "bob", displayName: "Bob", model: "gpt-5" },
      ],
    });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("Alice");
    expect(frame).toContain("Bob");
    ui.unmount();
  });

  it("shows the round header", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toMatch(/Round\s*1/);
    ui.unmount();
  });

  it("streams turn deltas into a single text block", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "Hello " },
      { kind: "turn.delta", expertSlug: "alice", text: "world" },
      {
        kind: "turn.end",
        expertSlug: "alice",
        turnId: "t1",
        content: "Hello world",
      },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("Hello world");
    ui.unmount();
  });

  it("renders error events", async () => {
    const events = stream({
      kind: "error",
      expertSlug: "alice",
      message: "boom",
      recoverable: false,
    });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("boom");
    ui.unmount();
  });

  it("shows a retry indicator on turn.retry", async () => {
    const events = stream({
      kind: "turn.retry",
      expertSlug: "alice",
      attempt: 1,
      reason: "RATE_LIMITED",
    });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toMatch(/retry|retrying/i);
    ui.unmount();
  });

  it("shows the cost indicator", async () => {
    const events = stream({
      kind: "cost.update",
      premiumRequests: 3,
      estimatedTotal: 10,
    });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("3");
    expect(frame).toContain("10");
    ui.unmount();
  });

  it("shows a completion message on debate.end", async () => {
    const events = stream({ kind: "debate.end", reason: "completed" });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toMatch(/complete|completed/i);
    ui.unmount();
  });

  it("assigns a stable color to the same expert across rounds", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [
          { slug: "alice", displayName: "Alice", model: "gpt-5" },
          { slug: "bob", displayName: "Bob", model: "gpt-5" },
        ],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "r1" },
      {
        kind: "turn.end",
        expertSlug: "alice",
        turnId: "t1",
        content: "r1",
      },
      { kind: "round.end", round: 0 },
      { kind: "round.start", round: 1 },
      { kind: "turn.start", expertSlug: "alice", round: 1, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "r2" },
      {
        kind: "turn.end",
        expertSlug: "alice",
        turnId: "t2",
        content: "r2",
      },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const raw = ui.lastFrame() ?? "";
    // Find ANSI-coded "Alice" occurrences and verify they share the same prefix.
    const matches = [...raw.matchAll(/\u001b\[(\d+)m[^\u001b]*Alice/g)];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const codes = matches.map((m) => m[1]);
    // All Alice instances should share the same color escape code.
    expect(new Set(codes).size).toBe(1);
    ui.unmount();
  });
});

describe("InkRenderer", () => {
  it("implements the Renderer interface", () => {
    const r = new InkRenderer();
    expect(typeof r.render).toBe("function");
  });

  it("render() resolves after the event stream completes", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "debate.end", reason: "completed" },
    );
    const r = new InkRenderer({ stdout: process.stdout, isTTY: false });
    // Should resolve cleanly without throwing.
    await r.render(events);
  });
});
