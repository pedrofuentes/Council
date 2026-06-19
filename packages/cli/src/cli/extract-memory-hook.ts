/**
 * Post-debate ExpertMemory extraction hook.
 *
 * After a debate finishes, this hook runs an LLM extraction pass on
 * each AI expert's full prior history (bounded by the same
 * DEFAULT_MAX_DEBATES / DEFAULT_MAX_TURNS used by the heuristic
 * recall) and persists the resulting structured ExpertMemory into
 * the expert row. Future `recallMemory` calls then prefer the cached
 * LLM memory over the heuristic scan (see §3.1).
 *
 * Sentinel pr273 cycle 1 #1 🔴: scanning ONLY the current debate
 * meant the cache was overwritten on each new debate and older
 * memory was silently dropped. We now gather the most recent N
 * turns across the most recent K debates ΓÇö same bounding as
 * `recallMemory` heuristic mode ΓÇö so the LLM has the full picture.
 *
 * Best-effort: any failure (extractor reject, JSON parse error, DB
 * write failure) is swallowed per-expert so one bad extraction does
 * not prevent the others from being persisted. Failures are reported
 * to stderr via the supplied writer.
 *
 * Per-debate cost: at most ONE LLM call per AI expert per debate.
 */
import type { CouncilEngine } from "../engine/index.js";
import type { Writer } from "./commands/writer.js";
import type { CouncilDatabase } from "../memory/db.js";
import { extractMemoryLLM } from "../memory/memory-extractor.js";
import { persistExtractedMemory } from "../memory/expert-memory.js";
import { DebateRepository } from "../memory/repositories/debates.js";
import { TurnRepository, type Turn } from "../memory/repositories/turns.js";

const EXTRACTOR_MAX_TURNS = 20;
const EXTRACTOR_MAX_DEBATES = 5;

export interface ExtractMemoryHookOpts {
  readonly engine: CouncilEngine;
  readonly db: CouncilDatabase;
  readonly panelId: string;
  readonly debateId: string;
  readonly expertSlugToId: Readonly<Record<string, string>>;
  /** Slugs that are human participants — skipped (no LLM extraction). */
  readonly humanSlugs: ReadonlySet<string>;
  /** Model name to use for the extractor expert. */
  readonly model: string;
  readonly writeError: Writer;
}

export async function runExtractMemoryHook(opts: ExtractMemoryHookOpts): Promise<void> {
  const debateRepo = new DebateRepository(opts.db);
  const turnRepo = new TurnRepository(opts.db);

  const allDebates = await debateRepo.findByPanelId(opts.panelId);
  const debates =
    allDebates.length > EXTRACTOR_MAX_DEBATES
      ? allDebates.slice(-EXTRACTOR_MAX_DEBATES)
      : allDebates;

  // Gather turns once across the bounded debate window so we don't
  // re-scan per expert. Bucket by expertId for fast lookup below.
  const byExpert = new Map<string, Turn[]>();
  for (const d of debates) {
    const turns = await turnRepo.findByDebateId(d.id);
    for (const t of turns) {
      if (t.speakerKind !== "expert" || t.expertId === null) continue;
      const bucket = byExpert.get(t.expertId);
      if (bucket === undefined) byExpert.set(t.expertId, [t]);
      else bucket.push(t);
    }
  }

  for (const [slug, expertId] of Object.entries(opts.expertSlugToId)) {
    if (opts.humanSlugs.has(slug)) continue;
    const collected = byExpert.get(expertId);
    if (collected === undefined || collected.length === 0) continue;

    // Chronological order (createdAt is ISO-8601, lexicographically
    // sortable) then trim to the most recent EXTRACTOR_MAX_TURNS.
    collected.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const recent =
      collected.length > EXTRACTOR_MAX_TURNS ? collected.slice(-EXTRACTOR_MAX_TURNS) : collected;
    const expertTurns = recent.map((t) => t.content);

    try {
      const memory = await extractMemoryLLM(expertTurns, opts.engine, opts.model);
      await persistExtractedMemory(opts.db, expertId, memory, {
        sourceDebateId: opts.debateId,
        derivation: "llm_summary",
        trustScore: 0.5,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.writeError(`!! memory extraction failed for expert ${slug}: ${msg}\n`);
    }
  }
}
