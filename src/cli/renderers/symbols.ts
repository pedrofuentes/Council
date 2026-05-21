/**
 * Symbol sets for Council CLI output.
 *
 * Provides Unicode symbols for rich terminals and ASCII fallbacks for
 * screen readers, legacy terminals (cmd.exe codepage 437), and
 * accessibility users.
 *
 * Auto-detection triggers ASCII mode when:
 * - `COUNCIL_ASCII=1` env var is set
 * - `NO_COLOR` env var is set (accessibility users likely want ASCII)
 * - `TERM=dumb`
 */

export interface SymbolSet {
  readonly panel: string;
  readonly roundRule: string;
  readonly separator: string;
  readonly headerRule: string;
  readonly cursor: string;
  readonly pass: string;
  readonly fail: string;
  readonly warn: string;
  readonly info: string;
  readonly error: string;
  readonly bullet: string;
  readonly complete: string;
  readonly paused: string;
}

const UNICODE_SYMBOLS: SymbolSet = Object.freeze({
  panel: "🏛️",
  roundRule: "━",
  separator: "─",
  headerRule: "═",
  cursor: "▋",
  pass: "✅",
  fail: "❌",
  warn: "⚠",
  info: "ℹ",
  error: "✗",
  bullet: "•",
  complete: "✓",
  paused: "⏸",
});

const ASCII_SYMBOLS: SymbolSet = Object.freeze({
  panel: "[Panel]",
  roundRule: "-",
  separator: "-",
  headerRule: "=",
  cursor: "|",
  pass: "[OK]",
  fail: "[FAIL]",
  warn: "[WARN]",
  info: "[i]",
  error: "[x]",
  bullet: "*",
  complete: "[DONE]",
  paused: "[~]",
});

/** Detect whether ASCII mode should be used based on environment. */
function shouldUseAscii(): boolean {
  if (process.env.COUNCIL_ASCII === "1") return true;
  if (process.env.NO_COLOR) return true;
  if (process.env.TERM === "dumb") return true;
  return false;
}

/**
 * Get the appropriate symbol set.
 *
 * @param ascii - Explicit override. `true` forces ASCII, `false` forces
 *   Unicode, `undefined` uses auto-detection from environment.
 */
export function getSymbols(ascii?: boolean): SymbolSet {
  const useAscii = ascii ?? shouldUseAscii();
  return useAscii ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
}
