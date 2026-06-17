/**
 * Chat input router for panel chat (Roadmap 5.5 + 5.6).
 *
 * `parseUserInput()` classifies a raw line typed in panel chat into one
 * of three kinds:
 *
 *   - `general`  — no leading directive; all panelists respond
 *   - `mention`  — one or more leading `@<slug>` tokens; only the named
 *                  panelists respond
 *   - `convene`  — leading `@convene <topic>`; triggers a structured
 *                  4-phase debate inline
 *
 * Parsing rules:
 *   - `@convene` is a RESERVED keyword and is matched first — even when
 *     an expert in the panel happens to have slug `convene`.
 *   - Mentions must appear contiguously at the START of the message;
 *     `ask @cto …` is plain text.
 *   - Unknown `@slug` (one that is not in `availableSlugs`) raises an
 *     error listing the available slugs (case-sensitive match).
 *   - Repeated mentions are deduplicated, preserving first-occurrence
 *     order.
 *
 * Pure: no I/O, no globals.
 */

export interface ParsedInput {
  readonly type: "general" | "mention" | "convene";
  readonly targetSlugs: readonly string[];
  readonly content: string;
}

const CONVENE_KEYWORD = "convene";
// Allows lowercase ASCII, digits, dashes — matches the slug grammar used
// elsewhere (e.g. expert library, panel YAML). Anchored at start.
const LEADING_MENTION_RE = /^@([A-Za-z0-9][A-Za-z0-9_-]*)\b/;
// A leading `@` immediately followed by a quote denotes a display-name
// mention (e.g. `@"Sasha Lin"`). Slugs never contain quotes, so this can
// only be an attempt to address an expert by display name.
const LEADING_QUOTED_MENTION_RE = /^@["']/;

export function parseUserInput(
  input: string,
  availableSlugs: readonly string[],
): ParsedInput {
  const trimmed = input.trim();

  // @convene wins over any expert-slug match so a panel that happens to
  // include an expert named "convene" can't shadow the directive.
  if (trimmed === "@convene" || trimmed.startsWith("@convene ") || trimmed.startsWith("@convene\t")) {
    const topic = trimmed.slice("@convene".length).trim();
    if (topic.length === 0) {
      throw new Error("@convene requires a topic. Usage: @convene <topic>");
    }
    return { type: "convene", targetSlugs: [], content: topic };
  }

  // Reject display-name mentions explicitly. Without this guard a quoted
  // mention fails the slug regex below, leaving `slugs` empty, and would
  // be silently broadcast to the whole panel — masquerading as a targeted
  // message that never routed. Erroring keeps routing unambiguous.
  if (LEADING_QUOTED_MENTION_RE.test(trimmed)) {
    throw new Error(
      `Display-name mentions like @"..." are not supported — address an expert by slug instead. Available experts: ${availableSlugs.join(", ")}`,
    );
  }

  // Try to consume one or more leading `@slug` tokens.
  const slugs: string[] = [];
  const seen = new Set<string>();
  let rest = trimmed;
  while (true) {
    const match = LEADING_MENTION_RE.exec(rest);
    if (!match) break;
    const slug = match[1] as string;
    if (!availableSlugs.includes(slug)) {
      throw new Error(
        `Expert "${slug}" is not in this panel. Available experts: ${availableSlugs.join(", ")}`,
      );
    }
    if (!seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
    rest = rest.slice(match[0].length).replace(/^\s+/, "");
  }

  if (slugs.length === 0) {
    return { type: "general", targetSlugs: [], content: trimmed };
  }

  if (rest.length === 0) {
    throw new Error(
      `@${slugs[0]} requires a message. Usage: @${slugs[0]} <message>`,
    );
  }

  return { type: "mention", targetSlugs: slugs, content: rest };
}

// Re-export the keyword so callers (e.g. help text) can reference the
// canonical name without duplicating the literal.
export const CONVENE_DIRECTIVE = `@${CONVENE_KEYWORD}`;

/**
 * Render a one-line roster of addressable expert slugs for the panel-chat
 * startup banner, e.g. `Experts: @sasha-cfo, @diego-cto — use @<slug> to
 * address a specific expert.` Returns an empty string when there are no
 * slugs so callers can skip rendering. Pure: no I/O.
 */
export function formatExpertRoster(slugs: readonly string[]): string {
  if (slugs.length === 0) return "";
  const list = slugs.map((s) => `@${s}`).join(", ");
  return `Experts: ${list} — use @<slug> to address a specific expert.`;
}
