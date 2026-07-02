/**
 * Tests for PlainRenderer per-expert colors and index prefix (T-04).
 *
 * Validates:
 * - TUI-12: Per-expert colors (different experts get different ANSI codes)
 * - A11Y-01: Expert index prefix "[N] Name" in turn headers
 * - #714: Human participant color (HUMAN_COLOR / whiteBright / SGR 97) at the
 *   turn.start call site — end-to-end through the Plain renderer.
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

describe("PlainRenderer per-expert colors (TUI-12)", () => {
  it("assigns different ANSI colors to different experts", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: true });
    await renderer.render(
      events(
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
        { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hi" },
        { kind: "turn.start", expertSlug: "bob", round: 0, seq: 1 },
        { kind: "turn.delta", expertSlug: "bob", text: "hey" },
        { kind: "turn.end", expertSlug: "bob", turnId: "t2", content: "hey" },
      ),
    );
    // With color on, the turn headers for different experts should have different ANSI codes
    // eslint-disable-next-line no-control-regex
    const ANSI_RE = /\u001b\[[0-9;]*m/g;
    const lines = sink.text.split("\n");
    // Turn headers are wrapped in brackets like [[1] Alice]
    const aliceLine = lines.find((l) => stripAnsi(l).includes("[[1] Alice]"));
    const bobLine = lines.find((l) => stripAnsi(l).includes("[[2] Bob]"));
    expect(aliceLine).toBeDefined();
    expect(bobLine).toBeDefined();
    const aliceCodes = (aliceLine ?? "").match(ANSI_RE) ?? [];
    const bobCodes = (bobLine ?? "").match(ANSI_RE) ?? [];
    // First ANSI code (color open) should differ between experts
    expect(aliceCodes[0]).not.toBe(bobCodes[0]);
  });

  it("uses the same color for the same expert across rounds", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: true });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
        },
        { kind: "round.start", round: 0 },
        { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
        { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hi" },
        { kind: "round.end", round: 0 },
        { kind: "round.start", round: 1 },
        { kind: "turn.start", expertSlug: "alice", round: 1, seq: 0 },
        { kind: "turn.end", expertSlug: "alice", turnId: "t2", content: "bye" },
      ),
    );
    // eslint-disable-next-line no-control-regex
    const ANSI_RE = /\u001b\[[0-9;]*m/g;
    const lines = sink.text.split("\n");
    // Turn headers are wrapped in brackets like [[1] Alice]
    const aliceLines = lines.filter((l) => stripAnsi(l).includes("[[1] Alice]"));
    expect(aliceLines.length).toBeGreaterThanOrEqual(2);
    const codes1 = (aliceLines[0] ?? "").match(ANSI_RE) ?? [];
    const codes2 = (aliceLines[1] ?? "").match(ANSI_RE) ?? [];
    expect(codes1[0]).toBe(codes2[0]);
  });
});

describe("PlainRenderer expert index prefix (A11Y-01)", () => {
  it("prefixes expert names with 1-based index in turn headers", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [
            { slug: "alice", displayName: "Alice", model: "gpt-5" },
            { slug: "bob", displayName: "Bob", model: "gpt-5" },
          ],
        },
        { kind: "round.start", round: 0 },
        { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
        { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hi" },
        { kind: "turn.start", expertSlug: "bob", round: 0, seq: 1 },
        { kind: "turn.end", expertSlug: "bob", turnId: "t2", content: "hey" },
      ),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("[1] Alice");
    expect(text).toContain("[2] Bob");
  });

  it("prefixes expert names in panel.assembled list too", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events({
        kind: "panel.assembled",
        experts: [
          { slug: "alice", displayName: "Alice", model: "gpt-5" },
          { slug: "bob", displayName: "Bob", model: "gpt-5" },
        ],
      }),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("[1] Alice");
    expect(text).toContain("[2] Bob");
  });

  it("human expert still shows [You] with index prefix", async () => {
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [
            { slug: "alice", displayName: "Alice", model: "gpt-5" },
            { slug: "user", displayName: "You", model: "", participantKind: "human" },
          ],
        },
        { kind: "turn.start", expertSlug: "user", round: 0, seq: 0, speakerKind: "human" },
        { kind: "turn.end", expertSlug: "user", turnId: "t1", content: "hi" },
      ),
    );
    const text = stripAnsi(sink.text);
    expect(text).toContain("[You] [2] You");
  });
});

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

describe("PlainRenderer human participant color (#714)", () => {
  it("applies HUMAN_COLOR (whiteBright, SGR 97) to human turn header at turn.start call site", async () => {
    // Verifies end-to-end: panel.assembled populates humanSlugs via
    // participantKind:"human", and turn.start renders that slug with SGR 97
    // (whiteBright) — the reserved HUMAN_COLOR — not a palette color.
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: true });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [
            { slug: "alice", displayName: "Alice", model: "gpt-5" },
            { slug: "user", displayName: "You", model: "", participantKind: "human" },
          ],
        },
        { kind: "round.start", round: 0 },
        { kind: "turn.start", expertSlug: "user", round: 0, seq: 0, speakerKind: "human" },
        { kind: "turn.end", expertSlug: "user", turnId: "t1", content: "hi" },
      ),
    );
    const lines = sink.text.split("\n");
    const humanLine = lines.find((l) => stripAnsi(l).includes("[You]"));
    expect(humanLine).toBeDefined();
    const codes = (humanLine ?? "").match(ANSI_RE) ?? [];
    // SGR 97 = whiteBright = HUMAN_COLOR. A palette color here is a regression.
    expect(codes[0]).toBe("\u001b[97m");
  });

  it("human turn header color (SGR 97) differs from AI expert turn header color", async () => {
    // Discriminating: if humanSlugs handling were dropped, both experts would
    // get palette colors and the codes would potentially be equal or wrong.
    const sink = new StringSink();
    const renderer = new PlainRenderer(sink, { color: true });
    await renderer.render(
      events(
        {
          kind: "panel.assembled",
          experts: [
            { slug: "alice", displayName: "Alice", model: "gpt-5" },
            { slug: "user", displayName: "You", model: "", participantKind: "human" },
          ],
        },
        { kind: "round.start", round: 0 },
        { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 },
        { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "hi" },
        { kind: "turn.start", expertSlug: "user", round: 0, seq: 1, speakerKind: "human" },
        { kind: "turn.end", expertSlug: "user", turnId: "t2", content: "hey" },
      ),
    );
    const lines = sink.text.split("\n");
    const humanLine = lines.find((l) => stripAnsi(l).includes("[You]"));
    const aliceLine = lines.find((l) => stripAnsi(l).includes("[[1] Alice]"));
    expect(humanLine).toBeDefined();
    expect(aliceLine).toBeDefined();
    const humanCodes = (humanLine ?? "").match(ANSI_RE) ?? [];
    const aliceCodes = (aliceLine ?? "").match(ANSI_RE) ?? [];
    expect(humanCodes[0]).toBe("\u001b[97m");
    expect(humanCodes[0]).not.toBe(aliceCodes[0]);
  });
});
