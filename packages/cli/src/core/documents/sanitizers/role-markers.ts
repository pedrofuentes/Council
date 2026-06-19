/**
 * Role-marker sanitization for extracted document content.
 *
 * Strips or neutralizes sequences in untrusted document text that
 * resemble LLM role markers. Coverage spans the conventions of the
 * major model families a document might try to impersonate:
 *
 *   - OpenAI ChatML — `<|im_start|>`, `<|im_end|>`
 *   - Pipe-delimited role tags — `<|system|>`, `<|user|>`,
 *     `<|assistant|>`, `<|tool|>`
 *   - Llama-2 — `[INST]` / `[/INST]`, `<<SYS>>` / `<</SYS>>`
 *   - Llama-3 — `<|begin_of_text|>`, `<|start_header_id|>`,
 *     `<|end_header_id|>`, `<|eot_id|>`
 *   - XML-style tags — `<system>`/`</system>`, `<user>`/`</user>`,
 *     `<assistant>`/`</assistant>`
 *   - Anthropic / transcript-style line-start labels — `Human:`,
 *     `Assistant:`, `System:`, `User:`
 *
 * Neutralization wraps the matched sequence in `[role-marker: ...]`
 * brackets so the text is no longer interpretable as a role boundary
 * while remaining forensically visible — important when investigating
 * whether a document was a deliberate injection attempt or merely a
 * legitimate document about AI systems.
 *
 * This is a defense-in-depth measure layered on top of per-document
 * delimiter wrapping. It does not — and cannot — fully prevent
 * sophisticated prompt-injection attacks; see
 * `docs/ARCHITECTURE.md` §Document Trust Model.
 */

/**
 * Audit event emitted when sanitization replaces one or more markers.
 *
 * @property replacementCount - Total number of marker occurrences that
 *   were neutralized in a single {@link sanitizeRoleMarkers} call.
 */
export interface RoleMarkerSanitizationEvent {
  readonly replacementCount: number;
}

/**
 * Optional callbacks for {@link sanitizeRoleMarkers}.
 *
 * @property onSanitize - Invoked once per call when at least one
 *   marker was replaced. Not invoked when the input contains no
 *   markers, so the caller does not need to filter no-op events.
 */
export interface SanitizeRoleMarkersOptions {
  readonly onSanitize?: (event: RoleMarkerSanitizationEvent) => void;
}

/*
 * Each pattern is intentionally narrow — we want to neutralize
 * obvious role boundary markers without mangling legitimate prose. In
 * particular the line-start labels (`Human:` / `Assistant:` /
 * `System:` / `User:`) are matched only at the start of a line
 * (multiline flag) so a sentence like "the Human: condition…" is
 * preserved.
 *
 * Casing: XML-style tags use the `i` flag so `<SYSTEM>` is also
 * neutralized. ChatML, pipe-delimited and Llama special tokens are
 * conventionally fixed-case and we match them literally to avoid
 * pathological false positives.
 */
const ROLE_MARKER_PATTERNS: readonly RegExp[] = [
  // OpenAI ChatML.
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,
  // Pipe-delimited role tags.
  /<\|user\|>/g,
  /<\|assistant\|>/g,
  /<\|system\|>/g,
  /<\|tool\|>/g,
  // Llama-3 header / sequence tokens.
  /<\|begin_of_text\|>/g,
  /<\|eot_id\|>/g,
  /<\|start_header_id\|>/g,
  /<\|end_header_id\|>/g,
  // Llama-2 instruction / system markers.
  /\[INST\]/g,
  /\[\/INST\]/g,
  /<<SYS>>/g,
  /<<\/SYS>>/g,
  // XML-style role tags.
  /<\/?system>/gi,
  /<\/?user>/gi,
  /<\/?assistant>/gi,
  // Transcript-style line-start labels.
  /^Human:/gm,
  /^Assistant:/gm,
  /^System:/gm,
  /^User:/gm,
];

/**
 * Replace every recognized role marker in `text` with a bracketed,
 * inert representation (e.g. `[role-marker: <|im_start|>]`).
 *
 * The function is pure aside from the optional `onSanitize` callback,
 * which fires at most once per call and only when at least one
 * replacement occurred.
 *
 * @param text - Untrusted text (typically extracted document content).
 * @param options - Optional logger and future expansion hooks.
 * @returns The sanitized text. Returns the original reference when
 *   no markers were found, so callers can cheaply check for changes
 *   via reference equality if desired.
 */
export function sanitizeRoleMarkers(
  text: string,
  options: SanitizeRoleMarkersOptions = {},
): string {
  if (text.length === 0) return text;

  let result = text;
  let replacementCount = 0;

  for (const pattern of ROLE_MARKER_PATTERNS) {
    result = result.replace(pattern, (match) => {
      replacementCount += 1;
      return `[role-marker: ${match}]`;
    });
  }

  if (replacementCount > 0) {
    options.onSanitize?.({ replacementCount });
  }

  return result;
}
