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
