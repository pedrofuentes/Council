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
  return defanged.length > MAX ? `${defanged.slice(0, MAX - 1)}…` : defanged;
}

/**
 * Escape fence-breaking characters. Use inside `<tag>...</tag>` fences
 * around untrusted content so no XML-like closing tag — including
 * whitespace-padded variants — can break out of the fence.
 */
export function escapeFenceContent(s: string): string {
  return s.replace(/</g, "&lt;");
}

/**
 * Sanitize multi-line prompt blocks (debate protocols, output contracts,
 * persisted memory dumps, etc.) before interpolating them into a
 * privileged prompt.
 *
 * Behaves like {@link sanitizePromptField} EXCEPT it preserves newline
 * characters so the original block structure (paragraphs, bullet lists)
 * survives. Callers must therefore wrap the result in an explicit fence
 * if they need to prevent the block from forging fresh top-level prompt
 * sections.
 *
 * Pipeline: NFKC normalize → strip bidi/zero-width → normalize exotic line
 * separators (NEL/LS/PS) to `\n` → strip C0 controls (except tab/newline/CR)
 * → defang `[NN]` section markers → cap length.
 */
export function sanitizePromptBlock(raw: string, maxLength = 4000): string {
  const normalized = raw.normalize("NFKC");
  const unicodeSafe = normalized.replace(
    /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    "",
  );
  // Normalize exotic line/paragraph separators — NEL (U+0085), LINE
  // SEPARATOR (U+2028), PARAGRAPH SEPARATOR (U+2029) — to a plain `\n` so
  // untrusted content cannot smuggle hidden line breaks past the block
  // sanitizer (issue #2066). The block already permits `\n`, so legitimate
  // line-break semantics survive while the invisible/ambiguous separators do
  // not. Runs before the C0 strip so the introduced `\n` is preserved.
  const lineSepNormalized = unicodeSafe.replace(/[\u0085\u2028\u2029]/g, "\n");
  // eslint-disable-next-line no-control-regex
  const stripped = lineSepNormalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const defanged = stripped.replace(/\[(\d+)\]/g, "(sec-$1)");
  return defanged.length > maxLength ? `${defanged.slice(0, maxLength - 1)}…` : defanged;
}

/**
 * Combined helper: {@link sanitizePromptBlock} followed by
 * {@link escapeFenceContent}. Use for multi-line untrusted content that
 * will be interpolated inside an XML-like fence.
 */
export function sanitizeFenced(raw: string, maxLength = 4000): string {
  return escapeFenceContent(sanitizePromptBlock(raw, maxLength));
}

/**
 * Heuristic check for instruction-like patterns commonly used in prompt
 * injection attempts. Returns the source strings of every matching
 * pattern. Use as a defense-in-depth signal (logging, telemetry, soft
 * warnings) — NOT as a hard block, since legitimate content can match
 * these patterns and determined attackers can rephrase to evade them.
 */
export function detectInstructionPatterns(text: string): readonly string[] {
  const PATTERNS = [
    /\bignore\s+(all\s+)?(previous|prior|above|earlier)\b/i,
    /\bdisregard\s+(all\s+)?(previous|prior|above|instructions?)\b/i,
    /\boverride\b/i,
    /\bsystem\s*:/i,
    /\badmin\s*:/i,
    /\bnew\s+instructions?\s*:/i,
    /\byou\s+are\s+now\b/i,
    /\bforget\s+(everything|all|your)\b/i,
  ];
  return PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}
