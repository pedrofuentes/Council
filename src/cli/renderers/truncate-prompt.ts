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
 * Returns `prompt` unchanged when its length is at or below the
 * configured maximum; otherwise returns the first `maxLength`
 * characters followed by an ellipsis (`...`).
 */
export function truncatePrompt(prompt: string, options: TruncatePromptOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_PROMPT_DISPLAY_MAX;
  if (prompt.length <= maxLength) {
    return prompt;
  }
  return prompt.slice(0, maxLength) + "...";
}
