/**
 * `stripToolMarkup()` — removes raw tool/skill-invocation markup that a model
 * may leak into an expert's prose response (F-12 / T-08).
 *
 * Copilot-class models occasionally emit tool-call XML (an `invoke` block, a
 * `search_skill` / `list_skills` tag, a `Skill` tag, or a `function_calls`
 * wrapper) instead of, or interleaved with, prose. Council has no tools wired
 * for experts, so this markup is never actionable — it must not reach the
 * terminal or be persisted to the transcript. This sanitizer neutralizes the
 * finalized/accumulated expert content at a single chokepoint (see
 * `core/debate.ts`), which also catches markup split across streaming deltas.
 *
 * Design goal: be PRECISE, not greedy. Only the specific, known tool-tag
 * shapes are removed. Ordinary angle-bracket content — TypeScript generics
 * (`Array<string>`), relational comparisons (`a < b`), and HTML shown inline
 * or inside code fences (`<div>`, `<span>`, `<section>`) — MUST survive
 * untouched. We therefore match an allow-list of tag NAMES anchored by a word
 * boundary, never a blanket `<[^>]*>`.
 */

/**
 * Known tool/skill-invocation tag names, with an optional XML namespace prefix
 * (e.g. `antml:invoke`). Order matters: multi-word names (`search_skill`,
 * `list_skills`) precede the bare `skill` alternative so the longest match wins.
 */
const TOOL_TAG = String.raw`(?:[A-Za-z][\w.-]*:)?(?:function_calls|invoke|parameter|search_skill|list_skills|skill)`;

/**
 * Paired blocks: `<tag …> … </tag>` including everything in between (e.g. an
 * `invoke` wrapping nested `parameter`s). The `\b` after the captured name
 * prevents matching `<invoker>` or `<skills>`; the case-insensitive
 * back-reference `\1` pairs the close tag to the exact open tag captured.
 */
const PAIRED_TOOL_BLOCK = new RegExp(String.raw`<(${TOOL_TAG})\b[^>]*>[\s\S]*?<\/\1\s*>`, "gi");

/**
 * Any remaining lone tool tag: an orphaned open (`<invoke …>`), an orphaned
 * close (`</search_skill>`), or a self-closing tag (`<list_skills/>`).
 */
const LONE_TOOL_TAG = new RegExp(String.raw`<\/?${TOOL_TAG}\b[^>]*\/?>`, "gi");

/**
 * Strip known tool/skill-invocation markup from `text`, returning prose only.
 *
 * Guarantees:
 *   - No-op fidelity: if no tool markup is present, the ORIGINAL string is
 *     returned byte-for-byte (no whitespace mangling) — the mock/plain-prose
 *     path is never altered.
 *   - Conservative tidy: whitespace is only cleaned up when a removal actually
 *     occurred, and only where a stripped block left blank lines or trailing
 *     spaces behind.
 */
export function stripToolMarkup(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const stripped = text.replace(PAIRED_TOOL_BLOCK, "").replace(LONE_TOOL_TAG, "");
  if (stripped === text) {
    return text;
  }

  return stripped
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
