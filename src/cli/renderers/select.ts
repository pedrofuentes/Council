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
}

/** Detect environments where PlainRenderer should be forced for accessibility. */
function shouldForcePlain(): boolean {
  if (process.env["TERM"] === "dumb") return true;
  if (process.env["CI"] === "true" || process.env["CI"] === "1") return true;
  if (process.env["ACCESSIBILITY"] === "1") return true;
  return false;
}

export function selectRenderer(opts: SelectRendererOpts): Renderer {
  switch (opts.format) {
    case "json":
      return new JsonRenderer(opts.sink);
    case "plain":
      return new PlainRenderer(opts.sink, { quiet: opts.quiet });
    case "auto":
      if (!opts.isTTY || shouldForcePlain()) {
        return new PlainRenderer(opts.sink, { color: false, quiet: opts.quiet });
      }
      return new InkRenderer({ isTTY: true });
    default: {
      const _exhaustive: never = opts.format;
      throw new Error(`Unknown renderer format: ${String(_exhaustive)}`);
    }
  }
}
