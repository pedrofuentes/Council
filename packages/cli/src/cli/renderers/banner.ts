/**
 * Startup banner renderer — the "Council" wordmark.
 *
 * Renders a bold block-art wordmark (figlet `ANSI Regular`, baked here as a
 * static string so no `figlet` runtime dependency is needed) with a brand-blue
 * diagonal gradient, plus a subtitle line carrying the version.
 *
 * Output degrades gracefully (highest priority first):
 *  - not a TTY, or terminal narrower than {@link MIN_BANNER_WIDTH}
 *      → a compact, plain `Council vX.Y.Z` one-liner (pipe/log safe);
 *  - ASCII mode (`COUNCIL_ASCII=1` or `TERM=dumb`)
 *      → plain-text `Council` + subtitle, no block glyphs, no color;
 *  - color level 0 (`NO_COLOR`, dumb pipe) → `█` block art, no color;
 *  - color level 1 (16-color)             → `█` block art, downsampled hue;
 *  - color level ≥ 2 (256 / truecolor)    → `█` block art, blue gradient.
 *
 * Charset detection here intentionally differs from {@link getSymbols}: `NO_COLOR`
 * disables color but keeps the Unicode block art (a `NO_COLOR` user on a modern
 * terminal still sees the wordmark, just uncolored).
 */
import { Chalk } from "chalk";

/** Baked `ANSI Regular` rendering of "Council" (uppercased by the font). */
const WORDMARK_LINES: readonly string[] = [
  " ██████  ██████  ██    ██ ███    ██  ██████ ██ ██",
  "██      ██    ██ ██    ██ ████   ██ ██      ██ ██",
  "██      ██    ██ ██    ██ ██ ██  ██ ██      ██ ██",
  "██      ██    ██ ██    ██ ██  ██ ██ ██      ██ ██",
  " ██████  ██████   ██████  ██   ████  ██████ ██ ███████",
];

const DEFAULT_SUBTITLE = "Persistent AI expert panels";

/** Minimum terminal width before falling back to the compact one-liner. */
export const MIN_BANNER_WIDTH = 57;

/** Gradient control points: #9ed8f5 → #5aa0e6 → #3f7fc4 (brand blue). */
type Rgb = readonly [number, number, number];
const GRADIENT_START: Rgb = [158, 216, 245]; // #9ed8f5
const GRADIENT_MID: Rgb = [90, 160, 230]; // #5aa0e6
const GRADIENT_END: Rgb = [63, 127, 196]; // #3f7fc4
const GRADIENT_MIDPOINT = 0.52;

export interface BannerOptions {
  /** Version string (without leading "v"), e.g. "0.3.0". */
  readonly version: string;
  /** Terminal width. Defaults to `process.stdout.columns ?? 80`. */
  readonly columns?: number;
  /** Whether stdout is a TTY. Defaults to `process.stdout.isTTY === true`. */
  readonly isTTY?: boolean;
  /** Chalk color level (0–3). Defaults to auto-detection (0 when `NO_COLOR`). */
  readonly colorLevel?: 0 | 1 | 2 | 3;
  /** Force ASCII charset. Defaults to `COUNCIL_ASCII=1` / `TERM=dumb`. */
  readonly ascii?: boolean;
  /** Subtitle text shown before the version. */
  readonly subtitle?: string;
}

/** A plain, pipe-safe one-liner: `Council vX.Y.Z`. */
export function renderCompactVersionLine(version: string): string {
  return `Council v${version}`;
}

function detectColorLevel(): 0 | 1 | 2 | 3 {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return 0;
  }
  return new Chalk().level;
}

function detectAscii(): boolean {
  return process.env.COUNCIL_ASCII === "1" || process.env.TERM === "dumb";
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

function gradientColor(t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, t));
  if (clamped <= GRADIENT_MIDPOINT) {
    return mix(GRADIENT_START, GRADIENT_MID, clamped / GRADIENT_MIDPOINT);
  }
  return mix(GRADIENT_MID, GRADIENT_END, (clamped - GRADIENT_MIDPOINT) / (1 - GRADIENT_MIDPOINT));
}

function subtitleLine(subtitle: string, version: string, ascii: boolean): string {
  return ascii ? `${subtitle} - v${version}` : `${subtitle}  \u00b7  v${version}`;
}

function renderPlainBanner(subtitle: string, version: string): string {
  return `Council\n${subtitleLine(subtitle, version, true)}`;
}

function renderBlockBanner(subtitle: string, version: string, colorLevel: 0 | 1 | 2 | 3): string {
  const chalk = new Chalk({ level: colorLevel });
  const rows = WORDMARK_LINES.length;
  const maxWidth = Math.max(...WORDMARK_LINES.map((line) => line.length));
  const denom = Math.max(1, maxWidth - 1 + (rows - 1));

  const art = WORDMARK_LINES.map((line, y) => {
    let rendered = "";
    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      if (ch === undefined || ch === " ") {
        rendered += " ";
        continue;
      }
      const [r, g, b] = gradientColor((x + y) / denom);
      rendered += chalk.rgb(r, g, b)(ch);
    }
    return rendered.replace(/\s+$/u, "");
  }).join("\n");

  return `${art}\n${subtitleLine(subtitle, version, false)}`;
}

/**
 * Render the Council startup banner, degrading per the matrix in the module
 * docblock. Returns a multi-line string with no trailing newline.
 */
export function renderBanner(options: BannerOptions): string {
  const { version } = options;
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const columns = options.columns ?? process.stdout.columns ?? 80;
  const ascii = options.ascii ?? detectAscii();
  const colorLevel = options.colorLevel ?? detectColorLevel();
  const subtitle = options.subtitle ?? DEFAULT_SUBTITLE;

  if (!isTTY || columns < MIN_BANNER_WIDTH) {
    return renderCompactVersionLine(version);
  }
  if (ascii) {
    return renderPlainBanner(subtitle, version);
  }
  return renderBlockBanner(subtitle, version, colorLevel);
}
