const FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;
const CLEAR_LINE = "\r\x1b[2K";

export interface ProgressStream {
  write(s: string): void;
  readonly isTTY?: boolean;
}

export interface ProgressOptions {
  readonly stream?: ProgressStream;
  readonly isTTY?: boolean;
  readonly quiet?: boolean;
  readonly intervalMs?: number;
}

export interface Progress {
  start(label: string): void;
  update(label: string): void;
  stop(): void;
}

function supportsAnimatedProgress(isTTY: boolean): boolean {
  return isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

export function createProgress(opts: ProgressOptions = {}): Progress {
  const stream: ProgressStream = opts.stream ?? process.stderr;
  const isTTY = opts.isTTY ?? stream.isTTY ?? false;
  const quiet = opts.quiet ?? false;
  const animated = supportsAnimatedProgress(isTTY);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  let active = false;
  let plainLineWritten = false;
  let currentLabel = "";

  const render = (): void => {
    const frame = FRAMES[frameIndex % FRAMES.length];
    stream.write(`\r${frame} ${currentLabel}…`);
    frameIndex += 1;
  };

  const start = (label: string): void => {
    if (quiet) return;
    if (!animated) {
      if (!plainLineWritten) {
        stream.write(`${label}…\n`);
        plainLineWritten = true;
      }
      return;
    }

    if (active) {
      stop();
    }
    active = true;
    currentLabel = label;
    frameIndex = 0;
    render();
    timer = setInterval(render, intervalMs);
    const maybeUnref = timer as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") {
      maybeUnref.unref();
    }
  };

  const update = (label: string): void => {
    if (quiet || !animated || !active) return;
    currentLabel = label;
    frameIndex = 0;
    stream.write(CLEAR_LINE);
    render();
  };

  const stop = (): void => {
    if (!animated || !active) return;
    active = false;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    stream.write(CLEAR_LINE);
  };

  return { start, update, stop };
}
