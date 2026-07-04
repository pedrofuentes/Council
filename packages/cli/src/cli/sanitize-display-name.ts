/**
 * Sanitize expert display names to prevent control/bidi/zero-width character
 * injection and enforce reasonable length limits.
 *
 * Callers use this for expert display names before storing or rendering them.
 * It does not guarantee that every CLI flow sanitizes names; each flow must
 * call this helper on untrusted display-name input.
 *
 * This sanitizer:
 * - Strips ANSI/OSC/C0/C1 controls, bidi overrides/isolates
 *   (U+202A–U+202E, U+2066–U+2069), remaining Unicode Bidi_Control marks,
 *   and zero-width characters via `stripControlChars`
 * - Strips default-ignorable invisibles that render as nothing but can hide
 *   content or pad length: U+00AD soft hyphen, U+2060–U+2064 word joiner and
 *   invisible operators, U+115F/U+1160/U+3164/U+FFA0 Hangul fillers, and
 *   U+E0000–U+E007F tag characters
 * - Collapses all whitespace (including newlines and tabs) to single spaces
 * - Trims leading and trailing whitespace
 * - Enforces a maximum length of 80 Unicode code points
 * - Throws CliUserError if the result is empty
 *
 * Emoji variation selectors (U+FE00–U+FE0F) are deliberately preserved so
 * emoji such as ❤️ (U+2764 U+FE0F) keep rendering; the trade-off is that
 * tag-sequence subdivision flags (e.g. 🏴󠁧󠁢󠁥󠁮󠁧󠁿) are not preserved, since they
 * depend on the tag block stripped above. Other printable Unicode (emoji,
 * accents, CJK) is preserved.
 */

import { CliUserError } from "./cli-user-error.js";
import { stripControlChars } from "./strip-control-chars.js";

/**
 * Maximum allowed length for expert display names.
 * Chosen to fit comfortably in terminal tables and transcript headers.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;

function truncateToCodePoints(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join("");
}

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

  // Step 2: Collapse all whitespace (spaces, newlines, tabs, etc.) to single spaces
  cleaned = cleaned.replace(/\s+/g, " ");

  // Step 3: Trim leading and trailing whitespace
  cleaned = cleaned.trim();

  // Step 4: Enforce maximum length without splitting surrogate pairs
  if (Array.from(cleaned).length > MAX_DISPLAY_NAME_LENGTH) {
    cleaned = truncateToCodePoints(cleaned, MAX_DISPLAY_NAME_LENGTH);
  }

  // Step 5: Reject empty names
  if (cleaned.length === 0) {
    throw new CliUserError(
      "Display name cannot be empty or consist only of whitespace and control characters. " +
        "Please provide a valid display name with at least one printable character.",
    );
  }

  return cleaned;
}
