/**
 * Tolerant JSON recovery for LLM responses.
 *
 * LLMs asked for "JSON only" still routinely wrap their answer in markdown
 * code fences, sandwich it between prose ("Sure, here you go: ..."), or emit
 * JSON5-style trailing commas that strict `JSON.parse` rejects. These helpers
 * recover the embedded JSON without inventing a new parser: they produce an
 * ordered list of candidate substrings (most→least likely) and parse each
 * strictly first, then with a trailing-comma-tolerant retry.
 *
 * This module is the shared home for the recovery primitives originally
 * written for the documents profile-analyzer (F16/F20, PR #1118) and now
 * reused by the `council conclude` synthesizer (PM-04). Callers layer their
 * own schema validation on top: iterate {@link jsonCandidates}, parse with
 * {@link tryParseJSON}, and keep the first candidate that satisfies their
 * shape. Every function here is pure and side-effect-free — none throw.
 */

/**
 * Strip a single leading/trailing markdown code fence that is flush against
 * the string ends (the common "```json\n{...}\n```" shape). Does nothing
 * when the fence is embedded in surrounding prose — see
 * {@link extractFencedBlock} for that case.
 */
export function stripCodeFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

/**
 * Extract the contents of the first fenced code block (``` ``` ``` or
 * ``` ```json ```) anywhere in the response — including when the model
 * prefixes the fence with prose ("Here's the profile:\n```json\n...").
 * The leading-/trailing-fence strip in {@link stripCodeFence} only fires
 * when the fence is flush against the string ends; this recovers the
 * common "prose, then fenced JSON" shape.
 */
export function extractFencedBlock(raw: string): string | null {
  const match = raw.match(/```(?:[a-zA-Z0-9]+)?[ \t]*\r?\n?([\s\S]*?)```/);
  return match && match[1] !== undefined ? match[1].trim() : null;
}

/**
 * Isolate the first balanced top-level JSON object (`{ ... }`) in `s`,
 * skipping over any leading prose and ignoring braces that appear inside
 * string literals (so `"a } b"` does not terminate the scan). Returns
 * `null` when no balanced object is present.
 */
export function isolateBalancedObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Insignificant whitespace between JSON tokens. Mirrors the `\s` the
 *  original trailing-comma regex used, so structural stripping stays
 *  behavior-preserving outside string literals. */
const TOKEN_WHITESPACE = /\s/;

/**
 * Remove *structural* trailing commas before a closing `}` or `]`. LLMs
 * frequently emit JSON5-style trailing commas that strict `JSON.parse`
 * rejects. Applied only as a fallback after a strict parse fails, so
 * well-formed responses are never touched.
 *
 * String-aware (#1122): a comma is dropped only when it sits OUTSIDE any
 * JSON string literal AND the next non-whitespace character is `}` or `]`.
 * A naive `/,(\s*[}\]])/g` regex is not string-aware — on already-invalid
 * input it rewrites an in-string `comma + whitespace + }/]`
 * (e.g. `{"x":"a, ]",}` → `{"x":"a ]"}`), corrupting the recovered value.
 * This scan tracks in-string state and honors backslash escapes so `\"`
 * never terminates a string. Only the comma itself is removed; surrounding
 * whitespace and the bracket are preserved, exactly as the original
 * regex's `$1` replacement did.
 */
export function stripTrailingCommas(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Look past insignificant whitespace: drop this comma only when the
      // next non-whitespace character is a structural close (`}` or `]`).
      let j = i + 1;
      while (j < s.length && TOKEN_WHITESPACE.test(s.charAt(j))) j++;
      const next = s.charAt(j);
      if (next === "}" || next === "]") {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Best-effort parse of a single candidate string: strict `JSON.parse`
 * first, then a trailing-comma-tolerant retry. Returns `undefined` when
 * both attempts fail (never throws).
 */
export function tryParseJSON(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through to the tolerant retry */
  }
  try {
    return JSON.parse(stripTrailingCommas(candidate));
  } catch {
    return undefined;
  }
}

/**
 * Ordered, de-duplicated list of candidate JSON strings to attempt, most
 * likely to least likely. Covers raw JSON, code-fenced JSON (with or
 * without surrounding prose), and prose-wrapped bare JSON.
 */
export function jsonCandidates(raw: string): readonly string[] {
  const out: string[] = [];
  const add = (value: string | null | undefined): void => {
    if (value === null || value === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  };
  const fenceStripped = stripCodeFence(raw);
  const fenced = extractFencedBlock(raw);
  add(fenceStripped);
  add(fenced);
  add(raw);
  add(isolateBalancedObject(fenceStripped));
  if (fenced !== null) add(isolateBalancedObject(fenced));
  add(isolateBalancedObject(raw));
  return out;
}
