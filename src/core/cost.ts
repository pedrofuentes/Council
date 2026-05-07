/**
 * Cost estimation for a debate.
 *
 * Council pays GitHub Copilot a "premium request" per expert turn (and per
 * moderator summary when enabled). The user can ask for a dry-run estimate
 * via `council convene --estimate` BEFORE running anything, so they don't
 * accidentally burn 30+ requests on a panel they didn't intend.
 *
 * Pure function — no engine, no DB, no I/O.
 *
 * Per ROADMAP §1.13:
 *   estimate = expertCount * maxRounds + (maxRounds × moderator summaries)
 */

export interface CostInput {
  readonly maxRounds: number;
  readonly maxWordsPerResponse: number;
  readonly mode: "freeform" | "structured";
  /** Whether to include moderator summary turns. Defaults to true. */
  readonly includeModerator?: boolean;
}

export interface CostBreakdownItem {
  readonly phase: string;
  readonly count: number;
}

export interface CostEstimate {
  readonly premiumRequests: number;
  readonly breakdown: readonly CostBreakdownItem[];
}

export function estimateDebateCost(input: CostInput, expertCount: number): CostEstimate {
  if (!Number.isInteger(expertCount) || expertCount <= 0) {
    throw new Error(`expertCount must be a positive integer, got ${expertCount}`);
  }
  if (!Number.isInteger(input.maxRounds) || input.maxRounds <= 0) {
    throw new Error(`maxRounds must be a positive integer, got ${input.maxRounds}`);
  }

  const expertTurns = expertCount * input.maxRounds;
  const includeModerator = input.includeModerator ?? true;
  const moderatorTurns = includeModerator ? input.maxRounds : 0;

  const breakdown: CostBreakdownItem[] = [{ phase: "Expert turns", count: expertTurns }];
  if (includeModerator) {
    breakdown.push({ phase: "Moderator summaries", count: moderatorTurns });
  }

  return {
    premiumRequests: expertTurns + moderatorTurns,
    breakdown,
  };
}

/**
 * Render a cost estimate as a multi-line plain-text block, suitable for
 * `council convene --estimate` output or for prompting the user before a
 * potentially expensive run.
 */
export function formatCostBreakdown(estimate: CostEstimate): string {
  const lines: string[] = [];
  for (const item of estimate.breakdown) {
    lines.push(`  ${item.phase}: ${item.count}`);
  }
  lines.push(`  ─────────────`);
  lines.push(`  Total: ${estimate.premiumRequests} premium requests`);
  return lines.join("\n");
}
