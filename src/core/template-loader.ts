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
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as yaml from "yaml";
import { z } from "zod";

import { ExpertDefinitionSchema } from "./expert.js";

const NonEmptyString = z.string().min(1);

export const DEBATE_MODES = ["freeform", "structured"] as const;
export const DebateModeSchema = z.enum(DEBATE_MODES);
export type DebateMode = z.infer<typeof DebateModeSchema>;

export const PanelDefaultsSchema = z.object({
  mode: DebateModeSchema.default("freeform"),
  maxRounds: z.number().int().min(1).max(20).optional(),
});

export const PanelDefinitionSchema = z
  .object({
    name: NonEmptyString,
    description: NonEmptyString,
    defaults: PanelDefaultsSchema.optional(),
    experts: z.array(ExpertDefinitionSchema).min(2).max(8),
  })
  .superRefine((panel, ctx) => {
    const slugs = panel.experts.map((e) => e.slug);
    const seen = new Set<string>();
    for (const slug of slugs) {
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
 * Resolve the panels directory. Tries source-layout first (this file lives in
 * `src/core/`), falls back to bundled layout (this file lives in `dist/`).
 */
function resolvePanelsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Source layout: <root>/src/core/template-loader.ts -> <root>/panels
  // Bundled layout: <root>/dist/index.js -> <root>/panels
  const inSourceTree = here.includes(`${path.sep}src${path.sep}`);
  return inSourceTree
    ? path.resolve(here, "..", "..", "panels")
    : path.resolve(here, "..", "panels");
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
 * Load a built-in panel template by name.
 */
export async function loadTemplate(name: string): Promise<PanelDefinition> {
  const candidates = [
    path.join(PANELS_DIR, `${name}.yaml`),
    path.join(PANELS_DIR, `${name}.yml`),
  ];
  for (const file of candidates) {
    try {
      return await loadTemplateFromFile(file);
    } catch (err: unknown) {
      if (!isENOENT(err)) throw err;
    }
  }
  throw new Error(`Panel template "${name}" not found in ${PANELS_DIR}`);
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
