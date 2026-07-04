/**
 * Tests for the spinner renderer — a tiny TTY-gated progress spinner.
 *
 * RED at this commit: src/cli/renderers/spinner.ts does not exist.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSpinner } from "../../../../src/cli/renderers/spinner.js";

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

describe("createSpinner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when the stream is not a TTY", () => {
    const stream = makeStream(false);
    const spinner = createSpinner({ stream });

    spinner.start("Checking");
    spinner.stop();

    expect(stream.writes).toEqual([]);
  });

  it("does nothing when isTTY override is false even if stream.isTTY is true", () => {
    const stream = makeStream(true);
    const spinner = createSpinner({ stream, isTTY: false });

    spinner.start("Checking");
    spinner.stop();

    expect(stream.writes).toEqual([]);
  });

  it("renders the first braille frame immediately on start in a TTY", () => {
    const stream = makeStream(true);
    const spinner = createSpinner({ stream });

    spinner.start("Checking");
    expect(stream.writes[0]).toBe("\r⠋ Checking…");

    spinner.stop();
  });

  it("advances braille frames on each interval tick", () => {
    vi.useFakeTimers();
    const stream = makeStream(true);
    const spinner = createSpinner({ stream, intervalMs: 80 });

    spinner.start("Probing");
    vi.advanceTimersByTime(80);
    vi.advanceTimersByTime(80);

    expect(stream.writes).toContain("\r⠋ Probing…");
    expect(stream.writes).toContain("\r⠙ Probing…");
    expect(stream.writes).toContain("\r⠹ Probing…");

    spinner.stop();
  });

  it("clears the line and stops animating on stop", () => {
    vi.useFakeTimers();
    const stream = makeStream(true);
    const spinner = createSpinner({ stream, intervalMs: 50 });

    spinner.start("Working");
    vi.advanceTimersByTime(50);
    spinner.stop();

    const last = stream.writes[stream.writes.length - 1];
    expect(last).toBe("\r\x1b[2K");

    const countAfterStop = stream.writes.length;
    vi.advanceTimersByTime(500);
    expect(stream.writes.length).toBe(countAfterStop);
  });

  it("stop is idempotent and safe to call without start", () => {
    const stream = makeStream(true);
    const spinner = createSpinner({ stream });

    expect(() => spinner.stop()).not.toThrow();
    expect(stream.writes).toEqual([]);

    spinner.start("X");
    spinner.stop();
    const len = stream.writes.length;

    expect(() => spinner.stop()).not.toThrow();
    expect(stream.writes.length).toBe(len);
  });

  it("respects a custom intervalMs", () => {
    vi.useFakeTimers();
    const stream = makeStream(true);
    const spinner = createSpinner({ stream, intervalMs: 200 });

    spinner.start("Slow");
    const initial = stream.writes.length;

    vi.advanceTimersByTime(199);
    expect(stream.writes.length).toBe(initial);

    vi.advanceTimersByTime(1);
    expect(stream.writes.length).toBe(initial + 1);

    spinner.stop();
  });

  it("restarting an active spinner clears the previous interval (#1279)", () => {
    vi.useFakeTimers();
    const stream = makeStream(true);
    const spinner = createSpinner({ stream, intervalMs: 80 });

    spinner.start("First");
    // Re-start while active: the `if (active) stop()` guard must tear down the
    // prior interval first, emitting a CLEAR_LINE and leaving exactly one timer.
    spinner.start("Second");

    expect(stream.writes).toContain("\r\x1b[2K");

    const writesBeforeTick = stream.writes.length;
    vi.advanceTimersByTime(80);

    // A single live interval renders exactly one frame per tick, all labelled
    // "Second". A leaked first interval would also render a "First" frame.
    const newWrites = stream.writes.slice(writesBeforeTick);
    expect(newWrites).toHaveLength(1);
    expect(newWrites[0]).toContain("Second");
    expect(newWrites[0]).not.toContain("First");

    spinner.stop();
  });
});
