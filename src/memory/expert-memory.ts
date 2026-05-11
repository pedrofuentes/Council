/**
 * Expert memory recall (ROADMAP §3.1) — read past debate turns for an expert
 * from the local SQLite store and produce a structured `ExpertMemory` object
 * the prompt-builder can render into Section [7] of the system prompt.
 *
 * Heuristic extraction (no LLM summarisation yet — that is a future
 * enhancement; see ROADMAP §3.1 follow-up):
 *
 *   - **positions**       The first 1-2 sentences of each prior turn —
 *                         the expert's opening stance.
 *   - **updatedPriors**   Sentences containing reversal phrases such as
 *                         "I was wrong" or "on reflection".
 *   - **unresolved**      Sentences ending in '?' or containing markers
 *                         like "remains unclear" / "open question".
 *
 * Each entry is truncated to ~200 characters so Section [7] does not
 * dominate the prompt budget. The most-recent N turns are scanned
 * (default 20) — older turns are dropped to bound prompt size.
 */
import type { ExpertMemory } from "../core/prompt-builder.js";

import type { CouncilDatabase } from "./db.js";
import { DebateRepository } from "./repositories/debates.js";
import { ExpertRepository } from "./repositories/experts.js";
import { TurnRepository, type Turn } from "./repositories/turns.js";

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_DEBATES = 5;
const ENTRY_MAX_CHARS = 200;

const REVERSAL_PHRASES: readonly RegExp[] = [
  /\bI was wrong\b/i,
  /\brevising my position\b/i,
  /\bon reflection\b/i,
  /\bI now think\b/i,
];

const UNRESOLVED_MARKERS: readonly RegExp[] = [
  /\bremains unclear\b/i,
  /\bopen question\b/i,
  /\bunresolved\b/i,
];

export interface RecallOptions {
  /** Max number of the most-recent turns to scan. Default 20. */
  readonly maxTurns?: number;
  /**
   * Max number of the most-recent debates to scan. Default 5. Bounding
   * the debate fan-out keeps recall cheap and prevents an unbounded
   * history scan as a panel accumulates debates over time
   * (Sentinel pr222 cycle 3 #1 🟡).
   */
  readonly maxDebates?: number;
}

/**
 * Defensive sanitiser for any text recalled from a prior turn before it is
 * rendered into Section [7] MEMORY of the system prompt. Prior turns are
 * untrusted from a prompt-engineering standpoint — an expert (or, in
 * `--continue` mode, a human via the panel) could emit text that looks
 * like one of the prompt's own section headers (e.g. `"[8] CURRENT TASK"`)
 * and thereby smuggle instructions past the memory boundary.
 *
 * The sanitiser:
 *   1. Removes anything that looks like a Section header `[N]` at the
 *      start of a line (or the start of the string).
 *   2. Flattens all line breaks (`\n`, `\r`, `\r\n`) to single spaces so
 *      injected content cannot fake a new section by being multi-line.
 *   3. Collapses runs of whitespace.
 */
export function sanitizeMemorySnippet(text: string): string {
  if (text.length === 0) return text;
  // Strip [N] section-marker prefixes wherever they appear at the start of
  // a line (covers both string start and post-newline positions before
  // newlines are flattened).
  const noMarkers = text.replace(/(^|\n|\r|\u2028|\u2029)\[\d+\]\s+/g, "$1");
  // Flatten line breaks (including Unicode line/paragraph separators) to spaces.
  const flat = noMarkers.replace(/[\r\n\u2028\u2029]+/g, " ");
  // Collapse repeated whitespace.
  return flat.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Replace the contents of section `[7] MEMORY` in a previously-built
 * system prompt with a freshly-rendered memory block. Returns the
 * original prompt unchanged when `memory` is undefined or when the
 * `[7] MEMORY` / `[8] CURRENT TASK` markers cannot be located (defensive
 * fallback — caller should never receive a silently-broken prompt).
 *
 * Robustness: uses the **last** occurrence of the `\n[8] CURRENT TASK`
 * marker after `[7] MEMORY` rather than the first, so any injected copy
 * of `[8] CURRENT TASK` that survives sanitisation is absorbed into the
 * replaced span instead of extending the real task section.
 *
 * Used by `council resume --continue`, where the persisted system prompt
 * was rendered with no memory but a fresh recall is now available.
 */
export function applyRecalledMemory(
  systemMessage: string,
  memory: ExpertMemory | undefined,
): string {
  if (!memory) return systemMessage;
  const startMarker = "[7] MEMORY\n";
  const endMarker = "\n[8] CURRENT TASK";
  const startIdx = systemMessage.indexOf(startMarker);
  if (startIdx === -1) return systemMessage;
  // Use lastIndexOf so a stray injected "[8] CURRENT TASK" inside the old
  // memory block (or anywhere before the real task section) cannot trick
  // us into preserving attacker-controlled content past the boundary.
  const endIdx = systemMessage.lastIndexOf(endMarker);
  if (endIdx === -1 || endIdx < startIdx + startMarker.length) return systemMessage;
  const block = renderMemoryBlock(sanitizeMemory(memory));
  return (
    systemMessage.slice(0, startIdx + startMarker.length) + block + systemMessage.slice(endIdx)
  );
}

function sanitizeMemory(memory: ExpertMemory): ExpertMemory {
  return {
    positions: memory.positions.map(sanitizeMemorySnippet).filter((s) => s.length > 0),
    updatedPriors: memory.updatedPriors.map(sanitizeMemorySnippet).filter((s) => s.length > 0),
    unresolved: memory.unresolved.map(sanitizeMemorySnippet).filter((s) => s.length > 0),
  };
}

function renderMemoryBlock(memory: ExpertMemory): string {
  const sections: string[] = [];
  if (memory.positions.length > 0) {
    sections.push("Positions you have taken:");
    for (const p of memory.positions) sections.push(`  - ${p}`);
  }
  if (memory.updatedPriors.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push("Updated priors (revise your weighting accordingly):");
    for (const u of memory.updatedPriors) sections.push(`  - ${u}`);
  }
  if (memory.unresolved.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push("Unresolved questions from prior sessions:");
    for (const q of memory.unresolved) sections.push(`  - ${q}`);
  }
  if (sections.length === 0) {
    return "(no prior memory — this is your first session with this panel)";
  }
  return sections.join("\n");
}

/**
 * Read the expert's past turns for the given panel and synthesise an
 * `ExpertMemory`. Returns `undefined` when the expert is unknown or has
 * no prior turns recorded.
 */
export async function recallMemory(
  db: CouncilDatabase,
  panelId: string,
  expertSlug: string,
  options?: RecallOptions,
): Promise<ExpertMemory | undefined> {
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxDebates = options?.maxDebates ?? DEFAULT_MAX_DEBATES;

  const experts = await new ExpertRepository(db).findByPanelId(panelId);
  const expert = experts.find((e) => e.slug === expertSlug);
  if (!expert) return undefined;

  const allDebates = await new DebateRepository(db).findByPanelId(panelId);
  if (allDebates.length === 0) return undefined;

  // Sentinel pr222 cycle 3 #1 🟡: bound the debate scan to the most
  // recent N. `findByPanelId` is ordered by startedAt ascending — take
  // the tail to get the newest debates without loading everything.
  const debates =
    allDebates.length > maxDebates ? allDebates.slice(-maxDebates) : allDebates;

  const turnRepo = new TurnRepository(db);
  const collected: Turn[] = [];
  for (const d of debates) {
    const turns = await turnRepo.findByDebateId(d.id);
    for (const t of turns) {
      if (t.expertId === expert.id && t.speakerKind === "expert") {
        collected.push(t);
      }
    }
  }
  if (collected.length === 0) return undefined;

  // Sort chronologically (createdAt is an ISO-8601 string — lexically
  // sortable) and keep only the most recent maxTurns.
  collected.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const recent = collected.slice(-maxTurns);

  const positions: string[] = [];
  const updatedPriors: string[] = [];
  const unresolved: string[] = [];

  for (const turn of recent) {
    const sentences = splitSentences(turn.content);
    if (sentences.length === 0) continue;

    // positions: first 1-2 sentences
    const opener = sentences.slice(0, 2).join(" ").trim();
    if (opener.length > 0) {
      const cleaned = sanitizeMemorySnippet(truncate(opener));
      if (cleaned.length > 0) positions.push(cleaned);
    }

    // updatedPriors: sentences matching reversal phrases
    for (const s of sentences) {
      if (REVERSAL_PHRASES.some((re) => re.test(s))) {
        const cleaned = sanitizeMemorySnippet(truncate(s.trim()));
        if (cleaned.length > 0) updatedPriors.push(cleaned);
      }
    }

    // unresolved: question-mark sentences or marker phrases
    for (const s of sentences) {
      const trimmed = s.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.endsWith("?") || UNRESOLVED_MARKERS.some((re) => re.test(trimmed))) {
        const cleaned = sanitizeMemorySnippet(truncate(trimmed));
        if (cleaned.length > 0) unresolved.push(cleaned);
      }
    }
  }

  return {
    positions,
    updatedPriors,
    unresolved,
  };
}

/**
 * Split a block of text into sentences. The splitter is intentionally
 * naïve (period / question / exclamation, then whitespace) — the recall
 * is heuristic and downstream LLM consumption is tolerant of imperfect
 * boundaries.
 */
function splitSentences(text: string): readonly string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // Split on sentence-terminator + whitespace, keeping the terminator.
  const parts: string[] = [];
  const re = /[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed)) !== null) {
    const piece = match[0].trim();
    if (piece.length > 0) parts.push(piece);
  }
  return parts.length > 0 ? parts : [trimmed];
}

function truncate(s: string): string {
  if (s.length <= ENTRY_MAX_CHARS) return s;
  return s.slice(0, ENTRY_MAX_CHARS) + "…";
}
