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
 *   - ANSI CSI sequences:  ESC [ ... letter
 *   - OSC sequences:        ESC ] ... BEL
 *   - C0 controls except newline (\n), tab (\t), carriage return (\r)
 *   - DEL (0x7F)
 *
 * Printable Unicode (emoji, accents, CJK) is preserved.
 */
const CONTROL_CHAR_PATTERN =
  // Order matters: match the multi-char ANSI/OSC sequences BEFORE the C0
  // character class, otherwise the class would consume the leading ESC
  // (\x1B is in the \x0E-\x1F range) and leave the rest of the sequence
  // visible. eslint-disable-next-line no-control-regex
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-9;]*[a-zA-Z]|\x1B\].*?\x07|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHAR_PATTERN, "");
}
