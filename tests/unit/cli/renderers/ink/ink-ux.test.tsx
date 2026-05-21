/**
 * Tests for the 7 Ink UX improvements (T-09).
 *
 * Covers: Ctrl+C handler, error cap, loading indicator, exhaustive default,
 * retry/cursor conflict, cancel banner, completion styling.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  DebateApp,
  reduce,
  INITIAL_STATE,
  type DebateState,
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

describe("TUI-03: Ctrl+C handler", () => {
  it("calls onComplete when Ctrl+C is pressed", async () => {
    // Create a never-ending stream so the debate stays active
    const neverEnd = async function* (): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      };
      // Hold open indefinitely
      await new Promise((_resolve) => { /* hold open */ });
    };

    let completed = false;
    const ui = render(
      <DebateApp events={neverEnd()} onComplete={() => { completed = true; }} />,
    );
    await flush();

    // Simulate Ctrl+C via ink-testing-library stdin
    ui.stdin.write("\x03");
    await flush();

    expect(completed).toBe(true);
    ui.unmount();
  });

  it("propagates cancellation to the upstream async iterator", async () => {
    let iteratorReturned = false;
    const cancellable = {
      [Symbol.asyncIterator](): AsyncIterator<DebateEvent> {
        const events: DebateEvent[] = [
          {
            kind: "panel.assembled",
            experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
          },
        ];
        let index = 0;
        return {
          async next() {
            if (index < events.length) {
              return { value: events[index++], done: false };
            }
            // Hold open indefinitely
            return new Promise((_resolve) => { /* hold open */ });
          },
          async return() {
            iteratorReturned = true;
            return { value: undefined, done: true };
          },
        };
      },
    };

    const ui = render(
      <DebateApp events={cancellable} onComplete={() => { /* noop */ }} />,
    );
    await flush();

    ui.stdin.write("\x03");
    await flush();

    expect(iteratorReturned).toBe(true);
    ui.unmount();
  });
});

describe("TUI-04: Cap displayed errors", () => {
  it("caps displayed errors to last 3 with hidden counter", async () => {
    const events = stream(
      { kind: "error", expertSlug: "alice", message: "err1", recoverable: true },
      { kind: "error", expertSlug: "alice", message: "err2", recoverable: true },
      { kind: "error", expertSlug: "alice", message: "err3", recoverable: true },
      { kind: "error", expertSlug: "alice", message: "err4", recoverable: true },
      { kind: "error", expertSlug: "alice", message: "err5", recoverable: true },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");

    // Should show last 3 errors
    expect(frame).toContain("err3");
    expect(frame).toContain("err4");
    expect(frame).toContain("err5");
    // Should NOT show the first 2
    expect(frame).not.toContain("err1");
    expect(frame).not.toContain("err2");
    // Should show hidden counter
    expect(frame).toContain("2 previous hidden");
    ui.unmount();
  });

  it("auto-dismisses recoverable errors after turn.end", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
      { kind: "error", expertSlug: "alice", message: "transient", recoverable: true },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "hello" },
      { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hello" },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");

    // Recoverable error should be dismissed after successful turn.end
    expect(frame).not.toContain("transient");
    ui.unmount();
  });
});

describe("TUI-05: Loading indicator", () => {
  it("shows spinner when round started but no turns yet", async () => {
    const neverEnd = async function* (): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      };
      yield { kind: "round.start", round: 0 };
      await new Promise((_resolve) => { /* hold open */ });
    };
    const ui = render(<DebateApp events={neverEnd()} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");

    expect(frame).toMatch(/waiting for responses/i);
    ui.unmount();
  });

  it("hides loading indicator once turn starts", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "hi" },
    );
    const ui = render(<DebateApp events={events} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");

    expect(frame).not.toMatch(/waiting for responses/i);
    ui.unmount();
  });

  it("hides loading indicator after turn.end in same round", async () => {
    const neverEnd = async function* (): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 };
      yield { kind: "turn.delta", expertSlug: "alice", text: "done" };
      yield { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "done" };
      // Stream stays open — no more turns, but turn.end happened
      await new Promise((_resolve) => { /* hold open */ });
    };
    const ui = render(<DebateApp events={neverEnd()} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");

    // Should not show loading since a turn already completed in this round
    expect(frame).not.toMatch(/waiting for responses/i);
    ui.unmount();
  });
});

describe("TUI-14: Exhaustive default in reduce()", () => {
  it("returns state unchanged for unknown event kinds (type-level exhaustive check)", () => {
    const state = { ...INITIAL_STATE };
    // Force an unknown kind at runtime to test the default branch
    const unknownEvent = { kind: "future.event" } as unknown as DebateEvent;
    const result = reduce(state, unknownEvent);
    expect(result).toBe(state);
  });
});

describe("TUI-15: Retry/cursor conflict", () => {
  it("suppresses streaming cursor when retrying", async () => {
    const neverEnd = async function* (): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 };
      yield { kind: "turn.delta", expertSlug: "alice", text: "partial" };
      yield { kind: "turn.retry", expertSlug: "alice", attempt: 1, reason: "RATE_LIMITED" };
      await new Promise((_resolve) => { /* hold open */ });
    };
    const ui = render(<DebateApp events={neverEnd()} />);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");

    // Cursor should NOT appear during retry
    expect(frame).not.toContain("▋");
    ui.unmount();
  });

  it("clears active turn text on turn.retry via reduce()", () => {
    let state: DebateState = reduce(INITIAL_STATE, {
      kind: "panel.assembled",
      experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
    });
    state = reduce(state, { kind: "round.start", round: 0 });
    state = reduce(state, { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 });
    state = reduce(state, { kind: "turn.delta", expertSlug: "alice", text: "partial text" });
    state = reduce(state, {
      kind: "turn.retry",
      expertSlug: "alice",
      attempt: 1,
      reason: "RATE_LIMITED",
    });

    // Active turn text should be cleared so retry doesn't concatenate
    expect(state.activeTurn?.text ?? "").toBe("");
  });
});

describe("TUI-20: Cancel banner", () => {
  it("shows cancelled message in completion banner on Ctrl+C", async () => {
    const neverEnd = async function* (): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      };
      await new Promise((_resolve) => { /* hold open */ });
    };

    const ui = render(<DebateApp events={neverEnd()} onComplete={() => { /* noop */ }} />);
    await flush();

    // Simulate Ctrl+C
    ui.stdin.write("\x03");
    await flush();

    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toMatch(/cancelled/i);
    ui.unmount();
  });
});

describe("TUI-22: Completion message styling", () => {
  it("uses green color and checkmark symbol for completion", async () => {
    const events = stream({ kind: "debate.end", reason: "completed" });
    const ui = render(<DebateApp events={events} />);
    await flush();
    const rawFrame = ui.lastFrame() ?? "";

    // Should contain green ANSI color (code 32)
    // eslint-disable-next-line no-control-regex
    expect(rawFrame).toMatch(/\u001b\[32m/);
    // Should contain the checkmark symbol and text
    const frame = stripAnsi(rawFrame);
    const sym = (await import("../../../../../src/cli/renderers/symbols.js")).getSymbols();
    expect(frame).toContain(sym.complete);
    expect(frame).toContain("Debate complete");
    ui.unmount();
  });
});
