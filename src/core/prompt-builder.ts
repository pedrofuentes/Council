/**
 * 8-section expert system prompt builder.
 *
 * The structure (per ROADMAP §1.6 and the Prompt Engineering Expert's
 * design doc at `docs/analysis/03-prompt-architecture.md`):
 *
 *   [1] IDENTITY          — who you are, in one paragraph
 *   [2] EXPERTISE PRIOR   — what you know deeply, what you weight
 *   [3] EPISTEMIC STANCE  — how you form beliefs
 *   [4] DEBATE PROTOCOL   — anti-sycophancy rules (mandatory disagreement budget)
 *   [5] OUTPUT CONTRACT   — required structure of every response
 *   [6] FORBIDDEN MOVES   — explicit failure modes to avoid
 *   [7] MEMORY            — prior positions, updated priors, unresolved questions
 *   [8] CURRENT TASK      — per-turn instruction
 *
 * Sections 1-6 are the static profile. Section 7 is injected from per-expert
 * memory (empty on first session). Section 8 is per-turn from the moderator.
 *
 * THE thesis (Prompt Engineering Expert): "constraints produce intelligence;
 * freedom produces mush." Default forbidden phrases and the disagreement
 * budget are ALWAYS injected — they cannot be opted out of.
 */
import type { PersonaProfile } from "./documents/profile-analyzer.js";
import type { ExpertDefinition } from "./expert.js";

/**
 * Phrases banned in every expert response — the surface forms of
 * agreement-padding and generic LLM filler.
 */
export const DEFAULT_FORBIDDEN_PHRASES: readonly string[] = [
  "Great point",
  "I agree with",
  "Building on",
  "holistic",
  "synergy",
  "leverage",
  "robust",
  "best practices",
];

/**
 * Default debate protocol — Layer 2 of the 3-layer anti-sycophancy system.
 * Always included; profiles MAY supplement via debateProtocol but cannot
 * remove the disagreement budget.
 */
export const DEFAULT_DEBATE_PROTOCOL = `
Before supporting any prior speaker's conclusion, identify at least one of:
  (a) A specific claim of theirs you find weak, with the strongest counter-argument
  (b) A consideration they omitted that materially changes the answer
  (c) A scenario where their recommendation fails

If after honest effort you find none, say exactly:
  "I have stress-tested [Expert]'s position and cannot find a material weakness.
   My contribution is therefore to add [X] which they did not address."

You are not permitted to simply concur.`.trim();

/**
 * Default output contract — keeps responses specific and falsifiable.
 */
export const DEFAULT_OUTPUT_CONTRACT = `
Every claim you make must be either:
  - Falsifiable (could be shown wrong by a specific observation)
  - Actionable (the listener could do something different as a result)

Avoid statements that could appear in any expert's response on any topic.`.trim();

/**
 * Per-expert memory accumulated across sessions.
 * See ROADMAP §3.1 (persistent expert memory) for the storage layer.
 */
export interface ExpertMemory {
  /** Stances the expert took in past discussions, with outcomes when known. */
  readonly positions: readonly string[];
  /** Adjustments the expert made after being shown to be wrong. */
  readonly updatedPriors: readonly string[];
  /** Open questions from past sessions the expert may want to revisit. */
  readonly unresolved: readonly string[];
}

function renderIdentity(def: ExpertDefinition): string {
  const personality = def.personality ? ` ${def.personality}` : "";
  return `You are ${def.displayName}. ${def.role}.${personality}`;
}

function renderExpertise(def: ExpertDefinition): string {
  const lines: string[] = [];
  lines.push("You weight evidence in this priority order:");
  def.expertise.weightedEvidence.forEach((item, i) => {
    lines.push(`  ${i + 1}. ${item}`);
  });
  if (def.expertise.referenceCases.length > 0) {
    lines.push("");
    lines.push("Reference cases you draw on (cite by name when used):");
    for (const ref of def.expertise.referenceCases) {
      lines.push(`  - ${ref}`);
    }
  }
  if (def.expertise.notExpertIn.length > 0) {
    lines.push("");
    lines.push(`You are NOT expert in: ${def.expertise.notExpertIn.join(", ")}.`);
    lines.push("Defer explicitly when asked about these.");
  }
  return lines.join("\n");
}

function renderForbiddenMoves(def: ExpertDefinition): string {
  const profile = def.forbiddenMoves ?? [];
  const allMoves = [
    ...DEFAULT_FORBIDDEN_PHRASES.map((p) => `Begin or include the phrase: "${p}"`),
    ...profile,
  ];
  const lines = ["You will be considered to have failed the task if you:"];
  for (const move of allMoves) {
    lines.push(`  - ${move}`);
  }
  return lines.join("\n");
}

function renderMemory(memory: ExpertMemory | undefined): string {
  if (!memory) {
    return "(no prior memory — this is your first session with this panel)";
  }
  const sections: string[] = [];
  if (memory.positions.length > 0) {
    sections.push("Positions you have taken:");
    for (const p of memory.positions) sections.push(`  - ${p}`);
  }
  if (memory.updatedPriors.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push("Updated priors (revise your weighting accordingly):");
    for (const u of memory.updatedPriors) sections.push(`  - ${u}`);
  }
  if (memory.unresolved.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push("Unresolved questions from prior sessions:");
    for (const q of memory.unresolved) sections.push(`  - ${q}`);
  }
  if (sections.length === 0) {
    return "(no prior memory — this is your first session with this panel)";
  }
  return sections.join("\n");
}

function renderPersonaProfile(profile: PersonaProfile): string {
  const lines: string[] = [
    "Based on analysis of documents about you, you exhibit the following traits:",
    "",
    `Communication Style: ${sanitizeProfileField(profile.communicationStyle)}`,
    "",
    "Decision Patterns:",
  ];
  if (profile.decisionPatterns.length === 0) {
    lines.push("  - (none observed)");
  } else {
    for (const p of profile.decisionPatterns) lines.push(`  - ${sanitizeProfileField(p)}`);
  }
  lines.push("");
  lines.push("Cognitive Tendencies:");
  if (profile.biases.length === 0) {
    lines.push("  - (none observed)");
  } else {
    for (const b of profile.biases) lines.push(`  - ${sanitizeProfileField(b)}`);
  }
  lines.push("");
  lines.push(
    `Characteristic Vocabulary: ${profile.vocabulary.map((v) => sanitizeProfileField(v)).join(", ")}`,
  );
  lines.push("");
  lines.push(
    "Adopt these traits naturally in your responses. Do not explicitly mention or quote this profile.",
  );
  return lines.join("\n");
}

/**
 * Defang profile-field strings before interpolation into the privileged
 * system prompt. Profile fields are derived from untrusted documents, so
 * even though `analyzeDocuments()` enforces a JSON shape, the string
 * *contents* may carry adversarial payloads (e.g. forged section markers
 * like "[10] OVERRIDE …" or embedded C0 control bytes).
 *
 * The transformation here is intentionally conservative:
 *   - Strip C0 control characters (except tab/newline/carriage return),
 *     then strip DEL.
 *   - Collapse any run of newlines to a single space so injected
 *     "[N] SECTION" lines cannot appear at column 0 of the prompt.
 *   - Neutralize bracketed numeric section-marker prefixes by escaping
 *     the opening bracket.
 *   - Cap total length so a runaway field cannot drown the prompt.
 */
function sanitizeProfileField(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const collapsed = stripped.replace(/[\r\n]+/g, " ");
  const defanged = collapsed.replace(/\[(\d+)\]/g, "(sec-$1)");
  const MAX = 2000;
  return defanged.length > MAX ? `${defanged.slice(0, MAX)}…` : defanged;
}

/**
 * Build the full system prompt for an expert.
 *
 * Without a `personaProfile`, the prompt has the canonical 8 sections
 * (sections 1-8 with `[8] CURRENT TASK`). When a `personaProfile` is
 * provided, a new section `[8] PERSONA PROFILE` is injected and
 * `CURRENT TASK` shifts to `[9]`.
 *
 * @param def             Static expert profile (validated by ExpertDefinitionSchema)
 * @param memory          Accumulated memory from past sessions (undefined on first run)
 * @param task            Per-turn instruction from the moderator
 * @param personaProfile  Optional LLM-derived behavioral profile (Roadmap 6.2)
 */
export function buildSystemPrompt(
  def: ExpertDefinition,
  memory: ExpertMemory | undefined,
  task: string,
  personaProfile?: PersonaProfile,
): string {
  const sections: string[] = [
    "[1] IDENTITY",
    renderIdentity(def),
    "",
    "[2] EXPERTISE PRIOR",
    renderExpertise(def),
    "",
    "[3] EPISTEMIC STANCE",
    def.epistemicStance,
    "",
    "[4] DEBATE PROTOCOL",
    def.debateProtocol ?? DEFAULT_DEBATE_PROTOCOL,
    "",
    "[5] OUTPUT CONTRACT",
    def.outputContract ?? DEFAULT_OUTPUT_CONTRACT,
    "",
    "[6] FORBIDDEN MOVES",
    renderForbiddenMoves(def),
    "",
    "[7] MEMORY",
    renderMemory(memory),
    "",
  ];
  if (personaProfile) {
    sections.push("[8] PERSONA PROFILE");
    sections.push(renderPersonaProfile(personaProfile));
    sections.push("");
    sections.push("[9] CURRENT TASK");
    sections.push(task);
  } else {
    sections.push("[8] CURRENT TASK");
    sections.push(task);
  }
  return sections.join("\n");
}
