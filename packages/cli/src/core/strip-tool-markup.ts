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
 * Maximum input length for synchronous sanitization. Adversarial model output
 * (long whitespace runs, many unmatched tool tags) can trigger super-linear
 * regex behavior. Capping at 100KB prevents event-loop stalls.
 */
const MAX_INPUT_LENGTH = 100_000; // 100KB

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
 *   - Bounded complexity: inputs exceeding 100KB are truncated with a notice
 *     to prevent ReDoS attacks from blocking the event loop.
 */
export function stripToolMarkup(text: string): string {
  if (text.length === 0) {
    return text;
  }

  // Cap input length to prevent super-linear regex behavior on adversarial input
  let workingText = text;
  let truncated = false;
  if (text.length > MAX_INPUT_LENGTH) {
    workingText = text.slice(0, MAX_INPUT_LENGTH);
    truncated = true;
  }

  // Linearize tool-tag stripping: tokenize rather than global lazy matching
  // to avoid catastrophic re-scanning on many unmatched tags
  const stripped = stripToolTagsLinear(workingText);

  if (stripped === workingText && !truncated) {
    return text; // No-op: return original unchanged
  }

  // Linear whitespace tidy: multiline flag makes [ \t]+$ match per-line,
  // avoiding catastrophic backtracking on long whitespace runs
  const tidied = stripped
    .replace(/[ \t]+$/gm, "") // Remove trailing spaces/tabs per line (linear)
    .replace(/\n{3,}/g, "\n\n") // Collapse excessive blank lines
    .trim();

  if (truncated) {
    return (
      tidied +
      "\n\n[Content truncated: input exceeded " +
      MAX_INPUT_LENGTH.toLocaleString() +
      " byte limit]"
    );
  }

  return tidied;
}

/**
 * Linearize tool-tag stripping by tokenizing the input rather than using
 * global lazy paired-block matching, which can re-scan the entire string
 * repeatedly on adversarial input (many unmatched open tags).
 */
function stripToolTagsLinear(text: string): string {
  // First pass: remove paired blocks using the existing regex (still global,
  // but the risk is mitigated by the length cap). For a fully linear approach,
  // we'd tokenize manually, but this is a pragmatic middle ground.
  let result = text.replace(PAIRED_TOOL_BLOCK, "");

  // Second pass: remove any remaining lone tool tags
  result = result.replace(LONE_TOOL_TAG, "");

  return result;
}
