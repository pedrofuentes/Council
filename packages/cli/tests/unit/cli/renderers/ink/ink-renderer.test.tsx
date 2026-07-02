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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function flush(): Promise<void> {
  // Allow the React effect that consumes the iterable to drain.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
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
    const ui = render(<DebateApp events={events} />);
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
    // Find ANSI-coded "Alice" occurrences and verify they share the same color.
    // tests/setup.ts forces chalk to color-mode 3 so ink emits SGR escapes
    // even though ink-testing-library's stdout reports as a non-TTY.
    // eslint-disable-next-line no-control-regex
    const matches = [...raw.matchAll(/\u001b\[(\d+)m[^\u001b]*Alice/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const codes = matches.map((m) => m[1]);
    // All Alice instances should share the same color escape code.
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
    const ui = render(<DebateApp events={events} />);
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
    const ui = render(<DebateApp events={events} />);
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
    const ui = render(<DebateApp events={events} />);
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
    const ui = render(<DebateApp events={events} />);
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
    const ui = render(<DebateApp events={events} />);
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
    const ui = render(<DebateApp events={events} />);
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
