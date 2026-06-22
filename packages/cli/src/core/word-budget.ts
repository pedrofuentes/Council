/**
 * Soft per-response word-budget instruction.
 *
 * `maxWordsPerResponse` (CLI `--max-words`, config `defaults.maxWordsPerResponse`)
 * is a SOFT cap: it nudges experts to stay concise without truncating their
 * output. This helper appends a length target plus a quality clause to a
 * per-turn task prompt, so brevity never costs a falsifiable claim or an
 * expert's disagreement.
 *
 * It is applied at the single debate turn chokepoint (`Debate.#runAiTurn`), so
 * it covers every freeform strategy and structured phase uniformly, and is
 * rebuilt on each run (unlike the persisted system prompt) — which is what
 * makes `--max-words` actually take effect per invocation.
 *
 * A non-positive (or non-finite) budget is the "no cap" sentinel — e.g. `chat`
 * passes `0` — and the task is returned unchanged.
 *
 * Default rationale (250 words): `docs/analysis/03-prompt-architecture.md`, plus
 * the deliberation literature (e.g. Khan et al. 2024, arXiv:2402.06782, cap
 * debaters at ~150 words/turn to curb LLM verbosity bias). The soft framing and
 * the paired quality clause matter more than the exact number; budgets below
 * ~100 words tend to be ignored by the model (token-elasticity, arXiv:2412.18547),
 * so the config floor stays at 50 but the caveat is documented.
 */
export function appendWordBudget(task: string, maxWords: number): string {
  if (!Number.isFinite(maxWords) || maxWords <= 0) {
    return task;
  }
  const budget = Math.floor(maxWords);
  return (
    `${task}\n\n` +
    `Length: aim for about ${budget} words. Be concise and high-signal — ` +
    `cut preamble and filler, but do not drop your strongest disagreement or ` +
    `a specific, falsifiable claim just to hit the target.`
  );
}
