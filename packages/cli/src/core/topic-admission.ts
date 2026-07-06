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
 * Bound the text handed to the sensitive-category regexes (and to
 * {@link detectShellExpansion}, which shares the same cost concern and
 * trade-off) to a safe prefix.
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

/**
 * The bounded, normalized text {@link detectShellExpansion} scans, plus
 * whether the 8 KiB cap manufactured an artificial trailing word boundary.
 */
interface ShellExpansionScan {
  /** First {@link CATEGORY_SCAN_LIMIT} chars, trimmed and NFKC-normalized. */
  readonly normalized: string;
  /** True iff the cap cut a token in half, manufacturing a trailing `\b`. */
  readonly suspectEdge: boolean;
  /** True iff the input was longer than {@link CATEGORY_SCAN_LIMIT} (#2507). */
  readonly truncated: boolean;
}

/**
 * Bound the text handed to {@link detectShellExpansion} to the same
 * {@link CATEGORY_SCAN_LIMIT} prefix as the category scan, and report
 * whether the trailing match boundary at the slice edge is ARTIFICIAL.
 *
 * The cap can slice through an intact currency literal such as `$180K`,
 * leaving the bounded string ending in `…$1`; {@link SHELL_POSITIONAL_PATTERN}
 * would then match that manufactured end-of-string boundary and warn on input
 * that never touched a shell (#2453). The original remedy — trimming the
 * trailing token off the truncated slice — over-corrected (#2482): it
 * discarded genuine pre-cap survivors buried in one long whitespace-free run
 * (false negative) and could trim a topic down to a whitespace-only or
 * one-char string, manufacturing the empty/one-char residue artifacts the
 * #2453 fix set out to eliminate (false positive).
 *
 * Instead, ALL bounded text is kept and the caller discards only matches
 * whose trailing word boundary is manufactured by the cut. The edge is
 * suspect iff the slice cut a token in half: the last bounded char is
 * non-whitespace AND the first char past the cap is a word char (JS `\b`
 * semantics: `[A-Za-z0-9_]`, i.e. `/\w/`; `charAt` past the end returns "",
 * which `/\w/` rejects, so an untruncated input is never suspect). See
 * {@link hasNonEdgeMatch}.
 *
 * The lookahead char is judged on its NFKC fold (#2507): all matching
 * happens on NFKC-normalized text, so the boundary judgment must use the
 * folded char — fullwidth `ａ` (U+FF41) folds to `a` (word char → edge
 * suspect), while Cyrillic/Greek lookalikes stay non-`\w` (a real boundary,
 * matching the sink patterns' ASCII `\b`). `.normalize` on a lone surrogate
 * half returns the input unchanged, so this never throws.
 *
 * Applies ONLY to {@link detectShellExpansion}; the category scan keeps using
 * the plain {@link boundCategoryScanText} prefix.
 */
function boundShellExpansionScanText(topic: string): ShellExpansionScan {
  const truncated = topic.length > CATEGORY_SCAN_LIMIT;
  const bounded = truncated ? topic.slice(0, CATEGORY_SCAN_LIMIT) : topic;
  const normalized = bounded.trim().normalize("NFKC");
  const suspectEdge =
    truncated &&
    !/\s$/.test(bounded) &&
    /\w/.test(topic.charAt(CATEGORY_SCAN_LIMIT).normalize("NFKC"));
  return { normalized, suspectEdge, truncated };
}

/**
 * Shared suspect-edge predicate (#2507): `true` iff `match` ends strictly
 * BEFORE the end of the scanned text. A match ending exactly at the end may
 * owe its trailing `\b` to the 8 KiB cut rather than to the input, so on a
 * suspect edge callers discard it — mirroring full-text `\b` semantics: when
 * the char past the cap is a word char, the pattern would not have matched
 * there in the untruncated string. Used by {@link hasNonEdgeMatch} and by
 * both the keyword and residue filters in {@link looksLikeCurrencyResidue},
 * so the three sites cannot drift.
 */
function isNonEdgeMatch(match: RegExpExecArray, textLength: number): boolean {
  return match.index + match[0].length < textLength;
}

/**
 * Match-existence check honouring the artificial-edge guard: when
 * `suspectEdge` is false, any match counts; when true, only a match ending
 * strictly BEFORE the end of `text` counts — see {@link isNonEdgeMatch}
 * (#2482).
 *
 * `pattern` MUST carry the `g` flag: `matchAll` requires it. `matchAll`
 * clones the regex, but the clone STARTS from the original's current
 * `lastIndex` (#2507) — hence the reset below, which makes this helper
 * self-defending against a stateful `.test()`/`.exec()` call site elsewhere
 * instead of relying on comment discipline alone. The iterator is lazy, so
 * on a clean edge this is as cheap as `.test()` — it stops at the first
 * match.
 */
function hasNonEdgeMatch(pattern: RegExp, text: string, suspectEdge: boolean): boolean {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (!suspectEdge || isNonEdgeMatch(match, text.length)) {
      return true;
    }
  }
  return false;
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
 *
 * Ends in `\b`, so a match can end at an end-anchored word boundary that the
 * 8 KiB cap manufactured — matched via {@link hasNonEdgeMatch} (hence the `g`
 * flag; never reuse with the stateful `.test()`/`.exec()`).
 */
const SHELL_POSITIONAL_PATTERN = /\$\d\b/g;

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
 *
 * Ends in `\b`, so a bisected token (`… Kilometers` cut after the `K`) could
 * manufacture a lone-unit match at the slice edge — matched via
 * {@link hasNonEdgeMatch} (hence the `g` flag; never reuse with the stateful
 * `.test()`/`.exec()`).
 */
const LONE_UNIT_SUFFIX_PATTERN = /\s[KMBG]\b/g;

/**
 * Bash currency residue (#2379). Bash expands single-digit positional
 * parameters, so a double-quoted `$450/mo` arrives as `50/mo` and `$180K`
 * as `80K` — no surviving `$`, no double space, and the unit suffix is
 * still attached to digits, so none of the other residue signals fire.
 *
 * The residue signature is a bare number carrying a currency-shaped
 * suffix with no `$` in front:
 *
 *   - magnitude: `80K`, `2M`, `1,500K`, `2.5B` — case-insensitive, since
 *     lowercase shorthand (`$80k` → `80k`) is just as common (#2425)
 *   - per-period rate: `50/mo`, `450/month`, `99/yr`
 *
 * The negative lookbehind `(?<![$\d,.A-Za-z])` anchors the match at the
 * true start of the number: `$`/digit/`,`/`.` reject every position inside
 * an intact literal like `$180K` or `$450/mo` (preserving the
 * currency-literal guarantee from PR #1022), and a letter rejects
 * alphanumeric codes like `Q2M` (#2426). Longer period alternatives come
 * first so `/month` is never half-matched as `/mo`.
 *
 * A bare number alone is weak evidence — "10K race" and "4K monitor" are
 * legitimate topics — so these patterns only count as residue when a money
 * keyword appears NEAR the match (see {@link looksLikeCurrencyResidue}).
 * Both are ARG-ONLY, like every other residue signal.
 *
 * The `g` flag is for `matchAll` (which requires it); never reuse these
 * with the stateful `.test()`/`.exec()`.
 */
const BARE_MAGNITUDE_RESIDUE_PATTERN = /(?<![$\d,.A-Za-z])\d[\d,]*(?:\.\d+)?[KMB]\b/gi;
const BARE_RATE_RESIDUE_PATTERN =
  /(?<![$\d,.A-Za-z])\d[\d,]*(?:\.\d+)?\/(?:month|mo|year|yr|week|wk|hour|hr|day)s?\b/gi;

/**
 * Money-context gate for the bare magnitude/rate residue signals: only a
 * topic that is plainly about money makes a bare `80K` or `50/mo` read as
 * a mangled currency amount rather than a distance, resolution, or count.
 *
 * The hyphen guards keep compound adjectives ("budget-friendly 4K TV",
 * "cost-effective", "low-budget") from counting as money context — there
 * the keyword describes a product, not an amount (#2424). `g` flag for
 * `matchAll`; never reuse with `.test()`.
 */
const MONEY_CONTEXT_PATTERN =
  /(?<!-)\b(?:budget|cost|price|pricing|revenue|arpu|mrr|arr|salary|salaries|funding|runway|raise|spend|spending|payment|fee|fees|invoice|dollars?|usd)\b(?!-)/gi;

/**
 * Proximity windows between a money keyword and a residue token, in
 * intervening whitespace-separated words (#2424). Mere co-occurrence
 * anywhere in the topic is NOT money context: "Should we upgrade to a 4K
 * monitor within our budget?" pairs an unrelated resolution token with a
 * far-away keyword and must not warn.
 *
 * Asymmetric on purpose — money phrasing runs longer in the keyword-first
 * direction ("budget is set at 80K": 3 between) than in the amount-first
 * direction ("80K in the budget": 2 between), while 3 words after already
 * reintroduces the "4K monitor within our budget" false positive.
 */
const MAX_WORDS_KEYWORD_BEFORE_RESIDUE = 3;
const MAX_WORDS_KEYWORD_AFTER_RESIDUE = 2;

/**
 * Hard character-distance cap for the proximity gate (#2484): a money
 * keyword more than this many characters from the residue token is not
 * "proximate", no matter how few whitespace-separated words span the gap —
 * a single 200-char token is one "word" but plainly separates the two.
 * This is simultaneously a semantic tightening AND the cost bound that the
 * word-count short-circuit alone could not provide: a range made of a few
 * very LONG unbroken tokens holds at most `max` word starts, so the
 * pre-#2484 scan walked the full range — O(distance), benchmarked at
 * ~30-43 ms per call on long-token adversarial shapes, contradicting the
 * module's "without measurable cost" contract. The cap bounds every
 * {@link wordsWithin} call at O(128) and makes the cost property
 * semantically testable (dropping the cap flips a far-keyword fixture's
 * outcome instead of just its timing).
 *
 * Exported (like {@link CATEGORY_SCAN_LIMIT}) so boundary tests derive
 * their gap fixtures from the cap instead of magic repeat counts — a future
 * cap change then fails loudly instead of silently invalidating fixture
 * intent (#2507).
 */
export const MAX_PROXIMITY_SCAN_CHARS = 128;

/**
 * Fallback whitespace test for non-ASCII code points. JS `\s` also covers
 * Unicode spaces (NBSP, ogham/en/em spaces, line/paragraph separators,
 * narrow no-break, ideographic space, BOM, …) that the ASCII fast path in
 * {@link isWhitespaceAt} cannot; behaviour must stay identical to `/\s/`.
 */
const NON_ASCII_WHITESPACE_PATTERN = /\s/;

/**
 * Whitespace test for the char at `index`, charCode-based: the ASCII range
 * is decided by direct comparison (0x20 space, 0x09-0x0D tab/LF/VT/FF/CR —
 * exactly the ASCII subset of `\s`); code points above 0x7F fall back to a
 * single shared regex so Unicode-space behaviour is unchanged. Avoids a
 * regex invocation per scanned character on the (overwhelmingly ASCII) hot
 * path (#2484).
 */
function isWhitespaceAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code <= 0x7f) {
    return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  }
  return NON_ASCII_WHITESPACE_PATTERN.test(text.charAt(index));
}

/**
 * Word-count proximity predicate: `true` iff the span `[from, to)` is at
 * most {@link MAX_PROXIMITY_SCAN_CHARS} characters wide AND at most `max`
 * whitespace-separated words fall strictly between the two match spans.
 *
 * Within the character cap, behaviourally identical to
 * `slice(from, to).trim().split(/\s+/).length <= max`: it scans
 * character-by-character and short-circuits as soon as the `(max + 1)`-th
 * word start is seen (#2454). A word start is a non-whitespace character at
 * the range start or preceded by whitespace; leading/trailing whitespace of
 * the range is ignored, matching the trim/split semantics exactly. The char
 * cap makes the scan O(min(range, 128)) — never O(distance) (#2484). Never
 * materializes a slice or array, so an adversarial arg within the 8 KiB cap
 * stays cheap.
 */
function wordsWithin(text: string, from: number, to: number, max: number): boolean {
  if (to - from > MAX_PROXIMITY_SCAN_CHARS) {
    return false;
  }
  let count = 0;
  let prevWhitespace = true;
  const end = Math.min(to, text.length);
  for (let i = from; i < end; i++) {
    const isWhitespace = isWhitespaceAt(text, i);
    if (!isWhitespace && prevWhitespace) {
      count++;
      if (count > max) {
        return false;
      }
    }
    prevWhitespace = isWhitespace;
  }
  return count <= max;
}

function looksLikeCurrencyResidue(normalized: string, suspectEdge: boolean): boolean {
  // In index order, courtesy of matchAll (`filter` preserves that order,
  // which the binary search below relies on). On a suspect edge (#2505), a
  // keyword match ending exactly at the end of the bounded text may owe its
  // trailing `\b` to the 8 KiB cut — verified repro: a slice ending
  // `… 80K in budget` with `ary plans` continuing past the cap. "budgetary"
  // is not a money keyword, so the bisected fragment must not count as money
  // context; discarding an edge keyword mirrors full-text `\b` semantics
  // exactly as for residues.
  //
  // Same `lastIndex` self-defense as {@link hasNonEdgeMatch} (#2507):
  // `matchAll` clones the regex but seeds the clone from the original's
  // current `lastIndex`, so each shared `g` pattern is reset before use
  // rather than trusting comment discipline at other call sites.
  MONEY_CONTEXT_PATTERN.lastIndex = 0;
  const keywords = [...normalized.matchAll(MONEY_CONTEXT_PATTERN)].filter(
    (keyword) => !suspectEdge || isNonEdgeMatch(keyword, normalized.length),
  );
  if (keywords.length === 0) {
    return false;
  }
  // On a suspect edge (#2482), a residue match ending exactly at the end of
  // the bounded text may owe its trailing `\b` to the 8 KiB cut (an intact
  // `…$1,500KB` bisected after the `K` reads as bare `500K`), so it is
  // excluded. Safe on the folded text: the confusable fold is a 1:1 char
  // replacement, so match indices and lengths are unaffected by it.
  BARE_MAGNITUDE_RESIDUE_PATTERN.lastIndex = 0;
  BARE_RATE_RESIDUE_PATTERN.lastIndex = 0;
  const residues = [
    ...normalized.matchAll(BARE_MAGNITUDE_RESIDUE_PATTERN),
    ...normalized.matchAll(BARE_RATE_RESIDUE_PATTERN),
  ].filter((residue) => !suspectEdge || isNonEdgeMatch(residue, normalized.length));
  // Per residue, only the NEAREST keyword on each side can matter: a farther
  // keyword spans a superset of the intervening text, so its word count is
  // never smaller. Binary search keeps a token-dense adversarial arg at
  // O(R log K) pair checks instead of the full R x K cross-product.
  return residues.some((residue) => {
    let lo = 0;
    let hi = keywords.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const candidate = keywords[mid];
      if (candidate !== undefined && candidate.index <= residue.index) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const before = keywords[lo - 1];
    const after = keywords[lo];
    return (
      (before !== undefined &&
        wordsWithin(
          normalized,
          before.index + before[0].length,
          residue.index,
          MAX_WORDS_KEYWORD_BEFORE_RESIDUE,
        )) ||
      (after !== undefined &&
        wordsWithin(
          normalized,
          residue.index + residue[0].length,
          after.index,
          MAX_WORDS_KEYWORD_AFTER_RESIDUE,
        ))
    );
  });
}

/**
 * Confusable unit letters that survive NFKC (which folds fullwidth `Ｋ`
 * but not small-caps or Cyrillic/Greek lookalikes), folded to ASCII so
 * `80ᴋ`/`50ᴍ` cannot slip past the `[KMB]` residue class (#2426, #2456).
 * Scoped to the residue tier only — this layer is warn-only and advisory,
 * so the fold deliberately covers just the letters the residue patterns
 * read. Greek lowercase `μ`/`β` are included as well; NFKC first folds the
 * micro-sign `µ` (U+00B5) to `μ` (U+03BC), so the single `μ` entry catches
 * both.
 *
 * The `(?<=\d)` guard folds ONLY digit-adjacent letters: these lookalikes
 * are ordinary letters in their own scripts (в/к are everyday Russian
 * prepositions), and folding them everywhere would turn virtually any
 * Cyrillic topic into lone-unit-suffix "residue" (Sentinel
 * SR-20260705-PR2435-e1d04a45, finding 2).
 */
const CONFUSABLE_UNIT_LETTER_PATTERN = /(?<=\d)[ᴋᴍʙКкМмВвΚκΜμΒβ]/g;
const CONFUSABLE_UNIT_LETTER_FOLD: Readonly<Record<string, string>> = {
  ᴋ: "K",
  К: "K",
  к: "K",
  Κ: "K",
  κ: "K",
  ᴍ: "M",
  М: "M",
  м: "M",
  Μ: "M",
  μ: "M",
  ʙ: "B",
  В: "B",
  в: "B",
  Β: "B",
  β: "B",
};

function foldConfusableUnitLetters(text: string): string {
  return text.replace(
    CONFUSABLE_UNIT_LETTER_PATTERN,
    (ch) => CONFUSABLE_UNIT_LETTER_FOLD[ch] ?? ch,
  );
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
 *          — both emptiness artifacts apply only when the input was NOT
 *          truncated (#2507): a topic longer than the 8 KiB cap is by
 *          definition not an empty or one-char argument, so an
 *          all-whitespace scan window (pathological leading whitespace
 *          before real content) must not manufacture them;
 *        - multiple consecutive internal spaces;
 *        - a lone `K`/`M`/`B`/`G` unit suffix after a space;
 *        - a bare magnitude/rate number (`80K`, `80k`, `50/mo`) with no `$`
 *          and a money keyword within a few words of it — the bash
 *          positional-expansion residue of `$180K` / `$450/mo` (#2379,
 *          proximity-gated per #2424). Unit-letter confusables are folded
 *          to ASCII first (#2426).
 *
 * Does NOT warn on intact currency/number literals like `$50`, `$450/mo`,
 * `$180K`, `$2M` where the `$` is followed by 2+ digits — these are intact
 * values that survived shell expansion.
 *
 * Like the category scan, reads only the first {@link CATEGORY_SCAN_LIMIT}
 * characters: a CLI positional can be ARG_MAX-sized, and the proximity gate
 * walks keyword/residue match lists, so the input must be bounded for the
 * cost to stay O(1) in oversized-input terms. This bound applies to the
 * survivor signals too, so a `$VAR`/`$1` that first appears only after the
 * cap does not warn, for any source. Signals that begin only after the cap
 * are sacrificed — same advisory-layer trade-off as
 * {@link boundCategoryScanText}.
 *
 * The bounding is via {@link boundShellExpansionScanText}, which also reports
 * whether the cap cut a token in half (last in-cap char non-whitespace AND a
 * word char immediately past the cap). On such a suspect edge, matches ending
 * exactly at the slice edge are discarded for the patterns whose match can
 * end at an end-anchored `\b` — the `$1` positional survivor, the lone unit
 * suffix, the bare magnitude/rate residues, and the money-context keywords
 * (#2505) — so the cap slicing through an intact `$180K` cannot manufacture
 * a phantom `$1` survivor on input that
 * never touched a shell (#2453), while genuine pre-cap matches keep warning
 * even inside one long unbroken run and nothing is ever trimmed into an
 * empty/one-char residue artifact (#2482). `$VAR` and the multi-space residue
 * carry no trailing boundary, so bisection cannot manufacture them and they
 * are matched unguarded.
 */
export function detectShellExpansion(topic: string, source: TopicSource = "arg"): boolean {
  const { normalized, suspectEdge, truncated } = boundShellExpansionScanText(topic);

  // Survivor signals — meaningful for every source.
  if (
    SHELL_VAR_PATTERN.test(normalized) ||
    hasNonEdgeMatch(SHELL_POSITIONAL_PATTERN, normalized, suspectEdge)
  ) {
    return true;
  }

  // Residue signals — only a shell argument can carry shell-mangling residue.
  if (source !== "arg") {
    return false;
  }

  const folded = foldConfusableUnitLetters(normalized);
  // The emptiness artifacts are gated on non-truncation (#2507): a >8 KiB
  // topic cannot be an empty/one-char argument, so a scan window that trims
  // to ""/one char only reflects pathological leading whitespace, not
  // shell mangling. Untruncated behaviour is unchanged.
  return (
    (!truncated && (normalized.length === 0 || looksLikeExpansionArtifact(normalized))) ||
    MULTI_SPACE_RESIDUE_PATTERN.test(normalized) ||
    hasNonEdgeMatch(LONE_UNIT_SUFFIX_PATTERN, folded, suspectEdge) ||
    looksLikeCurrencyResidue(folded, suspectEdge)
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
