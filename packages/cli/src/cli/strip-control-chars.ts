/**
 * Sanitize untrusted text before writing it to the user's terminal.
 *
 * Auto-composed panel names, expert displayNames, and roles all originate
 * from an LLM. A malicious prompt or a compromised provider could embed
 * ANSI escape sequences that:
 *   - Spoof previous lines (e.g. clear the screen + redraw a fake "OK")
 *   - Set the terminal title (information disclosure)
 *   - Inject OSC 8 hyperlinks that exfiltrate data on click
 *   - Emit BEL / NUL / other C0 controls that interfere with TTYs
 *
 * This helper strips:
 *   - ANSI CSI sequences:  ESC [ ... final byte, including ECMA-48
 *     private/intermediate bytes
 *   - OSC sequences:        ESC ] ... BEL
 *   - C0 controls except newline (\n), tab (\t), carriage return (\r)
 *   - DEL (0x7F)
 *   - C1 controls (U+0080–U+009F) — invisible non-printable codepoints
 *     that some terminals interpret as alternate escape introducers
 *     (e.g. 0x9B = CSI, 0x9D = OSC). Stripping these closes a TTY-injection
 *     vector equivalent to the ANSI ESC-prefixed sequences above.
 *   - Bidi override/isolate characters (U+202A–U+202E, U+2066–U+2069) that
 *     enable Trojan Source attacks (CVE-2021-42574) by visually reordering
 *     text in the terminal to disguise malicious content.
 *   - Weak Bidi_Control marks (U+061C, U+200E, U+200F), zero-width characters,
 *     and hidden default-ignorable format characters that can invisibly
 *     reorder, hide, or pad terminal output.
 *
 * Printable Unicode (emoji, accents, CJK, NBSP and other Latin-1 supplement
 * characters at U+00A0+) is preserved.
 */
import { HIDDEN_FORMAT_CHARS, ZERO_WIDTH_CHARS } from "./hidden-format-chars.js";

const CONTROL_CHAR_PATTERN =
  // Order matters: match the multi-char ANSI/OSC sequences BEFORE the C0
  // character class, otherwise the class would consume the leading ESC
  // (\x1B is in the \x0E-\x1F range) and leave the rest of the sequence
  // visible.
  //
  // The OSC branch uses a linear, non-backtracking body (`[^\x07\x1B]*`) and an
  // OPTIONAL terminator (BEL `\x07` or ST `ESC \`). The previous `.*?\x07`
  // form backtracked quadratically on many unterminated `ESC]` introducers
  // (a ReDoS DoS vector), and left unterminated OSC sequences only partially
  // stripped. The negated class stops at the next ESC so a following CSI is
  // still matched by its own branch.
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]|[\u202A-\u202E\u2066-\u2069]/gs;

export function stripControlChars(text: string): string {
  return text
    .replace(CONTROL_CHAR_PATTERN, "")
    .replace(ZERO_WIDTH_CHARS, "")
    .replace(HIDDEN_FORMAT_CHARS, "");
}

/**
 * Sanitize untrusted text for display on a SINGLE terminal line.
 *
 * `stripControlChars` deliberately preserves newline (\n), carriage return
 * (\r) and tab (\t), and does not touch the Unicode line/paragraph separators
 * U+2028/U+2029. Those surviving characters let untrusted text break out of a
 * one-line echo — e.g. a crafted topic containing "\r\n\r\nReceived topic: …"
 * could inject extra lines or CR-overwrite a label, spoofing a confirmation
 * prompt. This helper first strips the dangerous control sequences, then
 * collapses any run of line/paragraph separators, CR, LF and tabs into a
 * single space so the result always renders as one line.
 *
 * Display-only: callers must keep forwarding the original (unsanitized) value
 * to the engine/persistence layer.
 */
export function toSingleLineDisplay(text: string): string {
  return stripControlChars(text).replace(/[\r\n\t\u2028\u2029]+/g, " ");
}
