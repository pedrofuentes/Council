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

/**
 * Returns `prompt` unchanged when its length (in Unicode code points)
 * is at or below the configured maximum; otherwise returns the first
 * `maxLength` code points followed by an ellipsis (`...`).
 *
 * Truncation operates on code points (via `Array.from`) rather than
 * UTF-16 code units so that surrogate-pair characters such as emoji
 * straddling the boundary are kept intact or dropped whole, never
 * split into invalid lone surrogates.
 */
export function truncatePrompt(prompt: string, options: TruncatePromptOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_PROMPT_DISPLAY_MAX;
  const codePoints = Array.from(prompt);
  if (codePoints.length <= maxLength) {
    return prompt;
  }
  return codePoints.slice(0, maxLength).join("") + "...";
}
