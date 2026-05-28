/**
 * Shared helper for truncating user-supplied prompts/topics when
 * echoing them into terminal headers (e.g. the `Topic:` line in the
 * `council convene` debate preamble).
 *
 * The full prompt is still forwarded to the engine — only the
 * displayed form is shortened, to keep long topics from flooding
 * the terminal with visual noise.
 */

/** Default maximum number of characters to show before truncating. */
export const DEFAULT_PROMPT_DISPLAY_MAX = 200;

export interface TruncatePromptOptions {
  /** Maximum number of characters to display before truncating. */
  readonly maxLength?: number;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Returns `prompt` unchanged when its length (in user-perceived grapheme
 * clusters) is at or below the configured maximum; otherwise returns the
 * first `maxLength` graphemes followed by an ellipsis (`...`).
 *
 * Truncation operates on grapheme clusters (via `Intl.Segmenter`) so that
 * multi-code-point sequences such as ZWJ-joined family emoji, regional-
 * indicator flag pairs, and base-character + combining-mark combinations
 * are kept intact or dropped whole — never split mid-cluster into invalid
 * lone surrogates, orphan ZWJs, or dangling combining marks.
 */
export function truncatePrompt(prompt: string, options: TruncatePromptOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_PROMPT_DISPLAY_MAX;
  let count = 0;
  let cutoffIndex = -1;
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(prompt)) {
    if (count === maxLength) {
      cutoffIndex = index;
      break;
    }
    count += 1;
    cutoffIndex = index + segment.length;
  }
  if (count < maxLength || cutoffIndex >= prompt.length) {
    return prompt;
  }
  return prompt.slice(0, cutoffIndex) + "...";
}
