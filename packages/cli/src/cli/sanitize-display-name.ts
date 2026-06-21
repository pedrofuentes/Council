/**
 * Sanitize expert display names to prevent control/bidi/zero-width character
 * injection and enforce reasonable length limits.
 *
 * Applied on `council expert create --name` and `council expert edit` to
 * ensure display names render safely in tables, transcripts, and LLM prompts.
 *
 * This sanitizer:
 * - Strips ANSI/OSC/C0/C1 controls plus bidi overrides/isolates
 *   (U+202A–U+202E, U+2066–U+2069) via `stripControlChars`
 * - Strips the remaining Unicode Bidi_Control marks — U+061C (ALM),
 *   U+200E (LRM), U+200F (RLM) — completing Trojan Source (CVE-2021-42574)
 *   protection for names rendered raw in `expert list`/`inspect`
 * - Strips zero-width characters (U+200B, U+200C, U+200D, U+FEFF)
 * - Strips default-ignorable invisibles that render as nothing but can hide
 *   content or pad length: U+00AD soft hyphen, U+2060–U+2064 word joiner and
 *   invisible operators, U+115F/U+1160/U+3164/U+FFA0 Hangul fillers, and
 *   U+E0000–U+E007F tag characters
 * - Collapses all whitespace (including newlines and tabs) to single spaces
 * - Trims leading and trailing whitespace
 * - Enforces a maximum length of 80 characters
 * - Throws CliUserError if the result is empty
 *
 * Emoji variation selectors (U+FE00–U+FE0F) are deliberately preserved so
 * emoji such as ❤️ (U+2764 U+FE0F) keep rendering; the trade-off is that
 * tag-sequence subdivision flags (e.g. 🏴󠁧󠁢󠁥󠁮󠁧󠁿) are not preserved, since they
 * depend on the tag block stripped above. Other printable Unicode (emoji,
 * accents, CJK) is preserved.
 */

import { CliUserError } from "./cli-user-error.js";
import { HIDDEN_FORMAT_CHARS, ZERO_WIDTH_CHARS } from "./hidden-format-chars.js";
import { stripControlChars } from "./strip-control-chars.js";

/**
 * Maximum allowed length for expert display names.
 * Chosen to fit comfortably in terminal tables and transcript headers.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * Sanitize an expert display name.
 *
 * @param raw - The raw display name input (potentially containing control characters,
 *              excessive whitespace, or being too long)
 * @returns The sanitized display name
 * @throws {CliUserError} If the name is empty or becomes empty after sanitization
 */
export function sanitizeDisplayName(raw: string): string {
  // Step 1: Strip control characters (ANSI, bidi overrides, C0/C1 controls)
  let cleaned = stripControlChars(raw);

  // Step 2: Strip zero-width characters
  cleaned = cleaned.replace(ZERO_WIDTH_CHARS, "");

  // Step 3: Strip remaining bidi marks and default-ignorable invisibles
  cleaned = cleaned.replace(HIDDEN_FORMAT_CHARS, "");

  // Step 4: Collapse all whitespace (spaces, newlines, tabs, etc.) to single spaces
  cleaned = cleaned.replace(/\s+/g, " ");

  // Step 5: Trim leading and trailing whitespace
  cleaned = cleaned.trim();

  // Step 6: Enforce maximum length
  if (cleaned.length > MAX_DISPLAY_NAME_LENGTH) {
    cleaned = cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }

  // Step 7: Reject empty names
  if (cleaned.length === 0) {
    throw new CliUserError(
      "Display name cannot be empty or consist only of whitespace and control characters. " +
        "Please provide a valid display name with at least one printable character.",
    );
  }

  return cleaned;
}
