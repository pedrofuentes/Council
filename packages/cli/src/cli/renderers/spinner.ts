/**
 * A tiny, dependency-free progress spinner for CLI commands.
 *
 * The spinner is TTY-gated: when the target stream is not a TTY (piped
 * output, CI, tests) every method is a no-op so captured output stays
 * byte-for-byte identical. When the stream is a TTY it animates a braille
 * frame followed by a label on the current line and clears that line on
 * stop. Spinner output goes ONLY to its own stream (stderr by default) so
 * it never pollutes a command's primary output.
 */

const FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DEFAULT_INTERVAL_MS = 80;

/** Carriage return + ANSI "erase entire line" — resets the spinner line. */
const CLEAR_LINE = "\r\x1b[2K";

export interface SpinnerStream {
  write(s: string): void;
  readonly isTTY?: boolean;
}

export interface SpinnerOptions {
  readonly stream?: SpinnerStream;
  readonly isTTY?: boolean;
  readonly intervalMs?: number;
}

export interface Spinner {
  start(label: string): void;
  stop(): void;
}

export function createSpinner(opts: SpinnerOptions = {}): Spinner {
  const stream: SpinnerStream = opts.stream ?? process.stderr;
  const isTTY = opts.isTTY ?? stream.isTTY ?? false;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  let active = false;

  const render = (label: string): void => {
    const frame = FRAMES[frameIndex % FRAMES.length];
    stream.write(`\r${frame} ${label}…`);
    frameIndex += 1;
  };

  const start = (label: string): void => {
    if (!isTTY) return;
    if (active) stop();
    active = true;
    frameIndex = 0;
    render(label);
    timer = setInterval(() => render(label), intervalMs);
    const maybeUnref = timer as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") {
      maybeUnref.unref();
    }
  };

  const stop = (): void => {
    if (!isTTY || !active) return;
    active = false;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    stream.write(CLEAR_LINE);
  };

  return { start, stop };
}
