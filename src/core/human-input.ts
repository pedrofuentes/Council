/**
 * Human input provider — abstraction for collecting human participant
 * responses during a debate (ROADMAP §3.3).
 *
 * The CLI implementation reads from stdin via readline; tests inject
 * canned responses. The Debate orchestrator calls `getInput()` instead
 * of `engine.send()` for participants whose slug is in `humanSlugs`.
 */

/** Context passed to the human input provider for each turn. */
export interface HumanInputContext {
  /** Slug of the human participant being prompted. */
  readonly expertSlug: string;
  /** Display name of the human participant. */
  readonly displayName: string;
  /** Current round number (0-indexed). */
  readonly round: number;
  /** Sequence number within the round. */
  readonly seq: number;
  /** The debate topic / prompt. */
  readonly prompt: string;
}

/** Result of a human input request. */
export type HumanInputResult =
  | { readonly kind: "submitted"; readonly content: string }
  | { readonly kind: "cancelled"; readonly reason?: string };

/** Provider that collects input from a human participant. */
export interface HumanInputProvider {
  getInput(context: HumanInputContext): Promise<HumanInputResult>;
}
