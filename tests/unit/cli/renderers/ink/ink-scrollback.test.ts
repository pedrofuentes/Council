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

import { InkRenderer } from "../../../../../src/cli/renderers/ink/InkRenderer.js";

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
