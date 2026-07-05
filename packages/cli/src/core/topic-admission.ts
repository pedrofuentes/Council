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

/**
 * Where a topic originated — used to scope the shell-expansion residue
 * heuristics (see {@link detectShellExpansion}).
 *
 *   - `"arg"`         — a CLI positional (e.g. `council convene <topic>`).
 *                       This is the ONLY source a shell can mangle before
 *                       Council sees it, so the ambiguous residue signals
 *                       apply here.
 *   - `"interactive"` — typed into a REPL prompt (e.g. a `council chat`
 *                       turn). Never shell-mangled.
 *   - `"file"`        — read verbatim via `--prompt-file`. Never
 *                       shell-mangled.
 */
export type TopicSource = "arg" | "interactive" | "file";

interface PatternCategory {
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

/**
 * Maximum number of input characters scanned by the sensitive-category
 * regexes.
 *
 * The category patterns use a greedy `.*` between two `\b…\b` anchors, which
 * is super-linear on a single very long line (~5 s for a 180 KB `--prompt-file`
 * payload). Now that `--prompt-file`/stdin can feed arbitrary-size content into
 * {@link checkTopicAdmission}, the scanned text is capped to this prefix BEFORE
 * the regexes (and the NFKC normalize) run, keeping admission fast and O(1)
 * with respect to oversized input (~10 ms worst case at this bound).
 *
 * 8 KiB is far larger than any realistic topic/question — even a verbose
 * multi-paragraph file topic is well under it — so capping never changes the
 * verdict for real input (every input at or below the cap is scanned
 * byte-identically to before). Detection of a sensitive phrase that begins only
 * AFTER the first 8 KiB is intentionally sacrificed; this layer is an advisory
 * warning, not a security boundary — the underlying LLM remains the hard guard.
 */
export const CATEGORY_SCAN_LIMIT = 8192;

/**
 * Bound the text handed to the sensitive-category regexes to a safe prefix.
 *
 * Slicing the RAW input *before* `.trim()`/NFKC normalization caps the cost of
 * both the normalize and the super-linear `.*` category scan. A no-op for input
 * at or below {@link CATEGORY_SCAN_LIMIT}, so realistic topics are unaffected.
 * Exported so tests can pin the bound deterministically by scanned-slice length
 * rather than relying on flaky wall-clock timing.
 */
export function boundCategoryScanText(topic: string): string {
  return topic.length > CATEGORY_SCAN_LIMIT ? topic.slice(0, CATEGORY_SCAN_LIMIT) : topic;
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
 * Multiple consecutive INTERNAL spaces. PowerShell treats `$180K` as an
 * undefined variable and expands it to the empty string, so a double-quoted
 * `"We have $180K in runway"` arrives as `We have  in runway` — a tell-tale
 * double space where the amount used to be, with no surviving `$`.
 */
const MULTI_SPACE_RESIDUE_PATTERN = /\S {2,}\S/;

/**
 * A lone unit suffix (`K`/`M`/`B`/`G`) standing alone after a space. In bash,
 * `$180K` expands `$1` (empty) leaving `80K`, or in shells that consume the
 * whole numeric run `$180` leaving a bare `K` — e.g. `Raise $180K now`
 * arrives as `Raise  K now`. The isolated single-letter unit is the residue.
 *
 * This is deliberately ARG-ONLY (see {@link detectShellExpansion}): typed or
 * file-sourced phrases such as "Vitamin K" or "Plan B" are NOT shell-mangled
 * and must never trip this signal.
 */
const LONE_UNIT_SUFFIX_PATTERN = /\s[KMBG]\b/;

/**
 * Bash currency residue (#2379). Bash expands single-digit positional
 * parameters, so a double-quoted `$450/mo` arrives as `50/mo` and `$180K`
 * as `80K` — no surviving `$`, no double space, and the unit suffix is
 * still attached to digits, so none of the other residue signals fire.
 *
 * The residue signature is a bare number carrying a currency-shaped
 * suffix with no `$` in front:
 *
 *   - magnitude: `80K`, `2M`, `1,500K`, `2.5B`
 *   - per-period rate: `50/mo`, `450/month`, `99/yr`
 *
 * The negative lookbehind `(?<![$\d,.])` anchors the match at the true
 * start of the number and rejects every position inside an intact literal
 * like `$180K` or `$450/mo`, preserving the currency-literal guarantee
 * from PR #1022. Longer period alternatives come first so `/month` is
 * never half-matched as `/mo`.
 *
 * A bare number alone is weak evidence — "10K race" and "4K monitor" are
 * legitimate topics — so these patterns only count as residue when the
 * topic also mentions money (see {@link MONEY_CONTEXT_PATTERN}). Both
 * are ARG-ONLY, like every other residue signal.
 */
const BARE_MAGNITUDE_RESIDUE_PATTERN = /(?<![$\d,.])\d[\d,]*(?:\.\d+)?[KMB]\b/i;
const BARE_RATE_RESIDUE_PATTERN =
  /(?<![$\d,.])\d[\d,]*(?:\.\d+)?\/(?:month|mo|year|yr|week|wk|hour|hr|day)s?\b/i;

/**
 * Money-context gate for the bare magnitude/rate residue signals: only a
 * topic that is plainly about money makes a bare `80K` or `50/mo` read as
 * a mangled currency amount rather than a distance, resolution, or count.
 *
 * Requires bounded adjacency (#2424): the money keyword must be within a
 * proximity window of the residue token to avoid false positives like
 * "4K monitor within our budget" where unrelated tokens co-occur.
 */
const MONEY_CONTEXT_PATTERN =
  /\b(?:budget|cost|price|pricing|revenue|arpu|mrr|arr|salary|salaries|funding|runway|raise|spend|spending|payment|fee|fees|invoice|dollars?|usd)\b/i;

/**
 * Maximum character distance between a money keyword and a residue token
 * for them to be considered adjacent. Allows phrases like "budget of 80K"
 * (~4 char gap) while rejecting distant unrelated combinations like
 * "budget-friendly 4K TV" (~10 char gap) or "4K monitor within our budget"
 * (~20 char gap).
 */
const PROXIMITY_WINDOW = 8;

function looksLikeCurrencyResidue(normalized: string): boolean {
  // Quick pre-check: both patterns must exist somewhere in the string.
  const hasMoney = MONEY_CONTEXT_PATTERN.test(normalized);
  const hasResidue =
    BARE_MAGNITUDE_RESIDUE_PATTERN.test(normalized) || BARE_RATE_RESIDUE_PATTERN.test(normalized);

  if (!hasMoney || !hasResidue) {
    return false;
  }

  // Find all money-context matches.
  const moneyMatches = Array.from(normalized.matchAll(new RegExp(MONEY_CONTEXT_PATTERN, "gi")));

  // Find all residue matches (magnitude or rate).
  const magnitudeMatches = Array.from(
    normalized.matchAll(new RegExp(BARE_MAGNITUDE_RESIDUE_PATTERN, "gi")),
  );
  const rateMatches = Array.from(
    normalized.matchAll(new RegExp(BARE_RATE_RESIDUE_PATTERN, "gi")),
  );
  const residueMatches = [...magnitudeMatches, ...rateMatches];

  // Check if any money match is within the proximity window of any residue match.
  for (const moneyMatch of moneyMatches) {
    if (moneyMatch.index === undefined) continue;
    const moneyStart = moneyMatch.index;
    const moneyEnd = moneyStart + moneyMatch[0].length;

    for (const residueMatch of residueMatches) {
      if (residueMatch.index === undefined) continue;
      const residueStart = residueMatch.index;
      const residueEnd = residueStart + residueMatch[0].length;

      // Calculate minimum distance between the two matches.
      const distance = Math.max(0, Math.max(residueStart - moneyEnd, moneyStart - residueEnd));

      if (distance <= PROXIMITY_WINDOW) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Exported detection function for the shell expansion warning heuristic.
 * Returns `true` if the topic shows evidence of potential shell expansion
 * issues that warrant a warning to the user.
 *
 * Two tiers of signal, gated by {@link TopicSource}:
 *
 *   1. Survivor signals (ALL sources): a literal `$VAR` / `$1` is still
 *      present in the text. Advisory for typed/file input too — the user
 *      may have meant a literal `$`, or correctly single-quoted it.
 *        - `$VAR`-style: `$` followed by a letter/underscore.
 *        - `$0`..`$9` positional parameters (single digit + word boundary).
 *
 *   2. Residue signals (ARG source ONLY): evidence that mangling ALREADY
 *      happened and erased the `$`, leaving a fragment. These can only occur
 *      for a CLI positional that passed through a shell as argv, so applying
 *      them to typed (`"interactive"`) or `--prompt-file` (`"file"`) input
 *      would be pure false positives.
 *        - empty after trimming (the whole topic expanded away);
 *        - exactly one character (e.g. a lone trailing unit suffix);
 *        - multiple consecutive internal spaces;
 *        - a lone `K`/`M`/`B`/`G` unit suffix after a space;
 *        - a bare magnitude/rate number (`80K`, `50/mo`) with no `$`, in a
 *          money-context topic — the bash positional-expansion residue of
 *          `$180K` / `$450/mo` (#2379).
 *
 * Does NOT warn on intact currency/number literals like `$50`, `$450/mo`,
 * `$180K`, `$2M` where the `$` is followed by 2+ digits — these are intact
 * values that survived shell expansion.
 */
export function detectShellExpansion(topic: string, source: TopicSource = "arg"): boolean {
  const normalized = topic.trim().normalize("NFKC");

  // Survivor signals — meaningful for every source.
  if (SHELL_VAR_PATTERN.test(normalized) || SHELL_POSITIONAL_PATTERN.test(normalized)) {
    return true;
  }

  // Residue signals — only a shell argument can carry shell-mangling residue.
  if (source !== "arg") {
    return false;
  }

  return (
    normalized.length === 0 ||
    looksLikeExpansionArtifact(normalized) ||
    MULTI_SPACE_RESIDUE_PATTERN.test(normalized) ||
    LONE_UNIT_SUFFIX_PATTERN.test(normalized) ||
    looksLikeCurrencyResidue(normalized)
  );
}

function shellExpansionWarning(): string {
  return (
    "⚠ Topic looks like it may have been affected by shell expansion " +
    "(possible shell expansion). If you intended a literal `$` or a value " +
    "like `$180K`, wrap the topic in single quotes (e.g., 'literal $180K'), " +
    "or pass it via `--prompt-file <path>` (or `--prompt-file -` for stdin) " +
    "to bypass the shell entirely."
  );
}

function warningMessage(categories: readonly string[]): string {
  return `⚠ This topic touches sensitive areas (${categories.join(", ")}). Proceeding — experts will follow safety guidelines.`;
}

export function checkTopicAdmission(
  topic: string,
  source: TopicSource = "arg",
): TopicAdmissionResult {
  const normalized = boundCategoryScanText(topic).trim().normalize("NFKC");
  const matched: string[] = [];
  for (const category of CATEGORIES) {
    if (category.patterns.some((p) => p.test(normalized))) {
      matched.push(category.label);
    }
  }
  const warnings: string[] = matched.map((label) => warningMessage([label]));
  if (detectShellExpansion(topic, source)) {
    warnings.push(shellExpansionWarning());
  }
  return { admitted: true, warnings };
}
