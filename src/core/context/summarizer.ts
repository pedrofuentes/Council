/**
 * Heuristic rolling summarizer for long debates (ROADMAP §2.6).
 *
 * After `summarizeAfterRound` rounds have completed, the orchestrator
 * may prepend a compact summary to each strategy's context so that
 * downstream prompts can reference earlier deliberation without
 * including every verbatim turn. This implementation is intentionally
 * heuristic — no LLM call is made. The approach:
 *
 *   1. For each expert who spoke, take the first sentence of their
 *      most recent turn as their "position".
 *   2. Scan all turns for disagreement signals ("disagree", "however",
 *      "but") to surface tension.
 *   3. Format the output as a single compact block and truncate to
 *      `maxSummaryLength` characters.
 *
 * LLM-driven summarization is a future enhancement; the interface
 * deliberately accepts only `PriorTurnRecord[]` so a future async
 * implementation can swap in without changing call sites (it would
 * become an async function but the orchestrator already handles
 * promises in `#runFreeform()`).
 */
import type { PriorTurnRecord } from "../moderator/strategy.js";

export interface SummarizerConfig {
  /** Start summarizing once the current round is >= this value. */
  readonly summarizeAfterRound: number;
  /** Hard cap on summary length in characters. */
  readonly maxSummaryLength: number;
}

const DISAGREEMENT_SIGNALS = ["disagree", "however", "but ", "counter", "oppose"];

export function buildRollingSummary(
  turns: readonly PriorTurnRecord[],
  currentRound: number,
  config: SummarizerConfig,
): string {
  if (turns.length === 0) return "";
  if (currentRound < config.summarizeAfterRound) return "";

  // Take each expert's MOST RECENT turn (latest round wins).
  const latestBySlug = new Map<string, PriorTurnRecord>();
  for (const t of turns) {
    const existing = latestBySlug.get(t.expertSlug);
    if (!existing || t.round >= existing.round) {
      latestBySlug.set(t.expertSlug, t);
    }
  }

  const positions: string[] = [];
  for (const t of latestBySlug.values()) {
    const sentence = firstSentence(t.content);
    positions.push(`- ${t.displayName}: ${sentence}`);
  }

  const hasDisagreement = turns.some((t) => {
    const lower = t.content.toLowerCase();
    return DISAGREEMENT_SIGNALS.some((s) => lower.includes(s));
  });

  const lastRound = turns.reduce((m, t) => (t.round > m ? t.round : m), 0);
  const header = `Summary of rounds 0-${lastRound}:`;
  const body = positions.join("\n");
  const tension = hasDisagreement
    ? "\nKey tension: experts disagree on the core question."
    : "";

  const summary = `${header}\n${body}${tension}`;

  if (summary.length <= config.maxSummaryLength) return summary;
  return summary.slice(0, config.maxSummaryLength);
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]*[.!?]/);
  if (match) return match[0].trim();
  return trimmed;
}
