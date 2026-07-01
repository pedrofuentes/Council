/**
 * Renderer selection factory.
 *
 * Maps the user-visible `--format` flag to a concrete `Renderer`:
 *
 *   - `"json"`  → `JsonRenderer` (always, regardless of TTY)
 *   - `"plain"` → `PlainRenderer` (always, regardless of TTY)
 *   - `"auto"`  → `InkRenderer` on TTY, `PlainRenderer` otherwise
 *
 * Explicit `--format` values must always override TTY auto-detection
 * so that piped output (CI, logs, scripts) stays deterministic. Only
 * the `auto` setting consults `process.stdout.isTTY`.
 */
import { JsonRenderer } from "./json.js";
import { PlainRenderer } from "./plain.js";
import { InkRenderer } from "./ink/InkRenderer.js";
import type { Renderer, Sink } from "./types.js";

export const RENDERER_FORMATS = ["auto", "json", "plain"] as const;
export type RendererFormat = (typeof RENDERER_FORMATS)[number];

export interface SelectRendererOpts {
  readonly format: RendererFormat;
  readonly isTTY: boolean;
  readonly sink: Sink;
  readonly quiet?: boolean;
  readonly showCost?: boolean;
}

/** Detect environments where PlainRenderer should be forced for accessibility. */
function shouldForcePlain(): boolean {
  if (process.env["TERM"] === "dumb") return true;
  if (process.env["CI"] === "true" || process.env["CI"] === "1") return true;
  if (process.env["ACCESSIBILITY"] === "1") return true;
  return false;
}

/**
 * Adapt a {@link Sink} into a `NodeJS.WriteStream` so it can back `InkRenderer`.
 *
 * `InkRenderer` (and Ink) emit frames through `stream.write` and read terminal
 * capabilities (`columns`, `isTTY`, resize events) off the stream. We intercept
 * `write` and forward it to the sink — so callers and tests capture the output
 * and stay isolated from the real process streams — while delegating every
 * other property to `base` (the real `process.stdout`/`process.stderr`) so
 * interactive terminal features (width, resize reflow) are preserved.
 */
function sinkWriteStream(
  sink: Sink,
  base: NodeJS.WriteStream,
  channel: "stdout" | "stderr",
): NodeJS.WriteStream {
  const write = (chunk: string | Uint8Array, ...rest: readonly unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (channel === "stderr" && sink.writeError !== undefined) {
      sink.writeError(text);
    } else {
      sink.write(text);
    }
    const callback = rest.find(
      (arg): arg is (error?: Error | null) => void => typeof arg === "function",
    );
    callback?.();
    return true;
  };
  return new Proxy(base, {
    get(target, property): unknown {
      if (property === "write") {
        return write;
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (value as (...args: readonly unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

export function selectRenderer(opts: SelectRendererOpts): Renderer {
  const showCost = opts.showCost ?? true;

  switch (opts.format) {
    case "json":
      return new JsonRenderer(opts.sink);
    case "plain":
      return new PlainRenderer(opts.sink, {
        showCost,
        ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
      });
    case "auto":
      if (!opts.isTTY || shouldForcePlain()) {
        return new PlainRenderer(opts.sink, {
          color: false,
          showCost,
          ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
        });
      }
      return new InkRenderer({
        stdout: sinkWriteStream(opts.sink, process.stdout, "stdout"),
        stderr: sinkWriteStream(opts.sink, process.stderr, "stderr"),
        isTTY: true,
        showCost,
        ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
      });
    default: {
      const _exhaustive: never = opts.format;
      throw new Error(`Unknown renderer format: ${String(_exhaustive)}`);
    }
  }
}
