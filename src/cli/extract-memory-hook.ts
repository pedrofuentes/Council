/**
 * Post-debate ExpertMemory extraction hook.
 *
 * After a debate finishes, this hook runs an LLM extraction pass on
 * each AI expert's turns from THIS debate and persists the resulting
 * structured ExpertMemory into the expert row. Future `recallMemory`
 * calls then prefer the cached LLM memory over the heuristic scan
 * (see §3.1).
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
import { TurnRepository } from "../memory/repositories/turns.js";

export interface ExtractMemoryHookOpts {
  readonly engine: CouncilEngine;
  readonly db: CouncilDatabase;
  readonly debateId: string;
  readonly expertSlugToId: Readonly<Record<string, string>>;
  /** Slugs that are human participants — skipped (no LLM extraction). */
  readonly humanSlugs: ReadonlySet<string>;
  /** Model name to use for the extractor expert. */
  readonly model: string;
  readonly writeError: Writer;
}

export async function runExtractMemoryHook(
  opts: ExtractMemoryHookOpts,
): Promise<void> {
  const turnRepo = new TurnRepository(opts.db);
  const turns = await turnRepo.findByDebateId(opts.debateId);

  for (const [slug, expertId] of Object.entries(opts.expertSlugToId)) {
    if (opts.humanSlugs.has(slug)) continue;
    const expertTurns = turns
      .filter((t) => t.expertId === expertId && t.speakerKind === "expert")
      .map((t) => t.content);
    if (expertTurns.length === 0) continue;
    try {
      const memory = await extractMemoryLLM(expertTurns, opts.engine, opts.model);
      await persistExtractedMemory(opts.db, expertId, memory);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.writeError(
        `!! memory extraction failed for expert ${slug}: ${msg}\n`,
      );
    }
  }
}
