/**
 * Shared defang for any externally-sourced string interpolated into a
 * privileged prompt — system prompts (`src/core/prompt-builder.ts`) and
 * meta-prompts that interpolate persisted data before an untrusted-data
 * fence (`src/core/documents/profile-analyzer.ts`).
 *
 * The transformation is intentionally conservative:
 *   - Strip C0 control characters (except tab/newline/carriage return),
 *     then strip DEL.
 *   - Collapse runs of `\r\n`, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR
 *     to a single space so a single field cannot forge fresh top-level
 *     lines in the prompt.
 *   - Neutralize bracketed numeric section-marker prefixes (`[NN]`) so
 *     attacker-controlled text cannot impersonate a real prompt section.
 *   - Cap total length so a runaway field cannot drown the prompt.
 *
 * Unicode hardening (issue #409) runs first, before any of the legacy
 * passes so they see a canonical, BMP-safe string:
 *   - NFKC normalize so fullwidth/compatibility characters (e.g.
 *     `Ａ` → `A`, `［１］` → `[1]`, `ﬁ` → `fi`) cannot bypass
 *     downstream pattern matching such as the `[NN]` section-marker
 *     defang.
 *   - Strip bidi override / isolate / mark characters (U+202A-U+202E,
 *     U+2066-U+2069, U+200E, U+200F) that can visually reorder text
 *     to disguise injected content.
 *   - Strip zero-width characters (U+200B-U+200D, U+FEFF) that can act
 *     as invisible padding or token separators.
 */
export function sanitizePromptField(raw: string): string {
  const normalized = raw.normalize("NFKC");
  const unicodeSafe = normalized.replace(
    /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    "",
  );
  // eslint-disable-next-line no-control-regex
  const stripped = unicodeSafe.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const collapsed = stripped.replace(/[\r\n\u0085\u2028\u2029]+/g, " ");
  const defanged = collapsed.replace(/\[(\d+)\]/g, "(sec-$1)");
  const MAX = 2000;
  return defanged.length > MAX ? `${defanged.slice(0, MAX)}…` : defanged;
}
