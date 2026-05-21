/**
 * Tests for dynamic separator width in plain and chat renderers.
 *
 * Both renderers should use process.stdout.columns (capped at 100)
 * instead of hardcoded 40-char separators.
 */
import { describe, expect, it, afterEach, vi } from "vitest";

import { PlainRenderer } from "../../../../src/cli/renderers/plain.js";
import { createChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";
import type { DebateEvent } from "../../../../src/core/types.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

function createBufferSink(): Sink & { output: string } {
  const sink = {
    output: "",
    write(text: string): void {
      sink.output += text;
    },
    writeError(text: string): void {
      sink.output += text;
    },
  };
  return sink;
}

async function* stream(...evts: DebateEvent[]): AsyncIterable<DebateEvent> {
  for (const e of evts) yield e;
}

describe("PlainRenderer — dynamic separator width", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses process.stdout.columns for round.end separator width", async () => {
    // Simulate a terminal of 60 columns
    vi.stubGlobal("process", {
      ...process,
      stdout: { ...process.stdout, columns: 60 },
      env: { ...process.env },
    });

    const sink = createBufferSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      stream(
        { kind: "round.start", round: 0 },
        { kind: "round.end", round: 0 },
      ),
    );

    // The separator should be 60 chars wide (uses terminal width)
    const separatorLine = sink.output.split("\n").find((l) => l.includes("─"));
    expect(separatorLine).toBeDefined();
    const dashCount = (separatorLine?.match(/─/g) ?? []).length;
    expect(dashCount).toBe(60);
  });

  it("caps separator width at 100 columns", async () => {
    vi.stubGlobal("process", {
      ...process,
      stdout: { ...process.stdout, columns: 200 },
      env: { ...process.env },
    });

    const sink = createBufferSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      stream(
        { kind: "round.start", round: 0 },
        { kind: "round.end", round: 0 },
      ),
    );

    const separatorLine = sink.output.split("\n").find((l) => l.includes("─"));
    expect(separatorLine).toBeDefined();
    const dashCount = (separatorLine?.match(/─/g) ?? []).length;
    expect(dashCount).toBe(100);
  });

  it("defaults to 80 when columns is undefined", async () => {
    vi.stubGlobal("process", {
      ...process,
      stdout: { ...process.stdout, columns: undefined },
      env: { ...process.env },
    });

    const sink = createBufferSink();
    const renderer = new PlainRenderer(sink, { color: false });
    await renderer.render(
      stream(
        { kind: "round.start", round: 0 },
        { kind: "round.end", round: 0 },
      ),
    );

    const separatorLine = sink.output.split("\n").find((l) => l.includes("─"));
    expect(separatorLine).toBeDefined();
    const dashCount = (separatorLine?.match(/─/g) ?? []).length;
    expect(dashCount).toBe(80);
  });
});

describe("ChatRenderer — dynamic separator width", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses process.stdout.columns for separator width", () => {
    vi.stubGlobal("process", {
      ...process,
      stdout: { ...process.stdout, columns: 50 },
      env: { ...process.env },
    });

    const sink = createBufferSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["alice", "Alice"]]),
    });
    renderer.showSeparator();

    const dashCount = (sink.output.match(/─/g) ?? []).length;
    expect(dashCount).toBe(50);
  });

  it("caps separator width at 100", () => {
    vi.stubGlobal("process", {
      ...process,
      stdout: { ...process.stdout, columns: 150 },
      env: { ...process.env },
    });

    const sink = createBufferSink();
    const renderer = createChatRenderer({
      sink,
      experts: new Map([["alice", "Alice"]]),
    });
    renderer.showSeparator();

    const dashCount = (sink.output.match(/─/g) ?? []).length;
    expect(dashCount).toBe(100);
  });
});
