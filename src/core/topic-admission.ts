/**
 * Topic admission control — a *warn-only* heuristic guard that runs at
 * every Council entry point (`convene`, `ask`, `chat`) before a topic
 * is sent into the deliberation pipeline.
 *
 * Design intent
 * -------------
 *   - Never blocks. `admitted` is always `true`; the only output is a
 *     list of human-readable warnings the caller can echo to the user.
 *     The hard safety boundary still lives with the underlying LLM —
 *     this layer just makes the user aware that the topic touches a
 *     sensitive area so the experts' safety responses are not a
 *     surprise.
 *   - Pure function: no I/O, no async, no DB. Safe to call in tight
 *     loops (e.g., per chat turn) without measurable cost.
 *   - Patterns are organized by category in a const array so adding
 *     new heuristics is a single localized edit.
 *   - NFKC normalization (reused conceptually from
 *     {@link sanitizePromptField} in `prompt-sanitize.ts`) prevents
 *     trivial fullwidth/compatibility bypasses such as
 *     `Ｗeapon` → `Weapon`.
 */

export interface TopicAdmissionResult {
  readonly admitted: true;
  readonly warnings: readonly string[];
}

interface PatternCategory {
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

const CATEGORIES: readonly PatternCategory[] = [
  {
    label: "violence/weapons",
    patterns: [
      /\b(?:synthesiz|manufactur|assembl|build|construct)(?:e|ing)?\b.*\b(?:weapon|explosive|bomb|firearm)/i,
      /\b(?:weapon|explosive|bomb|firearm).*\b(?:synthesiz|manufactur|assembl|build|construct)/i,
    ],
  },
  {
    label: "controlled substances",
    patterns: [
      /\b(?:synthesiz|manufactur|produc)(?:e|ing)?\b.*\b(?:drug|narcotic|methamphetamine|fentanyl)/i,
      /\b(?:drug|narcotic|methamphetamine|fentanyl).*\b(?:synthesiz|manufactur|produc)/i,
    ],
  },
  {
    label: "Crescendo escalation",
    patterns: [
      /\bignore (?:all )?(?:previous |prior |above )?instructions?\b/i,
      /\byou are now\b.*\bnew (?:role|persona|identity)\b/i,
      /\bforget (?:everything|all|your)\b.*\b(?:instructions?|rules?|guidelines?)\b/i,
      // "Forget everything and take on a new role" — common Crescendo variant
      // that does not name "instructions" explicitly.
      /\bforget (?:everything|all|your)\b.*\bnew (?:role|persona|identity)\b/i,
    ],
  },
];

/**
 * Matches a `$` followed by a letter or underscore (typical shell variable
 * start characters). This pattern indicates a potential shell variable like
 * `$VAR`, `$PATH`, `$foo`, but excludes currency literals like `$450`,
 * `$180K` where the `$` is followed by a digit.
 *
 * Deliberately does NOT match bare `$` (e.g., "Pricing in $ vs €") to
 * avoid noise on currency mentions.
 */
const SHELL_VAR_PATTERN = /\$[A-Za-z_]/;

/**
 * Matches shell positional parameters like `$0`, `$1`, `$2`, etc.
 * Only matches single-digit parameters (0-9) since these are the most
 * common and unambiguous shell special variables.
 *
 * Does NOT match `$10`, `$50`, `$99`, etc., which are more likely to be
 * currency amounts in practice (especially when appearing with context
 * like "Compare $50 vs $45" or "$50/month").
 */
const SHELL_POSITIONAL_PATTERN = /\$\d\b/;

/**
 * Heuristic for shell-expansion *artifacts*: when `$180K` is passed
 * inside double quotes, POSIX sh and PowerShell both expand `$180` to
 * the empty string, leaving Council with the lone trailing unit suffix
 * (`K`). A trimmed topic of exactly one character is almost never a
 * real Council topic and is a strong signal that quoting misfired.
 *
 * Two characters (e.g., "AI", "LLM") are common legitimate topics, so
 * we deliberately stop at length 1 to keep false positives at zero.
 */
function looksLikeExpansionArtifact(normalized: string): boolean {
  return normalized.length === 1;
}

/**
 * Exported detection function for shell expansion warning heuristic.
 * Returns `true` if the topic shows evidence of potential shell expansion
 * issues that warrant a warning to the user.
 *
 * Detection signals:
 * 1. Contains a `$VAR`-style pattern ($ followed by letter/underscore) —
 *    indicates the user may have intended a literal `$PATH` or similar
 *    but used double quotes, OR correctly single-quoted and the literal
 *    survived (warning is advisory in either case).
 * 2. Contains shell positional parameters like `$0`, `$1`, `$2` (single digit
 *    after `$` followed by word boundary) — distinct from currency amounts
 *    like `$50`, `$180K` which have 2+ digits or additional context.
 * 3. Topic is exactly one character after normalization — strong signal
 *    that a currency literal like `$180K` was mangled by the shell,
 *    leaving only the trailing unit suffix `K`.
 *
 * Does NOT warn on intact currency/number literals like `$50`, `$450/mo`,
 * `$180K`, `$2M` where the `$` is followed by 2+ digits or has
 * additional non-boundary context. These are intact values that survived
 * shell expansion (user correctly used single quotes or the shell had
 * no variable to expand).
 */
export function detectShellExpansion(topic: string): boolean {
  const normalized = topic.trim().normalize("NFKC");
  return (
    SHELL_VAR_PATTERN.test(normalized) ||
    SHELL_POSITIONAL_PATTERN.test(normalized) ||
    looksLikeExpansionArtifact(normalized)
  );
}

function shellExpansionWarning(): string {
  return (
    "⚠ Topic looks like it may have been affected by shell expansion " +
    "(possible shell expansion). If you intended a literal `$` or used a value " +
    "like `$180K`, wrap the topic in single quotes (e.g., 'literal $180K') so " +
    "the shell does not expand it before Council sees it."
  );
}

function warningMessage(categories: readonly string[]): string {
  return `⚠ This topic touches sensitive areas (${categories.join(", ")}). Proceeding — experts will follow safety guidelines.`;
}

export function checkTopicAdmission(topic: string): TopicAdmissionResult {
  const normalized = topic.trim().normalize("NFKC");
  const matched: string[] = [];
  for (const category of CATEGORIES) {
    if (category.patterns.some((p) => p.test(normalized))) {
      matched.push(category.label);
    }
  }
  const warnings: string[] = matched.map((label) => warningMessage([label]));
  if (detectShellExpansion(topic)) {
    warnings.push(shellExpansionWarning());
  }
  return { admitted: true, warnings };
}
