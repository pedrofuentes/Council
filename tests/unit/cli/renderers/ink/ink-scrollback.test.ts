import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DebateEvent } from "../../../../../src/core/types.js";

const { mockedInkRender } = vi.hoisted(() => ({
  mockedInkRender: vi.fn(
    (
      app: ReactElement<{
        readonly events: AsyncIterable<DebateEvent>;
        readonly onComplete?: (err?: unknown) => void;
      }>,
      options?: { readonly stdout?: NodeJS.WriteStream },
    ) => {
      const consume = (async () => {
        for await (const _event of app.props.events) {
          // Simulate Ink consuming the stream for live rendering.
        }
        app.props.onComplete?.();
      })();

      return {
        unmount: () => {
          options?.stdout?.write("[CLEAR]");
        },
        waitUntilExit: () => consume,
      };
    },
  ),
}));

vi.mock("ink", () => ({
  Box: "div",
  Text: "span",
  Static: (_props: { readonly children: (item: unknown) => unknown; readonly items: unknown[] }) => null,
  render: mockedInkRender,
  useInput: () => undefined,
  useStdin: () => ({ isRawModeSupported: false }),
}));

import {
  coalesceDeltas,
  INITIAL_STATE,
  InkRenderer,
  reduce,
} from "../../../../../src/cli/renderers/ink/InkRenderer.js";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function createClearingStream() {
  let output = "";

  const stream = {
    isTTY: true,
    columns: 80,
    write(chunk: string | Uint8Array): boolean {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (text === "[CLEAR]") {
        output = "";
      } else {
        output += text;
      }
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  return {
    stream,
    read: (): string => output,
  };
}

async function* events(): AsyncIterable<DebateEvent> {
  yield {
    kind: "panel.assembled",
    experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
  };
  yield { kind: "round.start", round: 0 };
  yield { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 };
  yield { kind: "turn.delta", expertSlug: "alice", text: "Hello world" };
  yield { kind: "turn.end", expertSlug: "alice", turnId: "turn-1", content: "Hello world" };
  yield { kind: "debate.end", reason: "completed" };
}

describe("InkRenderer scrollback preservation", () => {
  it("writes a permanent final transcript after Ink clears its live output", async () => {
    const stdout = createClearingStream();
    const stderr = createClearingStream();
    const renderer = new InkRenderer({
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTTY: true,
      showCost: false,
    });

    await renderer.render(events());

    const transcript = stripAnsi(stdout.read());
    expect(transcript).toContain("Panel assembled");
    expect(transcript).toContain("Round 1");
    expect(transcript).toContain("Hello world");
    expect(transcript).toContain("Debate complete (completed)");
  });

  it("coalesces ≥1 batches of synchronous deltas into a single combined delta", async () => {
    // T6-ink-rerender: when the SDK synchronously emits many small deltas,
    // the renderer must batch them so we don't trigger N setState calls.
    // We assert that the final transcript still contains the joined text
    // even when 50 tiny deltas arrive back-to-back.
    const stdout = createClearingStream();
    const stderr = createClearingStream();
    const renderer = new InkRenderer({
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTTY: true,
      showCost: false,
    });

    async function* burst(): AsyncIterable<DebateEvent> {
      yield {
        kind: "panel.assembled",
        experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
      };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 };
      for (let i = 0; i < 50; i++) {
        yield { kind: "turn.delta", expertSlug: "alice", text: "x" };
      }
      yield {
        kind: "turn.end",
        expertSlug: "alice",
        turnId: "t1",
        content: "x".repeat(50),
      };
      yield { kind: "debate.end", reason: "completed" };
    }

    await renderer.render(burst());

    const transcript = stripAnsi(stdout.read());
    expect(transcript).toContain("x".repeat(50));
  });

  it("skips the final transcript when Ink is writing to a non-TTY sink", async () => {
    const stdout = createClearingStream();
    const stderr = createClearingStream();
    const renderer = new InkRenderer({
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTTY: false,
      showCost: false,
    });

    await renderer.render(events());

    expect(stdout.read()).toBe("");
  });
});

describe("coalesceDeltas", () => {
  it("merges consecutive turn.delta events from the same expert", () => {
    const input: DebateEvent[] = [
      { kind: "turn.delta", expertSlug: "alice", text: "Hello " },
      { kind: "turn.delta", expertSlug: "alice", text: "world" },
    ];
    const result = coalesceDeltas(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "turn.delta",
      expertSlug: "alice",
      text: "Hello world",
    });
  });

  it("keeps deltas from different experts separate", () => {
    const input: DebateEvent[] = [
      { kind: "turn.delta", expertSlug: "alice", text: "A" },
      { kind: "turn.delta", expertSlug: "bob", text: "B" },
    ];
    const result = coalesceDeltas(input);
    expect(result).toHaveLength(2);
  });

  it("does not merge across a non-delta event", () => {
    const input: DebateEvent[] = [
      { kind: "turn.delta", expertSlug: "alice", text: "A" },
      { kind: "turn.end", expertSlug: "alice", turnId: "t1", content: "A" },
      { kind: "turn.start", expertSlug: "alice", round: 0, seq: 1 },
      { kind: "turn.delta", expertSlug: "alice", text: "B" },
    ];
    const result = coalesceDeltas(input);
    expect(result).toHaveLength(4);
    expect(result[3]).toEqual({ kind: "turn.delta", expertSlug: "alice", text: "B" });
  });

  it("returns an empty array when given no events", () => {
    expect(coalesceDeltas([])).toEqual([]);
  });

  it("preserves the original first delta's speakerKind when merging", () => {
    const input: DebateEvent[] = [
      { kind: "turn.delta", expertSlug: "alice", text: "A", speakerKind: "human" },
      { kind: "turn.delta", expertSlug: "alice", text: "B" },
    ];
    const result = coalesceDeltas(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "turn.delta",
      expertSlug: "alice",
      text: "AB",
      speakerKind: "human",
    });
  });
});

describe("reduce — PanelRoster moved to Static items", () => {
  it("panel.assembled adds a single panel item to completedItems", () => {
    const state = reduce(INITIAL_STATE, {
      kind: "panel.assembled",
      experts: [
        { slug: "alice", displayName: "Alice", model: "gpt-5" },
        { slug: "bob", displayName: "Bob", model: "gpt-5" },
      ],
    });
    const panelItems = state.completedItems.filter((item) => item.type === "panel");
    expect(panelItems).toHaveLength(1);
  });

  it("subsequent deltas do not re-add the panel item", () => {
    let state = reduce(INITIAL_STATE, {
      kind: "panel.assembled",
      experts: [{ slug: "alice", displayName: "Alice", model: "gpt-5" }],
    });
    state = reduce(state, { kind: "round.start", round: 0 });
    state = reduce(state, { kind: "turn.start", expertSlug: "alice", round: 0, seq: 0 });
    state = reduce(state, { kind: "turn.delta", expertSlug: "alice", text: "hi" });
    const panelItems = state.completedItems.filter((item) => item.type === "panel");
    expect(panelItems).toHaveLength(1);
  });
});
