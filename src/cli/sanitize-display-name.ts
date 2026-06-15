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
 * Pattern matching the remaining Unicode `Bidi_Control` marks and
 * default-ignorable invisible format characters not already removed by
 * `stripControlChars` or {@link ZERO_WIDTH_CHARS}. Expert `list`/`inspect`
 * render `displayName` straight to the terminal, so this sanitizer is the
 * sole defense for those views.
 *
 * Deliberately stripped:
 * - U+061C ARABIC LETTER MARK, U+200E LEFT-TO-RIGHT MARK, U+200F
 *   RIGHT-TO-LEFT MARK — the Bidi_Control marks beyond the overrides/isolates
 *   handled by `stripControlChars`; together they close the Trojan Source vector.
 * - U+00AD SOFT HYPHEN — usually invisible; can fragment or obfuscate text.
 * - U+2060–U+2064 — WORD JOINER and the invisible math operators; all render
 *   as nothing.
 * - U+115F, U+1160, U+3164, U+FFA0 — Hangul filler code points that render
 *   blank and can spoof a "non-empty" name.
 * - U+E0000–U+E007F — Unicode TAG characters; invisible and able to smuggle
 *   hidden ASCII-like payloads.
 *
 * Deliberately NOT stripped: variation selectors U+FE00–U+FE0F. U+FE0F (VS16)
 * is required by common emoji (e.g. ❤️ = U+2764 U+FE0F); removing it would
 * corrupt them. The accepted trade-off is that tag-sequence subdivision flags
 * (England/Scotland/Wales) are not preserved, as they depend on the tag block.
 *
 * The `u` flag makes the astral range U+E0000–U+E007F match by code point, so
 * surrogate pairs of unrelated emoji are never split.
 */
const HIDDEN_FORMAT_CHARS =
  /[\u00AD\u061C\u115F\u1160\u200E\u200F\u2060-\u2064\u3164\uFFA0\u{E0000}-\u{E007F}]/gu;

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
