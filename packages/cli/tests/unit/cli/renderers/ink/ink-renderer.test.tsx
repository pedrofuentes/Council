/**
 * Tests for the Ink-based DebateApp + InkRenderer.
 *
 * Uses ink-testing-library to render the component into an in-memory
 * stdout buffer, then asserts on the latest frame.
 *
 * RED at this commit: src/cli/renderers/ink/InkRenderer.tsx does not exist.
 *
 * #714: Human participant color (HUMAN_COLOR / whiteBright / SGR 97) is
 * verified end-to-end through the Ink renderer's ExpertCard call site.
 * FORCE_COLOR=3 is set by tests/setup.ts so Ink emits SGR escapes even
 * though ink-testing-library's stdout reports as a non-TTY.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

import { DebateApp, InkRenderer } from "../../../../../src/cli/renderers/ink/InkRenderer.js";
import type { DebateEvent } from "../../../../../src/core/types.js";

async function* stream(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

/** A promise plus its resolver, for gating async progression under test control. */
function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Renders `<DebateApp>` and returns a `flush()` that resolves once the event
 * stream has fully drained — signaled by `onComplete`, the same completion
 * hook `InkRenderer.render()` resolves on (see InkRenderer.tsx's `finish()`
 * call in `#renderWithInk`) — instead of a fixed number of `setImmediate`
 * ticks (#233).
 *
 * A fixed tick count is timing-fragile: it assumes a constant number of
 * ticks is enough to drain the stream and commit the resulting render
 * regardless of how many events there are, which breaks down for streams
 * with more events (e.g. #255's 10-event, 2-round stream) or a loaded CI
 * runner. `onComplete` fires only after every event has been consumed, so
 * waiting on it scales with the actual stream instead of guessing a count.
 */
function renderApp(events: AsyncIterable<DebateEvent>): {
  readonly ui: ReturnType<typeof render>;
  readonly flush: () => Promise<void>;
} {
  const complete = deferred();
  const ui = render(<DebateApp events={events} onComplete={() => complete.resolve()} />);
  const flush = async (): Promise<void> => {
    await complete.promise;
    // onComplete fires synchronously inside the consuming effect's `finally`
    // block, one render commit ahead of Ink flushing it out to lastFrame().
    // A single settle tick lets that last commit land before assertions run.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ui, flush };
}

/** Extracts every numeric SGR parameter from the ANSI escape sequences in `s`. */
function sgrParams(s: string): readonly number[] {
  // eslint-disable-next-line no-control-regex
  return [...s.matchAll(/\u001b\[([0-9;]+)m/g)].flatMap(
    (m): readonly number[] => (m[1] ?? "").split(";").map(Number),
  );
}

/**
 * Returns the SGR parameters emitted immediately before `header` on the single
 * frame line that contains it.
 *
 * Ink renders the `<Static>` PanelRoster row and the ExpertCard turn header on
 * separate lines. The human roster row is colored with the same HUMAN_COLOR
 * (SGR 97) as the human turn header, so a byte window around the header can
 * pick up the roster's 97 and pass even when the ExpertCard call site applies
 * the wrong color. Isolating to the header's own line removes that leak so the
 * assertion actually discriminates the ExpertCard call site (#714).
 */
function turnHeaderColor(raw: string, header: string): readonly number[] {
  const line = raw.split("\n").find((l) => stripAnsi(l).includes(header));
  if (line === undefined) return [];
  return sgrParams(line.slice(0, line.indexOf(header)));
}

/**
 * Returns the SGR color parameters emitted immediately before every
 * line-level occurrence of `name`, in frame order.
 *
 * Unlike `turnHeaderColor` (which reports only the first match), this
 * reports every match — needed to compare a color across multiple
 * occurrences, e.g. the same expert's roster row and its turn header in
 * each round (#255). Isolating the scan to one line at a time (rather than
 * a single regex applied to the whole multi-line frame) also makes the
 * extraction deterministic: it cannot silently stop matching partway
 * through the frame just because an unrelated escape sequence appears
 * between two occurrences.
 */
function allColorsFor(raw: string, name: string): readonly (readonly number[])[] {
  return raw
    .split("\n")
    .filter((line) => stripAnsi(line).includes(name))
    .map((line) => sgrParams(line.slice(0, line.indexOf(name))));
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
    const { ui, flush } = renderApp(events);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("[1] Alice");
    expect(frame).toContain("[2] Bob");
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
    const { ui, flush } = renderApp(events);
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
    const { ui, flush } = renderApp(events);
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
    const { ui, flush } = renderApp(events);
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
    const { ui, flush } = renderApp(events);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toMatch(/retry|retrying/i);
    ui.unmount();
  });

  it("renders streaming cursor with cyan color (not dim)", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "Hello" },
      // turn.end NOT sent yet, so cursor should be visible
    );
    const { ui, flush } = renderApp(events);
    await flush();
    const rawFrame = ui.lastFrame() ?? "";
    
    // The cursor should be styled with cyan (ANSI code 36), not dim (ANSI code 2).
    // Ink uses ANSI escape codes: \u001b[36m = cyan foreground
    // eslint-disable-next-line no-control-regex
    expect(rawFrame).toMatch(/\u001b\[36m.*▋/);
    // Verify it's NOT using dim (SGR 2)
    // eslint-disable-next-line no-control-regex
    expect(rawFrame).not.toMatch(/\u001b\[2m.*▋/);
    ui.unmount();
  });

  it("shows the cost indicator", async () => {
    const events = stream({
      kind: "cost.update",
      premiumRequests: 3,
      estimatedTotal: 10,
    });
    const { ui, flush } = renderApp(events);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("3");
    expect(frame).toContain("10");
    ui.unmount();
  });

  it("shows a completion message on debate.end", async () => {
    const events = stream({ kind: "debate.end", reason: "completed" });
    const { ui, flush } = renderApp(events);
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
    const { ui, flush } = renderApp(events);
    await flush();
    const raw = ui.lastFrame() ?? "";
    // tests/setup.ts forces chalk to color-mode 3 so ink emits SGR escapes
    // even though ink-testing-library's stdout reports as a non-TTY.
    //
    // Every "Alice" occurrence (the <Static> roster row plus one ExpertCard
    // turn header per round) must share the identical SGR color — her color
    // is assigned once from her panel index and must never drift between
    // renders or rounds (#255). allColorsFor isolates each occurrence to its
    // own frame line instead of scanning the whole multi-line frame with one
    // regex, so the settled frame (guaranteed by renderApp's onComplete-based
    // flush, #233) is read deterministically rather than in-flight.
    const colors = allColorsFor(raw, "Alice");
    expect(colors.length).toBeGreaterThanOrEqual(2);
    // Guard against a vacuous pass: every occurrence must actually carry a
    // color, not just coincidentally-matching empty arrays.
    expect(colors.every((c) => c.length > 0)).toBe(true);
    const codes = colors.map((c) => c.join(","));
    // All Alice instances — roster row and both round headers — should share
    // the same color escape codes.
    expect(new Set(codes).size).toBe(1);
    ui.unmount();
  });
  it("renders expert index prefix [N] in turn headers", async () => {
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
      { kind: "turn.delta", expertSlug: "alice", text: "hi" },
      {
        kind: "turn.end",
        expertSlug: "alice",
        turnId: "t1",
        content: "hi",
      },
      { kind: "turn.start", expertSlug: "bob", round: 0, seq: 1 },
      { kind: "turn.delta", expertSlug: "bob", text: "hey" },
      {
        kind: "turn.end",
        expertSlug: "bob",
        turnId: "t2",
        content: "hey",
      },
    );
    const { ui, flush } = renderApp(events);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("[[1] Alice]");
    expect(frame).toContain("[[2] Bob]");
    ui.unmount();
  });

  it("renders [You] label for human participants with index prefix", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [
          { slug: "alice", displayName: "Alice", model: "gpt-5" },
          { slug: "user", displayName: "You", model: "", participantKind: "human" },
        ],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "user", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "user", text: "hi" },
      {
        kind: "turn.end",
        expertSlug: "user",
        turnId: "t1",
        content: "hi",
      },
    );
    const { ui, flush } = renderApp(events);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).toContain("[[You] [2] You]");
    ui.unmount();
  });

  it("applies HUMAN_COLOR (whiteBright, SGR 97) to human turn header at ExpertCard call site (#714)", async () => {
    // Verifies end-to-end: panel.assembled sets humanSlugs via
    // participantKind:"human", and the ExpertCard component renders the human
    // turn header with color="whiteBright" (SGR 97) — the reserved HUMAN_COLOR.
    // FORCE_COLOR=3 (set in tests/setup.ts) ensures Ink emits ANSI codes.
    //
    // The assertion is scoped to the ExpertCard turn-header line ("[[You] ...")
    // and NOT a byte window, which would span the <Static> PanelRoster row
    // whose human entry is ALSO SGR 97 and would mask a wrong ExpertCard color.
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [
          { slug: "alice", displayName: "Alice", model: "gpt-5" },
          { slug: "user", displayName: "You", model: "", participantKind: "human" },
        ],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "user", round: 0, seq: 0, speakerKind: "human" },
      { kind: "turn.delta", expertSlug: "user", text: "hi" },
      { kind: "turn.end", expertSlug: "user", turnId: "t1", content: "hi" },
    );
    const { ui, flush } = renderApp(events);
    await flush();
    const raw = ui.lastFrame() ?? "";
    // The ExpertCard emits the human header as "[[You] [2] You]" (double
    // bracket). The roster row is "[2] You" (no "[You]"), so "[[You]" is unique
    // to the ExpertCard turn header — it targets the call site under test.
    expect(stripAnsi(raw)).toContain("[[You]");
    const headerSgr = turnHeaderColor(raw, "[[You]");
    // SGR 97 = whiteBright = HUMAN_COLOR. A palette color here is a regression.
    expect(headerSgr).toContain(97);
    ui.unmount();
  });

  it("human turn header SGR differs from AI expert turn header SGR in Ink (#714)", async () => {
    // Discriminating: if the ExpertCard call site lost humanSlugs awareness,
    // the human header would take a palette color and this test would fail.
    // Each assertion is scoped to its own ExpertCard turn-header line, so the
    // <Static> roster (which also colors the human row SGR 97) cannot leak in,
    // and the AI check targets Alice's HEADER ("[[1] Alice]") rather than her
    // roster row ("[1] Alice").
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [
          { slug: "alice", displayName: "Alice", model: "gpt-5" },
          { slug: "user", displayName: "You", model: "", participantKind: "human" },
        ],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "hello" },
      { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hello" },
      { kind: "turn.start", expertSlug: "user", round: 0, seq: 1, speakerKind: "human" },
      { kind: "turn.delta", expertSlug: "user", text: "hi" },
      { kind: "turn.end", expertSlug: "user", turnId: "t2", content: "hi" },
    );
    const { ui, flush } = renderApp(events);
    await flush();
    const raw = ui.lastFrame() ?? "";

    // Target the ExpertCard turn HEADERS ("[[You] ...]" / "[[1] Alice]"), NOT
    // the <Static> roster rows ("[2] You" / "[1] Alice").
    expect(stripAnsi(raw)).toContain("[[You]");
    expect(stripAnsi(raw)).toContain("[[1] Alice]");

    const humanSgr = turnHeaderColor(raw, "[[You]");
    const aliceSgr = turnHeaderColor(raw, "[[1] Alice]");

    expect(humanSgr).toContain(97); // whiteBright for human
    expect(aliceSgr).not.toContain(97); // AI expert must NOT be whiteBright
    expect(aliceSgr).toContain(36); // Alice's palette color is cyan (SGR 36)
    ui.unmount();
  });
});

describe("InkRenderer ASCII mode (COUNCIL_ASCII=1) (#677)", () => {
  // ASCII_SYMBOLS/UNICODE_SYMBOLS selection (src/cli/renderers/symbols.ts) is
  // read fresh on every render via getSymbols(), so toggling the env var
  // around each test drives the component through the ASCII branch without
  // needing a dedicated prop.
  let originalAscii: string | undefined;

  beforeEach(() => {
    originalAscii = process.env["COUNCIL_ASCII"];
    process.env["COUNCIL_ASCII"] = "1";
  });

  afterEach(() => {
    if (originalAscii === undefined) delete process.env["COUNCIL_ASCII"];
    else process.env["COUNCIL_ASCII"] = originalAscii;
  });

  it("renders ASCII panel/round glyphs and suppresses the streaming cursor (no Unicode glyphs leak through)", async () => {
    const events = stream(
      {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      },
      { kind: "round.start", round: 0 },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
      { kind: "turn.delta", expertSlug: "alice", text: "Hello" },
      // turn.end intentionally omitted — keeps the turn "active" so the
      // streaming-cursor branch (suppressed outright in ASCII mode for
      // screen readers, per shouldSuppressCursor()) is exercised too.
    );
    const { ui, flush } = renderApp(events);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");

    // ASCII_SYMBOLS panel/round glyphs replace their Unicode counterparts.
    expect(frame).toContain("[Panel] Panel assembled");
    expect(frame).toContain("--- Round 1 ---");

    // The corresponding Unicode glyphs must be entirely absent.
    expect(frame).not.toContain("🏛️");
    expect(frame).not.toContain("━");

    // ASCII mode suppresses the cursor outright rather than swapping in an
    // ASCII substitute — the Unicode cursor glyph must not appear.
    expect(frame).not.toContain("▋");
    ui.unmount();
  });

  it("renders the ASCII completion glyph (not the Unicode checkmark) on debate.end", async () => {
    const events = stream({ kind: "debate.end", reason: "completed" });
    const { ui, flush } = renderApp(events);
    await flush();
    const frame = stripAnsi(ui.lastFrame() ?? "");

    expect(frame).toContain("[DONE] Debate complete (completed)");
    expect(frame).not.toContain("✓");
    ui.unmount();
  });
});

describe("InkRenderer", () => {
  it("implements the Renderer interface", () => {
    const r = new InkRenderer();
    expect(typeof r.render).toBe("function");
  });

  it("render() stays pending until the stream ends, then resolves (#234)", async () => {
    // A deferred generator lets the test control exactly when the stream
    // ends. The prior version of this test only awaited r.render(events)
    // and asserted it didn't throw, which only proves non-throwing, not the
    // lifecycle: a regression that resolved render() early (e.g. right
    // after the first event, without draining the rest of the stream)
    // would still pass. Gating the second event on `gate.promise` proves
    // render() cannot resolve before the WHOLE stream is consumed.
    //
    // Holding the stream open gives Ink a real window to commit a frame to
    // process.stdout (unlike the immediate-resolution streams elsewhere in
    // this file, which unmount before any commit is flushed) — mirrors the
    // process.stdout isolation already used in select.test.ts (#235) so the
    // test doesn't print to the real terminal.
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const gate = deferred();
      async function* events(): AsyncGenerator<DebateEvent> {
        yield {
          kind: "panel.assembled",
          experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
        };
        await gate.promise;
        yield { kind: "debate.end", reason: "completed" };
      }

      const r = new InkRenderer({ stdout: process.stdout, isTTY: false });
      let resolved = false;
      const done = r.render(events()).then(() => {
        resolved = true;
      });

      // The generator is blocked on gate.promise, so a correct render() can
      // NEVER resolve here, no matter how long we wait — only a regression
      // that resolves early would flip `resolved` to true. Waiting longer
      // only strengthens this check; it cannot introduce flakiness.
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(resolved).toBe(false);

      gate.resolve();
      await done;
      expect(resolved).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("render() rejects when the event stream throws", async () => {
    async function* failing(): AsyncGenerator<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      };
      throw new Error("engine blew up");
    }
    const r = new InkRenderer({ stdout: process.stdout, isTTY: false });
    await expect(r.render(failing())).rejects.toThrow("engine blew up");
  });
});
