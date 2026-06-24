import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";

/** Distinguishes a config-load warning from an "update available" notice. */
export type StartupWarningKind = "warning" | "update";

export interface StartupWarning {
  readonly kind: StartupWarningKind;
  readonly text: string;
}

export interface StartupWarningsInput {
  /** Config-load warnings (e.g. from {@link loadConfigWithMeta}). */
  readonly warnings?: readonly string[];
  /** A pre-formatted "update available" notice (e.g. from `maybeNotifyUpdate`). */
  readonly updateNotice?: string;
}

/**
 * Build the sanitized, ordered list of startup notices shown in the TUI banner.
 *
 * Both sources are untrusted at the terminal sink: config warnings may echo
 * file-derived strings and the update notice carries chalk ANSI plus a trailing
 * newline. Every entry is collapsed to a single line via `toSingleLineDisplay`
 * (strips control/ANSI/bidi, collapses CR/LF/U+2028/U+2029/tab) and trimmed;
 * entries that are blank once sanitized are dropped so the banner never renders
 * an empty row. Config warnings come first, then the update notice.
 */
export function selectStartupWarnings(input: StartupWarningsInput): readonly StartupWarning[] {
  const result: StartupWarning[] = [];

  for (const warning of input.warnings ?? []) {
    const text = toSingleLineDisplay(warning).trim();
    if (text.length > 0) {
      result.push({ kind: "warning", text });
    }
  }

  if (input.updateNotice !== undefined) {
    const text = toSingleLineDisplay(input.updateNotice).trim();
    if (text.length > 0) {
      result.push({ kind: "update", text });
    }
  }

  return result;
}
