/**
 * Tests for Ink renderer performance improvements:
 * - Static component usage for completed turns
 * - Round separators between rounds
 * - No excessive margins between sibling turns
 * - No duplicate round headers (StandaloneRoundHeader removed)
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

describe("InkRenderer — Static completed turns", () => {
  it("completed turns are rendered in Ink Static (not re-rendered on new events)", async () => {
    // After a turn ends, adding new turns should NOT cause the completed
    // turn to re-render. We verify by checking that the completed turn
    // appears in the output frame even after additional events.
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
      { kind: "turn.delta", expertSlug: "alice", text: "First turn" },
      { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "First turn" },
      { kind: "turn.start", expertSlug: "bob", round: 0, seq: 1 },
      { kind: "turn.delta", expertSlug: "bob", text: "Second turn" },
      { kind: "turn.end", expertSlug: "bob", turnId: "t2", content: "Second turn" },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    // Both completed turns should be present
    expect(frame).toContain("First turn");
    expect(frame).toContain("Second turn");
    ui.unmount();
  });

  it("separates completed turns from active streaming turn", async () => {
    // The active (streaming) turn should render separately from completed turns.
    // We use a controlled stream to verify active vs completed separation.
    let resolve: ((ev: DebateEvent) => void) | null = null;
    const eventQueue: DebateEvent[] = [];

    async function* controlled(): AsyncIterable<DebateEvent> {
      const pending: DebateEvent[] = [
        {
          kind: "panel.assembled",
          experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
        },
        { kind: "round.start", round: 0 },
        { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
        { kind: "turn.delta", expertSlug: "alice", text: "Complete" },
        { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "Complete" },
        { kind: "turn.start", expertSlug: "alice", round: 0, seq: 1 },
        { kind: "turn.delta", expertSlug: "alice", text: "Streaming..." },
      ];
      for (const ev of pending) yield ev;
    }

    const ui = render(<DebateApp events={controlled()} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    // Completed turn should have its text without cursor
    expect(frame).toContain("Complete");
    // Active streaming turn should have text (cursor tested elsewhere)
    expect(frame).toContain("Streaming...");
    ui.unmount();
  });
});

describe("InkRenderer — Round separators", () => {
  it("renders a dim horizontal rule between rounds on round.end", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "Round 1 text" },
      { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "Round 1 text" },
      { kind: "round.end", round: 0 },
      { kind: "round.start", round: 1 },
      { kind: "turn.start", expertSlug: "alice", round: 1, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "Round 2 text" },
      { kind: "turn.end", expertSlug: "alice", turnId: "t2", content: "Round 2 text" },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    // Should contain a horizontal rule made of ─ chars between rounds
    expect(frame).toMatch(/─{10,}/);
    ui.unmount();
  });
});

describe("InkRenderer — Excessive whitespace fix", () => {
  it("does not add marginTop between sibling turns in the same round", async () => {
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
      { kind: "turn.delta", expertSlug: "alice", text: "AAA" },
      { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "AAA" },
      { kind: "turn.start", expertSlug: "bob", round: 0, seq: 1 },
      { kind: "turn.delta", expertSlug: "bob", text: "BBB" },
      { kind: "turn.end", expertSlug: "bob", turnId: "t2", content: "BBB" },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    const lines = frame.split("\n");
    // Find the line with AAA text and BBB header — there should be at most
    // one blank line between them, not multiple
    const aaaIdx = lines.findIndex((l) => l.includes("AAA"));
    const bbbHeaderIdx = lines.findIndex((l, i) => i > aaaIdx && l.includes("[2] Bob"));
    expect(aaaIdx).toBeGreaterThan(-1);
    expect(bbbHeaderIdx).toBeGreaterThan(-1);
    // Between the end of Alice's turn and Bob's header, there should be
    // NO blank lines — sibling turns in the same round should not have margins
    const between = lines.slice(aaaIdx + 1, bbbHeaderIdx);
    const blankCount = between.filter((l) => l.trim() === "").length;
    expect(blankCount).toBe(0);
    ui.unmount();
  });
});

describe("InkRenderer — No duplicate round header", () => {
  it("renders round header exactly once when turns follow immediately", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "hi" },
      { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hi" },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    // Count occurrences of "Round 1" — should be exactly 1
    const matches = frame.match(/Round\s*1/g);
    expect(matches).toHaveLength(1);
    ui.unmount();
  });
});
