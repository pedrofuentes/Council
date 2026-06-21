/**
 * Pattern matching zero-width characters that should be removed before terminal display.
 * These characters are invisible but can be used for obfuscation or injection attacks.
 *
 * - U+200B: ZERO WIDTH SPACE
 * - U+200C: ZERO WIDTH NON-JOINER
 * - U+200D: ZERO WIDTH JOINER
 * - U+FEFF: ZERO WIDTH NO-BREAK SPACE (BOM)
 */
// eslint-disable-next-line no-misleading-character-class
export const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\uFEFF]/g;

/**
 * Pattern matching Unicode `Bidi_Control` marks and default-ignorable invisible
 * format characters not covered by zero-width or strong bidi-control stripping.
 *
 * Deliberately stripped:
 * - U+061C ARABIC LETTER MARK, U+200E LEFT-TO-RIGHT MARK, U+200F
 *   RIGHT-TO-LEFT MARK — weak Bidi_Control marks that can visually reorder text.
 * - U+00AD SOFT HYPHEN — usually invisible; can fragment or obfuscate text.
 * - U+2060–U+2064 — WORD JOINER and the invisible math operators.
 * - U+115F, U+1160, U+3164, U+FFA0 — Hangul filler code points that render blank.
 * - U+E0000–U+E007F — Unicode TAG characters; invisible and able to smuggle
 *   hidden ASCII-like payloads.
 *
 * Deliberately NOT stripped: variation selectors U+FE00–U+FE0F. U+FE0F (VS16)
 * is required by common emoji (e.g. ❤️ = U+2764 U+FE0F).
 *
 * The `u` flag makes the astral range U+E0000–U+E007F match by code point, so
 * surrogate pairs of unrelated emoji are never split.
 */
export const HIDDEN_FORMAT_CHARS =
  /[\u00AD\u061C\u115F\u1160\u200E\u200F\u2060-\u2064\u3164\uFFA0\u{E0000}-\u{E007F}]/gu;
