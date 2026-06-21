import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgress } from "../../../src/cli/progress.js";

interface CaptureStream {
  readonly writes: string[];
  readonly isTTY?: boolean;
  write(s: string): void;
}

function makeStream(isTTY?: boolean): CaptureStream {
  const writes: string[] = [];
  return {
    writes,
    isTTY,
    write(s: string): void {
      writes.push(s);
    },
  };
}

describe("createProgress", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.NO_COLOR;
    delete process.env.TERM;
  });

  it("emits one plain line when stderr is not a TTY", () => {
    const stream = makeStream(false);
    const progress = createProgress({ stream });

    progress.start("Composing panel");
    progress.update("Selecting experts");
    progress.stop();

    expect(stream.writes).toEqual(["Composing panel…\n"]);
  });

  it("is silent when quiet is set", () => {
    const stream = makeStream(false);
    const progress = createProgress({ stream, quiet: true });

    progress.start("Composing panel");
    progress.update("Selecting experts");
    progress.stop();

    expect(stream.writes).toEqual([]);
  });

  it("uses plain output when NO_COLOR is set even for a TTY", () => {
    process.env.NO_COLOR = "1";
    const stream = makeStream(true);
    const progress = createProgress({ stream });

    progress.start("Composing panel");
    progress.stop();

    expect(stream.writes).toEqual(["Composing panel…\n"]);
  });

  it("uses plain output when TERM is dumb even for a TTY", () => {
    process.env.TERM = "dumb";
    const stream = makeStream(true);
    const progress = createProgress({ stream });

    progress.start("Composing panel");
    progress.stop();

    expect(stream.writes).toEqual(["Composing panel…\n"]);
  });

  it("spins and clears the line for a capable TTY", () => {
    vi.useFakeTimers();
    const stream = makeStream(true);
    const progress = createProgress({ stream, intervalMs: 80 });

    progress.start("Composing panel");
    progress.update("Selecting experts");
    vi.advanceTimersByTime(80);
    progress.stop();

    expect(stream.writes).toContain("\r⠋ Composing panel…");
    expect(stream.writes).toContain("\r\x1b[2K");
    expect(stream.writes).toContain("\r⠋ Selecting experts…");
    expect(stream.writes).toContain("\r⠙ Selecting experts…");
    expect(stream.writes.at(-1)).toBe("\r\x1b[2K");
  });

  it("stops animating after stop", () => {
    vi.useFakeTimers();
    const stream = makeStream(true);
    const progress = createProgress({ stream, intervalMs: 80 });

    progress.start("Composing panel");
    progress.stop();
    const writeCount = stream.writes.length;
    vi.advanceTimersByTime(800);

    expect(stream.writes.length).toBe(writeCount);
  });
});
