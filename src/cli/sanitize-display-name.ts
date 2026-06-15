/**
 * Sanitize expert display names to prevent control/bidi/zero-width character
 * injection and enforce reasonable length limits.
 *
 * Applied on `council expert create --name` and `council expert edit` to
 * ensure display names render safely in tables, transcripts, and LLM prompts.
 *
 * This sanitizer:
 * - Strips ANSI/OSC/C0/C1/bidi control characters via `stripControlChars`
 * - Strips zero-width characters (U+200B, U+200C, U+200D, U+FEFF)
 * - Collapses all whitespace (including newlines and tabs) to single spaces
 * - Trims leading and trailing whitespace
 * - Enforces a maximum length of 80 characters
 * - Throws CliUserError if the result is empty
 *
 * Valid printable Unicode (emoji, accents, CJK) is preserved.
 */

import { CliUserError } from "./cli-user-error.js";
import { stripControlChars } from "./strip-control-chars.js";

/**
 * Maximum allowed length for expert display names.
 * Chosen to fit comfortably in terminal tables and transcript headers.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * Pattern matching zero-width characters that should be removed from display names.
 * These characters are invisible but can be used for obfuscation or injection attacks.
 *
 * - U+200B: ZERO WIDTH SPACE
 * - U+200C: ZERO WIDTH NON-JOINER
 * - U+200D: ZERO WIDTH JOINER
 * - U+FEFF: ZERO WIDTH NO-BREAK SPACE (BOM)
 */
// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\uFEFF]/g;

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

  // Step 3: Collapse all whitespace (spaces, newlines, tabs, etc.) to single spaces
  cleaned = cleaned.replace(/\s+/g, " ");

  // Step 4: Trim leading and trailing whitespace
  cleaned = cleaned.trim();

  // Step 5: Enforce maximum length
  if (cleaned.length > MAX_DISPLAY_NAME_LENGTH) {
    cleaned = cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }

  // Step 6: Reject empty names
  if (cleaned.length === 0) {
    throw new CliUserError(
      "Display name cannot be empty or consist only of whitespace and control characters. " +
        "Please provide a valid display name with at least one printable character.",
    );
  }

  return cleaned;
}
