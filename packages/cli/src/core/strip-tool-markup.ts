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
 *
 * Performance / safety (#2413): every step runs in O(n) over the input length
 * with no backtracking. Sanitization tokenizes the input in a single forward
 * pass and trims whitespace with a manual character scan — it deliberately
 * avoids the global lazy paired-block regex (`<(tag)>[\s\S]*?</\1>`) and the
 * multiline trailing-whitespace regex (`/[ \t]+$/gm`), both of which are
 * super-linear on adversarial input (many unmatched tool tags, or a long run
 * of horizontal whitespace not terminated by a newline). There is NO input
 * length cap: capping BEFORE sanitizing would slice a tool tag mid-token and
 * leak the surviving fragment (and any inner payload of a cross-boundary
 * paired block) as prose, defeating the sanitizer. Because the algorithm is
 * genuinely linear, the full input is always sanitized.
 */

/** Char codes used by the manual scans (avoids per-char string allocation). */
const CHAR_TAB = 9;
const CHAR_SPACE = 32;
const CHAR_SLASH = 47; // '/'

/**
 * Known tool/skill-invocation tag names, with an optional XML namespace prefix
 * (e.g. `antml:invoke`). Order matters: multi-word names (`search_skill`,
 * `list_skills`) precede the bare `skill` alternative so the longest match wins.
 */
const TOOL_TAG = String.raw`(?:[A-Za-z][\w.-]*:)?(?:function_calls|invoke|parameter|search_skill|list_skills|skill)`;

/**
 * Sticky matcher for a tool-tag NAME (allow-listed name + word boundary),
 * anchored at a specific offset via `lastIndex`. The `\b` prevents matching
 * `<invoker>` or `<skills>`; the `y` (sticky) flag requires the name to begin
 * exactly at the scanned offset, mirroring `<`/`</` immediately preceding it.
 */
const TOOL_TAG_MATCHER = new RegExp(String.raw`${TOOL_TAG}\b`, "iy");

/** A single complete tool tag located in the input. */
interface ToolTag {
  /** Index of the opening `<`. */
  readonly start: number;
  /** Index one past the closing `>`. */
  readonly end: number;
  /** `"open"` for `<tag …>` (incl. self-closing), `"close"` for `</tag …>`. */
  readonly kind: "open" | "close";
  /** Lower-cased, namespace-inclusive tag name used for pairing. */
  readonly name: string;
}

/**
 * Locate every complete tool tag in `text` in a single O(n) forward pass.
 *
 * For each `<`, we optionally consume a leading `/` (close tag), require an
 * allow-listed name at that offset, then take the FIRST following `>` as the
 * tag end (equivalent to the old `[^>]*>` — everything up to that `>` is, by
 * construction, non-`>`). If a name candidate has no `>` anywhere after it,
 * no complete tag can exist in the remainder, so we stop — this keeps input
 * like `<invoke<invoke<invoke…` (never terminated) strictly linear.
 */
function scanToolTags(text: string): readonly ToolTag[] {
  const tags: ToolTag[] = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    const isClose = text.charCodeAt(lt + 1) === CHAR_SLASH;
    const nameStart = isClose ? lt + 2 : lt + 1;
    TOOL_TAG_MATCHER.lastIndex = nameStart;
    if (TOOL_TAG_MATCHER.exec(text) === null) {
      i = lt + 1;
      continue;
    }
    // On a successful sticky match, lastIndex is advanced to the name's end.
    const nameEnd = TOOL_TAG_MATCHER.lastIndex;
    const gt = text.indexOf(">", nameEnd);
    if (gt === -1) {
      break;
    }
    tags.push({
      start: lt,
      end: gt + 1,
      kind: isClose ? "close" : "open",
      name: text.slice(nameStart, nameEnd).toLowerCase(),
    });
    i = gt + 1;
  }
  return tags;
}

/**
 * Reduce located tags to the character ranges to delete, mirroring the old
 * "remove paired blocks, then remove lone tags" semantics without a regex.
 *
 * A backward pass records, for each open tag, the nearest later close tag of
 * the same name (the lazy `</\1>` pairing). A forward pass then removes each
 * paired open together with everything through its close (jumping past the
 * consumed region, exactly like the lazy block match); tags with no partner
 * are removed on their own. Overall O(n).
 */
function toolTagRemovalRanges(
  tags: readonly ToolTag[],
): readonly (readonly [number, number])[] {
  const matchedClose = new Map<number, number>();
  const lastCloseByName = new Map<string, number>();
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const tag = tags[i];
    if (tag === undefined) {
      continue;
    }
    if (tag.kind === "close") {
      lastCloseByName.set(tag.name, i);
    } else {
      const close = lastCloseByName.get(tag.name);
      if (close !== undefined) {
        matchedClose.set(i, close);
      }
    }
  }

  const ranges: (readonly [number, number])[] = [];
  let i = 0;
  while (i < tags.length) {
    const tag = tags[i];
    if (tag === undefined) {
      i += 1;
      continue;
    }
    const close = tag.kind === "open" ? matchedClose.get(i) : undefined;
    if (close !== undefined) {
      const closeTag = tags[close];
      if (closeTag !== undefined) {
        ranges.push([tag.start, closeTag.end]);
        i = close + 1;
        continue;
      }
    }
    ranges.push([tag.start, tag.end]);
    i += 1;
  }
  return ranges;
}

/** Concatenate the input minus the given (ascending, non-overlapping) ranges. */
function deleteRanges(
  text: string,
  ranges: readonly (readonly [number, number])[],
): string {
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      out += text.slice(cursor, start);
    }
    cursor = end;
  }
  if (cursor < text.length) {
    out += text.slice(cursor);
  }
  return out;
}

/**
 * Drop trailing spaces/tabs from each line via a manual character scan — a
 * genuinely linear replacement for `/[ \t]+$/gm`, which backtracks
 * quadratically on a long horizontal-whitespace run not ended by a newline.
 */
function trimTrailingHorizontalWhitespace(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    let end = line.length;
    while (end > 0) {
      const code = line.charCodeAt(end - 1);
      if (code !== CHAR_SPACE && code !== CHAR_TAB) {
        break;
      }
      end -= 1;
    }
    if (end !== line.length) {
      lines[i] = line.slice(0, end);
    }
  }
  return lines.join("\n");
}

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
 *   - Linear complexity: every step is O(n) with no backtracking, so the whole
 *     input is sanitized without a length cap and without stalling the event
 *     loop on adversarial input (#2413).
 */
export function stripToolMarkup(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const tags = scanToolTags(text);
  if (tags.length === 0) {
    return text; // No tool markup present: return original unchanged.
  }

  const stripped = deleteRanges(text, toolTagRemovalRanges(tags));

  // Collapsing blank lines with a greedy `\n{3,}` and `.trim()` are both
  // linear (no backtracking pathology).
  return trimTrailingHorizontalWhitespace(stripped)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
