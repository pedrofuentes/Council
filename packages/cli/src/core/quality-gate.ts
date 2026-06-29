/**
 * Anti-sycophancy quality gate.
 *
 * Inspects an expert response BEFORE it lands in the transcript, classifies
 * any failures against the 3-layer system from
 * `docs/analysis/03-prompt-architecture.md`, and produces a regenerate-hint
 * the orchestrator can pass back to the model on the next attempt.
 *
 * Design notes:
 *   - **Heuristic, not LLM-based.** This gate is the cheap, deterministic
 *     first line of defense. An LLM-based judge can be added later (and
 *     would be ADR-worthy) but the heuristic gate handles the 90% case
 *     for free and catches the most common failures.
 *   - **No regex magic.** Forbidden phrases are simple case-insensitive
 *     substring matches. The disagreement-signal detection is a small set
 *     of common opener patterns + the explicit stand-down phrase from the
 *     default debate protocol.
 *   - **Mutually-reinforcing prompts.** The hint is designed to be appended
 *     to a regeneration prompt, e.g. "Your previous response was rejected:
 *     <hint>. Rewrite to satisfy these constraints."
 */
import { DEFAULT_FORBIDDEN_PHRASES } from "./prompt-builder.js";

/**
 * Minimum word count for a response to be considered substantive.
 *
 * 12 words is roughly "two short sentences". Below this, the response
 * cannot meaningfully encode either a position or a counter-argument.
 */
const MIN_WORDS = 12;

/**
 * Substrings that signal the responder is offering disagreement, an
 * omitted consideration, or a counter-argument. Case-insensitive.
 */
const DISAGREEMENT_SIGNALS: readonly string[] = [
  "i disagree",
  "disagree with",
  "weak claim",
  "weakness in",
  "counter",
  "omitted",
  "missing from",
  "did not address",
  "did not consider",
  "does not address",
  "scenario where",
  "fails when",
  "would fail",
  "stress-tested",
];

/**
 * The exact stand-down phrase mandated by DEFAULT_DEBATE_PROTOCOL when
 * the responder honestly cannot find a material weakness.
 */
const STAND_DOWN_MARKER = "stress-tested";

export type QualityCheckKind =
  | "forbidden_phrase"
  | "no_disagreement_signal"
  | "too_short";

export interface QualityCheck {
  readonly kind: QualityCheckKind;
  readonly detail: string;
}

export interface QualityResult {
  readonly ok: boolean;
  readonly failures: readonly QualityCheck[];
  /**
   * When `ok=false`, a short hint describing what to fix. Designed to be
   * appended verbatim to the regeneration prompt. Undefined when ok=true.
   */
  readonly regenerateHint?: string;
}

export interface QualityGateOptions {
  /** Slugs of experts who have already spoken in the current round. */
  readonly priorSpeakers: readonly string[];
}

function countWords(text: string): number {
  // Simple whitespace split; a response of "Yes." counts as 1 word.
  return text.trim().split(/\s+/).filter((s) => s.length > 0).length;
}

function findForbiddenPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return DEFAULT_FORBIDDEN_PHRASES.filter((p) => lower.includes(p.toLowerCase()));
}

/**
 * Negation openers that flip a disagreement signal into pseudo-agreement.
 * Includes the explicit forms from issue #47 plus the universal `n't`
 * contraction tail (don't / doesn't / can't / won't / wouldn't).
 */
const NEGATION_PREFIX = /(?:\bnot|n't|\bno longer)\s+$/;

function hasDisagreementSignal(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(STAND_DOWN_MARKER)) return true;
  return DISAGREEMENT_SIGNALS.some((signal) => {
    let from = 0;
    let idx = lower.indexOf(signal, from);
    while (idx !== -1) {
      // Count the signal only if it is not immediately preceded by a negation
      // ("I don't disagree with X" must not satisfy the disagreement budget).
      if (!NEGATION_PREFIX.test(lower.slice(0, idx))) return true;
      from = idx + signal.length;
      idx = lower.indexOf(signal, from);
    }
    return false;
  });
}

function buildRegenerateHint(failures: readonly QualityCheck[]): string {
  const kinds = new Set(failures.map((f) => f.kind));
  const parts: string[] = [];
  if (kinds.has("forbidden_phrase")) {
    const phrases = failures
      .filter((f) => f.kind === "forbidden_phrase")
      .map((f) => f.detail)
      .join(", ");
    parts.push(
      `Your previous response contained forbidden phrases (${phrases}). Rewrite without these surface forms of agreement-padding.`,
    );
  }
  if (kinds.has("no_disagreement_signal")) {
    parts.push(
      "Your response did not signal a specific disagreement, omitted consideration, or failure scenario. Either identify one (per the debate protocol) or use the explicit stand-down phrase.",
    );
  }
  if (kinds.has("too_short")) {
    parts.push(
      `Your response was too short to carry signal (under ${MIN_WORDS} words). Add a concrete claim or example.`,
    );
  }
  return parts.join(" ");
}

/**
 * Apply the heuristic quality gate to a single expert response.
 *
 * @param response  The candidate response text from the expert
 * @param options   Context — notably which prior speakers are visible this round
 */
export function applyQualityGate(
  response: string,
  options: QualityGateOptions,
): QualityResult {
  const failures: QualityCheck[] = [];

  // Layer 1: forbidden phrases.
  const forbidden = findForbiddenPhrases(response);
  for (const phrase of forbidden) {
    failures.push({
      kind: "forbidden_phrase",
      detail: phrase,
    });
  }

  // Layer 3 first: a too-short response can't carry any meaningful signal,
  // and we want to flag it independently of disagreement detection.
  const wordCount = countWords(response);
  if (wordCount < MIN_WORDS) {
    failures.push({
      kind: "too_short",
      detail: `${wordCount} words (minimum ${MIN_WORDS})`,
    });
  }

  // Layer 2: disagreement budget — only required when prior speakers exist.
  // Skip when too_short is already flagged (single failure is clearer feedback).
  if (
    options.priorSpeakers.length > 0 &&
    wordCount >= MIN_WORDS &&
    !hasDisagreementSignal(response)
  ) {
    failures.push({
      kind: "no_disagreement_signal",
      detail: `response did not identify a weakness, omission, or failure scenario in any of: ${options.priorSpeakers.join(", ")}`,
    });
  }

  if (failures.length === 0) {
    return { ok: true, failures: [] };
  }
  return {
    ok: false,
    failures,
    regenerateHint: buildRegenerateHint(failures),
  };
}
