/**
 * Shared CLI helpers — primarily the `Writer` injection pattern.
 *
 * Each command builder accepts an optional `Writer` parameter that
 * defaults to `process.stdout.write`. Tests can pass a string-capturing
 * writer to assert against output. This avoids reaching into Commander's
 * private OutputConfiguration internals.
 */

export type Writer = (s: string) => void;

const UTF8_OUTPUT_ENCODING: BufferEncoding = "utf8";

export const defaultWriter: Writer = (s) => process.stdout.write(s, UTF8_OUTPUT_ENCODING);

let quietMode = false;

/** Enable quiet mode — suppresses informational notices on stderr. */
export function setQuiet(enabled: boolean): void {
  quietMode = enabled;
}

/** Returns whether quiet mode is currently active. */
export function isQuiet(): boolean {
  return quietMode;
}

/** Always writes to stderr — used for errors and diagnostics that must never be silenced. */
export const defaultErrorWriter: Writer = (s) => process.stderr.write(s, UTF8_OUTPUT_ENCODING);

/** Writes informational notices to stderr, suppressed by --quiet. */
export const defaultNoticeWriter: Writer = (s) => {
  if (!quietMode) {
    process.stderr.write(s, UTF8_OUTPUT_ENCODING);
  }
};
