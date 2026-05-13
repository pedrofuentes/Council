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
 * `[7] MEMORY` marker cannot be located (defensive fallback — caller
 * should never receive a silently-broken prompt).
 *
 * The end of the memory block is the next `\n[N] ` section header after
 * `[7] MEMORY`. The section number is NOT fixed: `buildSystemPrompt`
 * may inject `[8] PERSONA PROFILE` and/or `[9] PANEL MEMBERSHIPS`
 * between `[7] MEMORY` and `[N] CURRENT TASK`, so any hardcoded
 * `[8] CURRENT TASK` end marker silently fails to patch memory in those
 * configurations (issue #364).
 *
 * Injection defense: a malicious turn could embed a `[N] ` marker
 * inside the memory body that survives `sanitizeMemorySnippet`. We
 * pick the **first** post-`[7] MEMORY` section marker — which is the
 * legitimate next section emitted by `buildSystemPrompt`, never an
 * injected one (injected markers in memory would appear at the line
 * start AFTER the legitimate header in source order). Combined with
 * the snippet sanitiser, this prevents attacker content from spilling
 * past the memory boundary.
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
  const startIdx = systemMessage.indexOf(startMarker);
  if (startIdx === -1) return systemMessage;
  const contentStart = startIdx + startMarker.length;
  // End of memory body = first "\n[N] " section header after [7] MEMORY
  // content begins. This handles task at [8], [9], or [10] and any
  // intervening sections (PERSONA PROFILE, PANEL MEMBERSHIPS).
  const endRe = /\n\[\d+\] /g;
  endRe.lastIndex = contentStart;
  const match = endRe.exec(systemMessage);
  if (match === null) return systemMessage;
  const endIdx = match.index;
  if (endIdx < contentStart) return systemMessage;
  const block = renderMemoryBlock(sanitizeMemory(memory));
  return systemMessage.slice(0, contentStart) + block + systemMessage.slice(endIdx);
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
 *
 * Preference order:
 *   1. If the expert row has a non-empty `extracted_memory_json` (set
 *      by the LLM extraction pass after a prior debate), parse and
 *      return that — the LLM-distilled memory is higher quality than
 *      the heuristic.
 *   2. Otherwise, fall through to the heuristic extraction over the
 *      expert's prior turns.
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

  // §3.1 LLM-cache preference: if the row has a non-empty cached LLM
  // memory, return it directly. The persister stores arrays; if every
  // array is empty we treat the cache as absent and fall through to
  // heuristic so we still surface SOMETHING when the LLM extractor
  // returned no signal.
  const cached = readCachedLLMMemory(expert.extractedMemoryJson);
  if (cached !== undefined) return cached;

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

/**
 * Persist an LLM-extracted ExpertMemory to the expert row, so the
 * next `recallMemory` call returns it directly (bypassing the
 * heuristic scan). Stored as JSON in `experts.extracted_memory_json`.
 *
 * Caller contract: best-effort. If the expert id does not exist this
 * is a no-op — we do NOT throw, because the post-debate extraction
 * hook should never fail the debate.
 */
export async function persistExtractedMemory(
  db: CouncilDatabase,
  expertId: string,
  memory: ExpertMemory,
): Promise<void> {
  const json = JSON.stringify({
    positions: [...memory.positions],
    updatedPriors: [...memory.updatedPriors],
    unresolved: [...memory.unresolved],
  });
  await new ExpertRepository(db).update(expertId, {
    extractedMemoryJson: json,
  });
}

/**
 * Parse a stored LLM ExpertMemory JSON column. Returns `undefined`
 * when the column is null, malformed, or contains no entries at all
 * (so the caller falls back to heuristic recall and still surfaces
 * something).
 */
function readCachedLLMMemory(json: string | null): ExpertMemory | undefined {
  if (json === null || json.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const positions = sanitizeArray(obj["positions"]);
  const updatedPriors = sanitizeArray(obj["updatedPriors"]);
  const unresolved = sanitizeArray(obj["unresolved"]);
  if (
    positions.length === 0 &&
    updatedPriors.length === 0 &&
    unresolved.length === 0
  ) {
    return undefined;
  }
  return { positions, updatedPriors, unresolved };
}

function sanitizeArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const cleaned = sanitizeMemorySnippet(truncate(item));
    if (cleaned.length > 0) out.push(cleaned);
  }
  return out;
}
