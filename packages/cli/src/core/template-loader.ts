/**
 * Panel template loader.
 *
 * Templates live as YAML files in the `panels/` directory at the repo root
 * (and ship inside the npm package via `package.json#files`).
 *
 * Validation pipeline:
 *   1. Read YAML file
 *   2. Parse to JS object (yaml lib)
 *   3. Validate via PanelDefinitionSchema (Zod) — reuses ExpertDefinitionSchema
 *      from `src/core/expert.ts` so the contract is identical for built-in
 *      and user-authored panels.
 *
 * Design choice: `PANELS_DIR` is resolved from this module's URL so it works
 * both in source (`src/core/template-loader.ts`) and bundled (`dist/...`).
 * The `panels/` directory is at the package root, two levels up from this file
 * in source layout and one level up in the bundled dist. We try both.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as yaml from "yaml";
import { z } from "zod";

import type { ExpertLibrary } from "./expert-library.js";
import { ExpertDefinitionSchema, type ExpertDefinition } from "./expert.js";
import { toSingleLineDisplay } from "../cli/strip-control-chars.js";

const NonEmptyString = z.string().min(1);

export const DEBATE_MODES = ["freeform", "structured"] as const;
export const DebateModeSchema = z.enum(DEBATE_MODES);
export type DebateMode = z.infer<typeof DebateModeSchema>;

/**
 * Regulated domains that require explicit non-advice / decision-support
 * framing (enforced by the panel quality gate, see `core/panel-lint.ts`).
 */
export const REGULATED_DOMAINS = ["legal", "finance", "hr"] as const;
export const RegulatedDomainSchema = z.enum(REGULATED_DOMAINS);
export type RegulatedDomain = z.infer<typeof RegulatedDomainSchema>;

export const PanelDefaultsSchema = z.object({
  mode: DebateModeSchema.default("freeform"),
  maxRounds: z.number().int().min(1).max(20).optional(),
  model: NonEmptyString.optional(),
});

/**
 * An entry in a panel's `experts` list — either a slug string referencing a
 * library expert, or a full inline `ExpertDefinition` for backwards compat.
 */
export const PanelExpertEntrySchema = z.union([NonEmptyString, ExpertDefinitionSchema]);
export type PanelExpertEntry = z.infer<typeof PanelExpertEntrySchema>;

function entrySlug(entry: PanelExpertEntry): string {
  return typeof entry === "string" ? entry : entry.slug;
}

export const PanelDefinitionSchema = z
  .object({
    name: NonEmptyString,
    description: NonEmptyString.optional(),
    defaults: PanelDefaultsSchema.optional(),
    experts: z.array(PanelExpertEntrySchema).min(1).max(8),
    /**
     * Example questions that showcase what this panel is for. Optional and
     * backward-compatible — existing panels omit it. The quality gate
     * (`core/panel-lint.ts`) warns (or, under the official bar, errors) when
     * an official panel ships without at least one sample prompt.
     */
    samplePrompts: z.array(NonEmptyString).readonly().optional(),
    /** One-line description of the concrete decision artifact this panel helps produce. */
    decisionArtifact: NonEmptyString.optional(),
    /** Free-form discovery tags (e.g. "engineering", "hiring"). */
    tags: z.array(NonEmptyString).readonly().optional(),
    /**
     * Marks a panel as operating in a regulated advice domain. When set, the
     * quality gate requires explicit non-advice / decision-support framing.
     */
    regulatedDomain: RegulatedDomainSchema.optional(),
  })
  .superRefine((panel, ctx) => {
    const seen = new Set<string>();
    for (const entry of panel.experts) {
      const slug = entrySlug(entry);
      if (seen.has(slug)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate expert slug "${slug}" — slugs must be unique within a panel`,
          path: ["experts"],
        });
        return;
      }
      seen.add(slug);
    }
  });

export type PanelDefinition = z.infer<typeof PanelDefinitionSchema>;

/**
 * A panel whose `experts` array contains only fully-resolved inline
 * definitions. Produced by calling {@link resolveExperts} on a
 * {@link PanelDefinition} and folding the result back into the panel shape.
 */
export interface ResolvedPanelDefinition {
  readonly name: string;
  readonly description?: string;
  readonly defaults?: PanelDefinition["defaults"];
  readonly experts: readonly ExpertDefinition[];
}

export const StoredPanelDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  defaults: PanelDefaultsSchema.optional(),
  experts: z.array(ExpertDefinitionSchema).min(1).max(8),
});

export type StoredPanelDefinition = z.infer<typeof StoredPanelDefinitionSchema>;

export type StoredPanelDefinitionResult =
  | { readonly kind: "ok"; readonly definition: StoredPanelDefinition }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Read and validate the stored panel definition from a session's
 * `config_json`. Distinguishes three cases so callers can emit precise
 * errors for older sessions, corrupt sessions, or usable definitions.
 */
export function parseStoredPanelDefinition(configJson: string): StoredPanelDefinitionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return { kind: "absent" };
  }
  if (parsed === null || typeof parsed !== "object" || !("definition" in parsed)) {
    return { kind: "absent" };
  }
  const definition = (parsed as { readonly definition: unknown }).definition;
  if (definition === undefined || definition === null) {
    return { kind: "absent" };
  }
  const result = StoredPanelDefinitionSchema.safeParse(definition);
  if (!result.success) {
    return { kind: "invalid", message: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { kind: "ok", definition: result.data };
}

/**
 * Typed error: a panel was looked up by name but no matching file exists.
 *
 * Distinguishing this from "panel file exists but failed to parse/validate"
 * lets callers (e.g. {@link loadPanel}) fall back to a different source on
 * "not found" while still propagating real validation errors verbatim.
 */
export class PanelNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelNotFoundError";
  }
}

/**
 * Compute Levenshtein edit distance between two strings. Used to surface
 * "did you mean ..." suggestions when a user mistypes a template/panel name.
 * Implemented inline (no external dependency) — O(m*n) time, O(min(m,n)) space.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure `a` is the shorter string so the row array is small.
  if (a.length > b.length) {
    [a, b] = [b, a];
  }
  let previous: number[] = new Array<number>(a.length + 1);
  let current: number[] = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) previous[i] = i;
  for (let j = 1; j <= b.length; j++) {
    current[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[i] = Math.min(
        (current[i - 1] ?? 0) + 1, // insertion
        (previous[i] ?? 0) + 1, // deletion
        (previous[i - 1] ?? 0) + cost, // substitution
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[a.length] ?? 0;
}

/**
 * Find the closest match to `name` among `candidates`. Returns the best
 * candidate when its Levenshtein distance is within a small threshold
 * proportional to `name.length`; otherwise undefined.
 */
function suggestClosest(name: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  // Threshold: up to 1/3 of the input length, minimum 1, maximum 3. This
  // catches typical typos ("securty" → "security-review") without offering
  // wildly unrelated suggestions for short or empty inputs.
  const threshold = Math.max(1, Math.min(3, Math.floor(name.length / 3)));
  let best: { readonly name: string; readonly distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(name, candidate);
    if (distance <= threshold && (best === undefined || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}

/**
 * Build a user-facing "panel not found" message that lists available names
 * and includes a did-you-mean suggestion when the input looks like a typo.
 * Internal filesystem paths are deliberately omitted (F05).
 */
function formatPanelNotFoundMessage(
  kind: "Panel template" | "User panel",
  requested: string,
  available: readonly string[],
): string {
  const suggestion = suggestClosest(requested, available);
  const head = `${kind} "${requested}" not found.`;
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
  const list =
    available.length > 0
      ? ` Available: ${[...available].sort().join(", ")}.`
      : " No panels are available.";
  return `${head}${hint}${list}`;
}

/**
 * Resolve the panels directory by probing candidate paths in order.
 *
 * Council ships `panels/*.yaml` at the package root (per package.json#files).
 * The challenge is that this file's location varies depending on the build:
 *   - Source-tree dev:    `<root>/src/core/template-loader.ts` → `../../panels`
 *   - Bundled (tsup) bin: `<root>/dist/bin/council.js`         → `../../panels`
 *   - Bundled (tsup) lib: `<root>/dist/index.js`               → `../panels`
 *   - npm-installed:      `<pkg>/dist/...`                     → `<pkg>/panels`
 *
 * We probe each candidate and return the first that exists. If none exist
 * (packaging bug), throw a clear error rather than silently returning
 * an empty list — closes Sentinel issue #38 / #71.
 */
function resolvePanelsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "panels"), // src/core/* and dist/bin/*
    path.resolve(here, "..", "panels"), // dist/*
    path.resolve(here, "panels"), // unusual but try
  ];
  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      /* try next candidate */
    }
  }
  // Fallback to the most-likely path so error messages stay informative.
  return candidates[0] ?? path.resolve(here, "..", "..", "panels");
}

const PANELS_DIR = resolvePanelsDir();

/**
 * List the names (without `.yaml` extension) of every bundled template.
 */
export async function listTemplates(): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PANELS_DIR);
  } catch (err: unknown) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map((name) => name.replace(/\.ya?ml$/, ""))
    .sort();
}

/**
 * List the absolute paths of every bundled panel YAML file.
 *
 * Used by `council panel lint --built-ins` to lint the shipped panels in
 * place. Returns an empty array when the panels directory is missing.
 */
export async function listTemplateFiles(): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PANELS_DIR);
  } catch (err: unknown) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map((name) => path.join(PANELS_DIR, name))
    .sort();
}

/**
 * Load a built-in panel template by name.
 *
 * `name` MUST match the template-slug regex `^[a-z][a-z0-9-]*$` — this
 * blocks path-traversal attempts (`../`, absolute paths, separators) so
 * `loadTemplate(userInput)` is safe to call with values from the CLI or
 * from a panel YAML's own references.
 */
export const TEMPLATE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export async function loadTemplate(name: string): Promise<ResolvedPanelDefinition> {
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid panel template name "${name}". Names must match ${TEMPLATE_NAME_PATTERN.source} (lowercase, digits, hyphens, must start with a letter).`,
    );
  }
  const candidates = [path.join(PANELS_DIR, `${name}.yaml`), path.join(PANELS_DIR, `${name}.yml`)];
  // Defense in depth: even though the regex prevents traversal, assert
  // every candidate is inside PANELS_DIR before reading.
  const panelsRoot = path.resolve(PANELS_DIR) + path.sep;
  for (const file of candidates) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(panelsRoot)) {
      throw new Error(`Refusing to read panel outside ${PANELS_DIR}: ${resolved}`);
    }
    try {
      const panel = await loadTemplateFromFile(resolved);
      return assertAllInline(panel, resolved);
    } catch (err: unknown) {
      if (!isENOENT(err)) throw err;
    }
  }
  throw new PanelNotFoundError(
    formatPanelNotFoundMessage("Panel template", name, await listTemplates()),
  );
}

/**
 * Narrow a {@link PanelDefinition} to a {@link ResolvedPanelDefinition} by
 * asserting every entry is an inline {@link ExpertDefinition}. Throws a
 * descriptive error when any slug-reference is present — used by
 * {@link loadTemplate} since built-in templates must remain self-contained.
 *
 * Exported so callers that already have a `PanelDefinition` in hand can
 * narrow it without going through {@link loadTemplate}.
 */
export function assertAllInline(panel: PanelDefinition, source: string): ResolvedPanelDefinition {
  const slugRefs = panel.experts.filter((e): e is string => typeof e === "string");
  if (slugRefs.length > 0) {
    const safeSource = toSingleLineDisplay(source);
    const safeSlugs = slugRefs.map((s) => toSingleLineDisplay(s)).join(", ");
    throw new Error(
      `Panel ${safeSource} contains slug references (${safeSlugs}). ` +
        `Built-in templates must use inline expert definitions. ` +
        `Use loadPanel() together with resolveExperts() and an ExpertLibrary ` +
        `to resolve slug references.`,
    );
  }
  const inlineExperts = panel.experts.filter((e): e is ExpertDefinition => typeof e !== "string");
  return {
    name: panel.name,
    ...(panel.description !== undefined ? { description: panel.description } : {}),
    ...(panel.defaults !== undefined ? { defaults: panel.defaults } : {}),
    experts: inlineExperts,
  };
}

/**
 * Load and validate a panel template from an arbitrary file path.
 */
export async function loadTemplateFromFile(file: string): Promise<PanelDefinition> {
  const raw = await fs.readFile(file, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse panel YAML (${file}): ${cause}`);
  }
  const result = PanelDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const fieldPath = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  - ${fieldPath}: ${i.message}`;
    });
    throw new Error(`Invalid panel template in ${file}:\n${lines.join("\n")}`);
  }
  return result.data;
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

/**
 * Resolve a panel's expert entries into full {@link ExpertDefinition}s.
 *
 * - Slug references are looked up via `library.get(slug)`.
 * - Inline definitions pass through unchanged.
 * - Slugs the library can't find are collected in `missing` (no throw),
 *   so callers can present a single useful error covering every gap.
 */
export async function resolveExperts(
  entries: readonly PanelExpertEntry[],
  library: ExpertLibrary,
): Promise<{ resolved: readonly ExpertDefinition[]; missing: readonly string[] }> {
  const resolved: ExpertDefinition[] = [];
  const missing: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const expert = await library.get(entry);
      if (expert) {
        resolved.push(expert);
      } else {
        missing.push(entry);
      }
    } else {
      resolved.push(entry);
    }
  }
  return { resolved, missing };
}

/**
 * Load a user-authored panel from `<dataHome>/panels/<name>.{yaml,yml}`.
 *
 * `name` is validated against {@link TEMPLATE_NAME_PATTERN} to block
 * path-traversal attempts before any filesystem access.
 */
export async function loadUserPanel(name: string, dataHome: string): Promise<PanelDefinition> {
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid panel template name "${name}". Names must match ${TEMPLATE_NAME_PATTERN.source} (lowercase, digits, hyphens, must start with a letter).`,
    );
  }
  const userPanelsDir = path.join(dataHome, "panels");
  const userRoot = path.resolve(userPanelsDir) + path.sep;
  const candidates = [
    path.join(userPanelsDir, `${name}.yaml`),
    path.join(userPanelsDir, `${name}.yml`),
  ];
  for (const file of candidates) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(userRoot)) {
      throw new Error(`Refusing to read panel outside ${userPanelsDir}: ${resolved}`);
    }
    try {
      return await loadTemplateFromFile(resolved);
    } catch (err: unknown) {
      if (!isENOENT(err)) throw err;
    }
  }
  throw new PanelNotFoundError(
    formatPanelNotFoundMessage("User panel", name, await listUserPanels(dataHome)),
  );
}

/**
 * List user-authored panels in `<dataHome>/panels/`. Returns names without
 * extension, sorted. An empty array is returned when the directory does
 * not exist (a fresh install has no user panels yet).
 */
export async function listUserPanels(dataHome: string): Promise<readonly string[]> {
  const userPanelsDir = path.join(dataHome, "panels");
  let entries: string[];
  try {
    entries = await fs.readdir(userPanelsDir);
  } catch (err: unknown) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map((name) => name.replace(/\.ya?ml$/, ""))
    .sort();
}

/**
 * Load a panel by name. User panels in `<dataHome>/panels/` take precedence
 * over the built-in templates that ship with Council, so users can override
 * a stock panel without touching the package.
 */
export async function loadPanel(name: string, dataHome: string): Promise<PanelDefinition> {
  try {
    return await loadUserPanel(name, dataHome);
  } catch (err: unknown) {
    // Only fall back to built-ins when the user panel is genuinely absent.
    // YAML parse errors, schema-validation failures, traversal-rejections,
    // etc. surface verbatim so the user can fix their file.
    if (!(err instanceof PanelNotFoundError)) throw err;
  }
  const resolved = await loadTemplate(name);
  return {
    name: resolved.name,
    ...(resolved.description !== undefined ? { description: resolved.description } : {}),
    ...(resolved.defaults !== undefined ? { defaults: resolved.defaults } : {}),
    experts: [...resolved.experts],
  };
}
