/**
 * Panel quality gate — a pure, dependency-free linter for panel definitions.
 *
 * `lintPanelDefinition` is the verifier the official v1 panels must pass. It is
 * intentionally PURE: no filesystem, no network, no engine — it takes an
 * (unvalidated) object and returns rule-tagged {@link LintFinding}s. The CLI
 * (`council panel lint`) handles file reading and rendering around it.
 *
 * ## Severities & the official bar
 *
 * The five panels Council ships today are NOT yet normalized (they have no
 * `samplePrompts` and a couple use the word "leverage"). To avoid hard-failing
 * them before the normalization task lands, findings carry a severity:
 *
 *   - `error`   — a structural defect that always fails the gate:
 *                 schema invalidity, too few weightedEvidence / referenceCases
 *                 / notExpertIn, duplicate role archetypes, or a regulated panel
 *                 missing its non-advice framing.
 *   - `warning` — a quality/style defect that does not fail the default gate:
 *                 missing sample prompts, generic filler phrases, slug-reference
 *                 experts, or an expert count outside the preferred 3-5 band.
 *
 * Passing `{ official: true }` escalates the "quality" warnings (filler phrases,
 * missing sample prompts, slug references) to errors — the strict bar every new
 * v1 panel must clear. Expert-count stays a warning (the schema already enforces
 * the hard 1-8 bounds).
 */
import { DEFAULT_FORBIDDEN_PHRASES } from "./prompt-builder.js";
import { PanelDefinitionSchema } from "./template-loader.js";
import type { ExpertDefinition } from "./expert.js";

export type LintSeverity = "error" | "warning";

export interface LintFinding {
  /** Stable, kebab-case rule identifier (e.g. "expert-evidence"). */
  readonly ruleId: string;
  readonly severity: LintSeverity;
  /** Actionable, human-readable explanation of the defect and the fix. */
  readonly message: string;
  /** Dotted/bracketed location within the panel (e.g. `experts[1].role`). */
  readonly path?: string;
}

export interface LintResult {
  /** True when there are no `error`-severity findings (warnings are allowed). */
  readonly ok: boolean;
  readonly findings: readonly LintFinding[];
  readonly errorCount: number;
  readonly warningCount: number;
}

export interface LintOptions {
  /**
   * Hold the panel to the strict official-quality bar: filler phrases, missing
   * sample prompts, and slug-reference experts are escalated to errors.
   */
  readonly official?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Rule thresholds
// ──────────────────────────────────────────────────────────────────────

const MIN_WEIGHTED_EVIDENCE = 4;
const MIN_REFERENCE_CASES = 2;
const MIN_NOT_EXPERT_IN = 2;
const PREFERRED_MIN_EXPERTS = 3;
const PREFERRED_MAX_EXPERTS = 5;

/**
 * Filler phrases banned in official panel copy: the prompt-builder defaults
 * (the same surface forms experts may never emit) plus the extra marketing
 * vocabulary that signals generic, non-falsifiable writing.
 */
const EXTRA_FILLER_PHRASES = [
  "world-class",
  "seasoned expert",
  "best practices",
  "holistic",
  "synergy",
  "leverage",
  "robust",
  "thought leader",
] as const;

export const BANNED_FILLER_PHRASES: readonly string[] = dedupeCaseInsensitive([
  ...DEFAULT_FORBIDDEN_PHRASES,
  ...EXTRA_FILLER_PHRASES,
]);

const BANNED_PHRASE_MATCHERS: readonly { readonly phrase: string; readonly re: RegExp }[] =
  BANNED_FILLER_PHRASES.map((phrase) => ({
    phrase,
    re: new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i"),
  }));

/**
 * Patterns that satisfy the "explicit non-advice / decision-support framing"
 * requirement for regulated panels. Any one match is sufficient.
 */
const NON_ADVICE_FRAMING: readonly RegExp[] = [
  /not\s+(?:legal|financial|tax|investment|hr|professional|medical)\s+advice/i,
  /does not constitute\s+(?:\w+\s+)?advice/i,
  /for\s+(?:informational|educational)\s+purposes/i,
  /decision[\s-]support/i,
  /consult\s+(?:a|an|your|with)\s+(?:licensed|qualified|professional|attorney|lawyer|accountant|advisor|adviser)/i,
  /not a substitute for professional/i,
];

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/**
 * Lint a panel definition against the Council quality gate.
 *
 * @param panel   An unvalidated object (parsed YAML / JSON). Schema validation
 *                is the first rule, so callers may pass raw input directly.
 * @param options See {@link LintOptions}.
 */
export function lintPanelDefinition(panel: unknown, options: LintOptions = {}): LintResult {
  const official = options.official === true;
  const findings: LintFinding[] = [];

  const parsed = PanelDefinitionSchema.safeParse(panel);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const fieldPath = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      findings.push({
        ruleId: "schema-valid",
        severity: "error",
        message: `${fieldPath}: ${issue.message}`,
        path: fieldPath,
      });
    }
    // An invalid shape can't be reliably inspected further — stop here so the
    // report stays focused on the schema errors the author must fix first.
    return toResult(findings);
  }

  const def = parsed.data;
  const quality: LintSeverity = official ? "error" : "warning";

  checkSamplePrompts(def, quality, findings);
  checkExpertCount(def, findings);
  checkExperts(def, quality, findings);
  checkPanelFiller(def, quality, findings);
  checkRegulatedDomainFraming(def, findings);

  return toResult(findings);
}

// ──────────────────────────────────────────────────────────────────────
// Rules
// ──────────────────────────────────────────────────────────────────────

type Panel = ReturnType<typeof PanelDefinitionSchema.parse>;

function checkSamplePrompts(panel: Panel, quality: LintSeverity, findings: LintFinding[]): void {
  const count = panel.samplePrompts?.length ?? 0;
  if (count === 0) {
    findings.push({
      ruleId: "sample-prompts",
      severity: quality,
      message:
        "Add at least one entry to 'samplePrompts' so users can see how to put this panel to work.",
      path: "samplePrompts",
    });
  }
}

function checkExpertCount(panel: Panel, findings: LintFinding[]): void {
  const n = panel.experts.length;
  if (n < PREFERRED_MIN_EXPERTS || n > PREFERRED_MAX_EXPERTS) {
    findings.push({
      ruleId: "expert-count",
      severity: "warning",
      message: `Panel has ${n} expert(s); official panels prefer ${PREFERRED_MIN_EXPERTS}-${PREFERRED_MAX_EXPERTS} (4-5 is ideal) to balance breadth against prompt budget.`,
      path: "experts",
    });
  }
}

function checkExperts(panel: Panel, quality: LintSeverity, findings: LintFinding[]): void {
  const rolesByArchetype = new Map<string, string>();

  panel.experts.forEach((entry, index) => {
    if (typeof entry === "string") {
      findings.push({
        ruleId: "expert-slug-reference",
        severity: quality,
        message: `Expert entry #${index + 1} ("${entry}") is a slug reference; official built-in panels must define experts inline so they are self-contained.`,
        path: `experts[${index}]`,
      });
      return;
    }

    const expert = entry;
    const where = `experts[${index}] (${expert.slug})`;

    if (expert.expertise.weightedEvidence.length < MIN_WEIGHTED_EVIDENCE) {
      findings.push({
        ruleId: "expert-evidence",
        severity: "error",
        message: `Expert "${expert.slug}" has ${expert.expertise.weightedEvidence.length} weightedEvidence item(s); needs at least ${MIN_WEIGHTED_EVIDENCE} so its prior is distinct.`,
        path: `${where}.expertise.weightedEvidence`,
      });
    }
    if (expert.expertise.referenceCases.length < MIN_REFERENCE_CASES) {
      findings.push({
        ruleId: "expert-reference-cases",
        severity: "error",
        message: `Expert "${expert.slug}" has ${expert.expertise.referenceCases.length} referenceCase(s); needs at least ${MIN_REFERENCE_CASES} concrete cases to cite.`,
        path: `${where}.expertise.referenceCases`,
      });
    }
    if (expert.expertise.notExpertIn.length < MIN_NOT_EXPERT_IN) {
      findings.push({
        ruleId: "expert-not-expert-in",
        severity: "error",
        message: `Expert "${expert.slug}" has ${expert.expertise.notExpertIn.length} notExpertIn entr(y/ies); needs at least ${MIN_NOT_EXPERT_IN} so it defers instead of bluffing.`,
        path: `${where}.expertise.notExpertIn`,
      });
    }

    const archetype = normalizeRole(expert.role);
    const priorSlug = rolesByArchetype.get(archetype);
    if (priorSlug !== undefined) {
      findings.push({
        ruleId: "duplicate-role",
        severity: "error",
        message: `Experts "${priorSlug}" and "${expert.slug}" share the role archetype "${expert.role}". Give each expert a distinct role so perspectives don't collapse.`,
        path: `${where}.role`,
      });
    } else {
      rolesByArchetype.set(archetype, expert.slug);
    }

    const filler = firstFillerPhrase(expertTextFields(expert));
    if (filler) {
      findings.push({
        ruleId: "filler-phrase",
        severity: quality,
        message: `Expert "${expert.slug}" ${filler.field} contains the generic filler phrase "${filler.phrase}". Replace it with specific, falsifiable language.`,
        path: `${where}.${filler.field}`,
      });
    }
  });
}

function checkPanelFiller(panel: Panel, quality: LintSeverity, findings: LintFinding[]): void {
  const fields: { readonly field: string; readonly value: string }[] = [];
  if (panel.description !== undefined)
    fields.push({ field: "description", value: panel.description });
  if (panel.decisionArtifact !== undefined) {
    fields.push({ field: "decisionArtifact", value: panel.decisionArtifact });
  }
  (panel.samplePrompts ?? []).forEach((prompt, i) => {
    fields.push({ field: `samplePrompts[${i}]`, value: prompt });
  });

  for (const { field, value } of fields) {
    const phrase = findBannedPhrase(value);
    if (phrase) {
      findings.push({
        ruleId: "filler-phrase",
        severity: quality,
        message: `Panel ${field} contains the generic filler phrase "${phrase}". Replace it with specific, falsifiable language.`,
        path: field,
      });
    }
  }
}

function checkRegulatedDomainFraming(panel: Panel, findings: LintFinding[]): void {
  if (panel.regulatedDomain === undefined) return;
  const haystack = collectFramingText(panel).join("\n");
  const framed = NON_ADVICE_FRAMING.some((re) => re.test(haystack));
  if (!framed) {
    findings.push({
      ruleId: "regulated-domain-framing",
      severity: "error",
      message: `regulatedDomain is "${panel.regulatedDomain}" but no explicit non-advice / decision-support framing was found. Add text such as "this is decision-support, not ${panel.regulatedDomain} advice" to the description or an expert's stance.`,
      path: "regulatedDomain",
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function expertTextFields(
  expert: ExpertDefinition,
): { readonly field: string; readonly value: string }[] {
  const out: { field: string; value: string }[] = [
    { field: "role", value: expert.role },
    { field: "displayName", value: expert.displayName },
    { field: "epistemicStance", value: expert.epistemicStance },
  ];
  if (expert.personality !== undefined)
    out.push({ field: "personality", value: expert.personality });
  if (expert.debateProtocol !== undefined) {
    out.push({ field: "debateProtocol", value: expert.debateProtocol });
  }
  if (expert.outputContract !== undefined) {
    out.push({ field: "outputContract", value: expert.outputContract });
  }
  expert.expertise.weightedEvidence.forEach((v, i) =>
    out.push({ field: `expertise.weightedEvidence[${i}]`, value: v }),
  );
  expert.expertise.referenceCases.forEach((v, i) =>
    out.push({ field: `expertise.referenceCases[${i}]`, value: v }),
  );
  expert.expertise.notExpertIn.forEach((v, i) =>
    out.push({ field: `expertise.notExpertIn[${i}]`, value: v }),
  );
  return out;
}

/** Text scanned to satisfy the regulated-domain non-advice framing rule. */
function collectFramingText(panel: Panel): string[] {
  const out: string[] = [];
  if (panel.description !== undefined) out.push(panel.description);
  if (panel.decisionArtifact !== undefined) out.push(panel.decisionArtifact);
  out.push(...(panel.samplePrompts ?? []));
  for (const entry of panel.experts) {
    if (typeof entry === "string") continue;
    out.push(entry.role, entry.epistemicStance);
    if (entry.debateProtocol !== undefined) out.push(entry.debateProtocol);
    if (entry.outputContract !== undefined) out.push(entry.outputContract);
    if (entry.personality !== undefined) out.push(entry.personality);
  }
  return out;
}

function firstFillerPhrase(
  fields: readonly { readonly field: string; readonly value: string }[],
): { readonly field: string; readonly phrase: string } | undefined {
  for (const { field, value } of fields) {
    const phrase = findBannedPhrase(value);
    if (phrase) return { field, phrase };
  }
  return undefined;
}

function findBannedPhrase(value: string): string | undefined {
  for (const { phrase, re } of BANNED_PHRASE_MATCHERS) {
    if (re.test(value)) return phrase;
  }
  return undefined;
}

function normalizeRole(role: string): string {
  return role.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeCaseInsensitive(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toResult(findings: readonly LintFinding[]): LintResult {
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.length - errorCount;
  return { ok: errorCount === 0, findings, errorCount, warningCount };
}
