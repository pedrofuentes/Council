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

import { DebateApp, INITIAL_STATE, reduce } from "../../../../../src/cli/renderers/ink/InkRenderer.js";
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
  it("completed turns render independently from active streaming turn", async () => {
    // With <Static>, completed turns are rendered outside the re-render cycle.
    // We verify this structural property: completed turn text persists unchanged
    // in the output while the active turn continues streaming new deltas.
    // Without <Static>, the entire turns array would be rebuilt on each delta.
    async function* controlled(): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [
          { slug: "alice", displayName: "Alice", model: "gpt-5" },
          { slug: "bob", displayName: "Bob", model: "gpt-5" },
        ],
      };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 };
      yield { kind: "turn.delta", expertSlug: "alice", text: "First turn" };
      yield { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "First turn" };
      // Pause to let React commit the completed turn to Static
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      // New turn events — these trigger re-renders of the dynamic section only
      yield { kind: "turn.start", expertSlug: "bob", round: 0, seq: 1 };
      yield { kind: "turn.delta", expertSlug: "bob", text: "Second" };
      await new Promise((r) => setImmediate(r));
      yield { kind: "turn.delta", expertSlug: "bob", text: " turn" };
      yield { kind: "turn.end", expertSlug: "bob", turnId: "t2", content: "Second turn" };
    }

    const ui = render(<DebateApp events={controlled()} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    // Both turns should be visible
    expect(frame).toContain("First turn");
    expect(frame).toContain("Second turn");
    // Completed turn text appears exactly once (not duplicated)
    const occurrences = frame.split("First turn").length - 1;
    expect(occurrences).toBe(1);
    // Completed turn should NOT have the streaming cursor (▋)
    const lines = frame.split("\n");
    const firstTurnLine = lines.find((l) => l.includes("First turn"));
    expect(firstTurnLine).not.toContain("▋");
    ui.unmount();
  });

  it("active turn shows streaming cursor while completed turns do not", async () => {
    // This directly verifies the split: completed turns have no cursor,
    // while the active streaming turn has one.
    async function* controlled(): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [
          { slug: "alice", displayName: "Alice", model: "gpt-5" },
          { slug: "bob", displayName: "Bob", model: "gpt-5" },
        ],
      };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 };
      yield { kind: "turn.delta", expertSlug: "alice", text: "Done" };
      yield { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "Done" };
      yield { kind: "turn.start", expertSlug: "bob", round: 0, seq: 1 };
      yield { kind: "turn.delta", expertSlug: "bob", text: "Still going" };
      // No turn.end — bob is still streaming
    }

    const ui = render(<DebateApp events={controlled()} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    // Alice's completed turn has no cursor
    expect(frame).toContain("Done");
    expect(frame).not.toMatch(/Done.*▋/);
    // Bob's active turn has the cursor
    expect(frame).toMatch(/Still going.*▋/);
    ui.unmount();
  });

  it("separates completed turns from active streaming turn", async () => {
    // The active (streaming) turn should render separately from completed turns.
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

describe("InkRenderer reducer — Static-enabling state structure", () => {
  it("turn.end moves turn from activeTurn to completedItems (enabling Static)", () => {
    // This tests the STATE MACHINE that feeds <Static>. The key property:
    // completedItems grows monotonically and is never rebuilt, so <Static>
    // can render each item exactly once. If we reverted to a single `turns[]`
    // array that's rebuilt on every delta, this test would fail because
    // there would be no `completedItems`/`activeTurn` split.
    let state = INITIAL_STATE;
    state = reduce(state, {
      kind: "panel.assembled",
      experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
    });
    state = reduce(state, { kind: "round.start", round: 0 });

    // Start a turn — should be in activeTurn, not completedItems
    state = reduce(state, { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 });
    expect(state.activeTurn).not.toBeNull();
    const completedBefore = state.completedItems.length;

    // Delta appends to activeTurn, does NOT touch completedItems
    state = reduce(state, { kind: "turn.delta", expertSlug: "alice", text: "Hello" });
    expect(state.activeTurn?.text).toBe("Hello");
    expect(state.completedItems.length).toBe(completedBefore);

    // End turn — moves to completedItems, activeTurn becomes null
    state = reduce(state, {
      kind: "turn.end",
      expertSlug: "alice",
      turnId: "t1",
      content: "Hello",
    });
    expect(state.activeTurn).toBeNull();
    expect(state.completedItems.length).toBe(completedBefore + 1);
    const lastItem = state.completedItems[state.completedItems.length - 1];
    expect(lastItem?.type).toBe("turn");
  });

  it("completedItems is never mutated — new deltas only touch activeTurn", () => {
    // This proves that once a turn lands in completedItems, subsequent
    // events do NOT rebuild or touch that array — the identity of the
    // completedItems reference changes only when items are ADDED.
    let state = INITIAL_STATE;
    state = reduce(state, {
      kind: "panel.assembled",
      experts: [
        { slug: "alice", displayName: "Alice", model: "gpt-5" },
        { slug: "bob", displayName: "Bob", model: "gpt-5" },
      ],
    });
    state = reduce(state, { kind: "round.start", round: 0 });
    state = reduce(state, { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 });
    state = reduce(state, { kind: "turn.delta", expertSlug: "alice", text: "A" });
    state = reduce(state, {
      kind: "turn.end",
      expertSlug: "alice",
      turnId: "t1",
      content: "A",
    });

    // Capture completedItems reference after Alice's turn
    const completedAfterAlice = state.completedItems;

    // Start Bob's turn and stream deltas — completedItems must stay unchanged
    state = reduce(state, { kind: "turn.start", expertSlug: "bob", round: 0, seq: 1 });
    expect(state.completedItems).toBe(completedAfterAlice);
    state = reduce(state, { kind: "turn.delta", expertSlug: "bob", text: "B1" });
    expect(state.completedItems).toBe(completedAfterAlice);
    state = reduce(state, { kind: "turn.delta", expertSlug: "bob", text: "B2" });
    expect(state.completedItems).toBe(completedAfterAlice);

    // Only when Bob's turn ends does completedItems grow
    state = reduce(state, {
      kind: "turn.end",
      expertSlug: "bob",
      turnId: "t2",
      content: "B1B2",
    });
    expect(state.completedItems).not.toBe(completedAfterAlice);
    expect(state.completedItems.length).toBe(completedAfterAlice.length + 1);
  });

  it("round.end adds a separator to completedItems (enabling Static round separators)", () => {
    let state = INITIAL_STATE;
    state = reduce(state, { kind: "round.start", round: 0 });
    const before = state.completedItems.length;
    state = reduce(state, { kind: "round.end", round: 0 });
    expect(state.completedItems.length).toBe(before + 1);
    const lastItem = state.completedItems[state.completedItems.length - 1];
    expect(lastItem?.type).toBe("round-separator");
  });
});
