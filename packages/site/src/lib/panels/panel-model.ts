/**
 * Build-time data model for the panel gallery.
 *
 * The gallery is sourced from the built-in panel YAMLs in
 * `packages/cli/panels/*.yaml` — the single source of truth — through an Astro
 * content-collection `glob` loader (see `content.config.ts`). That keeps the
 * page in sync with the CLI without importing the CLI runtime into the site
 * bundle: the YAML is read as data, and this module holds the pure, CLI-free
 * transformation from a parsed panel into the presentational summary the
 * gallery renders.
 */

/** Broad discipline buckets the gallery groups panels into. */
export type Discipline =
  | "Engineering"
  | "Startup & Career"
  | "Product & Design"
  | "Go-to-market"
  | "Finance, People, Legal & Exec";

/** Disciplines in the order they are presented in the gallery. */
export const DISCIPLINES: readonly Discipline[] = [
  "Engineering",
  "Startup & Career",
  "Product & Design",
  "Go-to-market",
  "Finance, People, Legal & Exec",
];

/** Regulated domains a panel may declare; always framed as decision-support. */
export type RegulatedDomain = "finance" | "hr" | "legal";

/** Subset of a panel expert the gallery reads (the YAML carries more). */
export interface RawExpert {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
}

/** Subset of a parsed panel YAML the gallery reads. */
export interface RawPanel {
  readonly name: string;
  readonly description: string;
  readonly experts: readonly RawExpert[];
  readonly samplePrompts?: readonly string[];
  readonly decisionArtifact?: string;
  readonly tags?: readonly string[];
  readonly regulatedDomain?: RegulatedDomain;
}

/** A panel expert as rendered on a gallery card. */
export interface PanelExpert {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
}

/** A regulated-domain badge, framed as decision-support rather than advice. */
export interface RegulatedDomainBadge {
  readonly domain: RegulatedDomain;
  readonly label: string;
}

/** Everything a single gallery card needs, derived purely from a {@link RawPanel}. */
export interface PanelSummary {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly discipline: Discipline;
  readonly tags: readonly string[];
  readonly experts: readonly PanelExpert[];
  readonly expertCount: number;
  readonly samplePrompts: readonly string[];
  readonly decisionArtifact?: string;
  readonly regulatedDomain?: RegulatedDomainBadge;
  /** Copy-pasteable `council convene "<topic>" --panel <slug>` invocation. */
  readonly conveneCommand: string;
}

/** A non-empty discipline section of the gallery. */
export interface DisciplineGroup {
  readonly discipline: Discipline;
  readonly panels: readonly PanelSummary[];
}

/** The inputs {@link disciplineOf} classifies a panel from. */
export interface DisciplineInput {
  readonly slug: string;
  readonly tags?: readonly string[];
  readonly regulatedDomain?: RegulatedDomain;
}

/** Slug words whose canonical display casing differs from a plain title-case. */
const NAME_ACRONYMS: Readonly<Record<string, string>> = {
  fpna: "FP&A",
  ux: "UX",
  hr: "HR",
};

/** Human-readable labels for each regulated domain. */
const REGULATED_DOMAIN_LABELS: Readonly<Record<RegulatedDomain, string>> = {
  finance: "Finance",
  hr: "People (HR)",
  legal: "Legal",
};

/**
 * Keyword rules mapping a panel's tokens to a discipline, evaluated top to
 * bottom so the most specialised (regulated/exec) bucket wins. Keywords are
 * single, unambiguous tokens; generic words shared across panels (e.g.
 * "strategy", "review") are deliberately excluded. Every built-in panel matches
 * a rule explicitly; the final bucket also serves as the fallback so an
 * unclassified future panel stays visible rather than being dropped.
 */
const DISCIPLINE_RULES: readonly (readonly [Discipline, readonly string[]])[] = [
  [
    "Finance, People, Legal & Exec",
    [
      "finance",
      "fpna",
      "budget",
      "hr",
      "hiring",
      "people",
      "legal",
      "risk",
      "compliance",
      "contracts",
      "executive",
      "board",
      "leadership",
    ],
  ],
  ["Engineering", ["engineering", "architecture", "code", "incident", "postmortem", "security", "performance"]],
  ["Startup & Career", ["startup", "validation", "career", "coaching", "founder"]],
  ["Product & Design", ["product", "design", "ux", "roadmap", "prioritization"]],
  [
    "Go-to-market",
    [
      "marketing",
      "brand",
      "positioning",
      "sales",
      "enterprise",
      "deal",
      "pricing",
      "packaging",
      "monetization",
      "negotiation",
      "growth",
      "experimentation",
    ],
  ],
];

/** Collapse runs of whitespace (incl. folded-scalar newlines) into single spaces. */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Lowercase alphanumeric tokens drawn from the slug, tags and regulated domain. */
function tokenize(input: DisciplineInput): ReadonlySet<string> {
  const tokens = new Set<string>();
  const addAll = (value: string): void => {
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 0) {
        tokens.add(token);
      }
    }
  };

  addAll(input.slug);
  for (const tag of input.tags ?? []) {
    addAll(tag);
  }
  if (input.regulatedDomain !== undefined) {
    tokens.add(input.regulatedDomain);
  }
  return tokens;
}

/** Turn a panel slug into a display name, expanding known acronyms. */
export function humanizePanelName(slug: string): string {
  return slug
    .split("-")
    .map((word) => NAME_ACRONYMS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Classify a panel into a single {@link Discipline} from its slug/tags/domain. */
export function disciplineOf(input: DisciplineInput): Discipline {
  const tokens = tokenize(input);
  for (const [discipline, keywords] of DISCIPLINE_RULES) {
    if (keywords.some((keyword) => tokens.has(keyword))) {
      return discipline;
    }
  }
  return "Go-to-market";
}

/** Build the correct convene invocation: a quoted topic plus `--panel <slug>`. */
export function buildConveneCommand(slug: string, topic = "<your topic>"): string {
  return `council convene "${topic}" --panel ${slug}`;
}

/** Resolve the display badge for a regulated domain. */
export function regulatedDomainBadge(domain: RegulatedDomain): RegulatedDomainBadge {
  return { domain, label: REGULATED_DOMAIN_LABELS[domain] };
}

/** Derive the presentational {@link PanelSummary} for one parsed panel. */
export function toPanelSummary(slug: string, panel: RawPanel): PanelSummary {
  const tags = panel.tags ?? [];
  const experts: readonly PanelExpert[] = panel.experts.map((expert) => ({
    slug: expert.slug,
    displayName: normalizeText(expert.displayName),
    role: normalizeText(expert.role),
  }));

  return {
    slug,
    name: humanizePanelName(slug),
    description: normalizeText(panel.description),
    discipline: disciplineOf({ slug, tags, ...domainKey(panel.regulatedDomain) }),
    tags: [...tags],
    experts,
    expertCount: experts.length,
    samplePrompts: (panel.samplePrompts ?? []).map(normalizeText),
    ...(panel.decisionArtifact !== undefined
      ? { decisionArtifact: normalizeText(panel.decisionArtifact) }
      : {}),
    ...(panel.regulatedDomain !== undefined
      ? { regulatedDomain: regulatedDomainBadge(panel.regulatedDomain) }
      : {}),
    conveneCommand: buildConveneCommand(slug),
  };
}

/** Group panels into ordered, non-empty discipline sections sorted by name. */
export function groupByDiscipline(panels: readonly PanelSummary[]): readonly DisciplineGroup[] {
  return DISCIPLINES.map((discipline) => ({
    discipline,
    panels: panels
      .filter((panel) => panel.discipline === discipline)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.panels.length > 0);
}

/** Spread helper that omits `regulatedDomain` entirely when undefined. */
function domainKey(
  regulatedDomain: RegulatedDomain | undefined,
): { readonly regulatedDomain?: RegulatedDomain } {
  return regulatedDomain !== undefined ? { regulatedDomain } : {};
}
